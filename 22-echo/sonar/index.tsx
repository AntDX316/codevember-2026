"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { cameraTaken, orbitPoint } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSettingRef } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { AMP, BOUNCES, Bubble, front, Ghost, Motes, Room, ROUND, Shell, Spray, TEAR_SPEED, TINT, u, useFilm } from "./render";
import { buildRoom } from "./room";
import { buildShape, march, scatter } from "./shape";
import { breath, creak, pop } from "./sound";

// The furthest the tear has to run; how long after the pop a new bubble starts to blow, and how long it takes.
const ACROSS = 4;
const REBORN = 5.2;
const GROW = 7;
// A press shorter than this that hardly moved is a tap: it pops. Held still longer, it pumps.
const TAP_MS = 260;
const STILL_PX = 7;

const scratch = { ray: new THREE.Ray(), inverse: new THREE.Matrix4(), hit: new THREE.Vector3(), pull: new THREE.Vector3(), pointer: new THREE.Vector2(), caster: new THREE.Raycaster() };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const linger = useSettingRef<number>("linger");
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const letters = useMemo(() => buildShape(startTier === "low" ? 0.02 : 0.014), [startTier]);
  const room = useMemo(() => buildRoom(), []);
  const sprayCount = startTier === "low" ? 1800 : 5000;
  const spray = useMemo(() => scatter(letters, sprayCount, 77), [letters, sprayCount]);
  useDispose(letters, room);
  const table = useFilm();
  const bubble = useRef<THREE.Group>(null);
  const ghost = useRef<THREE.Group>(null);

  const state = useMemo(
    () => ({
      now: 0,
      // whole: floating; torn: tearing and gone; growing: a new one blowing.
      phase: "whole" as "whole" | "torn" | "growing",
      poppedAt: -100,
      grow: 1,
      pump: 0,
      press: null as null | { x: number; y: number; at: number; moved: boolean },
      pumping: false,
      pops: 0,
      earned: false,
      voice: null as null | ReturnType<typeof creak>
    }),
    []
  );

  // Pops it at a pointer's place: where the ray meets the letters, or the nearest the ray comes to their middle.
  const burst = (clientX: number, clientY: number) => {
    const s = state;
    const g = bubble.current;
    if (!g || s.phase === "torn" || (s.phase === "growing" && s.grow < 0.3)) return;
    const rect = gl.domElement.getBoundingClientRect();
    scratch.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    scratch.caster.setFromCamera(scratch.pointer, camera);
    g.updateMatrixWorld();
    scratch.inverse.copy(g.matrixWorld).invert();
    scratch.ray.copy(scratch.caster.ray).applyMatrix4(scratch.inverse);
    scratch.ray.direction.normalize();
    if (march(scratch.ray.origin, scratch.ray.direction, scratch.hit) === null) scratch.ray.closestPointToPoint(new THREE.Vector3(), scratch.hit);
    u.tearAt.value.copy(scratch.hit);
    u.tear.value = 0;
    u.age.value = 0;
    u.strength.value = 1 + s.pump * 0.9;
    if (ghost.current) {
      ghost.current.matrix.copy(g.matrixWorld);
      ghost.current.matrixWorldNeedsUpdate = true;
    }
    const pan = THREE.MathUtils.clamp(scratch.pointer.x, -1, 1);
    pop(ROUND, AMP.slice(0, BOUNCES + 1), pan, u.strength.value);
    s.phase = "torn";
    s.poppedAt = s.now;
    s.pump = 0;
    s.pops++;
    dismissPrompt();
  };

  useEffect(() => {
    const dom = gl.domElement;
    const down = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      state.press = { x: event.clientX, y: event.clientY, at: performance.now(), moved: false };
    };
    const move = (event: PointerEvent) => {
      const p = state.press;
      if (p && Math.hypot(event.clientX - p.x, event.clientY - p.y) > STILL_PX) p.moved = true;
    };
    const up = (event: PointerEvent) => {
      const p = state.press;
      state.press = null;
      if (!p || p.moved || state.pumping) return;
      if (performance.now() - p.at < TAP_MS) burst(event.clientX, event.clientY);
    };
    const cancel = () => {
      state.press = null;
    };
    dom.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      dom.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      state.voice?.stop();
      state.voice = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- burst reads only refs and module state.
  }, [gl, state]);

  useFrame((_, raw) => {
    const dt = Number.isFinite(raw) ? Math.min(raw, 1 / 20) : 1 / 60;
    const s = state;
    s.now += dt;
    const now = s.now;
    u.clock.value = now;
    u.linger.value = linger.current ?? 1.2;

    // Pumping: a press held still on a whole bubble.
    const held = !!s.press && !s.press.moved && performance.now() - s.press.at > TAP_MS && s.phase === "whole";
    if (held && !s.pumping) {
      s.pumping = true;
      s.voice = creak();
    }
    if (!held && s.pumping) {
      s.pumping = false;
      s.voice?.stop();
      s.voice = null;
    }
    s.pump = held ? Math.min(1, s.pump + dt * 0.42 * (1.1 - s.pump)) : Math.max(0, s.pump - dt * 0.22);
    s.voice?.set(0.35 + s.pump * 0.65);
    if (s.pump > 0.05) dismissPrompt();

    // The pop's life: the tear runs, the room rings, and after a while a new bubble blows.
    const since = now - s.poppedAt;
    if (s.phase === "torn") {
      u.tear.value = since;
      if (since > REBORN) {
        s.phase = "growing";
        s.grow = 0;
        u.tear.value = -1;
        breath();
      }
    }
    if (s.phase === "growing") {
      s.grow = Math.min(1, s.grow + dt / GROW);
      if (s.grow >= 1) s.phase = "whole";
    }
    u.age.value = s.poppedAt < -50 ? 1000 : since;

    const g = bubble.current;
    if (g && s.phase !== "torn") {
      const grown = 1 - Math.pow(1 - s.grow, 3);
      const jitter = s.pumping ? Math.sin(now * 31) * 0.006 * s.pump : 0;
      g.scale.setScalar(Math.max(0.03, grown * (1 + s.pump * 0.22 + jitter)));
      g.position.set(0, Math.sin(now * 0.55) * 0.07, 0);
      g.rotation.set(Math.sin(now * 0.31) * 0.03, Math.sin(now * 0.23) * 0.09, Math.sin(now * 0.41) * 0.02);
    }
    const whole = s.phase === "torn" ? Math.max(0, 1 - since / (ACROSS / TEAR_SPEED)) : Math.pow(s.grow, 1.5);
    u.glow.value = whole * (1 + s.pump * 2.6) * (0.9 + Math.sin(now * 1.3) * 0.1);
    u.wobble.value = 0.35 + s.pump * 1.6;

    // The ghost: flashed each time the wave comes home, lingering faintly between, gone as the new bubble grows.
    let level = 0;
    let latest = 1;
    if (s.poppedAt > -50) {
      for (let k = 1; k <= BOUNCES; k++) {
        const t = since - k * ROUND;
        const a = AMP[Math.min(k, AMP.length - 1)];
        level += a * (t < 0 ? Math.exp(-((t / 0.05) ** 2)) : Math.exp(-t / 0.5) * 0.85 + 0.15 * Math.exp(-t / 4));
        if (t > -0.05) latest = k;
      }
      level *= s.phase === "growing" ? Math.max(0, 1 - s.grow * 3) : s.phase === "whole" ? 0 : 1;
    }
    u.ghost.value = level * u.strength.value;
    u.ghostTint.value.copy(TINT[Math.min(latest, TINT.length - 1)]);
    if (ghost.current) ghost.current.visible = level > 0.002;

    const f = front(since);
    if (f && s.poppedAt > -50) {
      u.shell.value = Math.max(f.radius, 0.01);
      u.shellLevel.value = f.level * u.strength.value * THREE.MathUtils.smoothstep(f.radius, 0.2, 1.2);
      u.shellTint.value.copy(TINT[f.e]);
    } else u.shellLevel.value = 0;

    if (!s.earned && s.pops >= 1 && since > ROUND * 2) {
      s.earned = true;
      followPrompt.earn("pop");
      shareResult.set("Popped the AI bubble in an echo chamber and watched its echo draw the room");
    }

    // A study of one thing: the orbit point is drawn gently back to the middle, the eye carried with it.
    const at = orbitPoint.current;
    if (at && !cameraTaken.current) {
      scratch.pull.copy(at).multiplyScalar(-(1 - Math.exp(-dt * 0.8)));
      at.add(scratch.pull);
      camera.position.add(scratch.pull);
    }
  });

  return (
    <>
      <Room geometry={room} />
      <group ref={bubble}>
        <Bubble geometry={letters} table={table} />
        <Spray points={spray} count={sprayCount} table={table} />
      </group>
      <group ref={ghost} matrixAutoUpdate={false} visible={false}>
        <Ghost geometry={letters} />
      </group>
      <Shell />
      <Motes count={startTier === "low" ? 700 : 1800} />
    </>
  );
}

