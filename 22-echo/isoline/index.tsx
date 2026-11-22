"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { scenePhase, useQuality } from "../../shared/engine/quality";
import { useSetting } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { balls, births, clock, tails, hitForm, moveBalls, nearestToRay, NEVER, pings, SLOTS } from "./blob";
import { Dust, Form, lens, normalView, palette } from "./render";
import { ping } from "./sound";

// A minor pentatonic from C5: a ping struck higher on the form sounds higher.
const SCALE = [523.25, 622.25, 698.46, 783.99, 932.33, 1046.5, 1244.5];
// Held on the form, pings stream this often.
const STREAM = 0.2;
// The form's own faint breath, so that it is glimpsed before the first touch.
const BREATH = 4.6;

const PALETTES: Record<string, { bone: string; accent: string }> = {
  ice: { bone: "#efe6d6", accent: "#5ee0ff" },
  ember: { bone: "#efe6d6", accent: "#ff7a3d" },
  bone: { bone: "#f2ece2", accent: "#fff6e8" }
};

const scratch = { ray: new THREE.Ray(), point: new THREE.Vector3(), ndc: new THREE.Vector2(), caster: new THREE.Raycaster(), side: new THREE.Vector3() };

function Scene() {
  const { tier } = useQuality();
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const size = useThree((state) => state.size);
  const colours = PALETTES[useSetting<string>("palette")] ?? PALETTES.ice;
  const state = useRef({ now: 0, live: -1, nextBreath: 0, held: false, grabbed: false, at: new THREE.Vector3(), nextStream: 0, next: 1, count: 0 });

  useEffect(() => {
    palette.bone.value.set(colours.bone);
    palette.accent.value.set(colours.accent);
  }, [colours]);

  const values = pings.array as THREE.Vector4[];
  const times = births.array as number[];
  const tailValues = tails.array as number[];

  // A ping from a point on the form: into the oldest of the visitor's slots, and heard.
  const sound = (at: THREE.Vector3, loud: number, tail = 2.4) => {
    const s = state.current;
    if (!Number.isFinite(at.x + at.y + at.z)) return;
    const slot = s.next;
    s.next = (s.next % (SLOTS - 1)) + 1;
    values[slot].set(at.x, at.y, at.z, loud);
    times[slot] = s.now;
    tailValues[slot] = tail;
    // Height picks the note; across the screen picks the side it is heard from.
    const height = THREE.MathUtils.clamp((at.y + 1.3) / 2.6, 0, 1);
    scratch.side.copy(at).project(camera);
    ping(SCALE[Math.round(height * (SCALE.length - 1))], scratch.side.x, loud);
    s.count++;
    if (s.count === 8) {
      followPrompt.earn("isoline");
      shareResult.set("Sounded out a shape in the dark by its echoes");
    }
  };

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __isoline: { state, normalView, sound, camera, balls: balls.array, gl } });

  // Pressing the form pings from where it was pressed, and holding streams pings from under the finger.
  useGrabbable({
    pick: (ray) => {
      const at = hitForm(ray, state.current.now, new THREE.Vector3());
      return at ? { distance: ray.origin.distanceTo(at), point: at } : null;
    },
    grab: (point) => {
      const s = state.current;
      s.held = true;
      s.grabbed = true;
      s.at.copy(point);
      s.nextStream = s.now + STREAM * 1.6;
      sound(point, 1);
      dismissPrompt();
    },
    drag: (point) => {
      scratch.ray.origin.copy(camera.position);
      scratch.ray.direction.copy(point).sub(camera.position).normalize();
      const at = hitForm(scratch.ray, state.current.now, scratch.point);
      if (at) state.current.at.copy(at);
    },
    release: () => {
      state.current.held = false;
    }
  });

  // A tap in the dark beside the form pings from the nearest part of it.
  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number; t: number; id: number } | null = null;
    const press = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    };
    const lift = (e: PointerEvent) => {
      const s = state.current;
      const was = down;
      down = null;
      const grabbed = s.grabbed;
      s.grabbed = false;
      if (!was || was.id !== e.pointerId || grabbed) return;
      if (Math.hypot(e.clientX - was.x, e.clientY - was.y) > 8 || performance.now() - was.t > 400) return;
      const rect = el.getBoundingClientRect();
      scratch.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      sound(nearestToRay(scratch.caster.ray, s.now, scratch.point), 0.85);
      dismissPrompt();
    };
    el.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", lift);
    return () => {
      el.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", lift);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the helpers read only refs and module state.
  }, [gl, camera]);

  useFrame((_, raw) => {
    const s = state.current;
    // A frame can arrive without a time while the stage is rebuilt; one such would stop the clock for good.
    if (Number.isFinite(raw)) s.now += Math.min(Math.max(raw, 0), 1 / 20);
    clock.value = s.now;
    moveBalls(s.now);
    lens.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);

    if (scenePhase.current === "live" && s.live < 0) {
      s.live = s.now;
      s.nextBreath = s.now + 0.6;
    }
    // The breath: a faint, silent ping from somewhere just off the form, wandering round it.
    if (s.live >= 0 && s.now > s.nextBreath) {
      s.nextBreath = s.now + BREATH;
      const turn = s.now * 0.83;
      values[0].set(Math.cos(turn) * 2.4, Math.sin(turn * 0.6) * 1.2, Math.sin(turn) * 2.4, 0.2);
      times[0] = s.now;
      tailValues[0] = 1.2;
    }
    if (s.held && s.now >= s.nextStream) {
      s.nextStream = s.now + STREAM;
      sound(s.at, 0.6, 9);
    }
  });

  const startTier = useRef(tier).current;
  return (
    <>
      <Form steps={tier === "high" ? 110 : tier === "medium" ? 84 : 60} />
      <Dust count={startTier === "low" ? 900 : startTier === "medium" ? 1800 : 2600} />
    </>
  );
}

