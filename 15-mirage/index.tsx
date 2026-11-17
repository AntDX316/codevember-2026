"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { float, Fn, instancedArray, perspectiveDepthToViewZ, uniform, vec2 } from "three/tsl";
import { orbitControls, orbitPoint, useGrabbable } from "../shared/engine/controls";
import { focusBlur, focusDistance, overlayLink } from "../shared/engine/Post";
import { useQuality } from "../shared/engine/quality";
import { useSetting, useSettingAction } from "../shared/engine/settings";
import { sound, useBed, useEvery, useMusic } from "../shared/engine/sound";
import { useLook } from "../shared/engine/Stage";
import type { DayDefinition } from "../shared/engine/types";
import { createDesert, homeAt, PATCH } from "./desert";
import { Animals, type Life } from "./animals";
import { Grass, Palms } from "./plants";
import { aim, Dunes, Dust, ease, Shafts, Grains, Mirage, Sand, Sky, Spray, toneOf, Water, world } from "./render";
import { LOOKS, type Style, STYLES } from "./styles";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const LOOK = {
  background: "#000000",
  gi: 0,
  ao: 0,
  vignette: 0.35,
  grain: 0.015,
  bloomThreshold: 0.9,
  haze: 0
};

// Detail by tier: columns along each side of the patch, grains to a column, spray, and simulation steps a frame.
const DETAIL = {
  high: {
    columns: 448,
    grains: 9,
    grass: 900000,
    sprays: 32768,
    dust: 4000,
    shafts: 14,
    steps: 5,
    fine: true
  },
  medium: {
    columns: 448,
    grains: 7,
    grass: 600000,
    sprays: 16384,
    dust: 2500,
    shafts: 10,
    steps: 4,
    fine: true
  },
  low: {
    columns: 320,
    grains: 6,
    grass: 220000,
    sprays: 4096,
    dust: 900,
    shafts: 0,
    steps: 3,
    fine: false
  }
};
// Seconds of turning sand to water it takes for the desert to become an oasis.
const PARADISE = 45;

// Where a ray first meets the dunes anywhere, stepping along it in growing strides; null if it reaches the sky.
function onDunes(ray: THREE.Ray) {
  const p = new THREE.Vector3();
  for (let t = 0.1; t < 120; t += 0.03 + t * 0.03) {
    ray.at(t, p);
    if (p.y < homeAt(p.x, p.z)) return p.clone();
  }
  return null;
}

// Where a ray first passes under the dunes inside the patch, stepping along it; null if it leaves the patch first.
function onSand(ray: THREE.Ray) {
  const p = new THREE.Vector3();
  for (let t = 0.05; t < 40; t += 0.01 + t * 0.004) {
    ray.at(t, p);
    if (Math.max(Math.abs(p.x), Math.abs(p.z)) > PATCH / 2 - 0.1) {
      if (p.y < 0) return null;
      continue;
    }
    if (p.y < homeAt(p.x, p.z)) return p.clone();
  }
  return null;
}

// How far off whatever is in the middle of the view stands, read from the finished frame's depth: palms, animals, grass
// and water included, which a ray against the sand alone passes through. Nine points round the middle, the median of
// them, so a single blade crossing it doesn't steal the focus. Read back a frame or two late, which the easing hides.
function useLookingAt(gl: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera) {
  const probe = useMemo(() => ({ out: instancedArray(1, "float"), near: uniform(0.05), far: uniform(400), pass: null as any, seen: null as number | null, busy: false }), []);
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        probe.pass = Fn(() => {
          const taps = [-1, 0, 1].flatMap((y) =>
            [-1, 0, 1].map((x) => {
              const d = depth.sample(vec2(0.5 + x * 0.018, 0.5 + y * 0.03)).level(float(0)).r as any;
              return d.greaterThanEqual(0.99999).select(float(1000), (perspectiveDepthToViewZ(d, probe.near, probe.far) as any).negate()) as any;
            })
          );
          let median = float(0) as any;
          taps.forEach((d, i) => {
            const below = taps.reduce((n: any, e, j) => (j === i ? n : n.add((j < i ? e.lessThanEqual(d) : e.lessThan(d)).select(float(1), float(0)))), float(0)) as any;
            median = below.equal(4).select(d, median);
          });
          probe.out.element(0).assign(median);
        })().compute(1);
      }),
    [probe]
  );
  useFrame(() => {
    if (!probe.pass) return;
    probe.near.value = camera.near;
    probe.far.value = camera.far;
    gl.compute(probe.pass);
    if (probe.busy) return;
    probe.busy = true;
    (gl.getArrayBufferAsync(probe.out.value as any) as Promise<ArrayBuffer>)
      .then((buffer) => (probe.seen = new Float32Array(buffer)[0]))
      .catch(() => {})
      .finally(() => (probe.busy = false));
  });
  return probe;
}

