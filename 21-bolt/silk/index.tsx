"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingAction } from "../../shared/engine/settings";
import { sound, useBed } from "../../shared/engine/sound";
import { KeyLight, StudioEnvironment } from "../../shared/engine/studio";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Air, Backdrop, FOCUS, KEY } from "./air";
import { CENTRE, createCloth, LENGTH, MOST, radiusAt, TAIL, WIDTH, type Cloth } from "./cloth";
import { Bolt, look, setSilk, Sheet, SILKS } from "./render";

/* eslint-disable @typescript-eslint/no-explicit-any -- three's compute types do not model every node. */

const TAU = Math.PI * 2;
const wrap = (a: number) => a - TAU * Math.round(a / TAU);

// What the frame loop keeps between frames: the roll, the hand, and the last positions read back from the cloth.
type State = {
  s: number;
  feed: number;
  lift: number;
  liftWant: number;
  angle: number;
  quarter: number;
  hand: "none" | "cloth" | "roll";
  gi: number;
  gj: number;
  target: THREE.Vector3;
  handAngle: number;
  handTurn: number;
  handFeed: number;
  rewinding: boolean;
  reel: number;
  data: Float32Array | null;
  last: Float32Array | null;
  readAt: number;
  reading: boolean;
  frame: number;
  speed: number;
  centroid: THREE.Vector3;
  seconds: number;
  flutterIn: number;
  tickAt: number;
  earned: boolean;
  picked: { kind: "cloth" | "roll"; index: number } | null;
};

// Run the cloth on by one frame: the roll's state eased from where it was to where it is now over the substeps.
function step(gl: THREE.WebGPURenderer, cloth: Cloth, from: { s: number; lift: number }, to: { s: number; lift: number }, delta: number, substeps: number, pairs: number, time: number) {
  const u = cloth.u;
  u.dt.value = delta / substeps;
  for (let k = 1; k <= substeps; k++) {
    const a = (k - 1) / substeps;
    const b = k / substeps;
    u.sPrev.value = from.s + (to.s - from.s) * a;
    u.s.value = from.s + (to.s - from.s) * b;
    u.liftPrev.value = from.lift + (to.lift - from.lift) * a;
    u.lift.value = from.lift + (to.lift - from.lift) * b;
    u.time.value = time - delta * (1 - b);
    const passes: unknown[] = [cloth.integrate];
    for (let n = 0; n < pairs; n++) passes.push(cloth.forth, cloth.back);
    gl.compute(passes as any);
  }
}

