"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../shared/engine/controls";
import { useDispose } from "../shared/engine/dispose";
import { focusBlur, focusDistance } from "../shared/engine/Post";
import { dismissPrompt, resetPrompt } from "../shared/engine/prompt";
import { useQuality } from "../shared/engine/quality";
import { useSetting, useSettingAction, useSettingsStore } from "../shared/engine/settings";
import { sound, useBed, useMusic } from "../shared/engine/sound";
import { KeyLight, StudioEnvironment } from "../shared/engine/studio";
import type { DayDefinition } from "../shared/engine/types";
import { followPrompt } from "../shared/ui/Follow";
import { shareResult } from "../shared/ui/Share";
import { createMorph, SPAN, type Morph } from "./grid";
import { FORMS } from "./form";
import { Air, Ash, Backdrop, KEY, look, Voxels } from "./render";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What has been done to the sculpture so far, as morphology writes it (A ⊖ 6B ⊕ 3B), and how much of it is left.
type Run = { op: "⊖" | "⊕"; n: number };
const record = {
  value: { runs: [] as Run[], left: 1 },
  listeners: new Set<() => void>(),
  set(next: { runs: Run[]; left: number }) {
    this.value = next;
    this.listeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }
};

const scratch = {
  inverse: new THREE.Matrix4(),
  origin: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  ray: new THREE.Ray(),
  ndc: new THREE.Vector2(),
  caster: new THREE.Raycaster()
};

// A world ray in the grid's cells: where it starts and which way it goes.
function toCells(ray: THREE.Ray, group: THREE.Object3D, G: number) {
  scratch.inverse.copy(group.matrixWorld).invert();
  const origin = scratch.origin.copy(ray.origin).applyMatrix4(scratch.inverse);
  const direction = scratch.direction.copy(ray.direction).transformDirection(scratch.inverse);
  origin.divideScalar(SPAN).addScalar(0.5).multiplyScalar(G);
  return { origin, direction };
}

