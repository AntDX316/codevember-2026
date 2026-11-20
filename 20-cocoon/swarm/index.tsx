"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { sound, useBed } from "../../shared/engine/sound";
import { Backdrop, focus, usePointerRay, type Variant } from "../kit";
import { createCore, createSwarm, PALETTES, SHELL } from "./swarm";

// The most motes each tier carries; the density setting draws a share of them.
const MOTES = { low: 18000, medium: 50000, high: 100000 };
// The light each mote gives is scaled to this many, so the cocoon glows about as bright at any density.
const REFERENCE = 45000;

// Where a ray first meets the cocoon's shell, a little enlarged, or null if it misses: the distance along the ray.
const scaledOrigin = new THREE.Vector3();
const scaledDirection = new THREE.Vector3();
function hitShell(ray: THREE.Ray, grow: number) {
  scaledOrigin.copy(ray.origin).divide(SHELL).divideScalar(grow);
  scaledDirection.copy(ray.direction).divide(SHELL).divideScalar(grow);
  const a = scaledDirection.lengthSq();
  const b = scaledOrigin.dot(scaledDirection);
  const c = scaledOrigin.lengthSq() - 1;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  return t > 0 ? t : null;
}

function Scene() {
  const { tier } = useQuality();
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const height = useThree((state) => state.size.height);
  const swarm = useMemo(() => createSwarm(MOTES[tier] ?? MOTES.medium), [tier]);
  const core = useMemo(() => createCore(), []);
  // An unseen egg round the swarm that writes only depth, so the lens focuses on the cocoon: the motes themselves write
  // none, and would otherwise be blurred as if they were the far sky.
  const proxy = useMemo(() => {
    const geometry = new THREE.SphereGeometry(1, 32, 16);
    const material = new THREE.MeshBasicNodeMaterial({ colorWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.copy(SHELL).multiplyScalar(1.15);
    mesh.renderOrder = -0.5;
    mesh.raycast = () => null;
    return { mesh, dispose: () => (geometry.dispose(), material.dispose()) };
  }, []);
  useDispose(swarm, core, proxy);

  const palette = useSettingRef<string>("swarmPalette");
  const density = useSettingRef<number>("swarmDensity");
  const wild = useSettingRef<number>("swarmWild");
  const pointer = usePointerRay();
  const shimmer = useBed("shimmer", 0.03);

  const state = useMemo(
    () => ({
      colours: { rest: new THREE.Color(), hot: new THREE.Color(), shadow: new THREE.Color(), core: new THREE.Color() },
      target: { rest: new THREE.Color(), hot: new THREE.Color(), shadow: new THREE.Color(), core: new THREE.Color() },
      paletteShown: "",
      held: false,
      heldSince: 0,
      holdTarget: new THREE.Vector3(),
      hand: new THREE.Vector3(),
      lastHand: new THREE.Vector3(),
      handVelocity: new THREE.Vector3(),
      handValid: false,
      pendingBurst: 0,
      burstAt: new THREE.Vector3(),
      flash: 0,
      lastWhoosh: 0,
      lastLevel: 0,
      fast: false,
      weave: new THREE.Vector3()
    }),
    []
  );

  // Focus on the middle of the cocoon, with a gentle lens; put back as found on leaving.
  useEffect(() => {
    focus.point.set(0, 0, 0);
    focus.blur = 0.6;
    return () => {
      focus.blur = 1;
    };
  }, []);

  const burst = (at: THREE.Vector3, power: number) => {
    state.burstAt.copy(at);
    state.pendingBurst = power;
    swarm.u.loosen.value = Math.min(1, swarm.u.loosen.value + 0.55 + power * 0.04);
    state.flash = Math.min(1.5, state.flash + power * 0.12);
    const pan = THREE.MathUtils.clamp(at.clone().project(camera).x, -1, 1) * 0.6;
    sound.play("whoosh", { gain: 0.22 + power * 0.03, pitch: 0.75 + Math.random() * 0.1, pan, size: 1.4 });
    sound.play("tinkle", { gain: 0.06 + power * 0.008, pitch: 1.4 + Math.random() * 0.3, pan });
  };

  useSettingAction("swarmBurst", () => burst(new THREE.Vector3(0, 0, 0), 7));

  // Pressing on the cocoon gathers the swarm to the pointer; letting go throws it out, harder the longer it was held.
  // Pressing beside it still turns the view.
  useGrabbable({
    pick: (ray) => {
      const t = hitShell(ray, 1.12);
      return t === null ? null : { distance: t, point: ray.at(t, new THREE.Vector3()) };
    },
    grab: (point) => {
      dismissPrompt();
      state.held = true;
      state.heldSince = swarm.u.time.value;
      state.holdTarget.copy(point);
      swarm.u.holdAt.value.copy(point);
      sound.play("rustle", { gain: 0.08, pitch: 1.5 });
    },
    drag: (point) => state.holdTarget.copy(point),
    release: () => {
      state.held = false;
      const held = Math.min(2.5, swarm.u.time.value - state.heldSince);
      burst(swarm.u.holdAt.value, 3.5 + held * 1.8);
    }
  });

  useFrame((_, delta) => {
    const u = swarm.u;
    const dt = Math.min(delta, 1 / 30);
    const ease = (rate: number) => 1 - Math.exp(-dt * rate);
    u.time.value += dt;
    u.dt.value = dt;
    const t = u.time.value;
    u.wild.value += (wild.current - u.wild.value) * ease(3);

    // The palette, faded to over a second.
    if (state.paletteShown !== palette.current) {
      state.paletteShown = palette.current;
      const p = PALETTES[palette.current] ?? PALETTES.ember;
      state.target.rest.set(p.rest);
      state.target.hot.set(p.hot);
      state.target.shadow.set(p.shadow);
      state.target.core.set(p.core);
      if (t <= dt) {
        for (const key of ["rest", "hot", "shadow", "core"] as const) state.colours[key].copy(state.target[key]);
      }
    }
    for (const key of ["rest", "hot", "shadow", "core"] as const) state.colours[key].lerp(state.target[key], ease(3));
    u.rest.value.copy(state.colours.rest);
    u.hot.value.copy(state.colours.hot);
    u.shadow.value.copy(state.colours.shadow);
    core.u.colour.value.copy(state.colours.core);

    // Holding draws in, and squeezes the shell a little; a burst flashes the core.
    u.hold.value += ((state.held ? 1 : 0) - u.hold.value) * ease(state.held ? 2.5 : 9);
    u.holdAt.value.lerp(state.holdTarget, ease(14));
    u.loosen.value *= Math.exp(-dt / 1.1);
    state.flash *= Math.exp(-dt / 0.35);
    u.breath.value = 1 + Math.sin(t * 1.15) * 0.028 + Math.sin(t * 2.71 + 1) * 0.01 - u.hold.value * 0.05;

    // The two windings slowly turn about the long axis, so the weave never settles.
    const tilt = 0.62;
    const turn = t * 0.06;
    u.weaveA.value.set(Math.sin(tilt) * Math.cos(turn), Math.cos(tilt), Math.sin(tilt) * Math.sin(turn));
    u.weaveB.value.set(-Math.sin(tilt) * Math.cos(turn), Math.cos(tilt), -Math.sin(tilt) * Math.sin(turn));

    // The hand: where the pointer's ray is at the cocoon, and how fast that is moving. Only a hovering pointer parts the
    // swarm; a press beside the cocoon is turning the view.
    const ray = pointer.ray;
    u.rayO.value.copy(ray.origin);
    u.rayD.value.copy(ray.direction);
    const front = hitShell(ray, 1);
    const along = front ?? Math.max(0.5, -ray.origin.dot(ray.direction));
    u.front.value = along;
    ray.at(along, state.hand);
    const hovering = pointer.active && !pointer.down && !state.held;
    if (hovering && state.handValid) {
      state.handVelocity.lerp(state.lastHand.sub(state.hand).multiplyScalar(-1 / Math.max(dt, 1e-3)), ease(20));
      if (state.handVelocity.length() > 10) state.handVelocity.setLength(10);
    } else state.handVelocity.multiplyScalar(1 - ease(6));
    state.lastHand.copy(state.hand);
    state.handValid = hovering;
    const handSpeed = state.handVelocity.length();
    u.hand.value.copy(state.handVelocity);
    const sweepTo = hovering ? 0.35 + Math.min(1, handSpeed / 2.5) * 0.65 : 0;
    u.sweep.value += (sweepTo - u.sweep.value) * ease(10);
    if (hovering && front !== null && handSpeed > 2.6 && !state.fast && t - state.lastWhoosh > 0.45) {
      state.lastWhoosh = t;
      sound.play("whoosh", { gain: Math.min(0.1, 0.03 + handSpeed * 0.01), pitch: 1.3 + Math.random() * 0.25, pan: THREE.MathUtils.clamp(pointer.ndc.x, -1, 1) * 0.6 });
    }
    state.fast = handSpeed > 2.2;

    camera.getWorldDirection(u.eye.value);
    u.burst.value = state.pendingBurst;
    u.burstAt.value.copy(state.burstAt);
    state.pendingBurst = 0;
    gl.compute(swarm.step);
    u.burst.value = 0;

    // Drawing: how many motes, how bright each, and how big a pixel is.
    const shown = Math.max(1000, Math.round(swarm.count * THREE.MathUtils.clamp(density.current, 0.1, 1)));
    swarm.mesh.count = shown;
    u.gain.value = Math.pow(REFERENCE / shown, 0.6) * 1.5;
    u.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, height);

    // The core breathes with the shell, brightens while held and flares on a burst.
    core.mesh.quaternion.copy(camera.quaternion);
    core.mesh.scale.setScalar(1.25 * u.breath.value * (1 + state.flash * 0.25));
    core.u.glow.value = (0.85 + Math.sin(t * 1.15) * 0.18) * (1 + u.hold.value * 0.5 + state.flash * 1.4);

    // The shimmer follows how stirred the swarm is.
    if (t - state.lastLevel > 0.15) {
      state.lastLevel = t;
      const stir = Math.max(u.sweep.value * Math.min(1, handSpeed / 3), u.hold.value * 0.7, u.loosen.value, u.wild.value * 0.25);
      shimmer.current?.level(0.025 + stir * 0.13, 0.35);
    }
  });

  return (
    <>
      <Backdrop top="#0a0918" horizon="#120c20" bottom="#030207" />
      <primitive object={proxy.mesh} />
      <primitive object={core.mesh} />
      <primitive object={swarm.mesh} />
    </>
  );
}

const swatch = (name: keyof typeof PALETTES) => [PALETTES[name].rest, PALETTES[name].shadow];

const swarm: Variant = {
  Scene,
  settings: {
    swarmPalette: {
      type: "choice",
      label: "Light",
      value: "ember",
      options: [
        { value: "ember", label: "Ember", swatch: swatch("ember") },
        { value: "moonlight", label: "Moonlight", swatch: swatch("moonlight") },
        { value: "aurora", label: "Aurora", swatch: swatch("aurora") },
        { value: "rose", label: "Rose", swatch: swatch("rose") }
      ]
    },
    swarmDensity: { type: "range", label: "Density", min: 0.1, max: 1, step: 0.01, value: 0.75, reset: 0.75 },
    swarmWild: { type: "range", label: "Calm to wild", min: 0, max: 1, step: 0.01, value: 0.3, reset: 0.3 },
    swarmBurst: { type: "action", label: "Burst" }
  },
  view: { position: [0.9, 0.45, 5.9], target: [0, 0, 0], fov: 36 },
  look: { background: "#05040a", exposure: 1, bloom: 0.75, bloomThreshold: 0.55, ao: 0, gi: 0, haze: 0, vignette: 0.45, grain: 0.022 },
  hint: "Sweep the pointer through it to part the swarm. Press and hold on it to gather the motes, then let go.",
  notes:
    "A cocoon of glowing motes, up to a hundred thousand of them moved on the graphics card. They wind round a breathing core along two crossing spirals, stirred by curl noise, so the weave is forever coming undone and re-knitting.",
  overview: [
    {
      title: "Swarm",
      points: [
        "Each mote is a thread of a compute pass: sprung to its own layer of an egg-shaped shell, steered along two crossing spirals and a drifting curl-noise flow.",
        "A passing hand pushes motes from its ray and drags them along; holding whirls them into a knot at the pointer, and letting go throws them out while the shell's springs go slack, so they spiral home.",
        "Drawn as tiny additive sprites stretched along their motion, gold at rest, white-hot when fast and violet on the side turned from the moon."
      ]
    }
  ]
};

export default swarm;
