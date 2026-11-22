"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Air } from "./air";
import { echo, ROOM } from "./echo";
import { Gum, gum, useGumGeometry } from "./gum";
import { Room } from "./room";
import { march } from "./shape";
import { armShreds, drawShreds, stepShreds, useShreds } from "./shreds";
import { blow, creak, snap } from "./sound";

// How big the gum starts, the size a new one blows up to, and the size at which it can take no more.
const START = 1;
const REBORN = 0.34;
const MOST = 1.55;
// A press held still this long blows; a shorter one, barely moved, is a tap and pops it.
const HOLD = 260;
// How fast the tear runs over the letters (in the gum's own units a second, before the slow motion), and how far it
// has to go to have taken it all.
const TEAR = 4.2;
const ALL_GONE = 4.6;
// When a new bubble starts to blow, after the pop, and how long it takes.
const AGAIN = 3.1;
const GROW = 1.9;

const scratch = { ray: new THREE.Ray(), o: new THREE.Vector3(), d: new THREE.Vector3(), hit: new THREE.Vector3(), inv: new THREE.Matrix4(), ndc: new THREE.Vector2(), caster: new THREE.Raycaster(), v: new THREE.Vector3() };

// Where a ray first meets the gum, in the gum's own space, or null.
function hitGum(ray: THREE.Ray, group: THREE.Object3D, out: THREE.Vector3) {
  scratch.inv.copy(group.matrixWorld).invert();
  scratch.o.copy(ray.origin).applyMatrix4(scratch.inv);
  scratch.d.copy(ray.direction).transformDirection(scratch.inv);
  return march(scratch.o, scratch.d, out) === null ? null : out;
}