// Where a world ray first meets the coarse map, as a distance along it in the world, or null.
function landOn(map: Uint32Array | null, ray: THREE.Ray, group: THREE.Object3D, G: number, block: number, C: number) {
  if (!map) return null;
  const { origin, direction } = toCells(ray, group, G);
  const o = origin.divideScalar(block);
  const d = direction;
  let near = 0;
  let far = Infinity;
  for (const axis of ["x", "y", "z"] as const) {
    const v = Math.abs(d[axis]) < 1e-6 ? 1e-6 : d[axis];
    const a = (0 - o[axis]) / v;
    const b = (C - o[axis]) / v;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  if (near > far) return null;
  for (let t = near; t <= far; t += 0.3) {
    const x = Math.floor(o.x + d.x * t);
    const y = Math.floor(o.y + d.y * t);
    const z = Math.floor(o.z + d.z * t);
    if (x < 0 || y < 0 || z < 0 || x >= C || y >= C || z >= C) continue;
    if (map[z * C * C + y * C + x]) return (t * block * SPAN) / G;
  }
  return null;
}

// The sound of erosion: a sand hiss under the stroke, a rustle as cells go, and a soft brush now and then from the
// flecks still drifting in the light.
const r = Math.random;
const SAND = {
  level: 0.14,
  gap: [0.12, 0.14] as [number, number],
  grain: (w: number) => sound.play("rustle", { gain: 0.2 + w * 0.35, pitch: 0.8 + r() * 0.4 }),
  fleck: () => sound.play("brush", { gain: 0.03, pitch: 1.5 + r() * 0.4 })
};

// How the lost cells look once they cool: crumbs in the sculpture's own colour, or sparks that stay hot. One shader draws them all; choosing only sets a uniform.
const DUST_STYLES = [
  { value: "flecks", label: "Flecks" },
  { value: "sparks", label: "Sparks" }
];

// Resolution, as how many times as many cubes as the tier's usual grid (128 a side, 112 on Low): the grid's side grows
// as the cube root, so 10× is about 276 a side. Each tier stops where its devices would struggle: High at 50×, Medium
// at 20×, Low (phones) at 5×.
const STEPS = [1, 2, 3, 5, 10, 20, 30, 50, 100];
const TOP_CUBES = { high: 50, medium: 20, low: 5 } as const;
const START_CUBES = { high: 5, medium: 5, low: 2 } as const;
// How many words (32 cells each) of a form are filled a frame after a change of resolution: about 400k cells.
const FILL_WORDS = 12288;

function Scene() {
  const { tier } = useQuality();
  // The grid is set by the tier the visit starts on: a later step down must not wipe what has been carved.
  const startTier = useRef(tier).current;
  // The usual grid for the tier, and the most it can be raised to, which the buffers are made for once, here.
  const BASE = startTier === "low" ? 112 : 128;
  const top = TOP_CUBES[startTier];
  // The slider lands on the named steps (¼×, ½×, 1×, 2×, 3×, 5×, 10× the cubes), the nearest one at or under it.
  const gridFor = (cubes: number) => {
    const step = STEPS.filter((m) => m <= Math.min(Math.max(cubes, 1), top)).pop() ?? 1;
    return Math.round((BASE * Math.cbrt(step)) / 4) * 4;
  };
  // The slider left at its default starts each device where it runs smoothly.
  const cubesFor = (value: number) => (value === 5 ? START_CUBES[startTier] : value);
  const morph = useMemo(
    () => {
      const most = gridFor(top);
      return createMorph(most, Math.round((startTier === "low" ? 160000 : 420000) * Math.pow(most / BASE, 2)), startTier === "low" ? 12000 : 40000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- made once for the tier the visit starts on.
    [startTier]
  );
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const group = useRef<THREE.Group>(null);
  const store = useSettingsStore();

  const dilateSetting = useSetting<boolean>("dilate");
  const form = useSetting<string>("form");
  const resolutionSetting = useSetting<number>("resolution");
  // "auto" is the tier's own starting point; any other value is a number of times the cubes.
  const resolution = cubesFor(resolutionSetting);
  const dustStyle = useSetting<string>("dustStyle");
  const dustSize = useSetting<number>("dustSize");
  const driftSpeed = useSetting<number>("driftSpeed");

  const state = useRef({
    held: false,
    over: false,
    moved: 0,
    pointer: { x: 0, y: 0, has: false },
    last: { x: 0, y: 0 },
    speed: 0,
    owed: 0,
    parity: 0,
    seconds: 0,
    shift: false,
    dirty: true,
    reading: false,
    sinceRead: 0,
    map: null as Uint32Array | null,
    full: 0,
    start: 0,
    starts: [] as number[],
    steps: 0,
    spin: 0,
    sway: 0,
    turn: FORMS.find((f) => f.value === "loop")?.turn ?? 0,
    earned: false,
    sinceCrackle: 0,
    drifting: 0,
    relist: false,
    unlisted: false,
    slice: FILL_WORDS / 3,
    touching: false,
    // Changing resolution: live, shrinking away, filling, growing back.
    phase: "live" as "live" | "out" | "fill" | "in",
    wantG: 0,
    askedG: 0,
    askedAt: 0,
    filled: [] as boolean[],
    progress: [] as number[],
    waitForm: -1,
    hand: new THREE.Vector3(),
    handLast: new THREE.Vector3(),
    handHas: false
  });

  // Every compute pass runs once now, behind the loader, so none compiles on the first stroke: every form is filled
  // here at the starting resolution, and counted as it is.
  useEffect(() => {
    const p = morph.passes;
    const s = state.current;
    const G0 = gridFor(cubesFor(store.get("resolution") as number));
    morph.resize(G0);
    morph.u.origin.value.set(-1e4, -1e4, -1e4);
    morph.u.form.value = Math.max(
      0,
      FORMS.findIndex((f) => f.value === store.get("form"))
    );
    gl.compute(p.zeroCounts as any);
    FORMS.forEach((_, k) => gl.compute(morph.fillSlice(k, 0, morph.size.WORDS) as any));
    s.filled = FORMS.map(() => true);
    s.progress = FORMS.map(() => morph.size.WORDS);
    s.wantG = G0;
    gl.compute([p.restore, p.recount, p.aim, p.decide, p.apply, p.drift, p.clear, p.gather, p.cap] as any);
    read(gl, morph, s);
    readStarts(gl, morph, s);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the form and resolution at load; later changes come below.
  }, [gl, morph]);

  // Bring back the sculpture as it was: the chosen form, every cell's budget cleared.
  const bringBack = () => {
    const s = state.current;
    const p = morph.passes;
    const k = Math.max(
      0,
      FORMS.findIndex((f) => f.value === store.get("form"))
    );
    // A form not yet filled at this resolution is waited for, out of sight.
    if (!s.filled[k]) {
      s.waitForm = k;
      if (s.phase === "live" || s.phase === "in") s.phase = "out";
      return;
    }
    morph.u.form.value = k;
    s.start = s.starts[k] ?? s.start;
    // Copied in this frame and listed for drawing the next, so neither frame carries both.
    gl.compute([p.restore, p.recount] as any);
    s.relist = true;
    record.set({ runs: [], left: 1 });
    // The dust from before melts away.
    look.dissolveAt.value = s.seconds;
  };
  const lastForm = useRef(form);
  useEffect(() => {
    if (lastForm.current === form) return;
    lastForm.current = form;
    bringBack();
    sound.play("whoosh", { gain: 0.22, pitch: 1.2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of form.
  }, [form]);
  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __morph: morph, __morphState: state, __camera: camera, __morphStore: store });

  // The pointer, followed over the canvas so the brush's reach shows where it would land.
  useEffect(() => {
    const el = gl.domElement;
    const move = (e: PointerEvent) => {
      const s = state.current;
      const rect = el.getBoundingClientRect();
      s.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      s.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      s.pointer.has = true;
      s.over = e.pointerType === "mouse";
      s.shift = e.shiftKey;
      const dx = e.clientX - s.last.x;
      const dy = e.clientY - s.last.y;
      s.last.x = e.clientX;
      s.last.y = e.clientY;
      if (s.held) s.moved += Math.hypot(dx, dy);
    };
    const leave = () => {
      state.current.over = false;
    };
    const key = (e: KeyboardEvent) => {
      state.current.shift = e.shiftKey;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") state.current.touching = true;
      move(e);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") state.current.touching = false;
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
    };
  }, [gl]);

  // A press on the sculpture takes hold of it; anywhere else turns the view.
  useGrabbable({
    pick: (ray) => {
      if (!group.current) return null;
      if (state.current.phase !== "live") return null;
      const distance = landOn(state.current.map, ray, group.current, morph.size.G, morph.size.BLOCK, morph.size.C);
      if (distance === null) return null;
      return { distance, point: ray.at(distance, new THREE.Vector3()) };
    },
    grab: () => {
      const s = state.current;
      s.held = true;
      s.moved = 0;
      // A press bites at once.
      s.owed = 1;
      dismissPrompt();
    },
    drag: () => {},
    release: () => {
      state.current.held = false;
    }
  });

  useSettingAction("restore", () => {
    bringBack();
    resetPrompt();
    sound.play("whoosh", { gain: 0.25, pitch: 1.4 });
  });

  // Sound: a faint air under everything; sand that follows the erosion; small brushes now and then from the flecks
  // still drifting; and a bright shimmer while growing.
  useBed("breeze", 0.02);
  useMusic("/codevember/music/electronic-surveillance-suspense.mp3", 0.26);
  const hiss = useBed("sand", 0);
  const growing = useBed("shimmer", 0);

  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 20);
    const s = state.current;
    const p = morph.passes;
    const u = morph.u;
    s.seconds += delta;
    u.seconds.value = s.seconds;
    const dilate = dilateSetting !== s.shift;
    u.dilate.value = dilate ? 1 : 0;
    look.dilate.value += ((dilate ? 1 : 0) - look.dilate.value) * (1 - Math.exp(-delta * 10));
    const G = morph.size.G;
    const cells = THREE.MathUtils.clamp(G * 0.084, 2, morph.size.RMAX - 1);
    u.reach.value = cells;
    look.reach.value = cells;
    // The dust: its look, and finer from a finer grid.
    look.dustStyle.value = Math.max(
      0,
      DUST_STYLES.findIndex((d) => d.value === dustStyle)
    );
    look.dustSize.value = dustSize * THREE.MathUtils.clamp(Math.sqrt(BASE / G), 0.6, 1.4);
    // The sliders read 1 at the tuned look: drift 1 is 2.5 times the air's base speed, amount 1 sheds 1.2 times the base share.
    u.drift.value = driftSpeed * 2.5;
    u.delta.value = delta;

    // It turns slowly while left alone, and holds still under the hand.
    const g = group.current;
    if (!g) return;
    // A slow sway about the vertical, never far from facing the eye; it eases still while held, and picks up from there.
    s.spin += ((s.held ? 0 : 1) - s.spin) * (1 - Math.exp(-delta * 2));
    s.sway += delta * s.spin;
    // Each form faces the eye at its own best angle, eased round when the form changes.
    const facing = FORMS.find((f) => f.value === form)?.turn ?? 0;
    s.turn += (facing - s.turn) * (1 - Math.exp(-delta * 3));
    g.rotation.y = s.turn + Math.sin(s.sway * 0.13) * 0.38;
    g.position.y = Math.sin(s.seconds * 0.45) * 0.03;
    g.updateMatrixWorld();
    u.toWorld.value.copy(g.matrixWorld);

    // Where the pointer's line meets the sculpture, worked out on the graphics card.
    const passes: unknown[] = [];
    const live = s.phase === "live";
    const aiming = live && s.pointer.has && (s.held || s.over);
    look.showBrush.value += ((aiming ? 1 : 0) - look.showBrush.value) * (1 - Math.exp(-delta * 8));
    // The hand in the air: where the pointer's line passes the sculpture's depth, and how fast that point moves. A mouse
    // stirs the dust just by passing over it; a finger, while it is down.
    const handing = s.pointer.has && (s.over || s.touching || s.held);
    scratch.ndc.set(s.pointer.x, s.pointer.y);
    scratch.caster.setFromCamera(scratch.ndc, camera);
    if (handing) {
      const ray = scratch.caster.ray;
      s.hand.copy(ray.origin).addScaledVector(ray.direction, camera.position.length());
      if (s.handHas) {
        scratch.direction.subVectors(s.hand, s.handLast).divideScalar(Math.max(delta, 1e-3));
        if (scratch.direction.length() > 3) scratch.direction.setLength(3);
        u.handMove.value.lerp(scratch.direction, 1 - Math.exp(-delta * 18));
      }
      s.handLast.copy(s.hand);
      s.handHas = true;
      u.handFrom.value.copy(ray.origin);
      u.handAlong.value.copy(ray.direction);
    } else {
      s.handHas = false;
      u.handMove.value.multiplyScalar(Math.exp(-delta * 10));
    }
    u.hand.value = handing ? 1 : 0;
    if (aiming) {
      const { origin, direction } = toCells(scratch.caster.ray, g, G);
      u.origin.value.copy(origin);
      u.direction.value.copy(direction).normalize();
      passes.push(p.aim);
    }

    // Held, it wears away (or grows back) a step at a time: two and a half steps a second held still, up to about twenty as the
    // pointer sweeps across it, at the usual grid. A finer grid takes more steps for the same depth, so its rate scales
    // with the grid, a few steps a frame at most; each step is its own dispatch, as its uniforms differ, and the surface
    // is listed once after them all.
    let stepped = false;
    const rate = G / BASE;
    if (s.held && live) {
      s.speed += (s.moved / Math.max(delta, 1e-3) - s.speed) * (1 - Math.exp(-delta * 8));
      s.moved = 0;
      s.owed += delta * (2.5 + 20 * THREE.MathUtils.clamp(s.speed / 900, 0, 1)) * rate;
      // A step works whole words at once and costs little, so a fine grid can take several a frame.
      const steps = Math.min(Math.floor(s.owed), Math.ceil(rate * 1.2), 6);
      if (passes.length) gl.compute(passes.splice(0) as any);
      for (let n = 0; n < steps; n++) {
        s.owed -= 1;
        // A ball steps with the cube and the cross in turn.
        u.cube.value = s.parity % 2 === 0 ? 1 : 0;
        // The fringe works two steps in four, so it still sees the ball's cube and cross steps alike.
        u.parity.value = Math.floor(s.parity / 2) % 2;
        s.parity++;
        u.salt.value = (u.salt.value + 7919) % 1000003;
        // A finer grid sheds a smaller share of its (many more, smaller) cells.
        u.shed.value = Math.min(1, (startTier === "low" ? 0.35 : 0.75) * 1.2 * Math.pow(BASE / G, 2));
        gl.compute([p.decide, p.apply] as any);
        stepped = true;
        s.steps++;
        const op = dilate ? "⊕" : "⊖";
        const runs = record.value.runs.slice();
        const lastRun = runs[runs.length - 1];
        if (lastRun && lastRun.op === op) runs[runs.length - 1] = { ...lastRun, n: lastRun.n + 1 };
        else runs.push({ op, n: 1 });
        record.set({ runs, left: record.value.left });
      }
      s.owed = Math.min(s.owed, 1);
      // Listing the surface reads every cell of the grid; on the finest grids it is done every other frame.
      if (stepped) s.unlisted = true;
      if (s.unlisted && (G <= 192 || s.steps % 2 === 0 || !stepped)) {
        s.unlisted = false;
        passes.push(p.clear, p.gather, p.cap);
        s.dirty = true;
      }
    } else {
      s.speed = 0;
      s.owed = 0;
    }
    if (s.unlisted && !s.held) {
      s.unlisted = false;
      s.relist = true;
    }
    if (s.relist && !stepped) {
      s.relist = false;
      s.dirty = true;
      passes.push(p.clear, p.gather, p.cap);
    }
    u.working.value = s.held && live ? 1 : 0;
    passes.push(p.warm, p.drift);
    gl.compute(passes as any);

    // A change of resolution: the cubes shrink to their middles, the new grid's forms are filled a slice a frame (the
    // one on show first), it comes back, and the rest fill quietly after.
    // The slider is followed once it has rested a moment, so dragging it does not refill at every notch.
    const wanted = gridFor(resolution);
    if (wanted !== s.askedG) {
      s.askedG = wanted;
      s.askedAt = s.seconds;
    }
    if (wanted !== s.wantG && s.seconds - s.askedAt > 0.35) {
      s.wantG = wanted;
      if (s.phase === "live" || s.phase === "in") s.phase = "out";
    }
    if (s.phase === "out") {
      look.grow.value = Math.max(0, look.grow.value - delta * 5);
      if (look.grow.value === 0) {
        if (s.wantG !== morph.size.G) {
          morph.resize(s.wantG);
          gl.compute(p.zeroCounts as any);
          s.filled = FORMS.map(() => false);
          s.progress = FORMS.map(() => 0);
          record.set({ runs: [], left: 1 });
        }
        s.phase = "fill";
      }
    }
    const showing = Math.max(
      0,
      FORMS.findIndex((f) => f.value === form)
    );
    const next = s.filled.length === 0 ? -1 : !s.filled[showing] ? showing : s.filled.findIndex((done) => !done);
    if (next >= 0) {
      // As much a frame as keeps the frame on time: the slice grows while frames come at 60 a second, and shrinks fast
      // when one runs long.
      s.slice = THREE.MathUtils.clamp(raw < 0.0185 ? s.slice * 1.3 : s.slice * 0.6, 1024, 262144);
      const slice = Math.round(s.slice);
      gl.compute(morph.fillSlice(next, s.progress[next], slice) as any);
      s.progress[next] += slice;
      if (s.progress[next] >= morph.size.WORDS) {
        s.filled[next] = true;
        readStarts(gl, morph, s);
      }
    }
    if (s.phase === "fill" && s.filled[showing]) {
      s.waitForm = -1;
      bringBack();
      s.phase = "in";
    }
    if (s.phase === "in") {
      look.grow.value = Math.min(1, look.grow.value + delta * 4);
      if (look.grow.value === 1) s.phase = "live";
    }

    // Sound follows the work: sand while eroding, shimmer while growing, and the flecks'
    // glints for as long as a good few of them are still in the air.
    const working = s.held ? THREE.MathUtils.clamp(0.35 + s.speed / 900, 0, 1) : 0;
    const v = SAND;
    hiss.current?.level(dilate ? 0 : working * v.level, 0.12);
    growing.current?.level(dilate ? working * 0.06 : 0, 0.2);
    s.sinceCrackle += delta;
    if (stepped && !dilate && s.sinceCrackle > v.gap[0] + Math.random() * v.gap[1]) {
      s.sinceCrackle = 0;
      v.grain(working);
    }
    if (stepped && dilate && s.sinceCrackle > 0.25 + Math.random() * 0.2) {
      s.sinceCrackle = 0;
      sound.play("tinkle", { gain: 0.08, pitch: 1.4 + Math.random() * 0.5 });
    }
    if (stepped && !dilate) s.drifting = Math.min(s.drifting + 1, 60);
    s.drifting *= Math.exp(-delta / 14);
    if (Math.random() < delta * 2.4 * Math.min(1, s.drifting / 25)) v.fleck();

    // The coarse map and the count, read back a few times a second while things change.
    s.sinceRead += delta;
    if (s.dirty && !s.reading && s.sinceRead > 0.25) read(gl, morph, s);

    // The moment worth sharing: a good part of it carved away.
    if (!s.earned && s.steps > 40 && record.value.left < 0.75) {
      s.earned = true;
      followPrompt.earn("eroded");
      shareResult.set("Just eroded a sculpture with mathematical morphology");
    }

    // The lens holds the front of the sculpture.
    focusDistance.value = Math.max(0.6, camera.position.length() - 0.5);
    focusBlur.value = 0.55;
  });

  return (
    <>
      <Backdrop />
      <StudioEnvironment
        ambient="#0b0a0a"
        intensity={0.6}
        boxes={[
          { position: [-6, 6, 4], scale: [4, 4, 0.2], color: "#ffe6cc", intensity: 3.2 },
          { position: [7, 2, -5], scale: [0.2, 5, 3], color: "#d4dcf0", intensity: 1.0 },
          { position: [0, 8, 0], scale: [5, 0.2, 5], color: "#fff4e8", intensity: 0.8 },
          { position: [2, -6, 3], scale: [5, 0.2, 5], color: "#3a2c22", intensity: 0.6 },
          { position: [3, 1, 8], scale: [4, 3, 0.2], color: "#fff6ec", intensity: 1.3 }
        ]}
      />
      <KeyLight position={[KEY.x, KEY.y, KEY.z]} target={[0, 0, 0]} color="#ffe2c4" intensity={320} angle={0.36} penumbra={0.75} shadowFar={14} />
      <RimLight />
      <group ref={group}>
        <Voxels morph={morph} />
      </group>
      <Ash morph={morph} />
      <Air dust={startTier === "low" ? 1000 : 2600} />
    </>
  );
}

