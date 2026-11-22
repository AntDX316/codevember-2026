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
import { BALL, createField, FRONTS, MODES, modeVectors, SPEED } from "./field";
import { Points } from "./render";
import { bow, strike } from "./sound";

// Each a light the dust burns with: white at a wavefront, warm on the inner shells, deep on the outer ones.
const PALETTES = {
  gold: { label: "Gold", hot: "#fff3e0", mid: "#ffb45c", deep: "#c2366b" },
  ice: { label: "Ice", hot: "#f2fbff", mid: "#6fd0ff", deep: "#3048ff" },
  violet: { label: "Violet", hot: "#fff0ff", mid: "#ff8ad8", deep: "#6a2cff" }
} as const;
type Palette = keyof typeof PALETTES;

// A press held still this long bows the tone; a shorter one that barely moves strikes a new one.
const HOLD = 320;
const TAP = 0.35;
// What is left of a tone once it has rung out, so the dust keeps a soft memory of its last pattern.
const REST = 0.4;
// How long a struck tone takes to fade, in seconds.
const RING = 7;
// The field leans toward the eye, so its symmetry reads from the first view; the ball turns slowly about the upright.
const TILT = 0.9;

const UP = new THREE.Vector3(0, 1, 0);
const scratch = { ndc: new THREE.Vector2(), caster: new THREE.Raycaster(), at: new THREE.Vector3(), colour: new THREE.Color() };

type Pending = { at: number; mode: number; gain: number; pan: number };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const field = useMemo(() => {
    const made = createField(startTier);
    made.u.frame.value.setFromMatrix4(new THREE.Matrix4().makeRotationX(TILT));
    return made;
  }, [startTier]);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const palette = useSetting<Palette>("palette");

  const state = useRef({
    clock: 0,
    spin: 0,
    mode: 0,
    struck: -100,
    holding: false,
    release: null as null | (() => void),
    pending: [] as Pending[],
    strikes: 0,
    heldFor: 0,
    pointer: { x: 0, y: 0 },
    press: null as null | { id: number; x: number; y: number; t: number },
    presses: 0,
    warmed: false,
    earned: false
  });

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __cymatic: field, __cymaticState: state, __camera: camera });

  // Where a press lands: on the ball's near face, or, missing it, the nearest the ray comes to the ball.
  const aim = useMemo(
    () => (x: number, y: number) => {
      scratch.ndc.set(x, y);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      const ray = scratch.caster.ray;
      const along = -ray.origin.dot(ray.direction);
      const miss = ray.origin.lengthSq() - along * along;
      const into = miss < BALL * BALL ? along - Math.sqrt(BALL * BALL - miss) : along;
      scratch.at.copy(ray.origin).addScaledVector(ray.direction, into);
      if (scratch.at.length() > BALL) scratch.at.setLength(BALL);
      return scratch.at.applyAxisAngle(UP, -state.current.spin);
    },
    [camera]
  );

  // A wavefront from a point, in the slot that has been quiet longest.
  const send = useMemo(
    () => (at: THREE.Vector3, t0: number, power: number) => {
      let best = 0;
      for (let k = 1; k < FRONTS; k++) if (field.u.frontAt[k].value.w < field.u.frontAt[best].value.w) best = k;
      field.u.frontAt[best].value.set(at.x, at.y, at.z, t0);
      field.u.frontStrength[best].value = power;
    },
    [field]
  );

  // Rings the next mode: its front sweeps out from the press, scattering the dust, which settles behind it into the new
  // pattern; the front comes back off the ball's far wall, and again off the near one, fainter each time.
  const ring = useMemo(
    () => (x: number, y: number) => {
      const s = state.current;
      const u = field.u;
      const at = aim(x, y);
      // Whatever each point feels now is where the new mode starts from.
      const age = s.clock - u.strike.value.w;
      if (age > 1.6) {
        u.fromA.value.copy(u.toA.value);
        u.fromB.value.copy(u.toB.value);
      }
      s.mode = (s.mode + 1) % MODES.length;
      const [a, b] = modeVectors(MODES[s.mode]);
      u.toA.value.copy(a);
      u.toB.value.copy(b);
      u.strike.value.set(at.x, at.y, at.z, s.clock);
      s.struck = s.clock;
      send(at, s.clock, 1);
      const far = at.clone().setLength(BALL).negate();
      const across = at.distanceTo(far) / SPEED;
      send(far, s.clock + across, 0.45);
      send(at.clone().setLength(BALL), s.clock + across * 2, 0.2);
      strike(MODES[s.mode].pitch, { pan: x * 0.5 });
      s.pending.push({ at: s.clock + across, mode: s.mode, gain: 0.9, pan: -x * 0.5 }, { at: s.clock + across * 2, mode: s.mode, gain: 0.5, pan: x * 0.4 });
      s.strikes++;
      dismissPrompt();
    },
    [field, aim, send]
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
    const up = (e: PointerEvent) => {
      s.presses = Math.max(0, s.presses - 1);
      const p = s.press;
      if (!p || p.id !== e.pointerId) return;
      s.press = null;
      if (s.holding) return;
      const still = Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8;
      if (!still || (performance.now() - p.t) / 1000 > TAP) return;
      const [x, y] = ndc(e.clientX, e.clientY);
      ring(x, y);
    };
    el.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      s.release?.();
    };
  }, [gl, ring]);

  // A press held still bows the tone that is sounding, holding the view still while it lasts: the pattern sharpens.
  useGrabbable({
    pick: (ray) => (state.current.presses > 1 ? null : { distance: 1, point: ray.at(1, new THREE.Vector3()) }),
    holdToGrab: HOLD,
    grab: () => {
      const s = state.current;
      s.holding = true;
      s.release?.();
      s.release = bow(MODES[s.mode].pitch);
      const rect = gl.domElement.getBoundingClientRect();
      const at = aim(((s.pointer.x - rect.left) / rect.width) * 2 - 1, -((s.pointer.y - rect.top) / rect.height) * 2 + 1);
      send(at.clone(), s.clock, 0.35);
      dismissPrompt();
    },
    drag: () => {},
    release: () => {
      const s = state.current;
      s.holding = false;
      s.release?.();
      s.release = null;
      // The tone rings on from where the bow left it.
      s.struck = s.clock;
    }
  });

  const step = (dt: number) => {
    const s = state.current;
    const u = field.u;
    s.clock += dt;
    u.now.value = s.clock;
    u.dt.value = dt;
    const ringing = REST + (1 - REST) * Math.exp(-Math.max(0, s.clock - s.struck) / RING);
    const drive = s.holding ? 1 : ringing;
    u.drive.value += (drive - u.drive.value) * (1 - Math.exp(-dt * 6));
    // A struck tone sharpens the pattern part way as it rings; a held one all the way.
    const sharp = s.holding ? 1 : (0.65 * (ringing - REST)) / (1 - REST);
    u.sharp.value += (sharp - u.sharp.value) * (1 - Math.exp(-dt * (sharp > u.sharp.value ? 0.8 : 0.4)));
    if (s.holding) s.heldFor += dt;
    s.spin = s.clock * 0.07;
    u.spin.value = s.spin;
    gl.compute(field.update);
  };

  useFrame((_, raw) => {
    const s = state.current;
    const u = field.u;
    // Behind the loader, the dust is let settle into its resting form so the first frame already shows it.
    if (!s.warmed) {
      s.warmed = true;
      s.struck = 0;
      for (let k = 0; k < 180; k++) step(1 / 30);
      s.clock = 0;
      s.struck = -100;
    }

    // The view: the eye, the plane quads face in, a pixel's width at a distance of one, and the focus on the ball.
    u.eye.value.copy(camera.position).applyAxisAngle(UP, -s.spin);
    const m = camera.matrixWorld.elements;
    u.camRight.value.set(m[0], m[1], m[2]);
    u.camUp.value.set(m[4], m[5], m[6]);
    u.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);
    u.focus.value = Math.max(0.5, camera.position.length() - 0.4);

    const dt = process.env.NODE_ENV !== "production" && (globalThis as { __cymaticPause?: boolean }).__cymaticPause ? 0 : Math.min(raw, 1 / 20);
    for (let k = s.pending.length - 1; k >= 0; k--) {
      const p = s.pending[k];
      if (s.clock < p.at) continue;
      strike(MODES[p.mode].pitch, { gain: p.gain, pan: p.pan, echo: true });
      s.pending.splice(k, 1);
    }

    const pal = PALETTES[palette] ?? PALETTES.gold;
    const ease = 1 - Math.exp(-Math.max(dt, 0.016) * 4);
    u.hot.value.lerp(scratch.colour.set(pal.hot), ease);
    u.mid.value.lerp(scratch.colour.set(pal.mid), ease);
    u.deep.value.lerp(scratch.colour.set(pal.deep), ease);

    if (dt > 0) step(dt);
    gl.domElement.style.cursor = "crosshair";

    if (!s.earned && scenePhase.current === "live" && (s.strikes >= 5 || s.heldFor > 4)) {
      s.earned = true;
      followPrompt.earn("echo");
      shareResult.set("Rang dust into a glowing 3D cymatic flower");
    }
  });

  return <Points cloud={field} />;
}