function Scene() {
  const { tier } = useQuality();
  // The cloth's resolution is set by the tier the visit starts on, so a later step down never throws away what was unrolled.
  const startTier = useRef(tier).current;
  const cloth = useMemo(() => (startTier === "low" ? createCloth(30, 190) : startTier === "medium" ? createCloth(40, 260) : createCloth(48, 320)), [startTier]);
  const substeps = startTier === "low" ? 2 : 3;
  const pairs = startTier === "low" ? 4 : 6;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera);
  const core = useRef<THREE.Group>(null);

  const silk = useSetting<string>("silk");
  const weight = useSetting<number>("weight");
  const breeze = useSetting<number>("breeze");
  useEffect(() => setSilk(silk), [silk]);

  const st = useRef<State>({
    s: TAIL,
    feed: 0,
    lift: 0,
    liftWant: 0,
    angle: 0,
    quarter: 0,
    hand: "none",
    gi: 0,
    gj: 0,
    target: new THREE.Vector3(),
    handAngle: 0,
    handTurn: 0,
    handFeed: 0,
    rewinding: false,
    reel: 0,
    data: null,
    last: null,
    readAt: 0,
    reading: false,
    frame: 0,
    speed: 0,
    centroid: new THREE.Vector3(0, 0.2, 0.2),
    seconds: 0,
    flutterIn: 0,
    tickAt: 0,
    earned: false,
    picked: null
  });

  // Behind the loader: the loose end laid hanging from the bolt, and a second and a half of steps so it has settled into
  // the air before it is seen. Every compute pass runs here once, so none is built on the first touch.
  useEffect(() => {
    const u = cloth.u;
    u.s.value = u.sPrev.value = TAIL;
    u.lift.value = u.liftPrev.value = 0;
    gl.compute(cloth.reset as any);
    gl.compute(cloth.takeHold as any);
    for (let k = 0; k < 60; k++) step(gl, cloth, { s: TAIL, lift: 0 }, { s: TAIL, lift: 0 }, 1 / 40, substeps, pairs, k / 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the cloth made.
  }, [gl, cloth]);
  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __silk: st, __cloth: cloth });

  // How close to the cloth a press must land, as an angle: a few pixels with a mouse, more under a finger.
  const reach = useMemo(() => (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? 0.035 : 0.014), []);
  const scratch = useMemo(() => ({ v: new THREE.Vector3(), w: new THREE.Vector3() }), []);

  useGrabbable({
    pick(ray) {
      const s = st.current;
      s.picked = null;
      let best = Infinity;
      // The cloth off the roll, from the last positions read back.
      const data = s.data;
      if (data) {
        const { COLS, dv } = cloth;
        const free = Math.min(cloth.ROWS, Math.ceil(s.s / dv));
        const o = ray.origin;
        const d = ray.direction;
        for (let k = 0; k < free * COLS; k++) {
          const x = data[k * 4] - o.x;
          const y = data[k * 4 + 1] - o.y;
          const z = data[k * 4 + 2] - o.z;
          const t = x * d.x + y * d.y + z * d.z;
          if (t <= 0 || t >= best) continue;
          const off = x * x + y * y + z * z - t * t;
          const r = Math.max(0.03, t * reach);
          if (off < r * r) {
            best = t;
            s.picked = { kind: "cloth", index: k };
          }
        }
      }
      // The bolt itself, to spin.
      const R = radiusAt(s.s) + 0.015;
      const oy = ray.origin.y - CENTRE.y;
      const oz = ray.origin.z - CENTRE.z;
      const a = ray.direction.y ** 2 + ray.direction.z ** 2;
      const b = 2 * (oy * ray.direction.y + oz * ray.direction.z);
      const c = oy * oy + oz * oz - R * R;
      const disc = b * b - 4 * a * c;
      if (a > 1e-8 && disc > 0) {
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        const x = ray.origin.x + ray.direction.x * t;
        if (t > 0 && t < best && Math.abs(x - CENTRE.x) < WIDTH / 2 + 0.05) {
          best = t;
          s.picked = { kind: "roll", index: -1 };
        }
      }
      return s.picked ? { distance: best, point: ray.at(best, new THREE.Vector3()) } : null;
    },
    grab(point) {
      const s = st.current;
      const picked = s.picked;
      if (!picked) return;
      dismissPrompt();
      s.rewinding = false;
      if (picked.kind === "cloth") {
        s.hand = "cloth";
        s.gi = picked.index % cloth.COLS;
        s.gj = Math.floor(picked.index / cloth.COLS);
        s.target.copy(point);
        const u = cloth.u;
        u.gi.value = s.gi;
        u.gj.value = s.gj;
        u.target.value.copy(point);
        gl.compute(cloth.takeHold as any);
        u.holding.value = 1;
        sound.play("peel", { variant: "silk", gain: 0.5, pitch: 0.9 + Math.random() * 0.2 });
      } else {
        s.hand = "roll";
        // Stroked like a wheel: the hand's travel along the surface where it took hold turns it.
        s.handAngle = Math.atan2(point.y - CENTRE.y, point.z - CENTRE.z);
        s.target.copy(point);
        s.handTurn = 0;
        s.handFeed = s.feed;
        sound.play("brush", { gain: 0.3, pitch: 0.8 });
      }
    },
    drag(point) {
      const s = st.current;
      if (s.hand === "cloth") {
        s.target.copy(point);
        cloth.u.target.value.copy(point);
      } else if (s.hand === "roll") {
        // The way the surface under the hand moves as the bolt unrolls, as seen on screen.
        const a = s.handAngle;
        const along = scratch.v.set(0, -Math.cos(a), Math.sin(a));
        const forward = camera.getWorldDirection(scratch.w);
        along.addScaledVector(forward, -along.dot(forward));
        if (along.lengthSq() < 0.04) along.set(0, -1, 0);
        along.normalize();
        s.handTurn += scratch.w.subVectors(point, s.target).dot(along);
        s.target.copy(point);
      }
    },
    release(velocity) {
      const s = st.current;
      if (s.hand === "cloth") {
        cloth.u.holding.value = 0;
        const fast = velocity.length();
        if (fast > 1.2) sound.play("whoosh", { gain: Math.min(0.5, 0.1 + fast * 0.06), pitch: 1.3 + Math.random() * 0.3 });
        sound.play("peel", { variant: "silk", gain: 0.25 + Math.min(0.35, fast * 0.08), pitch: 1.05 + Math.random() * 0.2 });
      }
      s.hand = "none";
    }
  });

  // Roll back: the bolt winds the cloth back on, drawing it through the air to itself.
  useSettingAction("rollBack", () => {
    const s = st.current;
    if (s.s <= TAIL + 0.02) return;
    s.rewinding = true;
    if (s.hand === "cloth") cloth.u.holding.value = 0;
    s.hand = "none";
    sound.play("whoosh", { gain: 0.3, pitch: 0.8 });
  });

  // Sound: the faint air of the room; the cloth's rush through the air as it billows, louder the faster it moves; a
  // soft hiss as it slides off the bolt, and the bolt's thrum each quarter turn.
  useBed("breeze", 0.035);
  const rush = useBed("wind", 0);
  const hiss = useBed("sand", 0);

  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 30);
    if (delta <= 0) return;
    const s = st.current;
    const u = cloth.u;
    s.seconds += delta;
    s.frame++;
    u.gravity.value = 0.08 + weight * weight * 4;
    u.breeze.value = breeze;

    // The roll. Its mass falls as cloth comes off; pulling past the cloth that is free turns it, and it coasts on after.
    const from = { s: s.s, lift: s.lift };
    const R = radiusAt(s.s);
    const mass = 0.18 + 0.09 * (LENGTH - s.s) * 0.5 * (1 + (0.045 * 0.045) / (R * R));
    if (s.hand === "cloth") {
      const ax = s.gi * cloth.du - WIDTH / 2;
      scratch.v.set(CENTRE.x + ax, CENTRE.y + R * Math.sin(s.lift), CENTRE.z + R * Math.cos(s.lift));
      const need = scratch.v.distanceTo(s.target);
      const free = s.s - s.gj * cloth.dv;
      const over = need - free * 0.985;
      if (over > 0) s.feed += ((over * 220) / mass) * delta;
    }
    if (s.hand === "roll") {
      // Turned by hand: the cloth fed at the speed of the bolt's surface under it.
      const want = THREE.MathUtils.clamp(s.handTurn / delta, -4, 7);
      s.handTurn = 0;
      s.handFeed += (want - s.handFeed) * (1 - Math.exp(-delta * 18));
      s.feed = s.handFeed;
    } else if (s.rewinding) {
      s.feed += (-1.0 - s.feed) * (1 - Math.exp(-delta * 2));
    } else {
      // Friction in the bolt's spindle, and the drag of the cloth it is paying out.
      const slow = (0.6 + 0.5 * Math.abs(s.feed)) * delta;
      s.feed = Math.abs(s.feed) <= slow ? 0 : s.feed - Math.sign(s.feed) * slow;
    }
    s.feed = THREE.MathUtils.clamp(s.feed, -4, 7);
    s.s += s.feed * delta;
    if (s.s <= TAIL) {
      if (s.feed < -0.3) sound.play("thud", { gain: Math.min(0.4, -s.feed * 0.15), pitch: 0.6 });
      s.s = TAIL;
      s.feed = Math.max(0, s.feed);
      s.rewinding = false;
    }
    if (s.s >= MOST) {
      if (s.feed > 0.3) sound.play("thud", { gain: Math.min(0.5, s.feed * 0.15), pitch: 0.5 });
      s.s = MOST;
      s.feed = Math.min(0, s.feed);
    }
    s.angle += (s.feed / R) * delta;
    if (core.current) core.current.rotation.x = s.angle;
    // Winding back, the cloth near the bolt is guided on.
    // At rest the loose end is held lightly hanging down the front, swaying, where a hand will find it.
    const resting = s.hand === "none" && s.s < TAIL + 0.05;
    const reelWant = s.rewinding ? 1 : Math.max(resting ? 0.008 : 0, THREE.MathUtils.clamp(-s.feed / 1.5, 0, 1));
    if (resting) s.liftWant *= Math.exp(-delta * 3);
    s.reel += (reelWant - s.reel) * (1 - Math.exp(-delta * 4));
    u.reel.value = s.reel;

    // Where the cloth leaves the bolt: where a line from the cloth just off it touches the roll.
    s.lift += (s.liftWant - s.lift) * (1 - Math.exp(-delta * 5));
    if (s.rewinding) s.lift -= s.lift * (1 - Math.exp(-delta * 2));

    step(gl, cloth, from, { s: s.s, lift: s.lift }, delta, substeps, pairs, s.seconds);
    look.s.value = s.s;
    look.lift.value = s.lift;

    // Read the cloth back a few times a second: for the hand to land on, the lift, the focus and the sound.
    if (!s.reading && s.seconds - s.readAt > 0.08) {
      s.reading = true;
      const askedAt = s.seconds;
      (gl.getArrayBufferAsync(cloth.A.value) as Promise<ArrayBuffer>)
        .then((buffer) => {
          const data = new Float32Array(buffer);
          const gap = Math.max(askedAt - s.readAt, 1e-3);
          s.readAt = askedAt;
          absorb(s, data, gap, cloth);
        })
        .catch(() => {})
        .finally(() => (s.reading = false));
    }

    // Sound.
    const feedSpeed = Math.abs(s.feed);
    hiss.current?.level(Math.min(0.2, feedSpeed * 0.07), 0.08);
    hiss.current?.tone(0.35 + Math.min(0.4, feedSpeed * 0.08), 0.1);
    rush.current?.level(Math.min(0.32, Math.max(0, s.speed - 0.08) * 0.42), 0.15);
    rush.current?.tone(0.7 + Math.min(1.2, s.speed * 0.7), 0.2);
    const quarter = Math.floor(s.angle / (Math.PI / 2));
    if (quarter !== s.quarter) {
      s.quarter = quarter;
      if (feedSpeed > 0.15 && s.seconds - s.tickAt > 0.05) {
        s.tickAt = s.seconds;
        sound.play("brush", { gain: Math.min(0.22, 0.05 + feedSpeed * 0.05), pitch: 0.55 + Math.min(0.6, feedSpeed * 0.12) });
      }
    }
    s.flutterIn -= delta;
    if (s.speed > 0.3 && s.flutterIn <= 0) {
      s.flutterIn = 0.14 + Math.random() * 0.3;
      sound.play("peel", { variant: "silk", gain: Math.min(0.32, 0.05 + s.speed * 0.12), pitch: 0.8 + Math.random() * 0.5, pan: Math.random() * 1.2 - 0.6 });
    }

    // The moment worth sharing: much of the bolt out and billowing.
    if (!s.earned && s.s > 3.5 && s.speed > 0.25) {
      s.earned = true;
      followPrompt.earn("unrolled");
      shareResult.set("I unrolled a whole bolt of shot silk into thin air");
    }

    // The lens holds the cloth.
    scratch.w.copy(CENTRE).lerp(s.centroid, 0.5);
    focusDistance.value = Math.max(1, camera.position.distanceTo(scratch.w));
    focusBlur.value = 0.8;
  });

  return (
    <>
      <Backdrop />
      <StudioEnvironment
        ambient="#050404"
        intensity={0.8}
        boxes={[
          { position: [-5, 7, 3], scale: [4, 0.3, 4], color: "#ffe2c4", intensity: 3.2 },
          { position: [7, 2, -5], scale: [0.3, 5, 3], color: "#cdd6f0", intensity: 1.1 },
          { position: [0, -6, 2], scale: [6, 0.3, 6], color: "#2a1f18", intensity: 0.6 },
          { position: [2, 2, 8], scale: [4, 3, 0.3], color: "#fff1e2", intensity: 0.5 }
        ]}
      />
      <KeyLight position={[KEY.x, KEY.y, KEY.z]} target={[FOCUS.x, FOCUS.y, FOCUS.z]} color="#ffe0bf" intensity={300} angle={0.55} penumbra={0.9} shadowFar={14} />
      <RimLight />
      <Bolt centre={CENTRE} core={core} />
      <Sheet cloth={cloth} />
      <Air dust={startTier === "low" ? 900 : 2400} />
    </>
  );
}

