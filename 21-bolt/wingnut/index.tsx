"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { orbitPoint, useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt, resetPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingAction, useSettingsStore } from "../../shared/engine/settings";
import { sound, useBed } from "../../shared/engine/sound";
import { StudioEnvironment } from "../../shared/engine/studio";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Air, Backdrop, SUN } from "./air";
import { threadTick, ting, Whirr } from "./audio";
import { FINISHES, metal } from "./metal";
import { Spinner } from "./physics";
import { HOVER, PHONE, RIG } from "./rig";
import { boltGeometry, hexNut, tHandle, wingNut, type Thing } from "./shapes";

const OBJECTS = [
  { value: "wing", label: "Wing nut", short: "Wing nut" },
  { value: "tee", label: "T-handle", short: "T-handle" },
  { value: "hex", label: "Hex nut", short: "Hex nut" }
];

// How much harder a flick throws than the hand moves (more on a phone's short swipes), and the fastest spin it can
// give (turns a second × 2π).
const FLICK = PHONE ? 2.8 : 1.7;
const MAX_SPIN = Math.PI * 2 * 7;

// What the wings sound like passing: two blades for the wing nut and the T-bar, none for a hex nut.
const BLADES: Record<string, number> = { wing: 2, tee: 2, hex: 0 };

const scratch = {
  ray: new THREE.Raycaster(),
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
  c: new THREE.Vector3(),
  g: new THREE.Vector3(),
  look: new THREE.Vector3(),
  front: new THREE.Vector3(),
  side: new THREE.Vector3(),
  h: new THREE.Vector3(),
  q: new THREE.Quaternion()
};

// How many ways the visit has gone well, for the follow card.
const visit = { flips: 0, earned: false };

function Things({ things, refs }: { things: Record<string, Thing>; refs: React.RefObject<Record<string, THREE.Group | null>> }) {
  const materials = useMemo(
    () => ({
      wing: { main: metal(FINISHES.brass, "z"), bright: metal(FINISHES.chrome, "z") },
      tee: { main: metal(FINISHES.aluminium, "z"), bright: metal(FINISHES.chrome, "x") },
      hex: { main: metal(FINISHES.zinc, "z"), bright: metal(FINISHES.chrome, "z") }
    }),
    []
  );
  useDispose(...Object.values(materials).flatMap((m) => [m.main, m.bright]));
  return (
    <>
      {Object.entries(things).map(([key, thing]) => (
        <group
          key={key}
          ref={(g) => {
            refs.current[key] = g;
          }}
        >
          {thing.parts.map((part, i) => (
            <mesh key={i} geometry={part.geometry} material={materials[key as keyof typeof materials][part.finish]} castShadow receiveShadow />
          ))}
        </group>
      ))}
    </>
  );
}

// The light: the sun through the porthole as a soft-shadowed spot, a cool rim from behind on the right as off a pale
// cabin wall, and very little else, so the metal falls off into the dark on the far side.
function Lights() {
  const key = useMemo(() => {
    const spot = new THREE.SpotLight("#ffe0bc", 200, 0, 0.5, 0.8, 2);
    spot.position.copy(SUN);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.bias = -0.0002;
    spot.shadow.normalBias = 0.004;
    spot.shadow.radius = 6;
    spot.shadow.camera.near = 2;
    spot.shadow.camera.far = 14;
    // Aimed between the bolt and where the nut hovers, so both stand in the sun.
    spot.target.position.copy(HOVER).multiplyScalar(0.6);
    return spot;
  }, []);
  const rim = useMemo(() => {
    const light = new THREE.DirectionalLight("#c4d0e8", 0.45);
    light.position.set(1, 4, -5);
    return light;
  }, []);
  useEffect(() => () => key.dispose(), [key]);
  return (
    <>
      <primitive object={key} />
      <primitive object={key.target} />
      <primitive object={rim} />
      <hemisphereLight args={["#2a2420", "#0a0c10", 0.25]} />
    </>
  );
}

