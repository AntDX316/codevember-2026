"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { lehmer } from "../../shared/engine/random";
import { useSettingRef } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Backdrop, Blob, FINISHES, look, RADIUS } from "./blob";
import { Dust, focus } from "./dust";
import { plink, singer } from "./sound";
import { buildTable, clock, table, DENT, DRIVE, omega, peak, PRESS, ringSpeed, rows, sendRows, TAPS } from "./waves";

// A little variety in each tap's pitch.
const jitter = lehmer(4117);

// How hard a tap strikes (its dent comes to about 0.07 of the radius), and the held tone's swell: shallower for the
// finer patterns, so every one tilts the surface about as much.
const TAP_KICK = 6;
const toneDepth = (l: number) => Math.min(0.06, 0.5 / l);
// Rings fade once this many are running, oldest first, so a new tap always has a row.
const RUNNING = 12;
const GONE = 12;
// A press held this long starts to sing.
const HOLD = 0.35;
// The tone walks up through the drop's own notes, one degree at a time, and back down.
const LOWEST = 6;
const HIGHEST = 22;
const STEP = 1.3;
// Each of the drop's notes is sung at a pitch rising with its frequency, gently, so the steps stay musical.
const noteOf = (l: number) => 196 * Math.pow(omega(l) / omega(LOWEST), 0.42);
// When a tap's rings meet at the far side, and when they come home.
const FAR_SIDE = Math.PI / ringSpeed;

const TAP_SCALE = -TAP_KICK / peak(DENT);
const pressWeight = (l: number) => ((2 * l + 1) / (4 * Math.PI)) * Math.exp(-0.5 * (l * PRESS) ** 2);

type Ring = { t0: number; dir: THREE.Vector3; gain: number; pitch: number; pan: number; echoes: number };

