"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { orbitControls, useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSettingAction, useSettingRef } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Backdrop, Motes, Probe } from "./air";
import { LiveFan, TINTS, Trail, view } from "./fans";
import { APEX, FAR, fanFrame, HALF, makeAtlas, makeScan, NEAR, TILT_LIMIT } from "./scan";
import { FACING, SHELL_CENTRE, SHELL_RADIUS } from "./shell";
import { pulse, stopSweep, sweepAt } from "./sound";

// A slice is left behind each time the beam has turned this far since the last.
const STEP = THREE.MathUtils.degToRad(1.1);
// How long one pulse takes to travel the fan, in seconds.
const PERIOD = 0.8;
const YAW_LIMIT = THREE.MathUtils.degToRad(100);
// How many slices left behind earn the follow prompt.
const EARNED = 45;

const scratch = {
  plane: new THREE.Plane(),
  hit: new THREE.Vector3(),
  down: new THREE.Vector3(),
  across: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(),
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
  delta: new THREE.Vector3(),
  sphere: new THREE.Sphere(SHELL_CENTRE.clone(), SHELL_RADIUS)
};

// Where a ray meets the live fan, with a little margin round it, or null.
function fanHit(ray: THREE.Ray, tilt: number, yaw: number) {
  fanFrame(tilt, yaw, scratch.down, scratch.across, scratch.normal);
  scratch.plane.setFromNormalAndCoplanarPoint(scratch.normal, APEX);
  if (!ray.intersectPlane(scratch.plane, scratch.hit)) return null;
  const rel = scratch.a.copy(scratch.hit).sub(APEX);
  const range = rel.length();
  const angle = Math.atan2(rel.dot(scratch.across), rel.dot(scratch.down));
  if (range < NEAR - 0.15 || range > FAR + 0.2 || Math.abs(angle) > HALF + 0.12) return null;
  return ray.origin.distanceTo(scratch.hit);
}

