"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { float, Fn, instancedArray, perspectiveDepthToViewZ, uniform, vec2 } from "three/tsl";
import { orbitControls, orbitPoint, useGrabbable } from "../shared/engine/controls";
import { focusBlur, focusDistance, overlayLink } from "../shared/engine/Post";
import { useQuality } from "../shared/engine/quality";
import { useSetting, useSettingAction } from "../shared/engine/settings";
import { sound, useBed, useEvery, useMusic } from "../shared/engine/sound";
import { followPrompt } from "../shared/ui/Follow";
import { shareResult } from "../shared/ui/Share";
import { useLook } from "../shared/engine/Stage";
import type { DayDefinition } from "../shared/engine/types";
import { Air, Spores } from "./air";
import { Bloom, grove } from "./bloom";
import { Deer } from "./deer";
import { Backdrop, Bokeh, FarFloor, Floor, Log, Trees } from "./floor";
import { eyeForward, Footprints, GiantHalos, Halos, Mushrooms, Threads } from "./fungi";
import { LOOKS, type Style, STYLES } from "./looks";
import { Dew, Leaves, Twigs } from "./litter";
import { Plants } from "./plants";
import { aim, clock, ease, FALLEN, FAR_GIANTS, GIANTS, groundAt, hitFloor, logZ, pixel, sporeCloud, surfaceAt, tapAt } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const LOOK = {
  background: "#000000",
  gi: 0,
  ao: 0.5,
  aoRadius: 0.05,
  vignette: 0.5,
  grain: 0.025,
  bloomThreshold: 0.55,
  haze: 0
};

// How much the floor can hold, by tier: mushrooms, points of thread, spores in the air, and clusters.
const DETAIL = {
  high: { mushrooms: 900, points: 60000, spores: 8000, clusters: 90, fine: true, tier: "high" as const },
  medium: { mushrooms: 650, points: 42000, spores: 5000, clusters: 70, fine: true, tier: "medium" as const },
  low: { mushrooms: 360, points: 22000, spores: 2500, clusters: 45, fine: false, tier: "low" as const }
};
// Only this near the middle will a spore take.
const REACH = 1.9;

// The blooms already glowing when the visit begins: where, and on the log or not.
const FIRST: [number, number, number?][] = [
  [0.0, 0.02, 0],
  [-0.22, -0.18, 0],
  [0.2, -0.3, 1],
  [0.36, 0.06, 0],
  [-0.4, 0.14, 1],
  [-0.08, -0.55, 0],
  [-0.45, logZ(-0.45), 0],
  [0.55, logZ(0.55), 0],
  [0.4, -0.5, 4],
  [-0.32, -0.78, 5],
  [0.62, -0.2, 2],
  [-0.62, -0.32, 0],
  [0.12, 0.32, 3],
  [-0.12, 0.45, 1],
  // Along the top of the fallen log, and on the smaller logs.
  [-1.6, logZ(-1.6), 3],
  [-0.95, logZ(-0.95), 4],
  [0.15, logZ(0.15), 0],
  [1.15, logZ(1.15), 4],
  [1.85, logZ(1.85), 3],
  ...FALLEN.map((log, k): [number, number, number] => [log.x, log.z, [4, 0, 3, 5, 4][k % 5]])
];

// Major pentatonic steps, so the blooms' chimes never clash.
const STEPS = [1, 1.125, 1.25, 1.5, 1.6875, 2];
const step = () => STEPS[Math.floor(Math.random() * STEPS.length)];

// Every touch, release and bloom sound, raised to sit well above the music.
const LOUD = 2.5;
const play = (name: Parameters<typeof sound.play>[0], options: Parameters<typeof sound.play>[1] = {}) => sound.play(name, { ...options, gain: (options.gain ?? 1) * LOUD });

