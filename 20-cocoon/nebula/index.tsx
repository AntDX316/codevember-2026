"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { sound, useBed, useEvery } from "../../shared/engine/sound";
import { Backdrop, focus, type Variant } from "../kit";
import { Gas, makeNebula, MAX_PUSHES } from "./gas";
import { Stars } from "./stars";

type Palette = { label: string; inner: string; outer: string; scatter: string; star: string; ring: string };

// The gas glows one colour near the star and another out in its shell; dust lit by the star reflects a third; and a
// heartbeat's front runs through in a fourth.
const PALETTES: Record<string, Palette> = {
  rose: { label: "Rose", inner: "#7cb2ff", outer: "#ff3b8d", scatter: "#8fb0ff", star: "#ffe9dc", ring: "#ff86d0" },
  emerald: { label: "Emerald", inner: "#a8fff0", outer: "#13c47a", scatter: "#7fd8ff", star: "#effff4", ring: "#5dffc0" },
  ultraviolet: { label: "Ultraviolet", inner: "#ff7ce0", outer: "#5b34ff", scatter: "#b49cff", star: "#f1e8ff", ring: "#a68bff" },
  solar: { label: "Solar", inner: "#fff0a8", outer: "#ff5a14", scatter: "#ffc58a", star: "#fff2d6", ring: "#ffb04a" }
};

// The star's power at the middle of the brightness slider.
const STAR_POWER = 9;
// The second beat of a heartbeat comes this long after the first.
const DUB = 0.32;

type Push = { at: THREE.Vector3; flow: THREE.Vector3; age: number; radius: number; power: number };

// An inner ellipsoid, the dense part of the cloud: a press inside it pushes the gas, a press outside turns the camera.
const GRIP = new THREE.Vector3(1.0, 1.3, 1.0);

