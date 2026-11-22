"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Core } from "./core";
import { createField, SLOTS, SPEED } from "./field";
import { Dust } from "./render";
import { CORE, createShape } from "./shape";
import { thump, tone } from "./sound";

// The dust's own glow, the white-hot crest of a compressed shell, and the echo's cool light.
const PALETTES = {
  ember: { label: "Ember", dust: "#ffe3c9", hot: "#fff4e6", echo: "#6fb6ff" },
  frost: { label: "Frost", dust: "#d6e4ff", hot: "#f4f8ff", echo: "#ffb36b" },
  ash: { label: "Ash", dust: "#e8e6e2", hot: "#ffffff", echo: "#9fd8ff" }
} as const;
type Palette = keyof typeof PALETTES;

// How long a tap sounds: about one beat, so it leaves a single bright shell and the dark one behind it.
const TAP_BEATS = 1.1;
const HOLD = 320;
const TAP = 0.35;
// A sound starts no nearer the core's middle than this.
const CLEARANCE = 1.05;

const scratch = { ndc: new THREE.Vector2(), caster: new THREE.Raycaster(), at: new THREE.Vector3(), dir: new THREE.Vector3(), colour: new THREE.Color() };

type Pending = { at: number; run: () => void };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const shape = useMemo(() => createShape(), []);
  const field = useMemo(() => createField(shape, startTier), [shape, startTier]);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const palette = useSetting<Palette>("palette");
  const pitch = useSetting<number>("pitch");

  const state = useRef({
    clock: 0,
    pending: [] as Pending[],
    sent: 0,
    held: -1,
    heldFor: 0,
    stopTone: null as null | (() => void),
    pointer: { x: 0, y: 0 },
    press: null as null | { id: number; x: number; y: number; t: number },
    presses: 0,
    earned: false
  });

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __pressure: field, __pressureState: state });

  // Starts a sound from a point on screen: on the line under the finger where it passes nearest the core, kept a little
  // way out from it. Returns its slot, and when its echo arrives back where it started.
  const send = useMemo(() => {
    const { at, info } = field.u;
    return (x: number, y: number, strength: number, lasts: number, beat: number) => {
      const s = state.current;
      let k = -1;
      for (let j = 0; j < SLOTS; j++) if (j !== s.held && (k < 0 || at[j].value.w < at[k].value.w)) k = j;
      scratch.ndc.set(x, y);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      const ray = scratch.caster.ray;
      const along = -ray.origin.dot(ray.direction);
      scratch.at.copy(ray.origin).addScaledVector(ray.direction, along);
      const miss = scratch.at.length();
      if (miss < CLEARANCE) scratch.at.addScaledVector(ray.direction, -Math.sqrt(CLEARANCE * CLEARANCE - miss * miss));
      const out = scratch.at.length();
      const surface = shape.radius(scratch.dir.copy(scratch.at).normalize());
      const reach = out - surface;
      // The echo's way back, measured as the dust measures it (see field.ts).
      const back = reach / ((surface / CORE) * 0.8 + 0.2);
      at[k].value.set(scratch.at.x, scratch.at.y, scratch.at.z, s.clock);
      info[k].value.set(strength, lasts, reach, beat);
      s.sent++;
      return { k, home: s.clock + (reach + back) / SPEED };
    };
  }, [field, shape, camera]);

  const ndc = (cx: number, cy: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    return [((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1];
  };

  // A tap sends one beat; a press held still sounds a tone until let go. Dragging turns the view.
  useEffect(() => {
    const el = gl.domElement;
    const s = state.current;
    const down = (e: PointerEvent) => {
      s.presses++;
      s.pointer = { x: e.clientX, y: e.clientY };
      if (e.pointerType === "mouse" && e.button !== 0) return;
      s.press = s.presses === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
    };
    const move = (e: PointerEvent) => {
      if (s.press && e.pointerId !== s.press.id) return;
      s.pointer = { x: e.clientX, y: e.clientY };
    };
    const up = (e: PointerEvent) => {
      s.presses = Math.max(0, s.presses - 1);
      const p = s.press;
      if (!p || p.id !== e.pointerId) return;
      s.press = null;
      if (s.held >= 0) return;
      const still = Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8;
      if (!still || (performance.now() - p.t) / 1000 > TAP) return;
      const [x, y] = ndc(e.clientX, e.clientY);
      const beat = pitch;
      const { home } = send(x, y, 1, TAP_BEATS / beat, beat);
      thump({ pan: x * 0.6 });
      s.pending.push({ at: home, run: () => thump({ echo: true, pan: x * 0.6 }) });
      dismissPrompt();
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ndc only reads the canvas.
  }, [gl, send, pitch]);

  // Holding sounds a steady tone from under the finger, a train of shells, and holds the view still while it lasts.
  useGrabbable({
    pick: (ray) => (state.current.presses > 1 ? null : { distance: 1, point: ray.at(1, new THREE.Vector3()) }),
    holdToGrab: HOLD,
    grab: () => {
      const s = state.current;
      const [x, y] = ndc(s.pointer.x, s.pointer.y);
      const beat = pitch * 1.15;
      const { k, home } = send(x, y, 0.75, 1e4, beat);
      s.held = k;
      const stopMain = tone({ pan: x * 0.6, pulse: beat });
      let stopEcho: null | (() => void) = null;
      const echoAt = home - s.clock;
      s.pending.push({ at: home, run: () => (stopEcho = tone({ echo: true, pan: x * 0.6, pulse: beat })) });
      s.stopTone = () => {
        stopMain();
        // The echo goes on for as long as the tone did, after it.
        const left = echoAt;
        const t = state.current.clock + left;
        state.current.pending.push({ at: t, run: () => stopEcho?.() });
      };
      dismissPrompt();
    },
    drag: () => {},
    release: () => {
      const s = state.current;
      if (s.held < 0) return;
      const info = field.u.info[s.held].value;
      info.y = s.clock - field.u.at[s.held].value.w;
      s.held = -1;
      s.stopTone?.();
      s.stopTone = null;
    }
  });

  useFrame((_, raw) => {
    const dt = process.env.NODE_ENV !== "production" && (globalThis as { __pressurePause?: boolean }).__pressurePause ? 0 : Math.min(raw, 1 / 20);
    const s = state.current;
    const u = field.u;
    s.clock += dt;
    u.now.value = s.clock;
    u.spin.value = s.clock * 0.035;
    shape.update(s.clock);
    if (s.held >= 0) s.heldFor += dt;

    for (let k = s.pending.length - 1; k >= 0; k--) {
      const p = s.pending[k];
      if (s.clock < p.at) continue;
      s.pending.splice(k, 1);
      p.run();
    }

    u.eye.value.copy(camera.position);
    const m = camera.matrixWorld.elements;
    u.camRight.value.set(m[0], m[1], m[2]);
    u.camUp.value.set(m[4], m[5], m[6]);
    u.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);
    u.focus.value = Math.max(0.5, camera.position.length() - 0.4);

    const pal = PALETTES[palette] ?? PALETTES.ember;
    const ease = 1 - Math.exp(-dt * 4);
    u.dust.value.lerp(scratch.colour.set(pal.dust), ease);
    u.hot.value.lerp(scratch.colour.set(pal.hot), ease);
    u.echo.value.lerp(scratch.colour.set(pal.echo), ease);

    gl.compute(field.update);
    gl.domElement.style.cursor = "crosshair";

    if (!s.earned && (s.sent >= 6 || s.heldFor > 3)) {
      s.earned = true;
      followPrompt.earn("echo");
      shareResult.set("Found a hidden shape by the echo it threw back through the dust");
    }
  });

  return (
    <>
      <Core shape={shape} field={field} />
      <Dust field={field} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.6, 0.45, 6.6],
    target: [0, 0, 0],
    fov: 34,
    phone: { position: [0.5, 0.35, 8.3], target: [0, 0, 0], fov: 40 }
  },
  extents: { centre: [0, 0, 0], radius: 14, color: "#ffd9b5" },
  // Black: every grain is added over the frame in the overlay pass, and the bloom takes the compressed shells.
  look: { background: "#000000", exposure: 1, bloom: 0.7, bloomThreshold: 0.45, gi: 0, ao: 0, haze: 0, vignette: 0.55, grain: 0.02 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false },
  settings: {
    palette: {
      type: "choice",
      label: "Colour",
      value: "ember",
      options: (Object.keys(PALETTES) as Palette[]).map((k) => ({ value: k, label: PALETTES[k].label, swatch: [PALETTES[k].dust, PALETTES[k].echo] }))
    },
    pitch: { type: "range", label: "Pitch", min: 1.8, max: 5, step: 0.1, value: 3.1, reset: 3.1 }
  },
  phonePills: ["palette"],
  prompt: { title: "Tap to sound", detail: "Hold for a tone · drag to turn", high: true },
  hint: "Tap to send a sound through the dust; hold for a tone. Drag to turn.",
  notes: "Sound made visible in a cloud of dust: each wave pushes the grains into bright shells, and the echo off a hidden core comes back in its shape.",
  overview: [
    {
      title: "Dust",
      points: [
        "Up to 440k grains on the GPU; one compute pass a frame moves each by every wave that has reached it at its true travel time, and lets it go once the wave has passed.",
        "So the dust really bunches and thins: compression is bright, rarefaction dark. Drawn as one call of camera-facing quads, out of focus near the lens."
      ]
    },
    {
      title: "Echo",
      points: [
        "When a wave meets the core it is thrown back, spreading from the core's own surface, so the echo's shells carry the core's shape. Behind the core lies its shadow.",
        "The thump and its echo are synthesised, the echo timed to arrive as its shell gets back to where the sound began."
      ]
    }
  ],
  Scene
};

export default day;