// What the cloth's positions tell the frame loop: its speed (for the sound), its middle (for the focus), and the angle it
// leaves the bolt at.
function absorb(s: State, data: Float32Array, gap: number, cloth: Cloth) {
  const { COLS, dv } = cloth;
  const rows = Math.min(Math.ceil(s.s / dv), data.length / 4 / COLS);
  let moved = 0;
  let count = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let j = 0; j < rows; j += 2)
    for (let i = 0; i < COLS; i += 3) {
      const k = (j * COLS + i) * 4;
      cx += data[k];
      cy += data[k + 1];
      cz += data[k + 2];
      if (s.last) moved += Math.hypot(data[k] - s.last[k], data[k + 1] - s.last[k + 1], data[k + 2] - s.last[k + 2]);
      count++;
    }
  if (count) {
    s.centroid.set(cx / count, cy / count, cz / count);
    const speed = s.last ? moved / count / gap : 0;
    s.speed += (speed - s.speed) * 0.35;
  }
  // The row a little way off the bolt, averaged across: the line from it touching the roll gives the lift.
  const j = Math.max(0, Math.min(rows - 1, Math.floor((s.s - 0.14) / dv)));
  let qy = 0;
  let qz = 0;
  for (let i = 0; i < COLS; i++) {
    const k = (j * COLS + i) * 4;
    qy += data[k + 1];
    qz += data[k + 2];
  }
  qy = qy / COLS - CENTRE.y;
  qz = qz / COLS - CENTRE.z;
  const R = radiusAt(s.s);
  const far = Math.hypot(qy, qz);
  if (far > R * 1.05) {
    const beta = Math.atan2(qy, qz);
    const gamma = Math.acos(R / far);
    let best = s.liftWant;
    let bestGap = Infinity;
    for (const a of [beta + gamma, beta - gamma]) {
      // Cloth leaves the bolt the way it unwinds: down the front, along (0, -cos a, sin a).
      const py = R * Math.sin(a);
      const pz = R * Math.cos(a);
      const along = (qy - py) * -Math.cos(a) + (qz - pz) * Math.sin(a);
      if (along <= 0) continue;
      const g = Math.abs(wrap(a - s.lift));
      if (g < bestGap) {
        bestGap = g;
        best = s.lift + wrap(a - s.lift);
      }
    }
    // Cloth leaves from the front or over the top, never round the back where it would wind on again.
    s.liftWant = THREE.MathUtils.clamp(best, -1.3, 1.7);
  }
  s.last = s.data;
  s.data = data;
}