function Scene() {
  const style = useSetting<Style>("style");
  const look = LOOKS[style];
  const { tier } = useQuality();
  const detail = DETAIL[tier as keyof typeof DETAIL] ?? DETAIL.medium;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const looking = useLookingAt(gl, camera);
  // The simulation is sized once, by the tier the visit starts on: when Auto steps the quality down a few seconds in, only
  // the grains, grass and steps change, so the sand and whatever has been made of it carry on rather than starting over.
  const size = useRef({ columns: detail.columns, sprays: detail.sprays }).current;
  const desert = useMemo(() => createDesert(size.columns, size.sprays), [size]);
  const tone = useMemo(() => toneOf(desert), [desert]);
  // How fully the desert has turned to an oasis, from 0 to 1, growing while the hand turns sand to water.
  const oasis = useRef(0);
  const [resets, setResets] = useState(0);
  useSettingAction("reset", () => setResets((n) => n + 1));
  useEffect(() => {
    if (!resets) return;
    desert.reset();
    oasis.current = 0;
  }, [desert, resets]);

  useLook(useMemo(() => ({ ...LOOK, exposure: look.exposure, bloom: look.bloom }), [look]));
  const first = useRef(true);
  useEffect(() => {
    aim(look, first.current);
    first.current = false;
  }, [look]);

  // A hand on the sand: where the press lands on the dunes. A press off the patch turns the view.
  const hand = useRef({
    held: false,
    at: new THREE.Vector3(),
    last: new THREE.Vector3(),
    velocity: new THREE.Vector2(),
    noise: 0,
    wet: 0,
    focus: new THREE.Vector3(),
    focusDistance: 5
  });
  useGrabbable({
    pick(ray) {
      const point = onSand(ray);
      return point ? { distance: ray.origin.distanceTo(point), point } : null;
    },
    grab(point) {
      const h = hand.current;
      h.held = true;
      h.at.copy(point);
      h.last.copy(point);
    },
    // The rig hands over a point on a plane facing the camera, which climbs into the air as the pointer moves up the
    // screen. The pointer's ray runs from the camera through that point, so follow it down to the sand instead; off the
    // patch, the hand keeps to its height and slides along the edge.
    drag(point) {
      const h = hand.current;
      const ray = new THREE.Ray(camera.position, point.clone().sub(camera.position).normalize());
      const hit = onSand(ray) ?? ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h.at.y), new THREE.Vector3());
      if (!hit) return;
      const edge = PATCH / 2 - 0.1;
      h.at.set(THREE.MathUtils.clamp(hit.x, -edge, edge), hit.y, THREE.MathUtils.clamp(hit.z, -edge, edge));
    },
    release() {
      hand.current.held = false;
    }
  });

  // The middle button turns the view, so a press on the sand can always dig; put back as it was on leaving.
  useEffect(() => {
    let kept: THREE.MOUSE | null = null;
    let feel: { speed: number; damping: number } | null = null;
    let frame = 0;
    const take = () => {
      const c = orbitControls.current;
      if (!c) {
        frame = requestAnimationFrame(take);
        return;
      }
      kept = c.mouseButtons.MIDDLE ?? null;
      c.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
      // A calmer turn that still follows the hand closely: less turn for the same drag, settling quicker.
      feel = { speed: c.rotateSpeed, damping: c.dampingFactor };
      c.rotateSpeed = 0.32;
      c.dampingFactor = 0.16;
    };
    take();
    return () => {
      cancelAnimationFrame(frame);
      if (orbitControls.current && kept !== null) orbitControls.current.mouseButtons.MIDDLE = kept;
      if (orbitControls.current && feel) {
        orbitControls.current.rotateSpeed = feel.speed;
        orbitControls.current.dampingFactor = feel.damping;
      }
    };
  }, []);

  useMusic("/codevember/music/spaghetti-waxtern.mp3", 0.3);
  // Two fingers on a trackpad turn the eye where it stands, as a head turns: up to look up, right to look right (with
  // natural scrolling), easing after the fingers; a pinch still zooms, and a mouse
  // wheel still zooms. Taken before the engine's own wheel handling, for this day only.
  const swipe = useRef({ theta: 0, phi: 0 });
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!orbitControls.current || event.target !== gl.domElement || event.ctrlKey) return;
      const wheelDeltaY = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      const trackpad = event.deltaX !== 0 || (wheelDeltaY !== undefined && wheelDeltaY === -3 * event.deltaY) || (event.deltaMode === 0 && !Number.isInteger(event.deltaY));
      if (!trackpad) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      swipe.current.theta += event.deltaX * 0.0017;
      swipe.current.phi -= event.deltaY * 0.0014;
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  }, [gl]);
  useFrame((_, delta) => {
    const c = orbitControls.current;
    const w = swipe.current;
    if (!c || (Math.abs(w.theta) < 1e-5 && Math.abs(w.phi) < 1e-5)) return;
    const k = 1 - Math.exp(-Math.min(delta, 1 / 20) * 14);
    const ahead = c.target.clone().sub(camera.position);
    const turn = new THREE.Spherical().setFromVector3(ahead);
    turn.theta += w.theta * k;
    turn.phi = THREE.MathUtils.clamp(turn.phi + w.phi * k, 0.2, Math.PI - 0.2);
    w.theta *= 1 - k;
    w.phi *= 1 - k;
    c.target.copy(camera.position).add(ahead.setFromSpherical(turn));
    c.update();
  });

  const river = useBed("river", 0);

  // Each palm breaking the ground pops: read the palms' growth back now and then, and play for each that has just begun.
  const sprouts = useRef({ last: null as Float32Array | null, busy: false, at: 0 });
  // What the animals go by: how far the oasis has come and how many palms stand.
  const life = useRef<Life>({ oasis: 0, palms: 0 });
  useFrame(() => {
    const r = sprouts.current;
    if (r.busy || performance.now() - r.at < 400) return;
    r.busy = true;
    r.at = performance.now();
    (gl.getArrayBufferAsync(desert.palms.value as any) as Promise<ArrayBuffer>)
      .then((buffer) => {
        const now = new Float32Array(buffer);
        let played = 0;
        if (r.last && r.last.length === now.length)
          for (let i = 0; i < now.length / 4 && played < 3; i++)
            if (r.last[i * 4 + 2] <= 0.01 && now[i * 4 + 2] > 0.01) {
              played++;
              const x = now[i * 4] - camera.position.x;
              setTimeout(() => sprout(THREE.MathUtils.clamp(x / 3, -0.8, 0.8)), played * 90);
            }
        r.last = now;
        let up = 0;
        for (let i = 0; i < now.length / 4; i++) if (now[i * 4 + 2] > 0.3) up++;
        life.current.palms = up;
      })
      .catch(() => {})
      .finally(() => (r.busy = false));
  });
  const wet = useRef({ level: 0, set: 0 });

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    ease(1 - Math.exp(-delta * 3));
    world.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / gl.domElement.height;

    const h = hand.current;
    // The hand's speed, smoothed, in metres a frame at sixty frames a second.
    const scale = 1 / 60 / Math.max(delta, 1e-3);
    h.velocity.lerp(new THREE.Vector2((h.at.x - h.last.x) * scale, (h.at.z - h.last.z) * scale).clampLength(0, 0.05), 0.5);
    h.last.copy(h.at);
    const u = desert.u;
    u.hand.value.set(h.at.x, h.at.z, 0.2, h.held ? 1 : 0);
    u.handVelocity.value.copy(h.held ? h.velocity : new THREE.Vector2());
    u.toSun.value.copy(world.toSun.value);
    u.gust.value = 0.5 + 0.5 * Math.sin(performance.now() / 2300) * Math.sin(performance.now() / 5100);
    // Per second: metres of sand turned to water at the hand's middle; metres of water turned back to sand, shallow and
    // deep; and how far dry sand drifts back toward the dunes.
    // The oasis: water lasts longer, moisture reaches further, and everything grows faster the further it has come.
    if (h.held) oasis.current = Math.min(1, oasis.current + delta / PARADISE);
    const o = oasis.current;
    life.current.oasis = o;
    world.oasis.value = o;
    u.oasis.value = o;
    const each = delta / detail.steps;
    u.melt.value = 0.8 * each;
    // Once there is an oasis it stays: the shallow edges still dry back a little, but the deeper water is kept.
    u.dryShallow.value = 0.0016 * each * (1 - 0.8 * Math.min(1, o * 1.6));
    u.dryDeep.value = 0.0005 * each * Math.max(0, 1 - o * 3);
    u.drift.value = 0.012 * each;
    // Moisture fades to a fifth this far from the water, in metres.
    u.reach.value = Math.pow(0.2, desert.CELL / (0.12 + 0.5 * o));
    u.spread.value = 0.25 + 0.95 * o;
    u.grow.value = (delta / 6) * (0.6 + o);
    u.wither.value = delta / 80;
    u.palmGrow.value = (delta / 12) * (0.5 + o);
    u.palmWither.value = delta / 50;
    desert.step(gl, detail.steps, [tone]);

    // The sound of sand turning to water under the hand, one of five to choose between, and running water a while after.
    const speed = h.velocity.length() * 60;
    if (h.held && performance.now() - h.noise > 110) {
      h.noise = performance.now();
      waterSound(speed);
    }
    const w = wet.current;
    w.level = h.held ? Math.min(1, w.level + delta * 0.8) : w.level * Math.exp(-delta / 6);
    if (performance.now() - w.set > 200) {
      w.set = performance.now();
      river.current?.level(w.level * 0.3);
    }

    // Focus like an eye: on the hand while it works the sand, otherwise on whatever is in the middle of the view, the
    // sand or the dunes beyond, refocusing smoothly as the view moves.
    if (h.held) h.focus.copy(h.at);
    const centre = new THREE.Ray(camera.position.clone(), camera.getWorldDirection(new THREE.Vector3()));
    // Until the frame's depth is first read, a ray against the sand and dunes stands in.
    const seen = h.held ? h.focus : looking.seen === null ? (onSand(centre) ?? onDunes(centre)) : null;
    const target = seen ? camera.position.distanceTo(seen) : looking.seen !== null && !h.held ? Math.min(looking.seen, 30) : 30;
    h.focusDistance += (Math.max(0.3, target) - h.focusDistance) * (1 - Math.exp(-delta * 5));
    focusDistance.value = h.focusDistance;
    // As through a lens, the sharp band widens with distance: close up the blur is strong, and a wide view stays sharp
    // with only its far edges soft.
    focusBlur.value = 2.6 * THREE.MathUtils.clamp(1.4 / h.focusDistance, 0.25, 1);
    if (process.env.NODE_ENV !== "production")
      Object.assign(globalThis, {
        __desert: { desert, hand: h, camera, gl, orbitPoint, oasis, scene }
      });
  });

  useAmbience(style);

  return (
    <>
      <Sky />
      <Dunes desert={desert} fine={detail.fine} inner={PATCH / 2 - desert.CELL / 2} />
      <Mirage bend="towers" />
      <Sand desert={desert} />
      <Grains desert={desert} perColumn={detail.grains} />
      <Water desert={desert} />
      <Spray desert={desert} />
      <Dust count={detail.dust} />
      {detail.shafts ? <Shafts desert={desert} steps={detail.shafts} /> : null}
      <Grass desert={desert} count={detail.grass} />
      <Palms desert={desert} />
      <Animals desert={desert} life={life} />
    </>
  );
}