const easeBack = (x: number) => {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const dom = useThree((state) => state.gl.domElement);
  const group = useRef<THREE.Group>(null);
  const geometry = useGumGeometry(startTier === "low" ? 0.034 : 0.022);
  const shreds = useShreds(geometry, startTier === "low" ? 300 : 720, startTier === "low" ? 120 : 260);

  const state = useMemo(
    () => ({
      now: 0,
      size: START,
      phase: "whole" as "whole" | "tearing" | "gone" | "growing",
      poppedAt: -100,
      tear: -1,
      tearLocal: new THREE.Vector3(),
      pump: 0,
      press: null as null | { local: THREE.Vector3 },
      nextCreak: 0,
      pops: 0,
      earned: false,
      kick: 0
    }),
    []
  );

  const pop = (local: THREE.Vector3) => {
    const s = state;
    if (s.phase !== "whole" && s.phase !== "growing") return;
    const g = group.current!;
    s.phase = "tearing";
    s.poppedAt = s.now;
    s.tear = 0;
    s.tearLocal.copy(local);
    s.press = null;
    gum.tearAt.value.copy(local);
    g.updateMatrixWorld();
    echo.at.value.copy(local).applyMatrix4(g.matrixWorld);
    echo.age.value = 0;
    armShreds(shreds, local, s.size);
    const pan = THREE.MathUtils.clamp(scratch.v.copy(echo.at.value).project(camera).x, -1, 1);
    snap(pan, s.size);
    s.pops++;
    dismissPrompt();
  };

  // A tap: a short press that barely moved. Holding goes through the grab below instead.
  useEffect(() => {
    let down: { x: number; y: number; t: number; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || e.pointerId !== down.id) return;
      const quick = performance.now() - down.t < HOLD && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8;
      down = null;
      if (!quick || !group.current) return;
      const rect = dom.getBoundingClientRect();
      scratch.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      const at = hitGum(scratch.caster.ray, group.current, new THREE.Vector3());
      if (at) pop(at);
    };
    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    return () => {
      dom.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
    };
  });

  useGrabbable({
    holdToGrab: HOLD,
    pick: (ray) => {
      if (!group.current || (state.phase !== "whole" && state.phase !== "growing")) return null;
      const at = hitGum(ray, group.current, new THREE.Vector3());
      if (!at) return null;
      const world = at.clone().applyMatrix4(group.current.matrixWorld);
      return { distance: ray.origin.distanceTo(world), point: world };
    },
    grab: (point) => {
      if (!group.current) return;
      state.press = { local: point.clone().applyMatrix4(scratch.inv.copy(group.current.matrixWorld).invert()) };
      state.nextCreak = state.now + 0.05;
      dismissPrompt();
    },
    drag: () => {},
    release: () => {
      state.press = null;
    }
  });

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __gum: { state, pop, camera, group, echo, shreds } });

  useFrame((_, raw) => {
    const dt = Number.isFinite(raw) ? Math.min(raw, 1 / 20) : 1 / 60;
    const s = state;
    s.now += dt;
    const g = group.current;
    if (!g) return;
    const since = s.now - s.poppedAt;
    // The first moments after the snap run slowed, like high-speed footage.
    const slow = s.phase === "tearing" || since < 2 ? 0.28 + 0.72 * THREE.MathUtils.smoothstep(since, 0.7, 2) : 1;
    echo.age.value = since;

    // Blowing: bigger, thinner, wobblier, creaking; past the most it can take, it goes.
    const blowing = !!s.press && (s.phase === "whole" || s.phase === "growing");
    if (blowing && s.phase === "growing") s.phase = "whole";
    s.pump += ((blowing ? 1 : 0) - s.pump) * (1 - Math.exp(-dt * 6));
    if (blowing) {
      s.size += dt * 0.32 * (0.6 + s.size * 0.5);
      if (s.now > s.nextCreak) {
        creak(THREE.MathUtils.clamp((s.size - REBORN) / (MOST - REBORN), 0, 1));
        s.nextCreak = s.now + 0.22 + Math.random() * 0.35;
        s.kick = 1;
      }
      if (s.size >= MOST) pop(s.press!.local.clone());
    }
    s.kick *= Math.exp(-dt * 6);

    if (s.phase === "tearing") {
      s.tear += dt * slow * TEAR * (0.5 + Math.min(s.tear, 1.5));
      if (s.tear > ALL_GONE) s.phase = "gone";
    }
    if (s.phase === "gone" && since > AGAIN) {
      s.phase = "growing";
      s.size = 0.02;
      s.tear = -1;
      blow();
    }
    if (s.phase === "growing") {
      const k = THREE.MathUtils.clamp((since - AGAIN) / GROW, 0, 1);
      s.size = 0.02 + (REBORN - 0.02) * easeBack(k);
      if (k >= 1) s.phase = "whole";
    }

    gum.clock.value += dt * (1 + s.pump * 2.5);
    gum.wobble.value = 0.01 + s.pump * 0.012 + s.kick * 0.02;
    gum.puff.value = Math.max(0, s.size - 1) * 0.05;
    gum.thin.value = THREE.MathUtils.clamp((s.size - 0.2) / 1.35, 0, 1);
    gum.tear.value = s.tear;
    g.visible = s.phase !== "gone";
    g.scale.setScalar(s.size * (1 + s.kick * 0.012));
    g.position.y = Math.sin(s.now * 0.7) * 0.05;
    g.rotation.y = Math.sin(s.now * 0.31) * 0.06;
    g.rotation.z = Math.sin(s.now * 0.43) * 0.02;
    g.updateMatrixWorld();

    stepShreds(shreds, dt * slow, s.phase === "tearing" ? s.tear : s.phase === "gone" ? 99 : -1, g, s.tearLocal, () => {});
    drawShreds(shreds);

    if (!s.earned && s.pops >= 1 && since > 2) {
      s.earned = true;
      followPrompt.earn("gum");
      shareResult.set("Popped the AI bubble and heard it echo round the hall");
    }
  });

  return (
    <>
      <hemisphereLight color="#fffdfa" groundColor="#d6cdc6" intensity={1.35} />
      <spotLight position={[0.6, ROOM.ceiling + 1.2, 0.4]} angle={0.66} penumbra={0.9} decay={0} intensity={2.1} color="#fffaf2" castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-radius={6} />
      <directionalLight position={[3, 8, 5]} intensity={0.3} color="#fff6ee" />
      <Room mirrorScale={startTier === "low" ? 0.25 : startTier === "medium" ? 0.35 : 0.5} />
      <Gum geometry={geometry} group={group} />
      <primitive object={shreds.mesh} />
      {typeof window !== "undefined" && window.location.search.includes("noair") ? null : <Air count={startTier === "low" ? 400 : 900} />}
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.4, 0.15, 6.4],
    target: [0, 0, 0],
    fov: 42,
    limits: { turn: { left: 75, right: 75, up: 32, down: 28 }, move: { left: 0.4, right: 0.4, down: 0.4, up: 0.4, nearer: 1.6, further: 0.9 } },
    phone: { position: [0.2, 0.1, 6.6], target: [0, 0, 0], fov: 66 }
  },
  hover: true,
  extents: { centre: [0, 1, 0], radius: 14, color: "#f4f2ee" },
  look: { background: "#000000", exposure: 1.05, bloom: 0.25, bloomThreshold: 1.4, gi: 0, ao: 0.45, aoRadius: 0.35, vignette: 0.24, grain: 0.014, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, ...(typeof window !== "undefined" && window.location.search.includes("noocc") ? { occlusion: false as const } : {}) },
  prompt: { title: "Tap the AI bubble", detail: "Hold to blow it bigger", high: true },
  hint: "Tap the gum to pop it; hold to blow it bigger. Drag to look round.",
  notes: "The AI bubble, blown in bubblegum, pops in a tiled hall: the snap races round the tiles and comes back, again and again.",
  overview: [
    {
      title: "Gum",
      points: ["The letters as a distance field of round strokes, meshed at load by surface nets", "The tear is a ragged front in the shader; shreds fly, tumble and splat onto the tiles"]
    },
    {
      title: "Echo",
      points: ["The snap's front runs out, meets the wall and comes back every 0.56 s, lighting the tiles it passes", "Each return is heard again, weaker and duller, over a convolution reverb of a tiled room"]
    }
  ],
  Scene
};

export default day;