// Thin lines along the angular momentum (which never changes) and along the thing's own axis (which flips about it).
function AxisLines({ spinner, rig, shown }: { spinner: Spinner; rig: React.RefObject<THREE.Group | null>; shown: boolean }) {
  const parts = useMemo(() => {
    const geometry = new THREE.CylinderGeometry(0.006, 0.006, 1, 8, 1);
    const momentum = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color("#ffc98a").multiplyScalar(2.2), transparent: true, opacity: 0.85, depthWrite: false });
    const own = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color("#9cc4ff").multiplyScalar(1.8), transparent: true, opacity: 0.75, depthWrite: false });
    return { geometry, momentum, own };
  }, []);
  useDispose(parts.geometry, parts.momentum, parts.own);
  const lRef = useRef<THREE.Mesh>(null);
  const zRef = useRef<THREE.Mesh>(null);
  const fade = useRef(0);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  useFrame((_, delta) => {
    fade.current += ((shown && spinner.mode === "free" ? 1 : 0) - fade.current) * (1 - Math.exp(-delta * 6));
    const l = lRef.current;
    const z = zRef.current;
    if (!l || !z || !rig.current) return;
    l.visible = z.visible = fade.current > 0.01;
    parts.momentum.opacity = 0.85 * fade.current;
    parts.own.opacity = 0.75 * fade.current;
    l.position.copy(spinner.position);
    z.position.copy(spinner.position);
    const L = scratch.a.copy(spinner.momentum);
    if (L.lengthSq() > 1e-10) l.quaternion.setFromUnitVectors(up, L.normalize());
    l.scale.set(1, 2.2, 1);
    z.quaternion.copy(spinner.quaternion).multiply(scratch.q.setFromUnitVectors(up, scratch.b.set(0, 0, 1)));
    z.scale.set(1, 1.3, 1);
  });
  return (
    <>
      <mesh ref={lRef} geometry={parts.geometry} material={parts.momentum} visible={false} raycast={() => null} />
      <mesh ref={zRef} geometry={parts.geometry} material={parts.own} visible={false} raycast={() => null} />
    </>
  );
}

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const detail = useMemo(() => (startTier === "low" ? { perTurn: 8, around: 96, fill: 0.012 } : startTier === "medium" ? { perTurn: 10, around: 128, fill: 0.01 } : { perTurn: 12, around: 160, fill: 0.008 }), [startTier]);
  // Everything built once at load: the bolt and all three things, each measured for its inertia.
  const built = useMemo(() => {
    const bolt = boltGeometry(detail);
    const things: Record<string, Thing> = { wing: wingNut(detail), tee: tHandle(detail), hex: hexNut(detail) };
    return { bolt, things };
  }, [detail]);
  useDispose(built.bolt, ...Object.values(built.things).flatMap((t) => t.parts.map((p) => p.geometry)));
  const steel = useMemo(() => metal(FINISHES.steel, "x"), []);
  useDispose(steel);

  const object = useSetting<string>("object");
  const timeSpeed = useSetting<number>("timeSpeed");
  const showAxis = useSetting<boolean>("axis");
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const store = useSettingsStore();

  const spinner = useMemo(() => {
    let seed = 90127;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    return new Spinner(built.things.wing.body, random);
  }, [built]);
  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __spinner: spinner, __camera: camera, __scene: scene, __store: store });

  const rig = useRef<THREE.Group>(null);
  // For testing in development: put the eye somewhere from the console.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (globalThis as Record<string, unknown>).__view = (from: number[], to: number[]) => {
      camera.position.set(from[0], from[1], from[2]);
      orbitPoint.current?.set(to[0], to[1], to[2]);
      camera.lookAt(to[0], to[1], to[2]);
    };
  }, [camera]);
  const thingRefs = useRef<Record<string, THREE.Group | null>>({});
  const whirr = useMemo(() => new Whirr(), []);
  useEffect(() => () => whirr.stop(), [whirr]);

  // The other thing goes onto the bolt in its place.
  const lastObject = useRef(object);
  useEffect(() => {
    if (lastObject.current === object) return;
    lastObject.current = object;
    spinner.setBody(built.things[object]?.body ?? built.things.wing.body);
    spinner.toStart();
    sound.play("whoosh", { gain: 0.18, pitch: 1.3 });
    ting(0.25, 0.8);
  }, [object, spinner, built]);

  useSettingAction("reset", () => {
    spinner.goBack();
    resetPrompt();
    sound.play("whoosh", { gain: 0.22, pitch: 1.1 });
  });

  // The hand: where it took hold (in the thing's own frame, so it turns with it), and the pointer's path since.
  const hand = useRef({ local: new THREE.Vector3(), point: new THREE.Vector3(), last: new THREE.Vector3(), fresh: false, has: false, spin: 0, peak: 0, slow: 1 });
  const thingNow = () => thingRefs.current[object] ?? null;
  // For testing in development: where the current thing's handles are on screen, 0 to 1 across and down.
  if (process.env.NODE_ENV !== "production")
    (globalThis as Record<string, unknown>).__handles = () => {
      const g = thingNow();
      if (!g) return [];
      return (built.things[object]?.handles ?? []).map((h) => {
        const v = g.localToWorld(h.clone()).project(camera);
        return [+(v.x * 0.5 + 0.5).toFixed(3), +(0.5 - v.y * 0.5).toFixed(3)];
      });
    };

  useGrabbable({
    pick: (ray) => {
      const g = thingNow();
      if (!g || spinner.mode === "return") return null;
      scratch.ray.ray.copy(ray);
      const hits = scratch.ray.intersectObject(g, true);
      if (hits.length) return { distance: hits[0].distance, point: hits[0].point.clone() };
      // Near enough one of its handles (a wing, the bar) still catches it, more so under a finger: a spinning wing is
      // hard to hit exactly.
      const room = PHONE ? 0.3 : 0.17;
      let best: { d: number; point: THREE.Vector3 } | null = null;
      for (const handle of built.things[object]?.handles ?? []) {
        const at = g.localToWorld(scratch.h.copy(handle));
        if (ray.distanceSqToPoint(at) > room * room) continue;
        const d = ray.origin.distanceTo(at);
        if (!best || d < best.d) best = { d, point: ray.closestPointToPoint(at, new THREE.Vector3()) };
      }
      if (best) return { distance: best.d, point: best.point };
      // Tumbling in the air it is anywhere in the ball it sweeps: a press over that catches it.
      if (spinner.mode === "free") {
        const centre = g.getWorldPosition(scratch.c);
        const ball = spinner.body.reach * 0.75;
        if (ray.distanceSqToPoint(centre) < ball * ball) {
          const d = ray.origin.distanceTo(centre);
          return { distance: d, point: ray.closestPointToPoint(centre, new THREE.Vector3()) };
        }
      }
      return null;
    },
    grab: (point) => {
      const g = thingNow();
      if (!g) return;
      g.updateMatrixWorld();
      const h = hand.current;
      // Held by the spot taken: kept at least a little way out from the axis, so a press on the hub still turns it.
      h.local.copy(point);
      g.worldToLocal(h.local);
      const out = Math.hypot(h.local.x, h.local.y);
      if (out < 0.25) {
        const a = Math.atan2(h.local.y, h.local.x) || 0;
        h.local.set(Math.cos(a) * 0.25, Math.sin(a) * 0.25, h.local.z);
      }
      h.point.copy(point);
      h.last.copy(point);
      h.fresh = false;
      h.has = true;
      spinner.grab();
      h.spin = spinner.handSpin;
      h.peak = 0;
      dismissPrompt();
      if (spinner.mode === "free") ting(0.22, 0.75);
      else sound.play("click", { gain: 0.22, pitch: 1.4 });
    },
    drag: (point) => {
      hand.current.point.copy(point);
      hand.current.fresh = true;
    },
    release: () => {
      const h = hand.current;
      h.has = false;
      if (Math.abs(h.peak) > Math.abs(spinner.handSpin)) spinner.handSpin = h.peak;
      spinner.letGo();
    }
  });

  // Sound: a faint cabin air under everything, and the spin's whirr; the rest are one-shots below.
  useBed("breeze", 0.02);

  const sounds = useRef({ tickAt: 0, lastTurn: 0 });

  useFrame((_, raw) => {
    const real = Math.min(raw, 1 / 20);
    const r = rig.current;
    const g = thingNow();
    if (!r || !g) return;
    const h = hand.current;

    // Held, time runs at its own pace so the thing stays under the hand; let go, it eases into the slow motion asked.
    h.slow += ((spinner.held ? 1 : timeSpeed) - h.slow) * (1 - Math.exp(-real * (spinner.held ? 12 : 2.5)));
    const dt = real * h.slow;

    // The hand drives the spin about the thing's own axis: the pointer's speed across the screen along the way the
    // spot taken hold of would move as it turns, over its distance from the axis.
    if (spinner.held && h.has) {
      const axis = spinner.axis(scratch.a).applyQuaternion(r.quaternion);
      const centre = g.getWorldPosition(scratch.c);
      const grip = scratch.g.copy(h.local);
      g.localToWorld(grip);
      const arm = grip.sub(centre);
      arm.addScaledVector(axis, -arm.dot(axis));
      const reach = Math.max(arm.length(), 0.3);
      const look = scratch.look.set(0, 0, -1).applyQuaternion(camera.quaternion);
      // Seen from the side, a drag across the axis rolls it like a pencil under a finger: as if the hand were on the
      // side facing the eye, whichever wing it caught. Seen end on, the spot taken hold of simply goes round.
      const front = scratch.front.copy(look).negate();
      front.addScaledVector(axis, -front.dot(axis));
      const endOn = THREE.MathUtils.smoothstep(Math.abs(look.dot(axis)), 0.6, 0.9);
      const tangent = scratch.b.crossVectors(axis, front.lengthSq() > 1e-6 ? front.normalize() : arm.clone().normalize()).multiplyScalar(1 - endOn);
      tangent.addScaledVector(scratch.side.crossVectors(axis, arm).normalize(), endOn);
      tangent.addScaledVector(look, -tangent.dot(look));
      const seen = Math.max(tangent.lengthSq(), 0.3);
      const moved = h.fresh ? scratch.g.subVectors(h.point, h.last) : scratch.g.set(0, 0, 0);
      h.last.copy(h.point);
      h.fresh = false;
      // A flick throws a little harder than the hand moves, as a fingertip snapping off a wing does.
      const wanted = THREE.MathUtils.clamp((FLICK * moved.dot(tangent)) / (reach * seen) / Math.max(real, 1e-3), -MAX_SPIN, MAX_SPIN);
      h.spin += (wanted - h.spin) * (1 - Math.exp(-real * 22));
      // The hardest of the last moment, kept a little while, so a hand that slows before letting go still throws.
      if (Math.abs(h.spin) > Math.abs(h.peak) || Math.sign(h.spin) !== Math.sign(h.peak)) h.peak = h.spin;
      else h.peak *= Math.exp(-real * 5);
      spinner.handSpin = h.spin;
    }

    // Stepped at 480 Hz whatever the frame rate.
    const steps = Math.max(1, Math.ceil(dt * 480));
    let hit = 0;
    let left = false;
    let flipped = false;
    for (let i = 0; i < steps; i++) {
      spinner.step(dt / steps);
      hit = Math.max(hit, spinner.hitHead);
      left ||= spinner.leftThread;
      flipped ||= spinner.flipped;
    }

    g.position.copy(spinner.position);
    g.quaternion.copy(spinner.quaternion);
    for (const key of Object.keys(thingRefs.current)) {
      const other = thingRefs.current[key];
      if (other) other.visible = key === object;
    }

    // Sound, timed to what is seen.
    const turns = spinner.spinRate();
    const s = sounds.current;
    if (spinner.mode !== "free") {
      // The thread: a tiny tick each half turn as it runs through.
      const half = Math.floor(spinner.theta / Math.PI);
      if (half !== s.lastTurn) {
        s.lastTurn = half;
        const now = performance.now();
        if (now - s.tickAt > 55 && turns > 0.05) {
          s.tickAt = now;
          threadTick(Math.min(1, 0.35 + turns * 0.2), 0.9 + Math.random() * 0.2);
        }
      }
    }
    if (hit > 0.5) ting(Math.min(0.7, 0.15 + hit * 0.03), 0.72);
    if (left) {
      ting(0.55, 1.0);
      sound.play("whoosh", { gain: 0.16, pitch: 1.6 });
    }
    if (flipped) {
      sound.play("whoosh", { gain: Math.min(0.3, 0.08 + turns * 0.04), pitch: 0.75 + Math.min(turns, 8) * 0.05 * h.slow, gap: 0.25 });
      visit.flips++;
      if (!visit.earned && visit.flips >= 2) {
        visit.earned = true;
        followPrompt.earn("flip");
        shareResult.set("Spun a wing nut off its bolt in zero gravity and watched it flip itself over (the Dzhanibekov effect)");
      }
    }
    whirr.set(Math.min(0.09, turns * 0.012) * (0.5 + 0.5 * h.slow), turns * h.slow, BLADES[object] ?? 0);

    // Focus on the thing, wherever it has floated.
    const at = g.getWorldPosition(scratch.c);
    const focus = Math.max(1, camera.position.distanceTo(at));
    focusDistance.value += (focus - focusDistance.value) * (1 - Math.exp(-real * 5));
    focusBlur.value = 1.1;
  });

  const dust = startTier === "high" ? 2600 : startTier === "medium" ? 1700 : 800;

  return (
    <>
      <Backdrop />
      <Air dust={dust} />
      <StudioEnvironment
        ambient="#070708"
        intensity={0.9}
        boxes={[
          { position: [-6, 5, -3], scale: [4, 4, 0.3], color: "#ffe2c0", intensity: 4 },
          { position: [3, 2, -7], scale: [3, 4, 0.3], color: "#c8d4ee", intensity: 0.7 },
          { position: [0, 7, 1], scale: [7, 0.2, 2], color: "#fff4e8", intensity: 0.9 },
          { position: [1, -6, 2], scale: [6, 0.2, 6], color: "#2a221c", intensity: 0.7 },
          { position: [3, 2, 8], scale: [3, 1.2, 0.2], color: "#fff6ec", intensity: 0.8 },
          { position: [-5, 1.5, 6], scale: [3, 4, 0.3], color: "#ffe9d2", intensity: 1.4 }
        ]}
      />
      <Lights />
      <group ref={rig} position={RIG.position} quaternion={RIG.quaternion}>
        <mesh geometry={built.bolt} material={steel} castShadow receiveShadow />
        <Things things={built.things} refs={thingRefs} />
        <AxisLines spinner={spinner} rig={rig} shown={showAxis} />
      </group>
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [1.3, 0.9, 6.9],
    target: [0.3, 0.38, 0],
    fov: 34,
    limits: { turn: { left: 70, right: 70, up: 45, down: 45 }, move: { left: 1.2, right: 1.2, down: 1, up: 1, nearer: 2.6, further: 3 } },
    phone: { position: [0.6, 0.5, 9], target: [0, 0.2, 0], fov: 46 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 11, color: "#ffd9b0" },
  // Black behind: the overlay pass (the beams and the dust) is added over the whole frame.
  look: { background: "#000000", exposure: 1.05, bloom: 0.24, bloomThreshold: 1.45, gi: 0, ao: 0.8, aoRadius: 0.12, vignette: 0.55, grain: 0.014, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, depthOfField: { range: 2.2 } },
  settings: {
    object: { type: "choice", label: "Spin", value: "wing", options: OBJECTS },
    timeSpeed: { type: "range", label: "Time speed", short: "Time", min: 0.1, max: 1, step: 0.01, value: 1, reset: 1 },
    axis: { type: "toggle", label: "Show spin axis", short: "Axis", value: false },
    reset: { type: "action", label: "Back on the bolt" }
  },
  phoneDock: ["object", "timeSpeed"],
  phonePills: ["reset", "axis"],
  // Which way unscrews it from the opening view: down across the bolt on a desktop, to the right on a phone.
  prompt: PHONE ? { title: "Flick a wing to the right", detail: "Spin the nut off the bolt", low: true } : { title: "Flick a wing downward", detail: "Spin the nut off the bolt, then watch it in the air", high: true },
  hint: "Flick a wing to spin the nut off the end of the bolt. In the air it turns about its middle axis, which is unstable, so it flips right over every second or two. Catch it and spin it again, slow time down, or try the hex nut, which never flips.",
  notes: "The zero-gravity wing nut: spun off a bolt in a sunlit cabin, it tumbles over and over by itself, the Dzhanibekov effect.",
  overview: [
    {
      title: "The flip",
      points: [
        "Off the thread the nut is a free rigid body: its angular momentum is fixed and its turning is ω = R I⁻¹ Rᵀ L.",
        "The quaternion is stepped with RK4 480 times a second; spun about its middle axis, a 1–2% wobble grows until it turns right over.",
        "The hex nut spins about its largest axis, which is stable, so it only wobbles: the control."
      ]
    },
    {
      title: "The thread",
      points: [
        "On the bolt the nut has one freedom: each turn carries it one pitch along, so a flick screws it off the end.",
        "Each shape's inertia is measured at load by filling its own solid with up to two million points."
      ]
    },
    {
      title: "Rendering",
      points: [
        "The thread is a true ISO profile on a grid that follows the helix, with normals from its slope, so there is no seam.",
        "Brass, steel, chrome and zinc carry lathe rings and smudges in their roughness; a porthole sun lights the dust."
      ]
    }
  ],
  Scene
};

export default day;
