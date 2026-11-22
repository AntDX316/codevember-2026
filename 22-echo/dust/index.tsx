"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { use, useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { scenePhase, useQuality } from "../../shared/engine/quality";
import { useSetting } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { createCloud, hitHead, loadScan, nearestOnHead, PINGS, SPEED } from "./cloud";
import { Points } from "./render";
import { ping } from "./sound";

// The colours a front burns through: white hot at the front, a cool tail behind it, and the deep glow of the revealed form.
const PALETTES = {
  ice: { label: "Ice", hot: "#fff4e6", mid: "#69c8ff", deep: "#2747ff" },
  ember: { label: "Ember", hot: "#fff1dc", mid: "#ffab4a", deep: "#d1301a" },
  silver: { label: "Silver", hot: "#ffffff", mid: "#c9d6e6", deep: "#5d6f8a" }
} as const;
type Palette = keyof typeof PALETTES;

// While held, a ping goes out this often.
const SWEEP = 0.42;
// A press held still this long is a sweep; a shorter one that barely moves is a tap.
const HOLD = 320;
const TAP = 0.35;

const scratch = { ndc: new THREE.Vector2(), caster: new THREE.Raycaster(), at: new THREE.Vector3(), near: new THREE.Vector3(), colour: new THREE.Color() };

type Pending = { at: number; gain: number; pan: number; pitch: number };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const scan = use(loadScan());
  const cloud = useMemo(() => createCloud(scan, startTier), [scan, startTier]);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const palette = useSetting<Palette>("palette");
  const linger = useSetting<number>("linger");

  const state = useRef({
    clock: 0,
    sway: 0,
    // Echo pings still to be heard, by the clock.
    pending: [] as Pending[],
    pings: 0,
    sweeping: false,
    sweepNext: 0,
    sweptFor: 0,
    pointer: { x: 0, y: 0 },
    press: null as null | { id: number; x: number; y: number; t: number },
    presses: 0,
    intro: -1,
    earned: false
  });

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __dust: cloud, __dustState: state, __camera: camera });

  // Sends a ping out from a point on screen: from where it lands on the head, or, off the head, from the empty space at the
  // head's depth. Echoes come back off the head once the front has reached it, softer, from where it first touched.
  const send = useMemo(() => {
    const slots = cloud.u.pingAt;
    const take = () => {
      let best = 0;
      for (let k = 1; k < PINGS; k++) if (slots[k].value.w < slots[best].value.w) best = k;
      return best;
    };
    const emit = (at: THREE.Vector3, t0: number, strength: number) => {
      const k = take();
      slots[k].value.set(at.x, at.y, at.z, t0);
      cloud.u.pingStrength[k].value = strength;
    };
    return (x: number, y: number, strength: number, echoes: number, heard: boolean) => {
      const s = state.current;
      scratch.ndc.set(x, y);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      const ray = scratch.caster.ray;
      if (!hitHead(cloud, ray, s.sway, scratch.at)) {
        // The plane through the head's middle, square to the view.
        const along = -ray.origin.dot(ray.direction);
        scratch.at.copy(ray.origin).addScaledVector(ray.direction, Math.max(1, along));
      }
      const now = s.clock;
      emit(scratch.at, now, strength);
      const gap = nearestOnHead(cloud, scratch.at, s.sway, scratch.near);
      const back = gap / SPEED + 0.3;
      for (let e = 0; e < echoes; e++) {
        const t = now + back + e * 0.62;
        emit(scratch.near, t, strength * (e === 0 ? 0.5 : 0.24));
        if (heard) s.pending.push({ at: t, gain: e === 0 ? 0.9 : 0.5, pan: x * 0.6, pitch: 1 - e * 0.04 });
      }
      if (heard) ping({ gain: echoes ? 1 : 0.6, pan: x * 0.6 });
    };
  }, [cloud, camera]);

  // A tap pings; a press held still sweeps, pinging from under the finger as it moves. Dragging turns the view.
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
      if (s.press && e.pointerId !== s.press.id) return;
      s.pointer = { x: e.clientX, y: e.clientY };
    };
    const up = (e: PointerEvent) => {
      s.presses = Math.max(0, s.presses - 1);
      const p = s.press;
      if (!p || p.id !== e.pointerId) return;
      s.press = null;
      if (s.sweeping) return;
      const still = Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8;
      if (!still || (performance.now() - p.t) / 1000 > TAP) return;
      const [x, y] = ndc(e.clientX, e.clientY);
      send(x, y, 1, 2, true);
      s.pings++;
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
  }, [gl, send]);

  // The sweep holds the view still while it runs, through the rig's hold-to-grab.
  useGrabbable({
    pick: (ray) => (state.current.presses > 1 ? null : { distance: 1, point: ray.at(1, new THREE.Vector3()) }),
    holdToGrab: HOLD,
    grab: () => {
      const s = state.current;
      s.sweeping = true;
      s.sweepNext = s.clock;
      dismissPrompt();
    },
    drag: () => {},
    release: () => {
      state.current.sweeping = false;
    }
  });

  useFrame((_, raw) => {
    // Held still for screenshots in development.
    const dt = process.env.NODE_ENV !== "production" && (globalThis as { __dustPause?: boolean }).__dustPause ? 0 : Math.min(raw, 1 / 20);
    const s = state.current;
    const u = cloud.u;
    u.prev.value = s.clock;
    s.clock += dt;
    u.now.value = s.clock;
    u.dt.value = dt;
    s.sway = Math.sin(s.clock * 0.09) * 0.22;
    u.sway.value = s.sway;
    u.linger.value = linger;

    // A first ping on its own once the scene is on show, from off to one side, so the head is glimpsed once.
    if (s.intro < 0 && scenePhase.current === "live") s.intro = s.clock + 0.7;
    if (s.intro > 0 && s.clock >= s.intro) {
      s.intro = 0;
      send(0.62, 0.25, 0.8, 1, false);
    }

    if (s.sweeping) {
      s.sweptFor += dt;
      if (s.clock >= s.sweepNext) {
        const rect = gl.domElement.getBoundingClientRect();
        const x = ((s.pointer.x - rect.left) / rect.width) * 2 - 1;
        const y = -((s.pointer.y - rect.top) / rect.height) * 2 + 1;
        send(x, y, 0.6, 1, false);
        ping({ gain: 0.45, pitch: 1.04, pan: x * 0.6 });
        s.sweepNext = s.clock + SWEEP;
        s.pings++;
      }
    }
    for (let k = s.pending.length - 1; k >= 0; k--) {
      const p = s.pending[k];
      if (s.clock < p.at) continue;
      ping({ gain: p.gain, pitch: p.pitch, pan: p.pan, echo: true });
      s.pending.splice(k, 1);
    }

    // The view: the eye, the plane quads face in, a pixel's width at a distance of one, and the focus on the head.
    u.eye.value.copy(camera.position);
    const m = camera.matrixWorld.elements;
    u.camRight.value.set(m[0], m[1], m[2]);
    u.camUp.value.set(m[4], m[5], m[6]);
    u.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);
    u.focus.value = Math.max(0.5, camera.position.length() - 0.6);

    const pal = PALETTES[palette] ?? PALETTES.ice;
    const ease = 1 - Math.exp(-dt * 4);
    u.hot.value.lerp(scratch.colour.set(pal.hot), ease);
    u.mid.value.lerp(scratch.colour.set(pal.mid), ease);
    u.deep.value.lerp(scratch.colour.set(pal.deep), ease);

    gl.compute(cloud.update);

    gl.domElement.style.cursor = "crosshair";

    if (!s.earned && (s.pings >= 6 || s.sweptFor > 3)) {
      s.earned = true;
      followPrompt.earn("echo");
      shareResult.set("Pinged a face out of the dust with sonar");
    }
  });

  return <Points cloud={cloud} />;
}