// A cool light from behind on the right, outlining the far edges against the dark.
function RimLight() {
  const light = useMemo(() => {
    const l = new THREE.DirectionalLight("#e4e8f2", 1.2);
    l.position.set(4, 2.5, -5);
    return l;
  }, []);
  useDispose(light);
  return <primitive object={light} />;
}

// Bring back the coarse map and the count of full cells.
function read(gl: THREE.WebGPURenderer, morph: Morph, s: { reading: boolean; dirty: boolean; sinceRead: number; map: Uint32Array | null; full: number; start: number }) {
  s.reading = true;
  s.dirty = false;
  s.sinceRead = 0;
  gl.compute(morph.passes.shrink as any);
  Promise.all([gl.getArrayBufferAsync(morph.coarse.value as any) as Promise<ArrayBuffer>, gl.getArrayBufferAsync(morph.counterBuffer as any) as Promise<ArrayBuffer>])
    .then(([map, counts]) => {
      s.map = new Uint32Array(map);
      s.full = new Uint32Array(counts)[1];
      if (s.start > 0) record.set({ runs: record.value.runs, left: s.full / s.start });
    })
    .catch(() => {})
    .finally(() => (s.reading = false));
}

// Bring back how many cells each form has at this resolution, once a fill has counted them.
function readStarts(gl: THREE.WebGPURenderer, morph: Morph, s: { starts: number[]; start: number }) {
  (gl.getArrayBufferAsync(morph.formCountBuffer as any) as Promise<ArrayBuffer>)
    .then((buffer) => {
      s.starts = Array.from(new Uint32Array(buffer));
      const shown = s.starts[morph.u.form.value];
      if (shown) s.start = shown;
    })
    .catch(() => {});
}

