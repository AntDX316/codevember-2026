"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useDispose } from "../../shared/engine/dispose";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt, resetPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingAction, useSettingsStore } from "../../shared/engine/settings";
import { sound, useBed, useEvery } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { blockMaterial, CENTRE, HALF, KEY_DIR, u } from "./block";
import { FigureView, makeFigures, MAX_TREES } from "./figure";
import { createGrower, SEGMENT_FLOATS, type GrowResult } from "./grow";
import { Air, Backdrop, Floor, Spark } from "./set";
import { charging, crack, crackle, ring, settle } from "./sounds";

// Captured lightning: a flawless block of clear acrylic, and a charge fired into it wherever it is pressed. A
// Lichtenberg figure (the branching fracture left when the charge in the plastic breaks down) runs through it in a
// fraction of a second, glowing, then cools to a frozen feathered tree you can turn in the light.

// The glow: the colour a figure burns as it runs, and the light it is shown in once it cools.
const GLOWS: Record<string, { hot: string; frozen: string; under: number; label: string; swatch: string }> = {
  blue: { hot: "#7fb8ff", frozen: "#e2ecf8", under: 0.45, label: "Blue", swatch: "#5aa2ff" },
  clear: { hot: "#cfe0ff", frozen: "#f2f4f8", under: 0, label: "Clear", swatch: "#e8eef6" },
  violet: { hot: "#b18cff", frozen: "#efe8ff", under: 0.5, label: "Violet", swatch: "#a77bff" },
  amber: { hot: "#ffae66", frozen: "#fff1e2", under: 0.45, label: "Amber", swatch: "#ffa04d" }
};

// The lattice the discharge grows on, 60 cells across the block; the fronds are finer.
const CELL = (HALF.x * 2) / 60;
// How many cells a full charge grows, by tier; a tap uses part of it, a held press up to all.
const SITES = { high: 2800, medium: 2400, low: 2000 } as const;
const CAPACITY = { high: 200000, medium: 150000, low: 60000 } as const;
// Seconds a figure takes to run through the block at full charge, at speed and in slow motion.
const GROW = 0.8;
const SLOW = 7;

type Tree = { slot: number; start: number; count: number; born: number; duration: number; cut: number; scale: number; centre: THREE.Vector3; rung: boolean };
type Press = { id: number; x: number; y: number; at: number; job: number; point: THREE.Vector3; normal: THREE.Vector3; moved: boolean; stopHum: (() => void) | null };

const scratch = {
  ray: new THREE.Ray(),
  local: new THREE.Ray(),
  ndc: new THREE.Vector2(),
  caster: new THREE.Raycaster(),
  v: new THREE.Vector3(),
  w: new THREE.Vector3()
};