function Scene() {
  const { tier } = useQuality();
  const low = useRef(tier === "low").current;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const gain = useSettingRef<number>("gain");
  const trail = useSettingRef<number>("trail");
  const tintName = useSettingRef<string>("tint");

  const atlas = useMemo(() => makeAtlas(low), [low]);
  const clock = useMemo(() => uniform(0), []);
  // One scan for the live view, and three for slices left behind, so a fast sweep can leave several in one frame.
  const scans = useMemo(() => ({ live: makeScan(atlas, clock), left: [0, 1, 2].map(() => makeScan(atlas, clock)) }), [atlas, clock]);
  const poses = useMemo(() => {
    const data = new Float32Array((atlas.slots - 1) * 4);
    for (let i = 0; i < atlas.slots - 1; i++) data.set([0, 0, -1, i + 1], i * 4);
    const attribute = new THREE.InstancedBufferAttribute(data, 4);
    attribute.setUsage(THREE.DynamicDrawUsage);
    return attribute;
  }, [atlas]);
  useDispose(atlas.texture);

  const state = useRef({
    seconds: 0,
    // Where the probe is steered to, and where it is, eased.
    aim: { tilt: 0, yaw: FACING },
    tilt: 0,
    yaw: FACING,
    // The pose the last slice was left at.
    last: { tilt: 0, yaw: FACING },
    next: 0,
    held: false,
    grabbed: new THREE.Vector3(),
    // When the probe was last moved by hand, for the idle sway and the sound.
    touched: -10,
    speed: 0,
    lastFront: 0,
    left: 0,
    earned: false,
    warmed: false
  });

  const clear = () => {
    const data = poses.array as Float32Array;
    for (let i = 0; i < atlas.slots - 1; i++) data[i * 4 + 2] = -1;
    poses.needsUpdate = true;
  };
  useSettingAction("clear", clear);

  useGrabbable({
    pick: (ray) => {
      const s = state.current;
      const onFan = fanHit(ray, s.tilt, s.yaw);
      const onShell = ray.intersectSphere(scratch.sphere, scratch.b) ? ray.origin.distanceTo(scratch.b) : null;
      const distance = onFan === null ? onShell : onShell === null ? onFan : Math.min(onFan, onShell);
      if (distance === null) return null;
      return { distance, point: ray.at(distance, new THREE.Vector3()) };
    },
    grab: (point) => {
      const s = state.current;
      s.held = true;
      s.grabbed.copy(point);
      s.touched = s.seconds;
      dismissPrompt();
    },
    drag: (point) => {
      const s = state.current;
      const delta = scratch.delta.subVectors(point, s.grabbed);
      s.grabbed.copy(point);
      scratch.right.setFromMatrixColumn(camera.matrixWorld, 0);
      scratch.up.setFromMatrixColumn(camera.matrixWorld, 1);
      const dx = delta.dot(scratch.right);
      const dy = delta.dot(scratch.up);
      // Across the screen rocks the beam, so that the bottom of the fan follows the pointer: which way that is depends
      // on where the eye is, so it is measured.
      fanFrame(s.aim.tilt, s.aim.yaw, scratch.down, scratch.across, scratch.normal);
      scratch.a.copy(APEX).addScaledVector(scratch.down, 1.75);
      fanFrame(s.aim.tilt + 0.01, s.aim.yaw, scratch.down, scratch.across, scratch.normal);
      scratch.b.copy(APEX).addScaledVector(scratch.down, 1.75).sub(scratch.a).divideScalar(0.01);
      const along = scratch.b.dot(scratch.right);
      const reach = Math.sign(along || 1) * Math.max(Math.abs(along), 0.9);
      s.aim.tilt = THREE.MathUtils.clamp(s.aim.tilt + dx / reach, -TILT_LIMIT, TILT_LIMIT);
      // Up and down the screen turns it.
      s.aim.yaw = THREE.MathUtils.clamp(s.aim.yaw - dy * 0.9, FACING - YAW_LIMIT, FACING + YAW_LIMIT);
      s.touched = s.seconds;
    },
    release: () => {
      state.current.held = false;
    }
  });

  useEffect(() => () => stopSweep(), []);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __ultrasound: { state, view, camera, atlas, scene, orbitControls } });

  const leave = (k: number, tilt: number, yaw: number) => {
    const s = state.current;
    const slot = s.next + 1;
    s.next = (s.next + 1) % (atlas.slots - 1);
    const scan = scans.left[k];
    scan.pose.tilt.value = tilt;
    scan.pose.yaw.value = yaw;
    scan.pose.slot.value = slot;
    gl.compute(scan.node as never);
    const data = poses.array as Float32Array;
    data.set([tilt, yaw, s.seconds, slot], (slot - 1) * 4);
    poses.needsUpdate = true;
    s.left++;
    if (!s.earned && s.left >= EARNED) {
      s.earned = true;
      followPrompt.earn("sweep");
      shareResult.set("Found what was hiding in the dark by ultrasound");
    }
  };

  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 20);
    const s = state.current;
    s.seconds += delta;
    clock.value = s.seconds;
    view.now.value = s.seconds;
    view.gain.value = gain.current;
    view.trail.value = trail.current;
    const look = TINTS[tintName.current as keyof typeof TINTS] ?? TINTS.amber;
    view.power.value.fromArray(look.power);
    view.scale.value.fromArray(look.scale);

    // The probe eases to where it is steered; left alone a while, it sways a little, as a held probe does.
    const idle = THREE.MathUtils.smoothstep(s.seconds - s.touched, 2, 5);
    const swayTilt = idle * 0.035 * Math.sin(s.seconds * 0.37);
    const swayYaw = idle * 0.025 * Math.sin(s.seconds * 0.23 + 1);
    const ease = 1 - Math.exp(-delta * 14);
    const before = { tilt: s.tilt, yaw: s.yaw };
    s.tilt += (s.aim.tilt + swayTilt - s.tilt) * ease;
    s.yaw += (s.aim.yaw + swayYaw - s.yaw) * ease;
    const moved = Math.abs(s.tilt - before.tilt) + Math.abs(s.yaw - before.yaw) * 0.8;
    s.speed += (moved / Math.max(delta, 1e-3) - s.speed) * (1 - Math.exp(-delta * 10));
    view.tilt.value = s.tilt;
    view.yaw.value = s.yaw;

    // The pulse: down the fan once a period. Each new one sounds, while the probe is in use.
    const phase = (s.seconds % PERIOD) / PERIOD;
    view.front.value = phase * view.trip.value;
    const active = s.held || s.seconds - s.touched < 2.5;
    if (phase < s.lastFront && active) pulse(1, 0.11 + Math.max(0, APEX.distanceTo(SHELL_CENTRE) - SHELL_RADIUS) * 0.12);
    s.lastFront = phase;
    sweepAt(active ? s.speed : 0);

    // Everything compiled behind the loader: every scan once, into slots no slice is shown from yet.
    if (!s.warmed) {
      s.warmed = true;
      scans.left.forEach((scan, k) => {
        scan.pose.slot.value = k + 1;
        gl.compute(scan.node as never);
      });
    }
    scans.live.pose.tilt.value = s.tilt;
    scans.live.pose.yaw.value = s.yaw;
    scans.live.pose.slot.value = 0;
    gl.compute(scans.live.node as never);

    // Slices left behind wherever the hand has swept the beam, up to three a frame on a fast sweep.
    if (s.seconds - s.touched < 1) {
      const gone = Math.abs(s.tilt - s.last.tilt) + Math.abs(s.yaw - s.last.yaw) * 0.8;
      if (gone > STEP) {
        const count = Math.min(3, Math.floor(gone / STEP));
        for (let k = 1; k <= count; k++) {
          const t = k / count;
          leave(k - 1, THREE.MathUtils.lerp(s.last.tilt, s.tilt, t), THREE.MathUtils.lerp(s.last.yaw, s.yaw, t));
        }
        s.last.tilt = s.tilt;
        s.last.yaw = s.yaw;
      }
    } else {
      s.last.tilt = s.tilt;
      s.last.yaw = s.yaw;
    }
  });

  return (
    <>
      <ambientLight intensity={0.25} />
      <directionalLight position={[-3, 4, 2.5]} intensity={2.2} />
      <Backdrop />
      <Probe />
      <LiveFan atlas={atlas} />
      <Trail atlas={atlas} poses={poses} />
      <Motes count={low ? 900 : 2200} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0, 1.0, 6.5],
    target: [0, 0.05, 0],
    fov: 36,
    limits: { turn: { left: 70, right: 70, up: 35, down: 25 }, move: { left: 0.6, right: 0.6, down: 0.5, up: 0.5, nearer: 2, further: 3 } },
    phone: { position: [0, 0.75, 6.4], target: [0, 0.05, 0], fov: 46 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 14, color: "#1a120c" },
  look: { background: "#000000", exposure: 1, bloom: 0.55, bloomThreshold: 0.8, gi: 0, ao: 0, vignette: 0.55, grain: 0.03, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, temporal: false, occlusion: false },
  settings: {
    tint: {
      type: "choice",
      label: "Tint",
      value: "amber",
      options: [
        { value: "amber", label: "Amber", swatch: ["#ffb070"] },
        { value: "cyan", label: "Cyan", swatch: ["#70d8ff"] }
      ]
    },
    gain: { type: "range", label: "Gain", min: 0.3, max: 2.5, step: 0.01, value: 1, reset: 1 },
    trail: { type: "range", label: "Slices fade over (s)", short: "Fade", min: 5, max: 120, step: 1, value: 45, reset: 45 },
    clear: { type: "action", label: "Clear slices" }
  },
  phonePills: ["tint", "clear"],
  prompt: { title: "Drag the beam through the dark", detail: "Sweep it to find what is hiding", high: true },
  hint: "Drag across to rock the beam through the dark, up and down to turn it. Each sweep leaves glowing slices behind.",
  notes: "An ultrasound probe over dark water. Its pulses come back as grainy echoes wherever they cross a surface, and sweeping it leaves slices that build up something hidden.",
  overview: [
    {
      title: "Echoes",
      points: [
        "Each scan line is one GPU thread walking a pulse down through a nautilus distance field: changes of material reflect, the inside scatters, and the pulse loses what it gives back, so shell casts shadows.",
        "Speckle is two noises squared and summed, finer along the beam than across, as a real probe's grain."
      ]
    },
    {
      title: "Slices",
      points: [
        "Every slice is a tile of one storage texture: the live fan rescans each frame, and sweeping leaves up to 99 behind, each drawn at its pose and fading.",
        "The pulse front redraws the fan as it travels and lights the motes it passes."
      ]
    }
  ],
  Scene
};

export default day;