// A plant breaking the ground: a bright little pop and a rustle of leaves opening.
function sprout(pan: number) {
  sound.play("pluck", { gain: 0.22, pan, pitch: 1.6 + Math.random() * 0.5 });
  sound.play("blip", { gain: 0.08, pan, pitch: 1.3 + Math.random() * 0.4 });
  setTimeout(() => sound.play("rustle", { gain: 0.1, pan, pitch: 1.2 + Math.random() * 0.3 }), 70);
}

// Sand turning to water under the hand: a soft trickle, louder the faster the hand moves, with the odd plop.
function waterSound(speed: number) {
  const loud = Math.min(0.35, speed * 0.4);
  sound.play(Math.random() < 0.6 ? "brush" : "drip", { gain: 0.15 + loud, pitch: 0.7 + Math.random() * 0.5 });
  if (Math.random() < 0.25) sound.play("plop", { gain: 0.1 + Math.random() * 0.1, pitch: 0.9 + Math.random() * 0.5 });
}

// Still desert air: a light breeze, and now and then a far crow by day or an owl under the moon.
function useAmbience(style: Style) {
  const night = style === "moonlit";
  useBed("breeze", 0.16);
  const pan = () => Math.random() * 1.6 - 0.8;
  useEvery(8, 20, () => sound.play("caw", { gain: 0.05, pan: pan(), pitch: 0.7 + Math.random() * 0.2 }), !night);
  useEvery(8, 20, () => sound.play("hoot", { gain: 0.08, pan: pan(), pitch: 0.9 + Math.random() * 0.2 }), night);
}