// The formula, quietly, under the sculpture: what has been done, and how much of the original is left.
function Formula() {
  const { runs, left } = useSyncExternalStore(
    record.subscribe,
    () => record.value,
    () => record.value
  );
  const shown = runs.slice(-4);
  const open = runs.length > 0;
  return (
    <div
      aria-live="polite"
      className="cv-morph-formula"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 104,
        transform: `translate(-50%, ${open ? 0 : 8}px)`,
        opacity: open ? 1 : 0,
        transition: "opacity 0.6s ease, transform 0.6s ease",
        pointerEvents: "none",
        padding: "8px 16px",
        borderRadius: 999,
        background: "rgba(16, 16, 18, 0.55)",
        backdropFilter: "blur(10px)",
        color: "rgba(255, 255, 255, 0.86)",
        fontSize: 13,
        letterSpacing: 0.2,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums"
      }}
    >
      <span style={{ fontStyle: "italic" }}>{runs.length > 4 ? "… " : "A "}</span>
      {shown.map((r, i) => (
        <span key={runs.length - shown.length + i}>
          {" "}
          {r.op} {r.n > 1 ? r.n : ""}
          <span style={{ fontStyle: "italic" }}>B</span>
        </span>
      ))}
      <span style={{ opacity: 0.55, marginLeft: 12 }}>{Math.round(left * 100)}% of A</span>
      <style>{`@media (min-width: 901px) and (hover: hover) { .cv-prompt.cv-prompt-high p { font-size: clamp(31px, 4.2vw, 59px); } } @media (max-width: 720px) { .cv-morph-formula { bottom: auto !important; top: 64px; font-size: 12px !important; } }`}</style>
    </div>
  );
}

