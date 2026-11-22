"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { scenePhase, useQuality } from "../../shared/engine/quality";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { createForm, nearestOnForm } from "./form";
import { Beacons, Form, lens, Mist, Motes, Shells } from "./render";
import { echoBack, ping, tone } from "./sound";
import { beacons, clock, NEVER, PERIOD, PING, PINGS, SLOTS, SOUNDING, SPEED } from "./waves";

// Presses within this distance of the middle place a beacon; further out, a drag turns the view.
const ZONE = 2.3;
// Notes of a minor pentatonic over two octaves, from A3: a beacon placed higher sounds higher, and its waves are
// a little shorter.
const SCALE = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25];
// A press held this long sings a steady tone.
const HOLD_TONE = 0.3;

type Slot = {
  used: boolean;
  at: THREE.Vector3;
  t0: number;
  let: number;
  end: number;
  pitch: number;
  pan: number;
  amp: number;
  pointer: number | null;
  stopTone: (() => void) | null;
  nextPing: number;
  echoes: number[];
  delay: number;
  gain: number;
};

const scratch = {
  ndc: new THREE.Vector2(),
  caster: new THREE.Raycaster(),
  plane: new THREE.Plane(),
  forward: new THREE.Vector3(),
  local: new THREE.Vector3(),
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  hit: new THREE.Vector3()
};

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const form = useMemo(() => createForm(startTier !== "low"), [startTier]);
  useDispose(form.geometry);
  const group = useMemo(() => new THREE.Group(), []);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const scene = useThree((state) => state.scene);

  const state = useRef({
    now: 0,
    live: -1,
    slots: Array.from(
      { length: SLOTS },
      (): Slot => ({ used: false, at: new THREE.Vector3(), t0: NEVER, let: NEVER, end: NEVER, pitch: 220, pan: 0, amp: 0, pointer: null, stopTone: null, nextPing: 1, echoes: [], delay: 0, gain: 0 })
    ),
    earned: false,
    touched: false,
    nextAmbient: 0
  });

  // Where a ray meets the plane through the middle square to the view, kept out of the form; null outside the zone.
  const place = (ray: THREE.Ray, out: THREE.Vector3, clampToZone: boolean) => {
    camera.getWorldDirection(scratch.forward);
    scratch.plane.setFromNormalAndCoplanarPoint(scratch.forward, scratch.hit.set(0, 0, 0));
    if (!ray.intersectPlane(scratch.plane, out)) return null;
    if (out.length() > ZONE) {
      if (!clampToZone) return null;
      out.setLength(ZONE);
    }
    // Inside the tube, drawn back toward the eye until clear of it.
    for (let k = 0; k < 40; k++) {
      scratch.local.copy(out);
      group.worldToLocal(scratch.local);
      if (nearestOnForm(form.line, scratch.local, scratch.point, scratch.normal) > 0.08) break;
      out.addScaledVector(ray.direction, -0.04);
    }
    return out;
  };

  const spawn = (at: THREE.Vector3, height: number, pan: number, pointer: number | null, amp = 1) => {
    const s = state.current;
    const now = s.now;
    // Only so many sound at once: the oldest still sounding falls quiet, its waves carrying on.
    const sounding = s.slots.filter((b) => b.used && b.end > now && b.pointer === null).sort((x, y) => x.t0 - y.t0);
    while (sounding.length >= SOUNDING) {
      const old = sounding.shift()!;
      old.end = Math.max(old.let, now);
    }
    let slot = s.slots.find((b) => !b.used);
    if (!slot) slot = s.slots.filter((b) => b.pointer === null).sort((x, y) => x.t0 - y.t0)[0];
    if (!slot) return null;
    const note = SCALE[Math.round(THREE.MathUtils.clamp((height * 0.5 + 0.5) * (SCALE.length - 1), 0, SCALE.length - 1))];
    Object.assign(slot, { used: true, t0: now, let: NEVER, end: NEVER, pitch: note, pan, amp, pointer, stopTone: null, nextPing: 1, echoes: [] as number[] });
    slot.at.copy(at);
    scratch.local.copy(at);
    group.worldToLocal(scratch.local);
    slot.echoes.push(now + (2 * Math.max(0, nearestOnForm(form.line, scratch.local, scratch.point, scratch.normal))) / SPEED);
    ping(note, pan, amp);
    return slot;
  };

  const release = (slot: Slot) => {
    const now = state.current.now;
    slot.pointer = null;
    slot.let = Math.max(now, slot.t0 + PING);
    slot.end = slot.let + PINGS * PERIOD;
    slot.stopTone?.();
    slot.stopTone = null;
  };

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __echoState: state, __echoCamera: camera, __echoGroup: group, __echoScene: scene });

  // Every finger, and the mouse, places its own beacon and carries it while pressed.
  useEffect(() => {
    const el = gl.domElement;
    const s = state.current;
    const touches = new Map<number, Slot>();
    const toNdc = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      return scratch.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      const ndc = toNdc(e);
      scratch.caster.setFromCamera(ndc, camera);
      const at = place(scratch.caster.ray, new THREE.Vector3(), false);
      if (!at) return;
      const slot = spawn(at, ndc.y, ndc.x, e.pointerId);
      if (!slot) return;
      touches.set(e.pointerId, slot);
      s.touched = true;
      dismissPrompt();
    };
    const move = (e: PointerEvent) => {
      const slot = touches.get(e.pointerId);
      if (!slot) return;
      scratch.caster.setFromCamera(toNdc(e), camera);
      place(scratch.caster.ray, slot.at, true);
    };
    const up = (e: PointerEvent) => {
      const slot = touches.get(e.pointerId);
      if (!slot) return;
      touches.delete(e.pointerId);
      if (slot.pointer === e.pointerId) release(slot);
    };
    const noMenu = (e: Event) => e.preventDefault();
    const callout = el.style.getPropertyValue("-webkit-touch-callout");
    el.style.setProperty("-webkit-touch-callout", "none");
    el.addEventListener("contextmenu", noMenu);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("contextmenu", noMenu);
      el.style.setProperty("-webkit-touch-callout", callout);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      for (const slot of s.slots) slot.stopTone?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the helpers read only refs and memoised objects.
  }, [gl, camera]);

  // A press in the mist places a beacon rather than turning the view; outside it, the drag turns.
  useGrabbable({
    pick: (ray) => {
      const at = place(ray, new THREE.Vector3(), false);
      return at ? { distance: ray.origin.distanceTo(at), point: at } : null;
    },
    grab: () => {},
    drag: () => {},
    release: () => {}
  });

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const s = state.current;
    s.now += dt;
    const now = s.now;
    clock.value = now;

    // The form turns slowly, a little tilted, so its contours keep changing.
    group.rotation.set(0.42 + Math.sin(now * 0.11) * 0.08, now * 0.045, 0.12);
    group.updateMatrixWorld();

    // Until the first touch, a faint ping now and then from somewhere at the edge of the mist, so the form is glimpsed.
    if (scenePhase.current === "live" && s.live < 0) {
      s.live = now;
      s.nextAmbient = now + 0.8;
    }
    if (!s.touched && s.live >= 0 && now > s.nextAmbient) {
      s.nextAmbient = now + 3.6;
      const turn = now * 1.7;
      const slot = spawn(scratch.hit.set(Math.cos(turn) * 2.1, Math.sin(turn * 0.7) * 0.9, Math.sin(turn) * 1.2 + 0.4), Math.sin(turn * 0.7) * 0.5, Math.cos(turn) * 0.6, null, 0.6);
      if (slot) {
        slot.let = now + PING;
        slot.end = slot.let;
      }
    }

    let sounding = 0;
    for (let k = 0; k < SLOTS; k++) {
      const b = s.slots[k];
      const u = beacons[k];
      if (b.used && b.pointer === null && now > b.end + 9) {
        b.used = false;
        b.amp = 0;
      }
      if (!b.used) {
        u.at.value.w = 0;
        u.times.value.set(NEVER, NEVER, NEVER, 18);
        continue;
      }
      if (b.end > now) sounding++;
      // The point of the form its sound meets first, found again as the form turns and the beacon moves.
      scratch.local.copy(b.at);
      group.worldToLocal(scratch.local);
      const d = nearestOnForm(form.line, scratch.local, scratch.point, scratch.normal);
      scratch.point.applyMatrix4(group.matrixWorld);
      scratch.normal.transformDirection(group.matrixWorld);
      b.delay = Math.max(0, d) / SPEED;
      const wavelength = 0.62 * Math.pow(330 / b.pitch, 0.3);
      u.at.value.set(b.at.x, b.at.y, b.at.z, b.amp);
      u.times.value.set(b.t0, b.let, b.end, (2 * Math.PI * SPEED) / wavelength);
      u.echo.value.set(scratch.point.x, scratch.point.y, scratch.point.z, b.delay);
      u.face.value.set(scratch.normal.x, scratch.normal.y, scratch.normal.z, d > 0 ? 0.55 : 0);

      // Held still a moment, a press sings.
      if (b.pointer !== null && !b.stopTone && now - b.t0 > HOLD_TONE) b.stopTone = tone(b.pitch, b.pan);
      // Each ping as it leaves, and its echo as it comes home to the beacon.
      if (b.let < NEVER) {
        const start = b.let + b.nextPing * PERIOD - PING;
        if (now >= start && start < b.end) {
          b.nextPing++;
          ping(b.pitch, b.pan, b.amp * 0.75);
          b.echoes.push(start + 2 * b.delay);
        }
      }
      for (let e = b.echoes.length - 1; e >= 0; e--) {
        if (now >= b.echoes[e]) {
          if (b.delay > 0.05) echoBack(b.pitch, b.pan);
          b.echoes.splice(e, 1);
        }
      }
    }

    // The lens: a pixel's size at a distance of one, focused on the middle of the form.
    lens.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);
    lens.focus.value = camera.position.length();

    // The moment worth sharing: three beacons sounding at once over the form.
    if (!s.earned && sounding >= 3) {
      s.earned = true;
      followPrompt.earn("interference");
      shareResult.set("Found a hidden shape in the dark by the echoes of three tones");
    }
  });

  return (
    <>
      <Form geometry={form.geometry} group={group} />
      <Mist count={startTier === "low" ? 70000 : startTier === "medium" ? 160000 : 260000} />
      <Motes count={startTier === "low" ? 700 : 1800} />
      <Shells fine={startTier !== "low"} />
      <Beacons />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.4, 0.5, 7.4],
    target: [0, 0, 0],
    fov: 36,
    limits: { turn: { left: 75, right: 75, up: 45, down: 45 }, move: 0.6 },
    phone: { position: [0.3, 0.4, 9.4], target: [0, 0, 0], fov: 44 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 12, color: "#6fa8ff" },
  look: { background: "#000000", exposure: 1, bloom: 0.6, bloomThreshold: 0.85, gi: 0, ao: 0, vignette: 0.65, grain: 0.02, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false, temporal: false },
  prompt: { title: "Tap the dark", detail: "Hold to sing a tone; drag outside to turn", low: true },
  hint: "Tap anywhere in the mist to place a beacon: it pings, and its waves reveal the hidden form as they pass. Hold for a steady tone and drag to carry it. Two or three beacons interfere: crests that meet glow, crests that meet troughs cancel.",
  notes: "A dark mist with a shape hidden in it, seen only where sound waves from your beacons cross it and each other.",
  overview: [
    { title: "Waves", points: ["Each beacon's waves are summed as signed pressure, so crests add and cancel: true interference, not overlays", "Echoes leave the point of the form each sound meets first, delayed by the trip"] },
    { title: "Rendering", points: ["A compute pass lights up to 260k mist specks from the field each frame", "The form is matte black, lit only by the field at its surface: contours and a fading afterglow"] }
  ],
  Scene
};

export default day;
