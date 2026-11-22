"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt } from "../../shared/engine/prompt";
import { scenePhase, useQuality } from "../../shared/engine/quality";
import { useSetting } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Air, Backdrop } from "./air";
import { createCloud, formAt, formDistance, FRONTS, LIFE, newForm, PALETTES, REACH, SPEED, type Palette } from "./cloud";
import { Flecks, view } from "./render";
import { sounding } from "./sound";

// A press held still this long sends a train of pulses; a shorter one that barely moves sends one.
const HOLD = 320;
const TAP = 0.35;
const TRAIN = 0.3;
// Where a pulse starts: on the near face of this ball round the cloud's middle, under the pointer.
const SHELL = REACH * 0.8;

const scratch = { ndc: new THREE.Vector2(), caster: new THREE.Raycaster(), at: new THREE.Vector3(), colour: new THREE.Color(), probe: new THREE.Vector3() };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const cloud = useMemo(() => createCloud(startTier), [startTier]);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const palette = useSetting<Palette>("palette");

  const state = useRef({
    clock: 0,
    form: newForm(),
    holding: false,
    lastPulse: -100,
    pointer: { x: 0, y: 0 },
    press: null as null | { id: number; x: number; y: number; t: number },
    presses: 0,
    sent: 0,
    heldFor: 0,
    warmed: false,
    earned: false
  });

  // Where a press lands: on the near face of the ball round the cloud, or, missing it, the nearest the ray comes to it.
  const aim = useMemo(
    () => (x: number, y: number) => {
      scratch.ndc.set(x, y);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      const ray = scratch.caster.ray;
      const along = -ray.origin.dot(ray.direction);
      const miss = ray.origin.lengthSq() - along * along;
      const into = miss < SHELL * SHELL ? along - Math.sqrt(SHELL * SHELL - miss) : along;
      scratch.at.copy(ray.origin).addScaledVector(ray.direction, into);
      if (scratch.at.length() > SHELL) scratch.at.setLength(SHELL);
      return scratch.at;
    },
    [camera]
  );

  // A pulse from a point, in the slot that has been quiet longest, and its sound: the puff now, the echo's chime when the
  // front first touches the form, and again as the echo comes back past where it started.
  const pulse = useMemo(
    () => (x: number, y: number, power: number) => {
      const s = state.current;
      const at = aim(x, y);
      let best = 0;
      for (let k = 1; k < FRONTS; k++) if (cloud.u.frontAt[k].value.w < cloud.u.frontAt[best].value.w) best = k;
      cloud.u.frontAt[best].value.set(at.x, at.y, at.z, s.clock);
      cloud.u.frontPower[best].value = power;
      // How far the front runs before it meets the form, marched along the line to the middle.
      let gap: number | null = null;
      let travelled = 0;
      scratch.probe.copy(at);
      const toward = at.clone().negate().normalize();
      for (let k = 0; k < 40; k++) {
        const d = formDistance(scratch.probe, s.form);
        if (d < 0.02) {
          gap = travelled;
          break;
        }
        travelled += d;
        scratch.probe.addScaledVector(toward, d);
      }
      const touch = gap === null ? null : gap / SPEED;
      sounding({ gain: power, pan: x * 0.6, touch, back: touch === null ? null : touch * 2 });
      s.sent++;
      s.lastPulse = s.clock;
      dismissPrompt();
    },
    [cloud, aim]
  );

  useEffect(() => {
    const el = gl.domElement;
    const s = state.current;
    const ndc = (cx: number, cy: number) => {
      const rect = el.getBoundingClientRect();
      return [((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1] as const;
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
      pulse(x, y, 1);
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
  }, [gl, pulse]);

  // A press held still sends a train of pulses from under the pointer, holding the view still while it lasts.
  useGrabbable({
    pick: (ray) => (state.current.presses > 1 ? null : { distance: 1, point: ray.at(1, new THREE.Vector3()) }),
    holdToGrab: HOLD,
    grab: () => {
      state.current.holding = true;
      state.current.lastPulse = -100;
    },
    drag: () => {},
    release: () => {
      state.current.holding = false;
    }
  });

  const step = (dt: number) => {
    const s = state.current;
    const u = cloud.u;
    s.clock += dt;
    u.now.value = s.clock;
    u.dt.value = dt;
    formAt(s.clock, s.form);
    u.frame.value.copy(s.form.frame);
    s.form.balls.forEach((b, k) => u.balls[k].value.copy(b));
    let active = 0;
    for (let k = 0; k < FRONTS; k++) if (u.frontPower[k].value > 0 && s.clock - u.frontAt[k].value.w < LIFE) active = 1;
    u.active.value = active;
    gl.compute(cloud.update);
  };

  useFrame((_, raw) => {
    const s = state.current;
    const u = cloud.u;
    // The view: the eye, the plane quads face, a pixel's width at a distance of one, and the focus on the cloud's middle.
    u.eye.value.copy(camera.position);
    const m = camera.matrixWorld.elements;
    view.right.value.set(m[0], m[1], m[2]);
    view.up.value.set(m[4], m[5], m[6]);
    u.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);
    u.focus.value = Math.max(1, camera.position.length() - 0.3);
    focusDistance.value = u.focus.value;
    focusBlur.value = 0.55;

    // Behind the loader, the cloud is let settle so the first frame already shows it.
    if (!s.warmed) {
      s.warmed = true;
      for (let k = 0; k < 90; k++) step(1 / 30);
    }

    const pal = PALETTES[palette] ?? PALETTES.moon;
    const ease = 1 - Math.exp(-Math.max(raw, 0.016) * 4);
    u.warm.value.lerp(scratch.colour.set(pal.warm), ease);
    u.cool.value.lerp(scratch.colour.set(pal.cool), ease);
    u.dust.value.lerp(scratch.colour.set(pal.dust), ease);

    const dt = Math.min(raw, 1 / 20);
    if (s.holding) {
      s.heldFor += dt;
      if (s.clock - s.lastPulse >= TRAIN) {
        const rect = gl.domElement.getBoundingClientRect();
        pulse(((s.pointer.x - rect.left) / rect.width) * 2 - 1, -((s.pointer.y - rect.top) / rect.height) * 2 + 1, 0.6);
      }
    }
    step(dt);
    gl.domElement.style.cursor = "crosshair";

    if (!s.earned && scenePhase.current === "live" && (s.sent >= 5 || s.heldFor > 3)) {
      s.earned = true;
      followPrompt.earn("echo");
      shareResult.set("Sounded a cloud of dust and saw the hidden shape in its echo");
    }
  });

  return (
    <>
      <Backdrop />
      <Flecks cloud={cloud} />
      <Air dust={startTier === "low" ? 900 : 2200} />
    </>
  );
}

const PHONE = typeof window !== "undefined" && window.matchMedia("(max-width: 900px), (hover: none)").matches;

const day: DayDefinition = {
  camera: {
    position: [0.9, 0.45, 7.6],
    target: [0, 0, 0],
    fov: 34,
    limits: { turn: { left: 180, right: 180, up: 65, down: 65 }, move: { left: 0.4, right: 0.4, down: 0.4, up: 0.4, nearer: 3, further: 3 } },
    phone: { position: [1.0, 0.5, 9.6], target: [0, 0, 0], fov: 42 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 25, color: "#ffdcb4" },
  // Black: the shafts, the flecks and the bokeh are all added over the frame in the overlay pass.
  look: { background: "#000000", exposure: 1.05, bloom: 0.55, bloomThreshold: 0.55, gi: 0, ao: 0, haze: 0, vignette: 0.6, grain: 0.016 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false },
  settings: {
    palette: {
      type: "choice",
      label: "Colour",
      value: "moon",
      options: (Object.keys(PALETTES) as Palette[]).map((k) => ({ value: k, label: PALETTES[k].label, swatch: [PALETTES[k].warm, PALETTES[k].cool] }))
    }
  },
  phonePills: ["palette"],
  // Above the cloud on a desktop; on a phone, small and clear of it.
  prompt: { title: "Tap to sound the dust", detail: "Hold for a train of pulses · drag to turn", ...(PHONE ? { low: true } : { high: true }) },
  hint: "Tap to send a pressure wave through the dust; its echo outlines a hidden form. Hold for a train of pulses. Drag to turn.",
  notes: "Sounding the dust: a pressure wave sweeps a cloud of tumbling flecks, and its echo off a form no one can see draws that form in glints.",
  overview: [
    {
      title: "The wave",
      points: [
        "Each tap sends a spherical front at 2.2 m/s; the flecks it passes are kicked along it, spin up and flash, then the air settles them.",
        "The echo leaves each point of the hidden form as the front touches it, so it grows outward in the form's shape and lights the flecks it passes cool."
      ]
    },
    {
      title: "Dust",
      points: [
        "Up to 320k flecks from Erosion, stepped in one compute pass: each tumbles about two axes and flashes as a face mirrors a shaft toward the eye.",
        "The form is a distance function (a torus melted into drifting balls), never drawn; flecks near it are drawn onto it for a moment by the echo."
      ]
    }
  ],
  Scene
};

export default day;