const day: DayDefinition = {
  camera: {
    position: [0, 0.12, 5.4],
    target: [0, 0.02, 0],
    fov: 32,
    limits: { turn: { left: 80, right: 80, up: 40, down: 35 }, move: { left: 0.5, right: 0.5, down: 0.5, up: 0.5, nearer: 2.4, further: 3 } },
    phone: { position: [0, -0.05, 7.1], target: [0, -0.1, 0], fov: 40 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 12, color: "#7fb8ff" },
  // Black: every point is added over the frame in the overlay pass, and the bloom takes the hot fronts.
  look: { background: "#000000", exposure: 1, bloom: 0.75, bloomThreshold: 0.4, gi: 0, ao: 0, haze: 0, vignette: 0.55, grain: 0.02 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false },
  settings: {
    palette: {
      type: "choice",
      label: "Colour",
      value: "ice",
      options: (Object.keys(PALETTES) as Palette[]).map((k) => ({ value: k, label: PALETTES[k].label, swatch: [PALETTES[k].mid, PALETTES[k].deep] }))
    },
    linger: { type: "range", label: "Linger", min: 3, max: 20, step: 0.5, value: 8, reset: 8 }
  },
  phonePills: ["palette"],
  prompt: { title: "Tap to ping", detail: "Hold to sweep · drag to turn", high: true },
  hint: "Tap to send a ping into the dark; hold to sweep. Drag to turn.",
  notes: "A face that exists only as dust, glimpsed by sonar: each ping's wavefront snaps the points it passes onto the surface and lights them, then they drift apart again.",
  overview: [
    {
      title: "Points",
      points: [
        "A head scan (Lee Perry-Smith, CC BY 3.0) sampled into 440k points by area, pushed out by its relief map, a third laid in scan rows; 60k more drift round it.",
        "One compute pass a frame moves every point and works out its colour and size; the draw is one call of camera-facing quads."
      ]
    },
    {
      title: "Echoes",
      points: [
        "Up to 16 spherical fronts at once, each reaching a point at its true travel time; a front snaps the points it crosses onto the surface on a stiff spring.",
        "Echoes set out from where the front first meets the head, softer, and the sound follows them: a sonar ping and its returns, synthesised."
      ]
    }
  ],
  Scene
};

export default day;
