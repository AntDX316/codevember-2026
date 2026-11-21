"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { suspend } from "suspend-react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingsStore } from "../../shared/engine/settings";
import { useBed } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { BoltMeshes, growBolt, useBolts, type Segment } from "./bolt";
import { StormCloud } from "./cloud";
import { Rain } from "./rain";
import { BASE, storm } from "./state";
import { crack, sizzle, thunder } from "./thunder";
import { bakeStorm, type StormVolume } from "./volume";

// The middle of the cloud's base, where the rain falls and the strikes leave from.
const CORE = new THREE.Vector2(0.7, 0.4);
// How far from the core a strike may land, and the rain may be swept.
const REACH = 13;
const RAIN_REACH = 6.5;
// The bolt's clock in slow motion: the leader takes a couple of seconds to find the sea.
const SLOW = 0.06;

type Pulse = { at: number; power: number; decay: number };
type Flash = { from: THREE.Vector3; drift: THREE.Vector3; start: number; length: number; pulses: Pulse[] };
type Strike = { start: number; land: number; strokes: Pulse[]; top: THREE.Vector3; bottom: THREE.Vector3; main: Segment[]; cracked: boolean; pan: number; distance: number; slot: number };

const flashPower = (pulses: Pulse[], t: number) => {
  let sum = 0;
  for (const p of pulses) {
    const d = t - p.at;
    if (d < 0) continue;
    // A few milliseconds to rise, then gone over its decay.
    sum += p.power * Math.min(1, d / 0.004) * Math.exp(-d / p.decay);
  }
  return sum;
};

// A flicker of pulses, as in-cloud lightning comes: two to eight bursts over the better part of a second.
function flicker(random: () => number, count: number, strength: number) {
  const pulses: Pulse[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    pulses.push({ at, power: strength * (0.35 + random() * 0.65) * (i === 0 ? 1 : 0.85), decay: 0.03 + random() * 0.1 });
    at += 0.025 + random() * random() * 0.22;
  }
  return pulses;
}

const scratch = {
  ray: new THREE.Raycaster(),
  ndc: new THREE.Vector2(),
  point: new THREE.Vector3(),
  forward: new THREE.Vector3()
};

// Where a ray meets the sea, within reach of the storm, or null.
function seaPoint(ray: THREE.Ray, out: THREE.Vector3) {
  if (ray.direction.y > -1e-3) return null;
  const t = -ray.origin.y / ray.direction.y;
  out.copy(ray.origin).addScaledVector(ray.direction, t);
  return t;
}

// Where a ray first meets the cloud, by stepping through the baked density, or null.
function cloudPoint(volume: StormVolume, ray: THREE.Ray, out: THREE.Vector3) {
  for (let t = 1; t < 90; t += 0.2) {
    out.copy(ray.origin).addScaledVector(ray.direction, t);
    if (out.y < 0) return null;
    if (volume.densityAt(out.x, out.y, out.z) > 0.3) return t;
  }
  return null;
}