// This module only ever loads in the browser, so the screen can be asked here.
const PHONE = typeof window !== "undefined" && window.matchMedia("(max-width: 900px), (hover: none)").matches;

const day: DayDefinition = {
  camera: {
    position: [1.5, 0.6, 5.7],
    target: [0, 0, 0],
    fov: 34,
    phone: { position: [1.9, 0.75, 8.1], target: [0, -0.1, 0], fov: 42 }
  },
  extents: { centre: [0, 0, 0], radius: 10, color: "#ffd7b0" },
  // Black behind: the overlay pass (the shaft, the dust and the ash) is added over the whole frame.
  look: { background: "#000000", exposure: 1.1, bloom: 0.28, bloomThreshold: 1.35, gi: 0, ao: 1, aoRadius: 0.18, vignette: 0.6, grain: 0.014, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true },
  autoFloor: "medium",
  settings: {
    form: { type: "choice", label: "Form", value: "loop", options: FORMS.map((f) => ({ value: f.value, label: f.label })) },
    dilate: { type: "toggle", label: "Erode or grow", value: false, sides: ["Erode", "Grow"] },
    restore: { type: "action", label: "Reset" },
    dustStyle: { type: "choice", label: "Dust style", value: "sparks", options: DUST_STYLES },
    dustSize: { type: "range", label: "Dust size", min: 0.25, max: 1.75, step: 0.01, value: 1, reset: 1 },
    driftSpeed: { type: "range", label: "Drift speed", min: 0, max: 2, step: 0.01, value: 1, reset: 1 },
    // How many times as many cubes as the usual grid, snapped to 1×, 2×, 3×, 5×, 10×, 20×, 30× or 50×, as far as the
    // device holds smoothly (phones 5×). Left at 5×, a phone starts at 2×.
    resolution: { type: "range", label: "Resolution (× cubes)", short: "Cubes", min: 1, max: 50, step: 1, phoneMax: 5, value: 5, reset: 5 }
  },
  phoneDock: ["form", "dilate"],
  phonePills: ["restore"],
  // Above the sculpture on a desktop; on a phone, small in the top left, clear of it and the dock.
  prompt: { title: "Drag across the sculpture to erode it", detail: "The thinnest parts go first", ...(PHONE ? { low: true } : { high: true }) },
  hint: "Drag across the sculpture to erode it, cell by cell: the thinnest parts go first. Switch to Grow (or hold Shift) to build it back up anywhere, as far as you like; Reset brings back the original.",
  notes: "Erosion as the operator from mathematical morphology: voxel sculptures worn away by a brush, layer by layer, their finest parts first.",
  overview: [
    {
      title: "Morphology",
      points: [
        "A bit-packed GPU grid, 32 cells a word: erode clears a cell if any neighbour under the round brush is empty; grow fills one if any is full.",
        "Thin parts go first and never come back as they were: growing rounds everything, which is why erosion then dilation (an opening) loses detail."
      ]
    },
    {
      title: "Forms",
      points: [
        "Four sculptures that run thin to thick: a twisting loop, a three-half-turn ribbon, two linked rings, a graded lattice.",
        "Every form is filled once per resolution, one bit a cell, so switching or restoring only copies bits into the grid."
      ]
    },
    {
      title: "Dust and detail",
      points: [
        "Lost cells cool from embers to tumbling flecks, stepped on the GPU each frame; the pointer pushes and swirls them like a hand through smoke.",
        "Resolution sets the cube count, 1× to 50× (128³ to 472³ cells); only open faces are drawn, and a new grid fills behind a fade."
      ]
    }
  ],
  Overlay: Formula,
  Scene
};

export default day;