// On a phone the prompt sits up under the bar, clear of the letters.
function Overlay() {
  return <style>{`@media (max-width: 720px) { .cv-prompt.cv-prompt-high { place-content: start center; padding: calc(max(16px, env(safe-area-inset-top)) + 60px) 20px 0; } .cv-prompt.cv-prompt-high p { font-size: 34px; } }`}</style>;
}

const day: DayDefinition = {
  camera: {
    position: [0.9, 0.35, 6.4],
    target: [0, 0.1, 0],
    fov: 40,
    limits: { turn: { left: 75, right: 75, up: 35, down: 25 }, move: { left: 0.4, right: 0.4, down: 0.4, up: 0.4, nearer: 2.2, further: 1.2 } },
    phone: { position: [0.3, 0.25, 7.4], target: [0, 0.1, 0], fov: 58 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 9, color: "#9fd8ff" },
  look: { background: "#000000", exposure: 1, bloom: 0.6, bloomThreshold: 0.55, gi: 0, ao: 0, vignette: 0.5, grain: 0.018, haze: 0 },
  passes: { bounce: false, haze: false, occlusion: false, temporal: false },
  settings: {
    linger: { type: "range", label: "Afterglow", min: 0.4, max: 3, step: 0.05, value: 1.2, reset: 1.2 }
  },
  prompt: { title: "Tap to pop the bubble", detail: "Hold to pump it up", high: true },
  Overlay,
  hint: "Tap to pop the AI bubble; hold to pump it first. Drag to look round the chamber.",
  notes: "The AI bubble in a pitch-dark echo chamber. When it pops, the only way to see the room is by its echo.",
  overview: [
    {
      title: "Echo",
      points: [
        "The pop's wavefront is slowed down to be seen: it runs out, comes home off the walls every 0.6 s, weaker and cooler each time",
        "Wherever it touches the concrete it draws scan lines: contour rings on the first pass, dots on the echoes, fading as they go"
      ]
    },
    {
      title: "Bubble",
      points: [
        "Puffy letters from a signed distance field, meshed at load by surface nets",
        "Real thin-film interference colours; the tear races out from the tapped point, throwing droplets"
      ]
    }
  ],
  Scene
};

export default day;