// Every slot starts silent.
for (let i = 0; i < SLOTS; i++) (births.array as number[])[i] = NEVER;

const day: DayDefinition = {
  camera: {
    position: [0.3, 0.45, 6.4],
    target: [0, 0, 0],
    fov: 36,
    limits: { turn: { left: 170, right: 170, up: 70, down: 70 }, move: { left: 0.5, right: 0.5, down: 0.5, up: 0.5, nearer: 2.4, further: 3 } },
    phone: { position: [0.3, 0.45, 8.6], target: [0, 0, 0], fov: 44 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 14, color: "#5ee0ff" },
  look: { background: "#020203", exposure: 1, bloom: 0.55, bloomThreshold: 0.7, gi: 0, ao: 0, haze: 0, vignette: 0.62, grain: 0.018 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false, temporal: false },
  phonePills: ["palette"],
  settings: {
    palette: {
      type: "choice",
      label: "Colour",
      value: "ice",
      options: [
        { value: "ice", label: "Ice", swatch: ["#efe6d6", "#5ee0ff"] },
        { value: "ember", label: "Ember", swatch: ["#efe6d6", "#ff7a3d"] },
        { value: "bone", label: "Bone", swatch: ["#f2ece2", "#fff6e8"] }
      ]
    }
  },
  prompt: { title: "Tap to ping", detail: "Hold on it to keep sounding", low: true },
  hint: "Tap the form, or the dark beside it, to send a ping across it. Hold to keep pinging; drag to turn.",
  notes: "A form in the dark, seen only by sonar: each ping draws contour lines of distance across its skin as the front sweeps over it.",
  overview: [
    { title: "Form", points: ["Seven balls on slow orbits, melted together with a soft minimum, ray marched inside a bounding sphere in TSL", "The same field runs on the CPU, so a press lands exactly on the surface you see"] },
    { title: "Sonar", points: ["Each ping and its two echoes light lines of equal distance from where it left, fixed in space so they slide over the morphing skin", "Lines are smoothed over each pixel's footprint and fade where they would crowd, so they stay razor thin without shimmer"] }
  ],
  Scene
};

export default day;