// A cool light from behind on the right, drawing the cloth's far edges out of the dark.
function RimLight() {
  const light = useMemo(() => {
    const l = new THREE.DirectionalLight("#dfe6f5", 1.1);
    l.position.set(3.5, 2, -4.5);
    return l;
  }, []);
  useEffect(() => () => light.dispose(), [light]);
  return <primitive object={light} />;
}

// This module only ever loads in the browser, so the screen can be asked here.
const PHONE = typeof window !== "undefined" && window.matchMedia("(max-width: 900px), (hover: none)").matches;

const day: DayDefinition = {
  camera: {
    position: [1.2, 0.85, 4.2],
    target: [0, 0.1, 0.35],
    fov: 38,
    phone: { position: [1.0, 0.35, 6.6], target: [0, -0.3, 0.4], fov: 46 },
    limits: { turn: { left: 70, right: 70, up: 45, down: 40 }, move: 0.7 }
  },
  hover: true,
  extents: { centre: [0, 0.1, 0.35], radius: 9 },
  look: { background: "#000000", exposure: 1.1, bloom: 0.3, bloomThreshold: 1.3, gi: 0, ao: 0.9, aoRadius: 0.12, vignette: 0.6, grain: 0.014, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, depthOfField: { range: 2.5 } },
  settings: {
    silk: {
      type: "choice",
      label: "Silk",
      value: "peacock",
      options: Object.entries(SILKS).map(([value, s]) => ({ value, label: s.label, swatch: [s.warp, s.weft] }))
    },
    weight: { type: "range", label: "Weight", min: 0, max: 1, step: 0.01, value: 0.35, reset: 0.35 },
    breeze: { type: "range", label: "Breeze", min: 0, max: 1, step: 0.01, value: 0.5, reset: 0.5 },
    rollBack: { type: "action", label: "Roll back" }
  },
  phoneDock: ["silk", "weight"],
  phoneDockPills: ["rollBack"],
  prompt: { title: "Pull the loose end", detail: "Or spin the bolt", ...(PHONE ? { low: true } : { high: true }) },
  hint: "Pull the loose end of the silk to unroll the bolt, and flick it to send waves down the cloth. Spin the bolt itself to spill it out; Roll back winds it on again.",
  notes: "A bolt of shot silk in a beam of light. Pull the loose end and the roll spins, paying out a long sheet of cloth that floats and folds in the air.",
  overview: [
    {
      title: "The cloth",
      points: [
        "Eight metres of silk as one particle grid, up to 48 × 320, stepped on the GPU: Verlet, then Jacobi passes for stretch, shear and bend.",
        "Tethers to the bolt and to the hand hold its length in one step; air drags hardest on cloth moving face first, so it floats and billows."
      ]
    },
    {
      title: "The bolt",
      points: [
        "Wound cloth sits on its exact spiral; the roll's spin, mass and friction are stepped from how far the hand pulls past the free cloth.",
        "As the bolt turns, rows leave it with its surface speed; Roll back reels the cloth in along the line it leaves by."
      ]
    },
    {
      title: "Shot silk",
      points: [
        "Warp and weft of two colours: face on it shows one, at a slant the other, with an anisotropic highlight drawn along the threads.",
        "Slubs, a woven selvedge and light through the thin cloth, in a soft beam with lit floaters, soft shadows and depth of field."
      ]
    }
  ],
  Scene
};

export default day;
