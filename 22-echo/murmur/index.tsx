"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { scenePhase, useQuality } from "../../shared/engine/quality";
import { useSetting } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { CAPSULES, createFlock, FRONTS, shapeAt, SPEED } from "./flock";
import { Birds, Shells, Sky, skyColours } from "./render";
import { chirp, rush } from "./sound";

// Each a sky the flock is ink against, and the light a startled bird catches.
const SKIES = {
  dusk: { label: "Dusk", zenith: "#0a0e1f", band: "#4b4258", sun: "#e08752", below: "#15141f", glint: "#bff6ff" },
  blue: { label: "Blue hour", zenith: "#03060e", band: "#1d2c48", sun: "#5f86b8", below: "#080d18", glint: "#e9fbff" },
  ember: { label: "Ember", zenith: "#080407", band: "#33181a", sun: "#e2512a", below: "#120709", glint: "#8fe9ff" }
} as const;
type Skies = keyof typeof SKIES;

// A press held still this long starts a feeding buzz; a shorter one that barely moves is a single chirp.
const HOLD = 300;
const TAP = 0.35;
// The buzz: the gap between chirps, from its first to its fastest, and how quickly it closes.
const BUZZ = { first: 0.2, last: 0.045, rate: 1.3 };

const scratch = { ndc: new THREE.Vector2(), caster: new THREE.Raycaster(), at: new THREE.Vector3(), colour: new THREE.Color() };
const ends = Array.from({ length: CAPSULES * 2 }, () => new THREE.Vector3());
const radii = new Array<number>(CAPSULES).fill(1);