function Scene() {
  const { tier } = useQuality();
  const nebula = useMemo(() => makeNebula(), []);
  const paletteKey = useSetting<string>("nebulaPalette");
  const density = useSettingRef<number>("nebulaDensity");
  const brightness = useSettingRef<number>("nebulaStar");
  const bed = useBed("drone", 0.16);

  const state = useMemo(
    () => ({
      time: 0,
      frame: 0,
      pushes: Array.from({ length: MAX_PUSHES }, (): Push => ({ at: new THREE.Vector3(), flow: new THREE.Vector3(), age: 99, radius: 0.3, power: 0 })),
      next: 0,
      // The hand: where it was, how fast it is going, how far it has gone since it pressed, and where it last left a push.
      held: false,
      last: new THREE.Vector3(),
      lastAt: 0,
      velocity: new THREE.Vector3(),
      moved: 0,
      pressedAt: 0,
      spawned: new THREE.Vector3(),
      // The heartbeat: seconds since it began, how strong, and whether the second beat has sounded.
      beat: 99,
      strength: 0,
      dubbed: true,
      // How stirred the drone is, easing back to rest.
      stir: 0,
      bedLevel: 0.16,
      // Scratch, so the frame loop makes nothing.
      o: new THREE.Vector3(),
      d: new THREE.Vector3(),
      step: new THREE.Vector3(),
      palette: { inner: new THREE.Color(), outer: new THREE.Color(), scatter: new THREE.Color(), star: new THREE.Color(), ring: new THREE.Color() }
    }),
    []
  );

  // The first colours are set straight away rather than eased in from black.
  const first = useRef(true);
  useEffect(() => {
    const p = PALETTES[paletteKey] ?? PALETTES.rose;
    const target = state.palette;
    target.inner.set(p.inner);
    target.outer.set(p.outer);
    target.scatter.set(p.scatter);
    target.star.set(p.star);
    target.ring.set(p.ring);
    if (first.current) {
      first.current = false;
      nebula.inner.value.copy(target.inner);
      nebula.outer.value.copy(target.outer);
      nebula.scatter.value.copy(target.scatter);
      nebula.starColour.value.copy(target.star);
      nebula.ring.value.copy(target.ring);
    }
  }, [paletteKey, state, nebula]);

  useEffect(() => {
    focus.point.set(0, 0, 0);
    focus.blur = 0.8;
  }, []);

  const push = (at: THREE.Vector3, flow: THREE.Vector3, radius: number, power: number) => {
    const p = state.pushes[state.next];
    state.next = (state.next + 1) % MAX_PUSHES;
    p.at.copy(at);
    p.flow.copy(flow);
    p.radius = radius;
    p.power = power;
    p.age = 0;
  };

  const heartbeat = (strength: number) => {
    state.beat = 0;
    state.strength = strength;
    state.dubbed = false;
    state.stir = Math.max(state.stir, strength);
    sound.play("thud", { gain: 0.55 * strength, pitch: 0.55, size: 1 });
    sound.play("chime", { gain: 0.32 * strength, pitch: 0.5 });
    sound.play("whoosh", { gain: 0.45 * strength, pitch: 0.45, size: 1 });
  };

  useSettingAction("nebulaHeartbeat", () => heartbeat(1));
  // Left alone, the young star still beats now and then, softly, to show it is alive.
  useEvery(11, 19, () => {
    if (!state.held && state.beat > 6) heartbeat(0.4);
  });

  useGrabbable({
    pick: (ray) => {
      // Into the inner ellipsoid's own space, where it is a unit sphere.
      const o = state.o.copy(ray.origin).divide(GRIP);
      const d = state.d.copy(ray.direction).divide(GRIP);
      const a = d.dot(d);
      const b = o.dot(d);
      const c = o.dot(o) - 1;
      const disc = b * b - a * c;
      if (disc < 0) return null;
      const root = Math.sqrt(disc);
      const far = (-b + root) / a;
      if (far < 0) return null;
      const near = Math.max(0, (-b - root) / a);
      // Held at the point nearest the star along the ray, the middle of the cloud, so the hand moves through its depths.
      const along = Math.min(far, Math.max(near, -ray.origin.dot(ray.direction)));
      return { distance: along, point: ray.at(along, new THREE.Vector3()) };
    },
    grab: (point) => {
      dismissPrompt();
      state.held = true;
      state.last.copy(point);
      state.spawned.copy(point);
      state.lastAt = performance.now();
      state.pressedAt = state.lastAt;
      state.velocity.set(0, 0, 0);
      state.moved = 0;
    },
    drag: (point) => {
      const now = performance.now();
      const dt = Math.max(1 / 240, (now - state.lastAt) / 1000);
      state.lastAt = now;
      const step = state.step.copy(point).sub(state.last);
      state.moved += step.length();
      state.velocity.lerp(step.divideScalar(dt), 0.35);
      state.last.copy(point);
      // A push every few centimetres of travel, each carrying the gas the way the hand is going.
      if (point.distanceTo(state.spawned) < 0.06) return;
      state.spawned.copy(point);
      const speed = state.velocity.length();
      const flow = state.step.copy(state.velocity).multiplyScalar(0.16);
      if (flow.length() > 0.5) flow.setLength(0.5);
      push(point, flow, 0.26 + Math.min(speed * 0.025, 0.16), 1);
      state.stir = Math.min(1, state.stir + speed * 0.02);
      if (speed > 0.6) sound.play("whoosh", { gain: Math.min(0.45, speed * 0.06), pitch: 0.55 + Math.min(speed * 0.04, 0.35), pan: Math.max(-1, Math.min(1, point.x / 2)), gap: 0.2 });
    },
    release: (velocity) => {
      state.held = false;
      // A press that hardly moved is a tap on the cocoon: the star's heart beats.
      if (state.moved < 0.05 && performance.now() - state.pressedAt < 450) {
        heartbeat(1);
        return;
      }
      const flow = state.step.copy(velocity).multiplyScalar(0.14);
      if (flow.length() > 0.02) {
        if (flow.length() > 0.5) flow.setLength(0.5);
        push(state.last, flow, 0.34, 0.9);
      }
    }
  });

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    state.time += delta;
    const t = state.time;
    nebula.time.value = t;
    nebula.frame.value = tier === "low" ? 0 : (state.frame = (state.frame + 1) % 64);
    // A slow turn, and a slower drift of the warp through the noise; both wrap with the noise, which tiles.
    const angle = t * 0.035;
    nebula.spin.value.set(Math.cos(angle), Math.sin(angle));
    nebula.drift.value.set((t * 0.0045) % 1, (t * 0.009) % 1, (t * -0.0035) % 1);

    // Colours, density and light ease to where the settings put them.
    const k = 1 - Math.exp(-delta * 2.5);
    nebula.inner.value.lerp(state.palette.inner, k);
    nebula.outer.value.lerp(state.palette.outer, k);
    nebula.scatter.value.lerp(state.palette.scatter, k);
    nebula.starColour.value.lerp(state.palette.star, k);
    nebula.ring.value.lerp(state.palette.ring, k);
    nebula.density.value += (density.current - nebula.density.value) * k;

    // The heartbeat: a flare and a shock front for each beat, the second smaller.
    state.beat += delta;
    const s = state.strength;
    const lub = state.beat;
    const dub = state.beat - DUB;
    if (!state.dubbed && dub >= 0) {
      state.dubbed = true;
      sound.play("thud", { gain: 0.35 * s, pitch: 0.62, size: 0.9 });
      sound.play("whoosh", { gain: 0.25 * s, pitch: 0.6, size: 0.8 });
    }
    nebula.beat.value.set(lub, dub, s, s * 0.65);
    const flare = 1 + 1.6 * s * Math.exp(-lub * 3.5) + (dub > 0 ? 0.8 * s * Math.exp(-dub * 4) : 0);
    const breath = 1 + 0.06 * Math.sin(t * 1.3) + 0.03 * Math.sin(t * 2.9);
    nebula.star.value += (STAR_POWER * brightness.current * breath - nebula.star.value) * k;
    nebula.flare.value = flare;

    // Each push swells in quickly, then heals away over a few seconds.
    const pushes = nebula.pushes.array as THREE.Vector4[];
    const flows = nebula.flows.array as THREE.Vector4[];
    for (let i = 0; i < MAX_PUSHES; i++) {
      const p = state.pushes[i];
      p.age += delta;
      const strength = p.power * (1 - Math.exp(-p.age * 9)) * Math.exp(-p.age * 0.42);
      pushes[i].set(p.at.x, p.at.y, p.at.z, strength > 0.002 ? strength : 0);
      flows[i].set(p.flow.x, p.flow.y, p.flow.z, p.radius);
    }

    // The drone opens up while the gas is stirred and settles back after.
    state.stir *= Math.exp(-delta * 0.6);
    const level = 0.16 + state.stir * 0.16;
    if (Math.abs(level - state.bedLevel) > 0.01) {
      state.bedLevel = level;
      bed.current?.level(level, 0.4);
    }
  });

  return (
    <>
      <Backdrop top="#05040b" horizon="#0b0817" bottom="#030207" />
      <Stars nebula={nebula} count={tier === "high" ? 2600 : tier === "medium" ? 1800 : 1000} embedded={36} />
      <Gas nebula={nebula} tier={tier} />
    </>
  );
}