// Where a ray first meets the block, in the block's own space: the point and the face's outward normal.
function hitBlock(ray: THREE.Ray, toLocal: THREE.Matrix4) {
  const local = scratch.local.copy(ray).applyMatrix4(toLocal);
  const o = local.origin;
  const d = local.direction;
  let near = -Infinity;
  let far = Infinity;
  let axis = 0;
  for (let a = 0; a < 3; a++) {
    const h = HALF.getComponent(a);
    const oa = o.getComponent(a);
    const da = d.getComponent(a) || 1e-9;
    const t1 = (-h - oa) / da;
    const t2 = (h - oa) / da;
    const lo = Math.min(t1, t2);
    if (lo > near) {
      near = lo;
      axis = a;
    }
    far = Math.min(far, Math.max(t1, t2));
  }
  if (near > far || near < 0) return null;
  const point = o.clone().addScaledVector(d, near);
  const normal = new THREE.Vector3().setComponent(axis, Math.sign(point.getComponent(axis)));
  return { point, normal };
}

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const glow = useSetting<string>("glow");
  const slow = useSetting<boolean>("slow");

  const figures = useMemo(() => makeFigures(CAPACITY[startTier]), [startTier]);
  const shadow = useMemo(() => new THREE.RenderTarget(startTier === "low" ? 512 : 1024, startTier === "low" ? 512 : 1024, { type: THREE.HalfFloatType, depthBuffer: false }), [startTier]);
  // The block, and (not on phones) its reflection in the floor: the same box turned over, shaded from the mirrored eye.
  const reflect = startTier !== "low";
  const block = useMemo(() => ({ material: blockMaterial(startTier === "low"), mirror: blockMaterial(true, true), geometry: new THREE.BoxGeometry(HALF.x * 2, HALF.y * 2, HALF.z * 2) }), [startTier]);
  useDispose(figures.geometry, shadow, block.material, block.mirror, block.geometry);
  const group = useRef<THREE.Group>(null);
  const mirror = useRef<THREE.Group>(null);

  const state = useRef({
    seconds: 0,
    trees: [] as Tree[],
    cursor: 1,
    slot: 0,
    job: 0,
    results: new Map<number, GrowResult>(),
    // A press released, waiting for its figure from the worker.
    waiting: null as null | { job: number; cut: number; point: THREE.Vector3; normal: THREE.Vector3 },
    press: null as Press | null,
    spin: 0,
    sway: 0,
    toLocal: new THREE.Matrix4(),
    fired: 0,
    earned: false,
    spark: 0,
    sparkAt: new THREE.Vector3()
  });

  const store = useSettingsStore();
  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __lb: state, __lbFigures: figures, __lbU: u, __lbStore: store });

  // The worker that grows figures, warmed with a small one at load so the first real strike is quick. Made in the
  // effect, not a memo: React's development double mount would otherwise end the worker the memo keeps.
  const growerRef = useRef<Worker | null>(null);
  useEffect(() => {
    const grower = createGrower([HALF.x, HALF.y, HALF.z], CELL);
    if (!grower) return;
    growerRef.current = grower;
    const s = state.current;
    grower.onmessage = (event: MessageEvent) => {
      const m = event.data as GrowResult;
      if (m.type === "tree") s.results.set(m.job, m);
    };
    grower.onerror = (event) => console.error("Lichtenberg grower:", event.message);
    grower.postMessage({ type: "grow", job: -1, root: [0, 0, HALF.z], normal: [0, 0, 1], sites: 300, seed: 1, layer: 0.25, reach: 0.5 });
    return () => {
      grower.terminate();
      growerRef.current = null;
    };
  }, []);

  // Lay a grown figure into the buffer and start it running.
  const fire = (result: GrowResult, cut: number, point: THREE.Vector3) => {
    const s = state.current;
    const count = result.count;
    if (count === 0) return;
    if (s.cursor + count > figures.capacity) s.cursor = 1;
    const start = s.cursor;
    const slot = s.slot;
    s.slot = (s.slot + 1) % MAX_TREES;
    // Whatever was in this stretch of the buffer, or held this slot, is gone.
    s.trees = s.trees.filter((t) => {
      const overlaps = t.start < start + count && start < t.start + t.count;
      if (!overlaps && t.slot !== slot) return true;
      for (let i = t.start; i < t.start + t.count; i++) figures.array[i * SEGMENT_FLOATS + 8] = 9;
      figures.buffer.addUpdateRange(t.start * SEGMENT_FLOATS, t.count * SEGMENT_FLOATS);
      return false;
    });
    const seg = result.segments;
    const centre = new THREE.Vector3();
    let weight = 0;
    for (let i = 0; i < count; i++) {
      const o = i * SEGMENT_FLOATS;
      seg[o + 11] = slot;
      if (seg[o + 8] <= cut) {
        centre.x += seg[o + 4];
        centre.y += seg[o + 5];
        centre.z += seg[o + 6];
        weight++;
      }
    }
    centre.divideScalar(Math.max(1, weight));
    figures.array.set(seg.subarray(0, count * SEGMENT_FLOATS), start * SEGMENT_FLOATS);
    figures.buffer.addUpdateRange(start * SEGMENT_FLOATS, count * SEGMENT_FLOATS);
    figures.buffer.needsUpdate = true;
    s.cursor = start + count;
    figures.used = Math.max(figures.used, s.cursor);
    figures.geometry.instanceCount = figures.used;
    const scale = slow ? SLOW / GROW : 1;
    const duration = GROW * (0.55 + 0.45 * cut) * scale;
    figures.trees.array[slot].set(s.seconds, duration, cut, scale);
    s.trees.push({ slot, start, count, born: s.seconds, duration, cut, scale, centre, rung: false });
    s.fired++;
    // The strike point flashes.
    s.sparkAt.copy(point).applyMatrix4(group.current?.matrixWorld ?? new THREE.Matrix4());
    s.spark = 1.4 + cut;
    crack(cut);
    crackle(duration, cut);
    dismissPrompt();
    if (!s.earned && s.fired >= 3) {
      s.earned = true;
      followPrompt.earn("lichtenberg");
      shareResult.set("Just captured lightning in a block of acrylic");
    }
  };

  // Presses: one held still on the block fires a charge when let go (held longer, a bigger one); one that moves turns
  // the view instead, and fires nothing.
  useEffect(() => {
    const el = gl.domElement;
    const s = state.current;
    const ndcOf = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      return scratch.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    };
    const cancel = () => {
      if (!s.press) return;
      s.press.stopHum?.();
      s.press = null;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (s.press) {
        // A second finger: a pinch, not a strike.
        cancel();
        return;
      }
      scratch.caster.setFromCamera(ndcOf(e), camera);
      const hit = hitBlock(scratch.caster.ray, s.toLocal);
      const grower = growerRef.current;
      if (!hit || !grower) return;
      const job = ++s.job;
      // Grown now, while the press is held, so it is ready when let go.
      const request = {
        type: "grow",
        job,
        root: hit.point.toArray(),
        normal: hit.normal.toArray(),
        sites: SITES[startTier],
        seed: (Math.random() * 1e9) | 0,
        layer: 0.16 + Math.random() * 0.22,
        reach: 0.55 + Math.random() * 0.12
      };
      grower.postMessage(request);
      s.press = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now(), job, point: hit.point, normal: hit.normal, moved: false, stopHum: null };
    };
    const move = (e: PointerEvent) => {
      const p = s.press;
      if (!p || p.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > (e.pointerType === "mouse" ? 6 : 12)) cancel();
    };
    const up = (e: PointerEvent) => {
      const p = s.press;
      if (!p || p.id !== e.pointerId) return;
      s.press = null;
      p.stopHum?.();
      const held = (performance.now() - p.at) / 1000;
      // A tap reaches most of the way; held, the charge builds to all of it over a second and a half.
      const cut = Math.min(1, 0.72 + Math.max(0, held - 0.2) * 0.22);
      s.waiting = { job: p.job, cut, point: p.point, normal: p.normal };
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- made once for the canvas.
  }, [gl, camera]);

  useSettingAction("reset", () => {
    const s = state.current;
    // Nothing past the first (hidden) strip is drawn any more, and new figures write over the old from the start, so
    // the buffer itself need not be touched.
    figures.used = 1;
    figures.geometry.instanceCount = 1;
    s.trees = [];
    s.cursor = 1;
    s.fired = 0;
    growerRef.current?.postMessage({ type: "reset" });
    resetPrompt();
    sound.play("whoosh", { gain: 0.25, pitch: 1.5 });
  });

  // Sound: only the air, and now and then the block settling; everything else follows the strikes.
  useBed("breeze", 0.018);
  useEvery(3, 9, () => {
    if (state.current.trees.length) settle();
  });

  const colours = useMemo(() => ({ hot: new THREE.Color(), frozen: new THREE.Color() }), []);
  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 20);
    const s = state.current;
    s.seconds += delta;
    u.clock.value = s.seconds;
    u.minWidth.value = tier === "low" ? 2.6 : 1.5;

    // The glow colour eases to the one chosen.
    const g = GLOWS[glow] ?? GLOWS.blue;
    const ease = 1 - Math.exp(-delta * 6);
    (u.hotColour.value as THREE.Color).lerp(colours.hot.set(g.hot), ease);
    (u.frozenColour.value as THREE.Color).lerp(colours.frozen.set(g.frozen), ease);
    u.under.value += (g.under - u.under.value) * ease;

    // The block turns slowly while left alone, and holds still under a press.
    const block = group.current;
    if (!block) return;
    s.spin += ((s.press ? 0 : 1) - s.spin) * (1 - Math.exp(-delta * 2));
    s.sway += delta * s.spin;
    block.rotation.y = -0.34 + Math.sin(s.sway * 0.11) * 0.28;
    block.position.set(CENTRE.x, CENTRE.y + Math.sin(s.seconds * 0.5) * 0.015, CENTRE.z);
    block.updateMatrixWorld();
    (u.toWorld.value as THREE.Matrix4).copy(block.matrixWorld);
    s.toLocal.copy(block.matrixWorld).invert();
    (u.toLocal.value as THREE.Matrix4).copy(s.toLocal);
    (u.eye.value as THREE.Vector3).copy(camera.position).applyMatrix4(s.toLocal);
    (u.eyeMirror.value as THREE.Vector3).set(camera.position.x, -camera.position.y, camera.position.z).applyMatrix4(s.toLocal);
    if (mirror.current) {
      mirror.current.matrix.makeScale(1, -1, 1).multiply(block.matrixWorld);
      mirror.current.matrixWorldNeedsUpdate = true;
    }
    (u.keyLocal.value as THREE.Vector3).copy(KEY_DIR).negate().transformDirection(s.toLocal);

    // A press held still builds a charge: a star at the point that swells, and a hum.
    const p = s.press;
    if (p) {
      const held = (performance.now() - p.at) / 1000;
      if (held > 0.22 && !p.stopHum) p.stopHum = charging();
      s.sparkAt.copy(p.point).applyMatrix4(block.matrixWorld);
      s.spark = Math.max(s.spark, Math.min(1, Math.max(0, held - 0.15) * 0.8) * (0.85 + Math.random() * 0.3));
    }
    // A released press fires once its figure has grown.
    if (s.waiting) {
      const result = s.results.get(s.waiting.job);
      if (result) {
        fire(result, s.waiting.cut, s.waiting.point);
        growerRef.current?.postMessage({ type: "commit", job: s.waiting.job, fraction: s.waiting.cut });
        s.results.clear();
        s.waiting = null;
      }
    }
    s.spark *= Math.exp(-delta * (p ? 2 : 7));
    (u.spark.value as THREE.Vector4).set(s.sparkAt.x, s.sparkAt.y, s.sparkAt.z, s.spark);

    // The figures still hot light the block, the floor and the air: the four newest, by heat.
    const hot = u.hot.array as THREE.Vector4[];
    for (let i = 0; i < 4; i++) {
      const t = s.trees[s.trees.length - 1 - i];
      if (!t) {
        hot[i].set(0, -10, 0, 0);
        continue;
      }
      const growth = (s.seconds - t.born) / t.duration;
      const after = (s.seconds - t.born - t.duration) / t.scale;
      const heat = growth < 1 ? 0.6 + 0.9 * growth : 2.6 * Math.exp(-after / 0.2) + 0.7 * Math.exp(-after / 0.8);
      scratch.v.copy(t.centre).applyMatrix4(block.matrixWorld);
      hot[i].set(scratch.v.x, scratch.v.y, scratch.v.z, heat * (0.5 + t.cut * 0.6));
      // The block rings as each figure completes.
      if (!t.rung && growth >= 1) {
        t.rung = true;
        ring(t.cut);
      }
    }

    // The lens holds the block.
    focusDistance.value = camera.position.distanceTo(CENTRE);
    focusBlur.value = 0.5;
  }, -1);

  return (
    <>
      <Backdrop />
      <Floor shadow={shadow} glossy={reflect} />
      <group ref={group} position={[CENTRE.x, CENTRE.y, CENTRE.z]}>
        <mesh geometry={block.geometry} material={block.material} />
      </group>
      {reflect ? (
        <group ref={mirror} matrixAutoUpdate={false}>
          <mesh geometry={block.geometry} material={block.mirror} />
        </group>
      ) : null}
      <FigureView figures={figures} mirrors={startTier !== "low"} reflect={reflect} target={shadow} />
      <Spark />
      <Air dust={startTier === "low" ? 700 : 1800} />
    </>
  );
}