// Sounds to choose between: for brushing mushrooms, for letting spores go, and for a new cluster showing.
// Brushing a mushroom: a soft bubble, higher for the little ones.
function touchSound(pan: number, pitch: number, many: number) {
  const gain = 0.035 + Math.min(0.04, many * 0.01);
  play("plop", { gain: gain * 1.2, pan, pitch: pitch * 0.9 });
}
type Release = "breath" | "sparkle" | "pop" | "fizz" | "shimmer" | "hush";
function releaseSound(voice: Release, pan: number, level = 1) {
  // Twice the touch sounds again: they are softer sounds, and should carry over the music.
  const play = (name: Parameters<typeof sound.play>[0], options: Parameters<typeof sound.play>[1] = {}) => sound.play(name, { ...options, gain: (options.gain ?? 1) * LOUD * 2 * level });
  if (voice === "breath") {
    play("whoosh", { gain: 0.05, pan, pitch: 1.7 + Math.random() * 0.3 });
    play("tinkle", { gain: 0.03, pan, pitch: 1.4 + Math.random() * 0.4 });
  } else if (voice === "sparkle") {
    for (let k = 0; k < 5; k++) setTimeout(() => play("ping", { gain: 0.025, pan: pan + (Math.random() - 0.5) * 0.4, pitch: step() * 2 }), k * 70 + Math.random() * 40);
  } else if (voice === "pop") {
    play("plop", { gain: 0.07, pan, pitch: 1.3 + Math.random() * 0.4 });
    setTimeout(() => play("plop", { gain: 0.04, pan, pitch: 1.9 + Math.random() * 0.4 }), 90);
  } else if (voice === "fizz") play("sizzle", { gain: 0.05, pan, pitch: 1.4 + Math.random() * 0.3 });
  else if (voice === "shimmer") [0, 2, 4].forEach((n, k) => setTimeout(() => play("chime", { gain: 0.02, pan, pitch: STEPS[n] * 1.5 }), k * 110));
  else play("brush", { gain: 0.06, pan, pitch: 1.6 + Math.random() * 0.3 });
}
// How a cloud of spores goes up, in the order the shader numbers them.
type Cloud = "plume" | "sparkle" | "mist" | "swirl" | "mushroom" | "puffball" | "ring";
const CLOUDS: { value: Cloud; label: string }[] = [
  { value: "plume", label: "Plume" },
  { value: "sparkle", label: "Sparkle" },
  { value: "mist", label: "Mist" },
  { value: "swirl", label: "Swirl" },
  { value: "mushroom", label: "Mushroom cloud" },
  { value: "puffball", label: "Puffball" },
  { value: "ring", label: "Smoke ring" }
];
type Chime = "ping" | "bell" | "pluck" | "soft";
function bloomSound(voice: Chime, pan: number, small: boolean) {
  const play = (name: Parameters<typeof sound.play>[0], options: Parameters<typeof sound.play>[1] = {}) => sound.play(name, { ...options, gain: (options.gain ?? 1) * LOUD * 2 });
  const pitch = step() * (small ? 1.5 : 1);
  if (voice === "ping") {
    play("ping", { gain: 0.05, pan, pitch });
    setTimeout(() => play("chime", { gain: 0.025, pan, pitch: 1.5 + Math.random() * 0.5 }), 120);
  } else if (voice === "bell") play("chime", { gain: 0.05, pan, pitch: pitch * 0.75 });
  else if (voice === "pluck") play("pluck", { gain: 0.06, pan, pitch: pitch * 0.9 });
  else play("blip", { gain: 0.04, pan, pitch: pitch * 0.6 });
}

// How far off whatever is in the middle of the view stands, read from the finished frame's depth, so mushrooms, the log
// and the litter all come sharp when looked at. Nine points round the middle, the median of them, read back a frame or
// two late, which the easing hides.
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

// How far off the point the view turns round may lie, in metres.
const PIVOT_REACH = 1;

// Times spores have been let go by hand since the page opened.
const planted = { count: 0 };