const mirage: DayDefinition = {
  camera: {
    position: [0.2, 0.55, 2.6],
    target: [-0.07, 0.03, 0.82],
    fov: 40,
    phone: { position: [0, 2.3, 8.2], target: [0, 0.1, 0] }
  },
  // Flown like Labyrinth: WASD to fly, Shift to rush with the view widening and the edges streaking, the eye drifting.
  explore: true,
  // Low drops the depth of field and swaps the grains and grass, a visible jolt a few seconds in, so Auto stops at
  // Medium; and the scene is drawn at one pixel per CSS pixel, as a retina screen at full density costs four times the
  // shading for little gain under the blur.
  autoFloor: "medium",
  maxDpr: 1,
  extents: { centre: [0, 0, 0], radius: 8 },
  look: { ...LOOK, exposure: 1, bloom: 0.4 },
  passes: {
    haze: false,
    bounce: false,
    // Only for the scene's depth, which the focus reads.
    overlay: true,
    depthOfField: { range: 1.8, sharpSky: true }
  },
  settings: {
    style: {
      type: "choice",
      label: "Desert",
      value: "sahara",
      options: STYLES
    },
    reset: { type: "action", label: "Start again" }
  },
  phonePills: ["style", "reset"],
  overview: [
    {
      title: "Sand and water",
      points: [
        "A heightfield of sand, water and wetness runs in WebGPU compute; the hand turns sand to water that flows by the pipe method.",
        "Water is lit per pixel with ripples, traced reflections, a depth-darkened bed and caustics."
      ]
    },
    {
      title: "Instancing",
      points: [
        "Hundreds of thousands of grains are culled each frame by a compute pass with an atomic counter, and drawn from that list.",
        "Moisture greens the desert: up to 900,000 grass blades in eight clump kinds, grown and culled in compute."
      ]
    },
    {
      title: "Palms and animals",
      points: [
        "Seven kinds of palm sprout, turn woody and leaf out, with fronds built leaflet by leaflet.",
        "Flamingos and camels are single skins of blended rods meshed by surface nets, skinned on the GPU."
      ]
    },
    {
      title: "Sky and the mirage",
      points: [
        "A ray-marched wall round the patch bends the far dunes into Fata Morgana towers; light shafts march against depth.",
        "Depth of field focuses like an eye, reading the depth of whatever sits at the centre of the frame."
      ]
    }
  ],
  hint: "Drag across the dunes to turn the sand to water. Keep going and an oasis grows. Drag the sky, hold the middle button or swipe two fingers on a trackpad to look round.",
  notes: "A little desert whose sand turns to water under your hand. Where the water lingers, grass and palms grow, until the desert is an oasis.",
  Scene
};

export default mirage;