type Pending = { at: number; where: THREE.Vector3; power: number; gain: number; pan: number };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const flock = useMemo(() => createFlock(startTier), [startTier]);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const sky = useSetting<Skies>("sky");

  const state = useRef({
    clock: 0,
    holding: false,
    buzzFrom: 0,
    nextChirp: 0,
    pending: [] as Pending[],
    chirps: 0,
    heldFor: 0,
    centres: Array.from({ length: CAPSULES }, () => ({ at: new THREE.Vector3(), size: 1 })),
    middle: new THREE.Vector3(),
    pointer: { x: 0, y: 0 },
    press: null as null | { id: number; x: number; y: number; t: number },
    presses: 0,
    warmed: false,
    earned: false
  });

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __murmur: flock, __murmurGl: gl });

  // Where a chirp starts: the nearest the press's ray comes to the middle of the flock, kept within its reach.
  const aim = useMemo(
    () => (x: number, y: number) => {
      scratch.ndc.set(x, y);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      const ray = scratch.caster.ray;
      const m = state.current.middle;
      const along = scratch.at.copy(m).sub(ray.origin).dot(ray.direction);
      scratch.at.copy(ray.origin).addScaledVector(ray.direction, along).sub(m);
      if (scratch.at.length() > 3.2) scratch.at.setLength(3.2);
      return scratch.at.add(m).clone();
    },
    [camera]
  );

  // A front from a point, in the slot that has been quiet longest.
  const send = useMemo(
    () => (at: THREE.Vector3, t0: number, power: number) => {
      let best = 0;
      for (let k = 1; k < FRONTS; k++) if (flock.u.fronts[k].value.w < flock.u.fronts[best].value.w) best = k;
      flock.u.fronts[best].value.set(at.x, at.y, at.z, t0);
      flock.u.power[best].value = power;
    },
    [flock]
  );

  // A chirp: its front runs out through the flock, startling it, and comes back off the densest parts as fainter fronts of
  // their own, each heard as it shows.
  const call = useMemo(
    () => (x: number, y: number, buzz: number) => {
      const s = state.current;
      const at = aim(x, y);
      const power = buzz > 0 ? 0.45 : 1;
      send(at, s.clock, power);
      chirp({ pan: x * 0.6, short: buzz > 0, gain: buzz > 0 ? 0.7 : 1, pitch: 1 + buzz * 0.25 });
      // A buzz is mostly chirps out; only now and then does one bring an echo back, or the fronts run out.
      if (buzz === 0 || s.chirps % 4 === 0) {
        const far = [...s.centres].sort((p, q) => q.size - p.size).slice(0, 2);
        for (const c of far) {
          const d = c.at.distanceTo(at);
          if (d < 0.8) continue;
          s.pending.push({ at: s.clock + d / SPEED, where: c.at.clone(), power: power * 0.45, gain: buzz > 0 ? 0.5 : 0.9, pan: Math.max(-1, Math.min(1, c.at.x * 0.25)) });
        }
      }
      if (buzz === 0) rush({ pan: x * 0.4, length: 1.4 });
      s.chirps++;
      dismissPrompt();
    },
    [aim, send]
  );

  useEffect(() => {
    const el = gl.domElement;
    const s = state.current;
    const ndc = (cx: number, cy: number) => {
      const rect = el.getBoundingClientRect();
      return [((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1];
    };
    const down = (e: PointerEvent) => {
      s.presses++;
      s.pointer = { x: e.clientX, y: e.clientY };
      if (e.pointerType === "mouse" && e.button !== 0) return;
      s.press = s.presses === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
    };
    const move = (e: PointerEvent) => {
      s.pointer = { x: e.clientX, y: e.clientY };
    };
    const up = (e: PointerEvent) => {
      s.presses = Math.max(0, s.presses - 1);
      const p = s.press;
      if (!p || p.id !== e.pointerId) return;
      s.press = null;
      if (s.holding) return;
      const still = Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8;
      if (!still || (performance.now() - p.t) / 1000 > TAP) return;
      const [x, y] = ndc(e.clientX, e.clientY);
      call(x, y, 0);
    };
    el.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [gl, call]);

  // A press held still is a feeding buzz: chirps coming faster and faster for as long as it lasts, the view held still.
  useGrabbable({
    pick: (ray) => (state.current.presses > 1 ? null : { distance: 1, point: ray.at(1, new THREE.Vector3()) }),
    holdToGrab: HOLD,
    grab: () => {
      const s = state.current;
      s.holding = true;
      s.buzzFrom = s.clock;
      s.nextChirp = s.clock;
      dismissPrompt();
    },
    drag: () => {},
    release: () => {
      state.current.holding = false;
    }
  });

  const step = (dt: number) => {
    const s = state.current;
    const u = flock.u;
    s.clock += dt;
    u.now.value = s.clock;
    u.dt.value = dt;
    s.middle.set(0, 0, 0);
    shapeAt(s.clock, ends, radii);
    for (let k = 0; k < CAPSULES; k++) {
      const a = ends[k * 2];
      const b = ends[k * 2 + 1];
      u.caps[k].a.value.set(a.x, a.y, a.z, radii[k]);
      u.caps[k].b.value.copy(b);
      const c = s.centres[k];
      c.at.copy(a).add(b).multiplyScalar(0.5);
      c.size = radii[k] * (1 + a.distanceTo(b) * 0.5);
      s.middle.addScaledVector(c.at, 1 / CAPSULES);
    }
    // The wind the flock wheels round leans slowly about, so the wheeling never settles into one plane.
    const w = s.clock * 0.05;
    u.wind.value.set(Math.sin(w * 1.3) * 0.6, 1, Math.cos(w) * 0.5).normalize();
    gl.compute(flock.update);
  };

  useFrame((_, raw) => {
    const s = state.current;
    const u = flock.u;
    // Behind the loader, the flock is let find its shape so the first frame already shows a murmuration.
    if (!s.warmed) {
      s.warmed = true;
      for (let k = 0; k < 150; k++) step(1 / 30);
    }

    const m = camera.matrixWorld.elements;
    u.eye.value.copy(camera.position);
    u.forward.value.set(-m[8], -m[9], -m[10]);
    u.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);

    const dt = Math.min(raw, 1 / 20);
    if (s.holding) {
      s.heldFor += dt;
      if (s.clock >= s.nextChirp) {
        const rect = gl.domElement.getBoundingClientRect();
        const x = ((s.pointer.x - rect.left) / rect.width) * 2 - 1;
        const y = -((s.pointer.y - rect.top) / rect.height) * 2 + 1;
        const held = s.clock - s.buzzFrom;
        call(x, y, Math.min(1, held / 2));
        s.nextChirp = s.clock + BUZZ.last + (BUZZ.first - BUZZ.last) * Math.exp(-held * BUZZ.rate);
      }
    }
    for (let k = s.pending.length - 1; k >= 0; k--) {
      const p = s.pending[k];
      if (s.clock < p.at) continue;
      send(p.where, p.at, p.power);
      chirp({ gain: p.gain, pan: p.pan, echo: true });
      s.pending.splice(k, 1);
    }

    const look = SKIES[sky] ?? SKIES.dusk;
    const ease = 1 - Math.exp(-Math.max(dt, 0.016) * 4);
    skyColours.zenith.value.lerp(scratch.colour.set(look.zenith), ease);
    skyColours.band.value.lerp(scratch.colour.set(look.band), ease);
    skyColours.sun.value.lerp(scratch.colour.set(look.sun), ease);
    skyColours.below.value.lerp(scratch.colour.set(look.below), ease);
    u.glint.value.lerp(scratch.colour.set(look.glint), ease);

    if (dt > 0) step(dt);
    gl.domElement.style.cursor = "crosshair";

    if (!s.earned && scenePhase.current === "live" && (s.chirps >= 5 || s.heldFor > 3)) {
      s.earned = true;
      followPrompt.earn("echo");
      shareResult.set("Sent a sonar chirp rippling through a murmuration");
    }
  });

  return (
    <>
      <Sky />
      <Birds flock={flock} />
      <Shells flock={flock} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0, 0.3, 10.5],
    target: [0, 0, 0],
    fov: 40,
    limits: { turn: { left: 80, right: 80, up: 50, down: 35 }, move: { left: 0.5, right: 0.5, down: 0.5, up: 0.5, nearer: 4, further: 4 } },
    phone: { position: [0, 0.3, 17], target: [0, 0, 0], fov: 50 }
  },
  extents: { centre: [0, 0, 0], radius: 30, color: "#d8794c" },
  look: { background: "#05070f", exposure: 1, bloom: 0.55, bloomThreshold: 0.6, gi: 0, ao: 0, haze: 0, vignette: 0.55, grain: 0.025 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false, temporal: false },
  settings: {
    sky: {
      type: "choice",
      label: "Sky",
      value: "dusk",
      options: (Object.keys(SKIES) as Skies[]).map((k) => ({ value: k, label: SKIES[k].label, swatch: [SKIES[k].sun, SKIES[k].band] }))
    }
  },
  phonePills: ["sky"],
  prompt: { title: "Tap to chirp", detail: "Hold for a feeding buzz · drag to turn", high: true },
  hint: "Tap to chirp at the flock; hold for a feeding buzz. Drag to turn.",
  notes: "A murmuration at dusk, found by sound. Each chirp's front startles the birds it passes: they swerve and catch the light, and the dense parts echo it back.",
  overview: [
    {
      title: "The flock",
      points: [
        "Up to 170k birds in one compute pass a frame. No bird looks at another: each holds its own depth under a skin melted from four drifting capsules and streams along it round a slowly turning wind, so neighbours fly as one.",
        "Each is a streak along its velocity, square to the view, its width flickering with a wingbeat; ink over the sky, with caught light added on top."
      ]
    },
    {
      title: "The chirp",
      points: [
        "A front runs out at 3.2 m/s; birds it passes are pushed away and bank, then steer back, so a ripple of density runs through the cloud.",
        "When it reaches the densest parts they send fainter fronts of their own, heard as echoes of the downward sweep. Holding speeds the chirps into a bat's feeding buzz."
      ]
    }
  ],
  Scene
};

export default day;