function Scene() {
  const volume = suspend(bakeStorm, ["bolt-storm-volume"]);
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const bolts = useBolts();
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const activity = useSetting<number>("activity");
  const rainAmount = useSetting<number>("rain");
  const slow = useSetting<boolean>("slow");
  const store = useSettingsStore();

  const state = useRef({
    clock: 0,
    random: Math.random,
    flashes: [null, null] as (Flash | null)[],
    nextFlash: 1.5,
    strikes: [null, null] as (Strike | null)[],
    nextSlot: 0,
    held: false,
    pressedOn: false,
    down: { x: 0, y: 0, at: 0, moved: 0 },
    pointer: { x: 0, y: 0 },
    rain: new THREE.Vector2(CORE.x, CORE.y),
    rainTarget: new THREE.Vector2(CORE.x, CORE.y),
    rainLevel: 1,
    lastRumble: -10,
    // Seconds on the wall clock since the scene began, for spacing out the thunder.
    seconds: 0,
    struck: 0,
    earned: false,
    // For checking frames by hand in development: the storm's clock held still.
    paused: false
  });

  // Call a strike down to a point on the sea.
  const strike = (target: THREE.Vector3) => {
    const s = state.current;
    const r = s.random;
    const off = new THREE.Vector2(target.x - CORE.x, target.z - CORE.y);
    if (off.length() > REACH) off.setLength(REACH);
    const bottom = new THREE.Vector3(CORE.x + off.x, 0, CORE.y + off.y);
    // It leaves the base above and a little toward the core, so a far strike slants out from under the cloud.
    const lean = off.clone().multiplyScalar(0.32);
    if (lean.length() > 3.4) lean.setLength(3.4);
    const top = new THREE.Vector3(CORE.x + lean.x + (r() - 0.5) * 0.8, BASE - 0.05, CORE.y + lean.y + (r() - 0.5) * 0.8);
    const { segments, land } = growBolt(top, bottom, r);
    const slot = s.nextSlot;
    s.nextSlot = (s.nextSlot + 1) % 2;
    bolts.write(slot, segments);
    // The return stroke, then two to four restrikes down the same channel.
    const strokes: Pulse[] = [{ at: 0, power: 1, decay: 0.05 }];
    let at = 0;
    const more = 2 + Math.floor(r() * 3);
    for (let i = 0; i < more; i++) {
      at += 0.05 + r() * 0.09;
      strokes.push({ at, power: 0.45 + r() * 0.4, decay: 0.025 + r() * 0.03 });
    }
    const distance = camera.position.distanceTo(bottom);
    scratch.point.copy(bottom).project(camera);
    const strikeState: Strike = {
      start: s.clock,
      land,
      strokes,
      top,
      bottom,
      main: segments.filter((g) => g.main),
      cracked: false,
      pan: THREE.MathUtils.clamp(scratch.point.x * 0.8, -0.9, 0.9),
      distance,
      slot
    };
    s.strikes[slot] = strikeState;
    if (slow) sizzle(0.06, land / SLOW, strikeState.pan);
    s.struck++;
    if (!s.earned && s.struck >= 3) {
      s.earned = true;
      followPrompt.earn("strike");
      shareResult.set("Called lightning down out of a thundercloud");
    }
    dismissPrompt();
  };

  // A flash inside the cloud at a point, or anywhere in it.
  const flashIn = (at: THREE.Vector3 | null, strength: number, big = false) => {
    const s = state.current;
    const r = s.random;
    let from = at;
    if (!from) {
      const k = Math.floor(r() * (volume.inside.length / 3)) * 3;
      from = new THREE.Vector3(volume.inside[k], volume.inside[k + 1], volume.inside[k + 2]);
    }
    const slot = !s.flashes[0] ? 0 : !s.flashes[1] ? 1 : s.flashes[0].start < s.flashes[1].start ? 0 : 1;
    const crawl = big || r() < 0.3;
    const drift = new THREE.Vector3(r() - 0.5, (r() - 0.5) * 0.3, r() - 0.5).multiplyScalar(crawl ? 7 : 1.5);
    const pulses = flicker(r, crawl ? 5 + Math.floor(r() * 5) : 2 + Math.floor(r() * 4), strength);
    const length = pulses[pulses.length - 1].at + 0.5;
    s.flashes[slot] = { from, drift, start: s.clock, length, pulses };
    // A rumble from far off, a little after, now and then.
    if (s.seconds - s.lastRumble > 2.5) {
      s.lastRumble = s.seconds;
      scratch.point.copy(from).project(camera);
      const pan = THREE.MathUtils.clamp(scratch.point.x * 0.7, -0.8, 0.8);
      window.setTimeout(() => thunder(0.16 + strength * 0.1, 0.12, pan, 4 + r() * 3), (1.2 + r() * 1.8) * 1000);
    }
  };

  // A press on the sea calls a strike there and takes hold of the rain; a press elsewhere turns the view.
  useGrabbable({
    pick: (ray) => {
      const t = seaPoint(ray, scratch.point);
      if (t === null) return null;
      if (Math.hypot(scratch.point.x - CORE.x, scratch.point.z - CORE.y) > 24) return null;
      // A tap that meets the cloud before the sea is for the cloud.
      const hit = cloudPoint(volume, ray, new THREE.Vector3());
      if (hit !== null && hit < t) return null;
      return { distance: t, point: scratch.point.clone() };
    },
    grab: (point) => {
      const s = state.current;
      s.held = true;
      s.pressedOn = true;
      strike(point);
    },
    drag: () => {},
    release: () => {
      state.current.held = false;
    }
  });

  // The pointer, followed so a drag across the sea sweeps the rain, and a tap on the cloud lights it.
  useEffect(() => {
    const el = gl.domElement;
    const toNdc = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const s = state.current;
      s.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      s.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };
    const down = (e: PointerEvent) => {
      const s = state.current;
      toNdc(e);
      s.down = { x: e.clientX, y: e.clientY, at: performance.now(), moved: 0 };
    };
    const move = (e: PointerEvent) => {
      const s = state.current;
      toNdc(e);
      s.down.moved = Math.max(s.down.moved, Math.hypot(e.clientX - s.down.x, e.clientY - s.down.y));
    };
    const up = (e: PointerEvent) => {
      const s = state.current;
      const tapped = !s.pressedOn && s.down.moved < 8 && performance.now() - s.down.at < 400;
      s.pressedOn = false;
      if (!tapped) return;
      toNdc(e);
      scratch.ndc.set(s.pointer.x, s.pointer.y);
      scratch.ray.setFromCamera(scratch.ndc, camera);
      const hit = new THREE.Vector3();
      if (cloudPoint(volume, scratch.ray.ray, hit) === null) return;
      hit.addScaledVector(scratch.ray.ray.direction, 1.2);
      flashIn(hit, 1.15, true);
      dismissPrompt();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handlers read the latest state through refs.
  }, [gl, camera, volume]);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __storm: { state, strike, flashIn, camera, storm }, __stormStore: store });

  // Rain on the sea, heavier as the rain is turned up; the thunder comes with each flash and strike.
  useBed("rain", 0.05 + rainAmount * 0.07);

  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 20);
    const s = state.current;
    const rate = s.paused ? 0 : slow ? SLOW : 1;
    s.seconds += delta;
    s.clock += delta * rate;
    storm.time.value = s.clock;
    bolts.freshness.value = 40;

    // The eye's frame, for everything drawn to face it.
    camera.getWorldDirection(scratch.forward);
    storm.forward.value.copy(scratch.forward);
    storm.right.value.setFromMatrixColumn(camera.matrixWorld, 0);
    storm.up.value.setFromMatrixColumn(camera.matrixWorld, 1);
    const height = gl.domElement.height || 1;
    storm.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;

    // The rain follows a drag across the sea, and stays where it is left.
    if (s.held) {
      scratch.ndc.set(s.pointer.x, s.pointer.y);
      scratch.ray.setFromCamera(scratch.ndc, camera);
      if (s.down.moved > 10 && seaPoint(scratch.ray.ray, scratch.point) !== null) {
        const off = new THREE.Vector2(scratch.point.x - CORE.x, scratch.point.z - CORE.y);
        if (off.length() > RAIN_REACH) off.setLength(RAIN_REACH);
        s.rainTarget.set(CORE.x + off.x, CORE.y + off.y);
      }
    }
    s.rain.lerp(s.rainTarget, 1 - Math.exp(-delta * 3));
    s.rainLevel += (rainAmount - s.rainLevel) * (1 - Math.exp(-delta * 2));
    storm.rain.value.set(s.rain.x, s.rain.y, 2.6, s.rainLevel);

    // Flashes inside the cloud, on their own, as often as the storm is set to.
    if (activity > 0.01 && s.clock > s.nextFlash) {
      flashIn(null, 0.8 + s.random() * 0.5);
      s.nextFlash = s.clock + (0.6 + -Math.log(1 - s.random()) * 3.4) / activity;
    }
    let flash = 0;
    for (let i = 0; i < 2; i++) {
      const f = s.flashes[i];
      const u = storm.ic[i].value;
      if (!f) {
        u.w = 0;
        continue;
      }
      const t = s.clock - f.start;
      if (t > f.length) {
        s.flashes[i] = null;
        u.w = 0;
        continue;
      }
      const along = Math.min(1, t / f.length);
      u.set(f.from.x + f.drift.x * along, f.from.y + f.drift.y * along, f.from.z + f.drift.z * along, flashPower(f.pulses, t) * 4);
      flash += u.w;
    }

    // The strikes: the leader creeping down, then the return stroke and its restrikes.
    let lit: Strike | null = null;
    let litPower = 0;
    let tipGlow = 0;
    const tip = new THREE.Vector3();
    for (let i = 0; i < 2; i++) {
      const k = s.strikes[i];
      const slotUniform = bolts.slots[i].value;
      if (!k) {
        slotUniform.set(-1, 0, 0, 0);
        continue;
      }
      const t = s.clock - k.start;
      const after = t - k.land;
      const last = k.strokes[k.strokes.length - 1].at;
      if (after > last + 1.2) {
        s.strikes[i] = null;
        slotUniform.set(-1, 0, 0, 0);
        continue;
      }
      let main = 0;
      let branches = 0;
      if (after >= 0) {
        main = flashPower(k.strokes, after);
        // The continuing current: a dimmer glow down the channel for a moment after the first stroke.
        main += 0.22 * Math.exp(-after / 0.2);
        branches = Math.exp(-after / 0.045) + 0.12 * flashPower(k.strokes.slice(1), after);
        if (!k.cracked) {
          k.cracked = true;
          const near = THREE.MathUtils.clamp(1 - (k.distance - 14) / 30, 0.2, 1);
          crack(0.55 * near + 0.15, k.pan, slow ? 0.75 : 1);
          window.setTimeout(() => thunder(0.85, near, k.pan, 5.5), (0.25 + k.distance * 0.035) * 1000);
        }
      }
      const leader = after < 0 ? 1 : 0;
      slotUniform.set(t, main, branches, leader);
      if (leader > 0) {
        // The tip of the leader, where it has got to.
        for (const g of k.main) {
          if (t < g.t1) {
            tip.copy(g.a).lerp(g.b, THREE.MathUtils.clamp((t - g.t0) / Math.max(1e-6, g.t1 - g.t0), 0, 1));
            break;
          }
        }
      } else tip.copy(k.bottom);
      if (!lit || k.start > lit.start) {
        lit = k;
        litPower = main;
        tipGlow = leader;
      }
    }
    // The channel lights the cloud base, the rain and the water; the base itself flares with it.
    const ic = storm.ic[2].value;
    if (lit) {
      storm.top.value.set(lit.top.x, lit.top.y, lit.top.z, litPower * 2.4);
      storm.tip.value.set(tip.x, tip.y, tip.z, tipGlow * 0.12);
      ic.set(lit.top.x, lit.top.y + 1.0, lit.top.z, litPower * 1.4 + tipGlow * 0.1);
    } else {
      storm.top.value.w = 0;
      storm.tip.value.w = 0;
      ic.w = 0;
    }
    flash += ic.w + litPower;
    storm.flash.value = flash;
  });

  return (
    <>
      <StormCloud volume={volume} />
      <BoltMeshes bolts={bolts} />
      <Rain drops={startTier === "low" ? 800 : startTier === "medium" ? 1400 : 2000} motes={startTier === "low" ? 30 : 60} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0, 1.6, 34],
    target: [1, 5.9, 0],
    fov: 50,
    limits: { turn: { left: 60, right: 60, up: 26, down: 6 }, move: { left: 2, right: 2, down: 1, up: 2, nearer: 9, further: 8 } },
    phone: { position: [1.5, 2, 50], target: [1.5, 8.4, 0], fov: 68 }
  },
  hover: true,
  extents: { centre: [1, 6, 0], radius: 50, floor: 0.6, color: "#9fb4dc" },
  // Black behind: the bolts and the rain are added over the whole frame in the overlay pass.
  look: { background: "#000000", exposure: 1.0, bloom: 0.3, bloomThreshold: 1.1, gi: 0, ao: 0, vignette: 0.55, grain: 0.02, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, temporal: false, occlusion: false },
  settings: {
    activity: { type: "range", label: "Flashes in the cloud", short: "Flashes", min: 0, max: 2, step: 0.01, value: 1, reset: 1 },
    rain: { type: "range", label: "Rain", min: 0, max: 2, step: 0.01, value: 1, reset: 1 },
    slow: { type: "toggle", label: "Slow motion", value: false }
  },
  phoneDock: ["activity", "rain"],
  phonePills: ["slow"],
  // Low on the screen, over the sea it asks to be tapped, clear of the cloud.
  prompt: { title: "Tap the sea to call down lightning", detail: "Drag across the water to move the rain", low: true },
  hint: "Tap the dark water to call a strike there; drag across it to sweep the rain. Tap the cloud to light it from inside. Slow motion shows the leader feeling its way down.",
  notes: "A lone thundercloud over a black, still sea, flickering with lightning inside it. Tap the water and a bolt finds its way down to it.",
  overview: [
    {
      title: "Cloud",
      points: [
        "A cumulonimbus baked once into a 3D texture: tower, turrets, anvil and mammatus as a distance field, billowed by Perlin–Worley noise.",
        "Moonlight through it is baked too, so each ray step is one tap; finer noise rising through the edges keeps it boiling."
      ]
    },
    {
      title: "Light",
      points: [
        "Raymarched at half resolution with several scattering orders, so the rim facing the moon silvers and the inside still glows.",
        "Flashes inside spread through the cloud as diffused light; the channel to the sea lights the base, the rain and the mist."
      ]
    },
    {
      title: "Bolt",
      points: [
        "A stepped leader grown step by step toward the tap, branching as it goes; the return stroke and restrikes follow its path.",
        "The sea is a mirror marched in the same pass, roughened under the rain; thunder is delayed by the strike's distance."
      ]
    }
  ],
  Scene
};

export default day;