const day: DayDefinition = {
  camera: {
    position: [0, 0.6, 10.4],
    target: [0, 0, 0],
    fov: 34,
    limits: { turn: { left: 180, right: 180, up: 70, down: 70 }, move: { left: 0.4, right: 0.4, down: 0.4, up: 0.4, nearer: 3, further: 4 } },
    phone: { position: [0, 0.8, 14.5], target: [0, 0, 0], fov: 40 }
  },
  extents: { centre: [0, 0, 0], radius: 30, color: "#ffb45c" },
  // Black: every point is added over the frame in the overlay pass, and the bloom takes the glow.
  look: { background: "#000000", exposure: 1, bloom: 0.8, bloomThreshold: 0.35, gi: 0, ao: 0, haze: 0, vignette: 0.55, grain: 0.02 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false },
  settings: {
    palette: {
      type: "choice",
      label: "Colour",
      value: "gold",
      options: (Object.keys(PALETTES) as Palette[]).map((k) => ({ value: k, label: PALETTES[k].label, swatch: [PALETTES[k].mid, PALETTES[k].deep] }))
    }
  },
  phonePills: ["palette"],
  prompt: { title: "Tap to ring it", detail: "Hold to sustain · drag to turn", high: true },
  hint: "Tap to ring a new tone; hold to sustain it. Drag to turn.",
  notes: "Cymatics in three dimensions: a ball of dust in a standing wave. Each tone shakes the dust off the moving parts of the wave onto the still ones, drawing its shape.",
  overview: [
    {
      title: "The wave",
      points: [
        "Six modes, each one formula: concentric shells rippled by an angular harmonic into petals, some with a gyroid or Schwarz lattice, some twisted into spirals.",
        "Each point is shaken in proportion to how hard the wave moves where it sits, and slides down its slope to the nearest still surface, as sand on a Chladni plate."
      ]
    },
    {
      title: "Dust",
      points: [
        "Up to 330k points in one compute pass a frame, drawn as camera-facing quads added over the frame; the new mode reaches each point as the strike's front passes it.",
        "Each strike's front echoes off the ball's far wall and back, and the sound follows: a struck or bowed singing bowl, one note of a pentatonic scale per mode."
      ]
    }
  ],
  Scene
};

export default day;
