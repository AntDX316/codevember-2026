"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { cameraTaken, orbitPoint, useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { scenePhase, useQuality } from "../../shared/engine/quality";
import { useSettingRef } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Backdrop, Bubble, Crumbs, DELAY, Dust, ECHOES, Ghosts, Spray, SPEED, u, useFilm } from "./render";
import { buildShape, march, scatter } from "./shape";
import { creak, pop } from "./sound";

// The furthest the tear has to run, and how long after the burst a new bubble starts to blow, and how long it takes.
const ACROSS = 3.9;
const REBORN = 3.4;
const GROW = 5.5;
// A press shorter than this, that hardly moved, is a tap: it pops. Held still longer, it pumps.
const TAP_MS = 230;
const PUMP_MS = 250;

// The valuation in the corner: climbs slowly, quickly while pumped, and crashes when it pops.
const ticker = { el: null as HTMLSpanElement | null, arrow: null as HTMLSpanElement | null, shown: "" };

const scratch = { ray: new THREE.Ray(), inverse: new THREE.Matrix4(), hit: new THREE.Vector3(), pull: new THREE.Vector3(), pointer: new THREE.Vector2(), caster: new THREE.Raycaster() };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const vivid = useSettingRef<number>("vivid");
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const geometry = useMemo(() => buildShape(startTier === "low" ? 0.018 : 0.013), [startTier]);
  const spray = useMemo(() => ({ ...scatter(geometry, startTier === "low" ? 1500 : 4000, 77), count: startTier === "low" ? 1500 : 4000 }), [geometry, startTier]);
  const crumbs = useMemo(() => ({ ...scatter(geometry, startTier === "low" ? 4000 : 12000, 131), count: startTier === "low" ? 4000 : 12000 }), [geometry, startTier]);
  useDispose(geometry);
  const table = useFilm();
  const group = useRef<THREE.Group>(null);
  const bubble = useRef<THREE.Group>(null);
  const ghosts = useRef<(THREE.Mesh | null)[]>([]);

  const state = useMemo(
    () => ({
      now: 0,
      // whole: floating; torn: the film tearing and gone; growing: a new one blowing.
      phase: "whole" as "whole" | "torn" | "growing",
      poppedAt: -100,
      grow: 1,
      pump: 0,
      pumping: false,
      wobble: 0,
      value: 1.04,
      pops: 0,
      voice: null as null | ReturnType<typeof creak>,
      home: null as null | THREE.Vector3
    }),
    []
  );

  // Where a ray meets the bubble, in world space, and in the bubble's own.
  const hitBubble = (ray: THREE.Ray) => {
    const g = bubble.current;
    if (!g || state.phase === "torn" || state.grow < 0.25) return null;
    scratch.inverse.copy(g.matrixWorld).invert();
    scratch.ray.copy(ray).applyMatrix4(scratch.inverse);
    scratch.ray.direction.normalize();
    if (march(scratch.ray.origin, scratch.ray.direction, scratch.hit) === null) return null;
    const local = scratch.hit.clone();
    const world = local.clone().applyMatrix4(g.matrixWorld);
    return { local, world };
  };

  const burst = (local: THREE.Vector3) => {
    const g = bubble.current!;
    g.updateMatrixWorld();
    u.at.value.copy(local);
    u.frame.value.copy(g.matrixWorld);
    u.centre.value.setFromMatrixPosition(g.matrixWorld);
    state.phase = "torn";
    state.poppedAt = state.now;
    state.pops++;
    pop(DELAY, ECHOES, state.pump);
    dismissPrompt();
    if (state.pops === 1) {
      followPrompt.earn("pop");
      shareResult.set("Popped the AI bubble. It echoed.");
    }
  };

  // Holding still on the bubble pumps it.
  useGrabbable({
    pick: (ray) => {
      const hit = hitBubble(ray);
      return hit ? { distance: ray.origin.distanceTo(hit.world), point: hit.world } : null;
    },
    grab: () => {
      if (state.phase === "torn") return;
      state.pumping = true;
    },
    drag: () => {},
    release: () => {
      state.pumping = false;
    },
    holdToGrab: PUMP_MS
  });

  // A quick tap on the bubble pops it, where it was tapped.
  useEffect(() => {
    const dom = gl.domElement;
    const down = new Map<number, { x: number; y: number; t: number }>();
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      down.set(event.pointerId, { x: event.clientX, y: event.clientY, t: performance.now() });
    };
    const onUp = (event: PointerEvent) => {
      const press = down.get(event.pointerId);
      down.delete(event.pointerId);
      if (!press || performance.now() - press.t > TAP_MS || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) return;
      const rect = dom.getBoundingClientRect();
      scratch.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      scratch.caster.setFromCamera(scratch.pointer, camera);
      const hit = hitBubble(scratch.caster.ray);
      if (hit && state.phase !== "torn") burst(hit.local);
    };
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerup", onUp);
    return () => {
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
    };
  });

  useEffect(
    () => () => {
      state.voice?.stop();
      state.voice = null;
    },
    [state]
  );

  useFrame((_, raw) => {
    const dt = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1 / 20) : 1 / 60;
    const s = state;
    s.now += dt;
    const now = s.now;
    u.clock.value = now;
    u.vivid.value += ((vivid.current ?? 1) - u.vivid.value) * (1 - Math.exp(-dt * 4));

    // The burst and what follows it.
    const since = now - s.poppedAt;
    u.since.value = since < 4 ? since : -1;
    if (s.phase === "torn") {
      u.tear.value = since;
      s.pump = 0;
      if (since > REBORN) {
        s.phase = "growing";
        s.grow = 0;
      }
    } else u.tear.value = -1;
    for (let k = 0; k < ECHOES; k++) (u.echoes.value as THREE.Vector4).setComponent(k, since - (k + 1) * DELAY);
    // The ghosts are drawn behind the loader so they are built before they are needed, then only while they show.
    const ghostsShow = scenePhase.current !== "live" || since < (ECHOES + 1) * DELAY + 2.5;
    for (const mesh of ghosts.current) if (mesh) mesh.visible = ghostsShow;
    if (s.phase === "growing") {
      s.grow = Math.min(1, s.grow + dt / GROW);
      if (s.grow >= 1) s.phase = "whole";
    }

    // Pumping: swells, thins, wobbles, creaks; let go, it slowly settles back.
    const pumping = s.pumping && s.phase !== "torn";
    const before = s.pump;
    if (pumping) s.pump = Math.min(1, s.pump + dt * 0.42 * (1 - s.pump * 0.55));
    else s.pump = Math.max(0, s.pump - dt * 0.05);
    const rate = (s.pump - before) / dt;
    s.wobble += (Math.min(1, Math.abs(rate) * 2.2) - s.wobble) * (1 - Math.exp(-dt * (pumping ? 6 : 1.5)));
    u.pump.value = s.pump;
    u.wobble.value = s.wobble + (s.phase === "growing" ? (1 - s.grow) * 0.8 : 0);
    if (pumping && !s.voice) s.voice = creak();
    if (s.voice) {
      s.voice.set(pumping ? 0.4 + s.wobble : 0, s.pump);
      if (!pumping) {
        s.voice.stop();
        s.voice = null;
      }
    }

    // Float and bob; a new bubble blows up from a speck, overshooting a little as it fills.
    const g = bubble.current;
    if (g) {
      const x = s.grow;
      const blown = s.phase === "growing" ? 0.03 + 0.97 * (1 - Math.pow(1 - x, 3)) * (1 + Math.sin(x * Math.PI) * 0.06) : 1;
      g.scale.setScalar(blown * (1 + s.pump * 0.1));
      g.position.set(Math.sin(now * 0.29) * 0.03, Math.sin(now * 0.71) * 0.05, 0);
      g.rotation.set(Math.sin(now * 0.31) * 0.05, Math.sin(now * 0.23) * 0.12, Math.sin(now * 0.37) * 0.02);
      g.visible = !(s.phase === "torn" && since > ACROSS / SPEED + 0.2);
    }

    // The valuation.
    if (s.phase === "torn") s.value = Math.max(0, s.value * Math.exp(-dt * 7) - dt * 0.05);
    else if (s.phase === "growing") s.value = 0.01 + s.grow * s.grow * 1.03;
    else s.value *= Math.exp(dt * (pumping ? 0.75 * (1 + s.pump * 2) : 0.004));
    if (ticker.el && ticker.arrow) {
      const shown = s.value >= 1000 ? `$${(s.value / 1000).toFixed(2)}Q` : `$${s.value.toFixed(2)}T`;
      if (shown !== ticker.shown) {
        ticker.shown = shown;
        ticker.el.textContent = shown;
        const down = s.phase === "torn";
        ticker.arrow.textContent = down ? "▼" : "▲";
        ticker.arrow.style.color = down ? "#ff6b6b" : "#7ee2a8";
      }
    }

    // A study of one thing: the orbit point is drawn gently back to where it started, the eye carried with it.
    const at = orbitPoint.current;
    if (at && !s.home) s.home = at.clone();
    if (at && s.home && !cameraTaken.current) {
      scratch.pull.copy(s.home).sub(at).multiplyScalar(1 - Math.exp(-dt * 0.8));
      at.add(scratch.pull);
      camera.position.add(scratch.pull);
    }
    u.focus.value = camera.position.length();
  });

  return (
    <>
      <Backdrop />
      <group ref={group}>
        <group ref={bubble}>
          <Bubble geometry={geometry} table={table} />
        </group>
      </group>
      <Ghosts geometry={geometry} table={table} meshes={ghosts} />
      <Spray points={spray} table={table} />
      <Crumbs points={crumbs} />
      <Dust count={startTier === "low" ? 700 : 1800} />
    </>
  );
}