const scratch = { ray: new THREE.Ray(), sphere: new THREE.Sphere(new THREE.Vector3(), RADIUS * 1.03), hit: new THREE.Vector3() };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const finish = useSettingRef<string>("finish");
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;

  const state = useMemo(
    () => ({
      now: 0,
      rings: [] as (Ring | null)[],
      taps: 0,
      earned: false,
      // The held press: where it is on the drop, since when, and the tone it drives.
      press: null as null | { since: number; dir: THREE.Vector3; pan: number },
      drive: { level: 0, phase: 0, tone: omega(LOWEST), degree: LOWEST, way: 1, stepAt: 0, dir: new THREE.Vector3(0, 1, 0), voice: null as null | ReturnType<typeof singer> }
    }),
    []
  );
  state.rings.length = TAPS;

  const strike = (dir: THREE.Vector3, pan: number) => {
    const s = state;
    let slot = s.rings.findIndex((r) => !r);
    if (slot < 0) {
      let oldest = 0;
      for (let k = 1; k < TAPS; k++) if (s.rings[k]!.t0 < s.rings[oldest]!.t0) oldest = k;
      slot = oldest;
    }
    // Higher on the drop sounds higher.
    const pitch = 330 * Math.pow(2, dir.y * 0.5 + (jitter() - 0.5) * 0.12);
    s.rings[slot] = { t0: s.now, dir: dir.clone(), gain: 1, pitch, pan, echoes: 0 };
    plink(pitch, pan);
    s.taps++;
    dismissPrompt();
  };

  // A ray onto the drop, near enough: the waves never move it more than a few hundredths.
  const onDrop = (ray: THREE.Ray, out: THREE.Vector3) => ray.intersectSphere(scratch.sphere, out);
  const panOf = (dir: THREE.Vector3) => THREE.MathUtils.clamp(scratch.hit.copy(dir).project(camera).x, -1, 1);

  useGrabbable({
    pick: (ray) => {
      const at = onDrop(ray, new THREE.Vector3());
      return at ? { distance: ray.origin.distanceTo(at), point: at } : null;
    },
    grab: (point) => {
      const dir = point.clone().normalize();
      const pan = panOf(dir);
      strike(dir, pan);
      state.press = { since: state.now, dir, pan };
    },
    drag: (point) => {
      // The rig carries the point on a plane square to the view; cast back through it onto the drop.
      if (!state.press) return;
      scratch.ray.origin.copy(camera.position);
      scratch.ray.direction.copy(point).sub(camera.position).normalize();
      if (onDrop(scratch.ray, scratch.hit)) state.press.dir.copy(scratch.hit).normalize();
    },
    release: () => {
      state.press = null;
    }
  });

  useEffect(
    () => () => {
      state.drive.voice?.stop();
      state.drive.voice = null;
    },
    [state]
  );

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __ripple: { state, strike, look, table, gl } });

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const s = state;
    s.now += dt;
    const now = s.now;
    clock.value = now;

    // The finish eases from one to the next.
    const want = FINISHES[finish.current] ?? FINISHES.mercury;
    const ease = 1 - Math.exp(-dt * 5);
    look.f0.value.x += (want.f0[0] - look.f0.value.x) * ease;
    look.f0.value.y += (want.f0[1] - look.f0.value.y) * ease;
    look.f0.value.z += (want.f0[2] - look.f0.value.z) * ease;
    look.film.value += (want.film - look.film.value) * ease;
    look.body.value += (want.body - look.body.value) * ease;

    // Taps: the oldest fade once too many are running; each echoes when its rings meet beyond and when they come back.
    const live = s.rings.filter((r) => r && r.gain > 0.5).length;
    let over = live - RUNNING;
    const order = s.rings
      .map((r, k) => ({ r, k }))
      .filter((x) => x.r)
      .sort((a, b) => a.r!.t0 - b.r!.t0);
    for (const { r, k } of order) {
      const ring = r!;
      const age = now - ring.t0;
      if (over > 0 && ring.gain > 0.5) {
        ring.gain = 0.49;
        over--;
      }
      if (ring.gain < 0.5) ring.gain = Math.max(0, ring.gain - dt * 1.6);
      if (age > GONE || ring.gain <= 0) {
        s.rings[k] = null;
        continue;
      }
      if (ring.echoes === 0 && age > FAR_SIDE) {
        ring.echoes = 1;
        plink(ring.pitch, -ring.pan, 0.3, 0.55);
      } else if (ring.echoes === 1 && age > FAR_SIDE * 2) {
        ring.echoes = 2;
        plink(ring.pitch, ring.pan, 0.14, 0.85);
      }
    }
    for (let k = 0; k < TAPS; k++) {
      const ring = s.rings[k];
      if (!ring) {
        rows.at[k * 4 + 3] = 0;
        continue;
      }
      const age = now - ring.t0;
      const fade = ring.gain >= 0.5 ? 1 : ring.gain / 0.5;
      rows.at.set([ring.dir.x, ring.dir.y, ring.dir.z, fade * (1 - THREE.MathUtils.smoothstep(age, GONE - 3, GONE))], k * 4);
      rows.time.set([age, TAP_SCALE, 0, 1], k * 4);
    }

    // The held tone: it swells in, steps up through the drop's notes and back, and fades when let go.
    const d = s.drive;
    const holding = s.press && now - s.press.since > HOLD;
    if (holding && d.level < 0.02) {
      d.degree = LOWEST;
      d.way = 1;
      d.stepAt = now + STEP;
      d.tone = omega(LOWEST);
      d.dir.copy(s.press!.dir);
    }
    if (holding) {
      d.dir.lerp(s.press!.dir, 1 - Math.exp(-dt * 8)).normalize();
      if (now > d.stepAt) {
        d.stepAt = now + STEP;
        if (d.degree + d.way > HIGHEST || d.degree + d.way < LOWEST) d.way = -d.way;
        d.degree += d.way;
      }
      if (!d.voice) d.voice = singer(noteOf(d.degree));
    }
    d.level += ((holding ? 1 : 0) - d.level) * (1 - Math.exp(-dt * (holding ? 2 : 1.2)));
    d.tone += (omega(d.degree) - d.tone) * (1 - Math.exp(-dt * 5));
    d.phase = (d.phase + d.tone * dt) % (Math.PI * 2000);
    d.voice?.note(noteOf(d.degree) * (d.tone / omega(d.degree)) ** 0.42, d.level);
    if (!holding && d.voice && d.level < 0.6) {
      d.voice.stop();
      d.voice = null;
    }
    rows.at.set([d.dir.x, d.dir.y, d.dir.z, d.level > 0.002 ? d.level : 0], DRIVE * 4);
    rows.time.set([0, toneDepth(d.degree) / pressWeight(d.degree), d.phase, d.tone], DRIVE * 4);
    sendRows();
    gl.compute(buildTable);

    focus.value = camera.position.length();

    if (!s.earned && (s.taps >= 4 || (holding && d.degree >= LOWEST + 2))) {
      s.earned = true;
      followPrompt.earn("ripple");
      shareResult.set("Rang a drop of liquid metal and watched its echoes collide on the far side");
    }
  });

  return (
    <>
      <Backdrop />
      <Blob cells={startTier === "low" ? 96 : startTier === "medium" ? 150 : 200} />
      <Dust count={startTier === "low" ? 500 : 1400} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.55, 0.32, 4.6],
    target: [0, 0, 0],
    fov: 36,
    limits: { turn: { left: 80, right: 80, up: 60, down: 60 }, move: { left: 0.4, right: 0.4, down: 0.4, up: 0.4, nearer: 1.4, further: 2 } },
    phone: { position: [0.45, 0.28, 6.4], target: [0, 0, 0], fov: 44 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 12, color: "#c8d4ff" },
  look: { background: "#030304", exposure: 1, bloom: 0.35, bloomThreshold: 1, gi: 0, ao: 0, vignette: 0.5, grain: 0.014, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false },
  phonePills: ["finish"],
  settings: {
    finish: {
      type: "choice",
      label: "Finish",
      value: "mercury",
      options: Object.entries(FINISHES).map(([value, f]) => ({ value, label: f.label, swatch: f.swatch }))
    }
  },
  prompt: { title: "Tap the drop", detail: "Hold to make it sing", high: true },
  hint: "Tap the drop to ring it; hold to sing a tone. Drag around it to turn.",
  notes: "A drop of liquid metal that rings like a bell: each tap's ripples race round it, collide on the far side and echo home.",
  overview: [
    {
      title: "Waves",
      points: [
        "Real drop physics: the surface is a sum of 150 spherical harmonics, each ringing at Rayleigh's capillary frequency, so short ripples outrun long ones",
        "A compute pass sums the series for up to 17 pings each frame; holding drives it at its own resonances into standing waves"
      ]
    },
    {
      title: "Rendering",
      points: [
        "A 240k-vertex sphere displaced on the GPU, with normals worked out per pixel from the series' exact slopes",
        "Reflections of a procedural studio and an oil film whose thickness follows the waves"
      ]
    }
  ],
  Scene
};

export default day;