function Scene() {
  const style = useSetting<Style>("style");
  const releaseVoice = useRef<Release>("breath");
  const bloomVoice = useRef<Chime>("ping");
  // How spores go up: the shader reads it as a number.
  const cloud = useSetting<Cloud>("cloud");
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;
  useEffect(() => {
    sporeCloud.value = CLOUDS.findIndex((c) => c.value === cloud);
  }, [cloud]);
  const look = LOOKS[style];
  const { tier } = useQuality();
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  // Sized once, by the tier the visit starts on, so a later step down in quality never wipes the bloom.
  const size = useRef(DETAIL[tier as keyof typeof DETAIL] ?? DETAIL.medium).current;
  const bloom = useMemo(() => new Bloom(size.mushrooms, size.points, size.spores, size.clusters), [size]);
  const giants = useMemo(() => grove(GIANTS, groundAt), []);
  const farGiants = useMemo(() => grove(FAR_GIANTS, groundAt), []);
  const start = useRef(performance.now() / 1000);
  const now = () => performance.now() / 1000 - start.current;

  // The first blooms, grown a while ago, so the floor already glows when the visit begins.
  const [resets, setResets] = useState(0);
  useSettingAction("reset", () => setResets((n) => n + 1));
  useEffect(() => {
    bloom.reset();
    const t = now();
    FIRST.forEach(([x, z, kind], i) => {
      const c = bloom.plant(x, z, t - 40 + i * 3, kind, true);
      if (c) {
        c.sang = true;
        c.nextPuff = t + 3 + i * 2.5;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bloom, resets]);

  useLook(useMemo(() => ({ ...LOOK, exposure: look.exposure, bloom: look.bloom }), [look]));
  const first = useRef(true);
  useEffect(() => {
    aim(look, first.current);
    first.current = false;
  }, [look]);

  // A new cluster first showing chimes softly, higher for the little ones, panned to where it is.
  useEffect(() => {
    bloom.onBloom = (c) => {
      const pan = THREE.MathUtils.clamp((c.x - camera.position.x) * 1.2, -0.8, 0.8);
      bloomSound(bloomVoice.current, pan, c.kind === 0 || c.kind === 3 || c.kind === 4);
    };
    // A cluster shooting its spores: the spore sound, softer, as the caps spring up.
    bloom.onPuff = (c, at) => {
      const pan = THREE.MathUtils.clamp((c.x - camera.position.x) * 1.2, -0.8, 0.8);
      const near = THREE.MathUtils.clamp(1.2 - Math.hypot(c.x - camera.position.x, c.z - camera.position.z) * 0.4, 0.25, 1);
      window.setTimeout(() => releaseSound(releaseVoice.current, pan, 0.45 * near), Math.max(0, (at - now()) * 1000));
    };
  }, [bloom, camera]);

  // Letting spores go: a soft breath of air and a sparkle. Where the floor was touched a cluster starts at once; the
  // spores carry the bloom on round about.
  const release = (x: number, y: number, z: number, count: number, seeds: number, here = true) => {
    if (here) bloom.plant(x, z, now(), undefined, true);
    if (here && ++planted.count === 5) {
      // Five handfuls of spores let go, and a bloom of your own glowing on the floor: the follow card's moment.
      shareResult.set("I grew a glowing bloom of mushrooms on a forest floor at night in Spore");
      followPrompt.earn();
    }
    // A swirl is twice as thick with spores as the other clouds.
    bloom.puff(x, y + 0.03, z, now(), cloudRef.current === "swirl" ? count * 2 : count, seeds);
    tapAt(x, z, now());
    bloom.wave(x, z, now());
    const pan = THREE.MathUtils.clamp((x - camera.position.x) * 1.2, -0.8, 0.8);
    releaseSound(releaseVoice.current, pan);
  };

  // A tap on the floor lets a puff of spores go there; a drag turns the view. Hold still on the floor first and then
  // drag to scatter a trail of them.
  useEffect(() => {
    const canvas = gl.domElement;
    let down: { x: number; y: number; t: number; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || held.current) return;
      if (performance.now() - d.t > 320 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const hit = hitFloor(ray.ray);
      if (!hit || Math.hypot(hit.point.x, hit.point.z) > REACH) return;
      release(hit.point.x, hit.point.y, hit.point.z, 140, bloom.clusters.length < 8 ? 2 : 1);
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera, bloom]);
  // Passing the pointer over mushrooms brushes them: they lean the way it moves and spring back, each with a soft
  // pluck, higher for the little ones.
  useEffect(() => {
    const canvas = gl.domElement;
    let last: { x: number; y: number } | null = null;
    let sang = 0;
    const ray = new THREE.Raycaster();
    const onMove = (e: PointerEvent) => {
      if (e.buttons !== 0 && e.pointerType === "mouse") {
        last = null;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const was = last;
      last = { x: e.clientX, y: e.clientY };
      if (!was) return;
      const dx = e.clientX - was.x;
      const dy = e.clientY - was.y;
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
      const ahead = new THREE.Vector3().crossVectors(right, new THREE.Vector3(0, 1, 0)).negate();
      const push = right.multiplyScalar(dx).addScaledVector(ahead, -dy).multiplyScalar(0.00012).clampLength(0, 0.004);
      const { hit, biggest } = bloom.brush(ray.ray.origin, ray.ray.direction, push);
      if (hit && performance.now() - sang > 70) {
        sang = performance.now();
        const pan = THREE.MathUtils.clamp(((e.clientX - rect.left) / rect.width) * 2 - 1, -0.8, 0.8);
        touchSound(pan, THREE.MathUtils.clamp(2.6 - biggest * 45, 0.9, 2.6) * (0.95 + Math.random() * 0.1), hit);
      }
    };
    const onLeave = () => (last = null);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    return () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [gl, camera, bloom]);
  const held = useRef(false);
  const trail = useRef({ at: new THREE.Vector3(), last: 0 });
  useGrabbable({
    holdToGrab: 320,
    pick(ray) {
      const hit = hitFloor(ray);
      return hit && Math.hypot(hit.point.x, hit.point.z) < REACH ? { distance: hit.distance, point: hit.point } : null;
    },
    grab(point) {
      held.current = true;
      trail.current.at.copy(point);
      trail.current.last = now();
      release(point.x, point.y, point.z, 110, 2);
    },
    // The rig hands over a point on a plane facing the eye; follow the pointer's ray from the eye down to the floor.
    drag(point) {
      const ray = new THREE.Ray(camera.position.clone(), point.clone().sub(camera.position).normalize());
      const hit = hitFloor(ray);
      if (!hit || Math.hypot(hit.point.x, hit.point.z) > REACH) return;
      const t = now();
      if (t - trail.current.last > 0.1 && hit.point.distanceTo(trail.current.at) > 0.04) {
        trail.current.last = t;
        trail.current.at.copy(hit.point);
        release(hit.point.x, hit.point.y, hit.point.z, 40, 0, Math.random() < 0.6);
      }
    },
    release() {
      setTimeout(() => (held.current = false), 0);
    }
  });

  // A macro scene: the eye may come right down among the mushrooms. Put back as it was on leaving.
  useEffect(() => {
    let kept: number | null = null;
    let frame = 0;
    const take = () => {
      const c = orbitControls.current;
      if (!c) {
        frame = requestAnimationFrame(take);
        return;
      }
      kept = c.minDistance;
      c.minDistance = 0.08;
    };
    take();
    return () => {
      cancelAnimationFrame(frame);
      if (orbitControls.current && kept !== null) orbitControls.current.minDistance = kept;
    };
  }, []);

  useMusic("/codevember/music/choir-of-magical-sounds.mp3", 0.15);

  // Night sounds: crickets, a low hum of the woods, and now and then an owl or a drop falling from the leaves.
  useBed("crickets", 0.1);
  useBed("hum", 0.025);
  const pan = () => Math.random() * 1.6 - 0.8;
  useEvery(14, 32, () => sound.play("hoot", { gain: 0.07, pan: pan(), pitch: 0.9 + Math.random() * 0.15 }), true);
  useEvery(3, 9, () => sound.play("drip", { gain: 0.03 + Math.random() * 0.03, pan: pan(), pitch: 0.8 + Math.random() * 0.6 }), true);

  const looking = useLookingAt(gl, camera);
  const focus = useRef(0.9);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const t = now();
    clock.value = t;
    ease(1 - Math.exp(-delta * 2.5));
    camera.getWorldDirection(eyeForward.value);
    pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / gl.domElement.height;
    bloom.update(t);
    // The eye may come down among the mushrooms but never into the litter or the log. The engine's own floor keeps a
    // landscape's eye a good way up, too high for this.
    const ground = surfaceAt(camera.position.x, camera.position.z).y + 0.02;
    if (camera.position.y < ground) camera.position.y += (ground - camera.position.y) * (1 - Math.exp(-delta * 12));
    // Focus like an eye on whatever is in the middle of the view; close up the blur is strong, further off it eases.
    const seen = looking.seen ?? 0.9;
    focus.current += (THREE.MathUtils.clamp(seen, 0.08, 6) - focus.current) * (1 - Math.exp(-delta * 5));
    focusDistance.value = focus.current;
    focusBlur.value = 2.2 * THREE.MathUtils.clamp(0.5 / focus.current, 0.35, 1);
    // The point the view turns round never drifts far off: panning and flying carry it along, and left metres away it
    // swings every turn wide. Past a metre it is drawn back toward the eye along the line of sight, so nothing in the
    // view moves; the next turn is just round something near.
    const pivot = orbitPoint.current;
    if (pivot) {
      const far = camera.position.distanceTo(pivot);
      if (far > PIVOT_REACH)
        pivot
          .sub(camera.position)
          .multiplyScalar(PIVOT_REACH / far)
          .add(camera.position);
    }
    if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __spore: { bloom, camera, orbitPoint, now } });
  });

  return (
    <>
      <Backdrop />
      <Bokeh tier={tier} />
      <directionalLight position={[look.toMoon[0] * 5, look.toMoon[1] * 5, look.toMoon[2] * 5]} intensity={look.moonPower * 1.5} color={look.moon} />
      <hemisphereLight color={look.moon} groundColor="#000000" intensity={0.2} />
      {/* A faint cool fill from this side of the floor, so what faces the eye is never lost in the moon's shadow. */}
      <directionalLight position={[0.6, 1.2, 3]} intensity={look.moonPower * 0.45} color={look.moon} />
      <Floor tier={tier} />
      <FarFloor />
      <Trees tier={tier} />
      <Log tier={tier} />
      {/* Loaded once, at the tier the visit starts on, apart from the rest, so a later change of tier never stops the scene. */}
      <Suspense fallback={null}>
        <Plants tier={size.tier} />
        <Leaves tier={size.tier} scan="dry_decay_leaves" />
        <Twigs tier={size.tier} />
        <Dew tier={size.tier} />
      </Suspense>
      <Mushrooms bloom={giants} fine bright={1.5} mirrored />
      <Mushrooms bloom={farGiants} fine={false} bright={0.55} mirrored />
      <GiantHalos giants={GIANTS} strength={0.09} />
      <GiantHalos giants={FAR_GIANTS} strength={0.05} />
      <Mushrooms bloom={bloom} fine={size.fine} />
      <Footprints bloom={bloom} />
      <Threads bloom={bloom} />
      <Halos bloom={bloom} />
      <Spores bloom={bloom} />
      <Air tier={tier} />
      <Deer count={tier === "low" ? 4 : 7} />
    </>
  );
}

const spore: DayDefinition = {
  camera: {
    // Turning round the near clusters, three quarters of a metre off, not a point far out on the floor.
    position: [0.05, 0.3, 0.85],
    target: [0, 0.1, 0.12],
    fov: 38,
    phone: { position: [0.05, 0.2, 0.85], target: [0, 0.035, -0.05] }
  },
  hover: true,
  extents: { centre: [0, 0.2, 0], radius: 2.6 },
  look: { ...LOOK, exposure: 1.05, bloom: 0.7 },
  maxDpr: 1.5,
  passes: {
    haze: false,
    bounce: false,
    // Only for the scene's depth, which the focus reads.
    overlay: true,
    depthOfField: { range: 0.35 }
  },
  settings: {
    style: { type: "choice", label: "Glow", value: "foxfire", options: STYLES },
    cloud: { type: "choice", label: "Spore cloud", value: "swirl", options: CLOUDS },
    reset: { type: "action", label: "Start again" }
  },
  phonePills: ["style", "reset"],
  overview: [
    {
      title: "Mushrooms",
      points: [
        "Every mushroom is one instanced draw built from numbers rather than a shape: each vertex knows only whether it is stem, cap or gills, how far along and how far round, and the shader makes the mushroom from that, its own size and lean, and how far it has grown. So a cluster costs the processor nothing once it is written: births, growth and glow are all worked out from the clock.",
        "Six kinds grow, from crowded troops of little bells on thread-thin stems and rice-sized bonnets to stout dipped caps, tall parasols, inkcaps and upturned funnels, with now and then a giant cluster twice the size of the rest. Each grows like a spring let go, the stem overshooting and settling before the cap pops open from a closed bud with a flash. Some glow brilliantly, some barely at all and some in slow waves rolling across their cluster; brush one and it leans, springs back and lights up.",
        "Before it shoots its spores a mushroom scrunches down with a shiver, then springs up as they go. The spores rise in a swirl, drift on wavering arcs and land, and those that land on floor or wood grow new clusters, so the bloom spreads by itself. Seven kinds of spore cloud are worked out in the shader from where and when each spore began and ends."
      ]
    },
    {
      title: "Mycelium and light",
      points: [
        "From each cluster threads of mycelium wander out through the litter, turning in lazy curves and forking, with a thicker strand reaching to the nearest other cluster. They are strips turned to the eye, growing at a living thread's pace, their tips brightest and pulses of light running out along them; each tap sends a ring of light through them and rocks the mushrooms it reaches.",
        "The blooms light everything round them through a coarse grid over the floor, filled on the processor each frame with the mushrooms' and threads' own light, so the litter, logs, ferns and grass take the colour of whatever glows nearby. Giant neon mushrooms stand in two rings out among the trees, their light worked out per vertex since it changes only over metres, with soft haloes hanging in the damp air."
      ]
    },
    {
      title: "The forest floor",
      points: [
        "The floor is a scan of decaying leaf litter (Poly Haven, CC0) pushed up by its own heights, with rainwater standing in its hollows: the puddles are real reflections, a second camera drawing only what glows and the woods behind from under the floor. Over it lie thousands of curled, folded leaves each wearing a patch of the scan, twigs, scanned stones and deadwood, moss cushions, sorrel, patches of grass in darker shades, and procedural ferns whose toothed leaflets are cut in the shader.",
        "Dew beads the litter and the logs, each drop a tiny ball lens as in Tension: the night bent upside down inside it, its rim mirroring the sky, the moon gathered to a burning point. Two big fallen trees lie across the floor, one built as a kinked, split tube with sloughed bark and bracket fungi, the other a scan, with smaller logs about; mushrooms grow along them too.",
        "Each kind of litter is split into wedges and rings round the middle, each with its own bounds, so whatever is behind the eye is skipped whole; the quality tier is judged behind the loader and sets how much litter is drawn."
      ]
    },
    {
      title: "The night",
      points: [
        "Tall trunks with shelf fungi stand all round under a starry sky and the Milky Way, mist lying low among them and far blooms glowing out of focus. Deer wander in the dark, seen only as black shapes against the mist and the giants' glow, walking a real deer's four-beat walk with each hoof planted, stopping to graze and look about. Fireflies blink and dust catches the moon.",
        "The view orbits close in among the mushrooms, its pivot kept near the floor, and depth of field focuses on whatever is in the middle of the frame. Three glows, Foxfire, Ghost and Aurora, change only the colours.",
        "Sound: crickets, a low hum of the woods, an owl and falling drops; a bubble as a mushroom is brushed, a breath and sparkle as spores go, and a soft pentatonic chime as each new cluster shows, all synthesised in Web Audio, over a music track."
      ]
    }
  ],
  hint: "Tap the forest floor to let spores go. Where they land, glowing mushrooms grow, and threads of light spread between them under the leaves. Hold, then drag, to scatter a trail. Drag to look round.",
  notes: "A forest floor at night. Spores drift down where you touch it, and where they land a bioluminescent bloom grows and spreads.",
  Scene
};

export default spore;