function Ticker() {
  return (
    <div
      className="cv-pop-ticker"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 104,
        transform: "translateX(-50%)",
        pointerEvents: "none",
        padding: "7px 14px",
        borderRadius: 999,
        background: "rgba(14, 14, 16, 0.5)",
        backdropFilter: "blur(10px)",
        color: "rgba(255, 255, 255, 0.82)",
        fontSize: 12,
        letterSpacing: 0.6,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums"
      }}
    >
      <span style={{ opacity: 0.55, marginRight: 10, textTransform: "uppercase", fontSize: 10.5, letterSpacing: 1.4 }}>Valuation</span>
      <span
        ref={(el) => {
          ticker.el = el;
          ticker.shown = "";
        }}
      >
        $1.04T
      </span>
      <span
        ref={(el) => {
          ticker.arrow = el;
        }}
        style={{ marginLeft: 8, color: "#7ee2a8", fontSize: 10 }}
      >
        ▲
      </span>
      <style>{`@media (max-width: 720px) { .cv-pop-ticker { bottom: auto !important; top: 64px; } }`}</style>
    </div>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.6, 0.15, 8.1],
    target: [0, 0, 0],
    fov: 36,
    limits: { turn: { left: 70, right: 70, up: 45, down: 45 }, move: { left: 0.4, right: 0.4, down: 0.4, up: 0.4, nearer: 2.2, further: 2.5 } },
    phone: { position: [0.25, 1.3, 11.2], target: [0, 1.2, 0], fov: 48 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 16, color: "#c8d4ff" },
  look: { background: "#020203", exposure: 1, bloom: 0.5, bloomThreshold: 0.65, gi: 0, ao: 0, vignette: 0.55, grain: 0.016, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false, temporal: false },
  settings: {
    vivid: { type: "range", label: "Film colour", min: 0.4, max: 1.8, step: 0.01, value: 1, reset: 1 }
  },
  prompt: { title: "Pop the bubble", detail: "Hold to pump it first", high: true },
  hint: "Tap the bubble to pop it; hold to pump it up. Drag to turn.",
  notes: "The AI bubble, in soap film. Pump it up, pop it, and listen to the pop echo.",
  overview: [
    {
      title: "Film",
      points: [
        "Puffy letters meshed at load from a smooth distance field by surface nets, every vertex slid onto the true surface",
        "Thin-film interference over the visible spectrum, on a film drained thin at the top and marbled by a slow swirl"
      ]
    },
    {
      title: "Pop",
      points: [
        "A ragged hole races out from the tap in slow motion, its rim shedding thousands of glinting droplets",
        "Each echo of the pop throws a ghost of the shape outward, crumbling into dust, and a shock through the air"
      ]
    }
  ],
  Overlay: Ticker,
  Scene
};

export default day;
