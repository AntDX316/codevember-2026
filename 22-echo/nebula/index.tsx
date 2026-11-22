"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSettingRef } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { BOUNDS, ECHO_REACH, ECHO_SPEED, envelope, LOBES, lobeCentre, lobeSize, nebula, placeLobes, PRIMARIES, REACH, SLOTS, SPEED } from "./cloud";
import { Motes, Smoke, lens } from "./render";
import { type Return, sonar } from "./sound";

// A press held this long becomes a sweep, a pulse this often for as long as it lasts.
const HOLD = 0.35;
const SWEEP = 0.42;
// Each knot's own note, and its echo's tint between teal (0) and violet (1).
const NOTES = [440, 523.25, 587.33, 659.25, 783.99, 349.23];
const TINTS = [0.1, 0.95, 0.4, 0.75, 0.0, 0.55];
const PRIMARY_LIFE = REACH / SPEED + 0.3;
const ECHO_LIFE = ECHO_REACH / ECHO_SPEED + 0.2;

type Pending = { at: number; lobe: number; strength: number };

const OFF = typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("off") ?? "");
const probe = new THREE.Vector3();
const toEye = new THREE.Vector3();

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const density = useSettingRef<number>("smoke");
  const state = useRef({ now: 0, frame: 0, pending: [] as Pending[], held: false, heldAt: 0, sweeping: false, nextSweep: 0, at: new THREE.Vector3(), pulses: 0, earned: false });
  if (state.current.now === 0) placeLobes(0);

  // A slot for a shell: one free in the range, else the oldest there.
  const slot = (from: number, to: number, life: number) => {
    const origins = nebula.origins.array as THREE.Vector4[];
    let pick = from;
    let oldest = Infinity;
    for (let k = from; k < to; k++) {
      const born = origins[k].w;
      if (state.current.now - born > life) return k;
      if (born < oldest) {
        oldest = born;
        pick = k;
      }
    }
    return pick;
  };

  // A pulse leaves from a point on the smoke. Every knot it will reach answers in turn, as the front gets there.
  const pulse = (from: THREE.Vector3, strength: number, answers: number) => {
    const s = state.current;
    const k = slot(0, PRIMARIES, PRIMARY_LIFE);
    (nebula.origins.array as THREE.Vector4[])[k].set(from.x, from.y, from.z, s.now);
    (nebula.shells.array as THREE.Vector4[])[k].set(strength, SPEED, 0, 0);
    const heard: (Pending & { distance: number })[] = [];
    for (let l = 0; l < LOBES; l++) {
      const distance = lobeCentre(l).distanceTo(from);
      if (distance < 0.25 || distance > REACH * 0.8) continue;
      const level = strength * (lobeSize(l) / 0.78) * Math.min(1, 1.35 - distance * 0.3);
      heard.push({ at: s.now + distance / SPEED, lobe: l, strength: level, distance });
    }
    heard.sort((a, b) => b.strength - a.strength);
    const kept = heard.slice(0, answers);
    s.pending.push(...kept);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const returns: Return[] = kept.map((h) => ({ delay: h.at - s.now, pitch: NOTES[h.lobe], level: Math.min(0.75, h.strength * 0.7), pan: lobeCentre(h.lobe).dot(right) * 0.7 }));
    sonar(880, strength, returns);
    s.pulses++;
  };

  // Where a ray first meets the smoke: stepped through the lobes, as the shader sees them before the noise.
  const pick = (ray: THREE.Ray) => {
    const b = ray.origin.dot(ray.direction);
    const c = ray.origin.lengthSq() - BOUNDS * BOUNDS;
    const h = b * b - c;
    if (h < 0) return null;
    const enter = Math.max(0, -b - Math.sqrt(h));
    const leave = -b + Math.sqrt(h);
    let hit = -1;
    let best = 0;
    let deepest = 0;
    for (let t = enter; t < leave; t += 0.02) {
      ray.at(t, probe);
      const e = envelope(probe);
      if (hit < 0 && e > 0.55) hit = t;
      if (e > best) {
        best = e;
        deepest = t;
      }
    }
    if (hit < 0) return null;
    // The pulse leaves from the thickest smoke along the ray, so its front rings out across the face of the cloud.
    return { distance: hit, point: ray.at(deepest, new THREE.Vector3()) };
  };

  useGrabbable({
    pick,
    grab: (point) => {
      const s = state.current;
      s.held = true;
      s.heldAt = s.now;
      s.sweeping = false;
      s.at.copy(point);
      dismissPrompt();
      pulse(point, 1, LOBES);
    },
    drag: () => {},
    release: () => {
      state.current.held = false;
      state.current.sweeping = false;
    }
  });

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const s = state.current;
    s.now += dt;
    const now = s.now;
    nebula.time.value = now;
    nebula.frame.value = s.frame = (s.frame + 1) % 64;
    nebula.drift.value.set(now * 0.005, now * -0.013, now * 0.0035);
    nebula.density.value += ((density.current ?? 1) - nebula.density.value) * (1 - Math.exp(-dt * 3));
    placeLobes(now);

    // Held: a train of pulses from where the press landed, each a little softer, with fewer answers.
    if (s.held && !s.sweeping && now - s.heldAt > HOLD) {
      s.sweeping = true;
      s.nextSweep = now;
    }
    if (s.sweeping && now >= s.nextSweep) {
      s.nextSweep = now + SWEEP;
      pulse(s.at, 0.7, 3);
    }

    for (let k = s.pending.length - 1; k >= 0; k--) {
      const p = s.pending[k];
      if (now < p.at) continue;
      const e = slot(PRIMARIES, SLOTS, ECHO_LIFE);
      const c = lobeCentre(p.lobe);
      (nebula.origins.array as THREE.Vector4[])[e].set(c.x, c.y, c.z, now);
      (nebula.shells.array as THREE.Vector4[])[e].set(p.strength * 1.4, ECHO_SPEED, 1, TINTS[p.lobe]);
      s.pending.splice(k, 1);
    }

    const origins = nebula.origins.array as THREE.Vector4[];
    let top = 0;
    let pushes = 0;
    for (let k = 0; k < SLOTS; k++)
      if (now - origins[k].w < (k < PRIMARIES ? PRIMARY_LIFE + 2 : ECHO_LIFE)) {
        top = k + 1;
        if (k < PRIMARIES) pushes = k + 1;
      }
    nebula.top.value = top;
    nebula.pushes.value = pushes;

    lens.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);
    lens.focus.value = toEye.copy(camera.position).length();

    if (!s.earned && s.pulses >= 5) {
      s.earned = true;
      followPrompt.earn("nebula");
      shareResult.set("Sounded a cloud of smoke and watched its echoes light it from inside");
    }
  });

  const low = startTier === "low";
  return (
    <>
      {!OFF.includes("smoke") && <Smoke tier={tier} />}
      {!OFF.includes("motes") && <Motes count={low ? 700 : startTier === "medium" ? 1300 : 1900} />}
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.45, 0.35, 5.5],
    target: [0, 0, 0],
    fov: 36,
    limits: { turn: { left: 80, right: 80, up: 55, down: 55 }, move: 0.6 },
    phone: { position: [0.45, 0.35, 8.6], target: [0, 0, 0], fov: 44 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 14, color: "#cfd8e6" },
  look: { background: "#020306", exposure: 1, bloom: 0.6, bloomThreshold: 0.55, gi: 0, ao: 0, vignette: 0.6, grain: 0.02, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false, temporal: false },
  settings: {
    smoke: { type: "range", label: "Smoke", min: 0.5, max: 1.8, step: 0.05, value: 1, reset: 1 }
  },
  prompt: { title: "Tap the cloud", detail: "Hold to keep sounding; drag around it to turn", low: true },
  hint: "Tap the smoke to send a pulse through it: a shell of light slices the cloud, and its dense knots answer with echoes. Hold for a sweep.",
  notes: "A cloud of dark smoke sounded like sonar: each pulse is a shell of light slicing through it, and every dense knot it reaches answers with an echo of its own.",
  overview: [
    { title: "Smoke", points: ["Raymarched at half resolution into a buffer of its own, with blue-noise starts that a reprojected history averages away", "Six wandering soft lobes, worn into billows by a baked tiling cube of noise read through a slow warp"] },
    { title: "Pulses", points: ["Each shell lights only the smoke where its front is, shadowed by the smoke between, and pushes the billows outward as it passes", "The lobes are known on the processor too, so each echo leaves its knot just as the front is seen to reach it, and is heard then"] }
  ],
  Scene
};

export default day;