// This module only ever loads in the browser, so the screen can be asked here.
const PHONE = typeof window !== "undefined" && window.matchMedia("(max-width: 900px), (hover: none)").matches;

const day: DayDefinition = {
  camera: {
    position: [0, 1.8, 4.08],
    target: [0, 1.02, 0],
    fov: 34,
    limits: { turn: { left: 70, right: 70, up: 30, down: 22 }, move: 0.4 },
    phone: { position: [0, 2.05, 5.88], target: [0, 0.82, 0], fov: 44 }
  },
  hover: true,
  extents: { centre: [0, 1, 0], radius: 8, floor: 0.25, color: "#cfe0ff" },
  // Black behind: the overlay pass (the figures, the shaft, the motes) is added over the whole frame.
  look: { background: "#000000", exposure: 1.15, bloom: 0.45, bloomThreshold: 1.0, gi: 0, ao: 0.5, aoRadius: 0.25, vignette: 0.62, grain: 0.012, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, depthOfField: { range: 3.5 } },
  settings: {
    glow: { type: "choice", label: "Glow", value: "blue", options: Object.entries(GLOWS).map(([value, g]) => ({ value, label: g.label, swatch: [g.swatch] })) },
    slow: { type: "toggle", label: "Slow motion", value: false },
    reset: { type: "action", label: "Reset" }
  },
  phoneDock: ["glow"],
  phoneDockPills: ["slow", "reset"],
  prompt: { title: "Tap the block to fire a charge into it", detail: "Hold to build a bigger one", ...(PHONE ? { low: true } : { high: true }) },
  hint: "Click or tap the block to fire a charge in; hold before letting go for a bigger one. Each figure threads between the ones already there. Drag anywhere to turn it in the light.",
  notes: "Captured lightning: a charge fired into clear acrylic breaks down into a Lichtenberg figure, frozen in the block.",
  overview: [
    {
      title: "Discharge",
      points: [
        "The dielectric breakdown model on a 60³ lattice in a Web Worker: the next cell is picked by potential², so exposed tips win and branch.",
        "Potential is Kim and Lin's closed form, one pass a step; the charge lies in a layer under the struck face, and old figures are closed off."
      ]
    },
    {
      title: "Acrylic",
      points: [
        "The block is traced per pixel: bent in at Snell's law, three bounces inside (total reflection past 42°), out to hand-shaded soft boxes.",
        "Each fracture is placed where it appears through the face by Newton steps on Snell's law, plus its mirror in every side face."
      ]
    },
    {
      title: "Light",
      points: [
        "Strips glow as the leader passes, flash, then cool to fine silver facets that glint as the block turns.",
        "The figures' shadows are bent through the block onto a floor map each frame; a hot figure lights the block, floor and dust."
      ]
    }
  ],
  Scene
};

export default day;