const variant: Variant = {
  Scene,
  settings: {
    nebulaPalette: {
      type: "choice",
      label: "Palette",
      value: "rose",
      options: Object.entries(PALETTES).map(([value, p]) => ({ value, label: p.label, swatch: [p.outer, p.inner] }))
    },
    nebulaDensity: { type: "range", label: "Density", min: 0.3, max: 2, step: 0.05, value: 1, reset: 1 },
    nebulaStar: { type: "range", label: "Star brightness", short: "Star", min: 0, max: 2.5, step: 0.05, value: 1, reset: 1 },
    nebulaHeartbeat: { type: "action", label: "Heartbeat" }
  },
  view: { position: [0.6, 0.55, 7.3], target: [0, 0, 0], fov: 36 },
  look: { background: "#06050c", exposure: 1, bloom: 0.45, bloomThreshold: 0.65, ao: 0, aoRadius: 0.35, vignette: 0.45, grain: 0.022 },
  hint: "Drag through the gas to push it about. Tap it and the star's heart beats.",
  notes:
    "A cocoon of glowing gas and dust round a newborn star, raymarched: the star's light scattered through the cloud and shadowed by it, filaments and dark lanes churning slowly, and a shock front running out with every heartbeat.",
  overview: [
    {
      title: "The cloud",
      points: [
        "One baked, tiling cube of noise, read through a slowly drifting warp, so filaments fold and churn without the cost of working noise out at every step.",
        "An egg-shaped shell hollowed round the star, with filaments where the noise folds into ridges and dust lanes that absorb rather than glow."
      ]
    },
    {
      title: "Light",
      points: [
        "Each step adds the gas's own glow and the starlight it scatters toward the eye, dimmed by a tap or two of gas on the way in from the star.",
        "Steps start at a different offset in every pixel and every frame, so the temporal pass smooths the banding away."
      ]
    },
    {
      title: "Touch",
      points: [
        "Dragging leaves pushes that carry and twist the gas the way the hand went, then heal over a few seconds.",
        "A tap flares the star twice, lub and dub, each sending a bright shock front out through the shell."
      ]
    }
  ]
};

export default variant;
