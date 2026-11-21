"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { orbitPoint, useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingsStore } from "../../shared/engine/settings";
import { sound, useBed } from "../../shared/engine/sound";
import { KeyLight, StudioEnvironment } from "../../shared/engine/studio";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Arc, POINTS } from "./arc";
import { Buzz, snapSound, strikeSound } from "./buzz";
import {
  Air,
  ArcRibbon,
  arcTint,
  createRibbon,
  createSmoke,
  createSparks,
  createSpots,
  emitSmoke,
  emitSpark,
  GLOW,
  glowPoints,
  KEY,
  ribbon,
  SmokeCloud,
  SparkTrails,
  Spots,
  stepSmoke,
  stepSparks,
  updateRibbon
} from "./render";
import { createRodGeometry, rodLine, settingOf, spreadOf, THROAT_HALF, THROAT_Y, TIP_Y, writeRod } from "./rods";
import { Ladder, Room } from "./set";

// The day's moment: the arc caught and stretched until it snapped, a few times.
const played = { pulledSnaps: 0, earned: false };

const SHORT = new THREE.Color("#ece6ff");
const LONG = new THREE.Color("#9d86ff");

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const store = useSettingsStore();
  const voltage = useSetting<number>("voltage");
  const spreadSetting = useSetting<number>("spread");
  const slow = useSetting<boolean>("slow");
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);

  // The arc, already a second into its rhythm when the room comes up.
  const arc = useMemo(() => {
    const a = new Arc();
    a.voltage = 0.7;
    a.spread = [spreadOf(0.34), spreadOf(0.34)];
    a.strike();
    a.warm(1.3);
    return a;
  }, []);
  const rods = useMemo(() => [createRodGeometry(), createRodGeometry()] as [THREE.BufferGeometry, THREE.BufferGeometry], []);
  useDispose(rods[0], rods[1]);
  const spread = spreadOf(spreadSetting);
  useEffect(() => {
    writeRod(rods[0], -1, spread);
    writeRod(rods[1], 1, spread);
    arc.spread[0] = arc.spread[1] = spread;
  }, [rods, spread, arc]);

  const strip = useMemo(createRibbon, []);
  const spots = useMemo(createSpots, []);
  const smoke = useMemo(() => createSmoke(startTier === "low" ? 140 : 260), [startTier]);
  const sparks = useMemo(() => createSparks(64), []);

  // The arc's light on everything solid: three lamps riding it, the middle one throwing the rods' shadows on the floor and
  // wall. Always there, only dimmed, so no shader rebuilds as it comes and goes.
  const lamps = useMemo(
    () =>
      [0.18, 0.5, 0.82].map((_, k) => {
        const light = new THREE.PointLight("#c9bcff", 0, 0, 2);
        if (k === 1) {
          light.castShadow = true;
          light.shadow.mapSize.set(startTier === "low" ? 256 : 512, startTier === "low" ? 256 : 512);
          light.shadow.bias = -0.002;
          light.shadow.normalBias = 0.004;
          light.shadow.radius = 4;
          light.shadow.camera.near = 0.02;
          light.shadow.camera.far = 6;
        }
        return light;
      }),
    [startTier]
  );
  useDispose(...lamps);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __arc: arc, __camera: camera, __store: store });
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (globalThis as Record<string, unknown>).__view = (from: number[], to: number[]) => {
      camera.position.set(from[0], from[1], from[2]);
      orbitPoint.current?.set(to[0], to[1], to[2]);
      camera.lookAt(to[0], to[1], to[2]);
    };
  }, [camera]);

  // Sound: a quiet room, and the arc's own buzz and crackle.
  useBed("breeze", 0.015);
  const buzz = useMemo(() => new Buzz(), []);
  useEffect(() => () => buzz.stop(), [buzz]);

  // Press into the ladder's V to reach into the arc: it bends toward the hand, a spark jumps across to it, and close enough
  // it catches there, to be stretched until it snaps. Press on a rod's upper half to bend the two apart or together.
  const grip = useRef<{ kind: "arc" } | { kind: "rod"; side: number; height: number } | null>(null);
  const aim = useMemo(() => ({ plane: new THREE.Plane(), normal: new THREE.Vector3(), hit: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), d: new THREE.Vector3(), on: new THREE.Vector3() }), []);
  useGrabbable({
    pick: (ray) => {
      // The plane of the ladder, turned to face the eye.
      aim.normal.set(camera.position.x, 0, camera.position.z).normalize();
      aim.plane.setFromNormalAndCoplanarPoint(aim.normal, aim.a.set(0, 0, 0));
      if (!ray.intersectPlane(aim.plane, aim.hit)) return null;
      const q = aim.hit;
      const reach = camera.position.distanceTo(q);
      // A few pixels' tolerance, more under a finger.
      const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
      const pixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / size.height;
      const tolerance = Math.max(0.012, reach * pixel * (touch ? 22 : 12));
      // A rod, along its upper reaches.
      let rodBest: { side: number; d: number; height: number } | null = null;
      for (const side of [-1, 1]) {
        rodLine(side, spread, aim.a, aim.b, aim.d);
        aim.a.lerp(aim.b, 0.3);
        const d2 = ray.distanceSqToSegment(aim.a, aim.b, undefined, aim.on);
        if (d2 < tolerance * tolerance && (!rodBest || d2 < rodBest.d)) rodBest = { side, d: d2, height: aim.on.y };
      }
      // The arc, or the air between the rods where it climbs.
      const lateral = Math.abs(q.x * aim.normal.z - q.z * aim.normal.x);
      const up = THREE.MathUtils.clamp((q.y - THROAT_Y) / (TIP_Y - THROAT_Y), 0, 1);
      const half = THROAT_HALF + spread * up + (q.y > TIP_Y ? 0.08 : 0) + 0.035;
      const inside = q.y > THROAT_Y - 0.03 && q.y < TIP_Y + 0.32 && lateral < half;
      let nearArc = Infinity;
      if (arc.on) for (let i = 0; i < POINTS; i += 2) nearArc = Math.min(nearArc, ray.distanceSqToPoint(arc.p[i]));
      const onArc = nearArc < tolerance * tolerance * 4;
      if (rodBest && (!onArc || rodBest.d < nearArc)) {
        grip.current = { kind: "rod", side: rodBest.side, height: Math.max(rodBest.height, THROAT_Y + 0.2) };
        return { distance: reach, point: q.clone() };
      }
      if (!inside && !onArc) return null;
      grip.current = { kind: "arc" };
      return { distance: reach, point: q.clone() };
    },
    grab: (point) => {
      dismissPrompt();
      if (grip.current?.kind === "arc") {
        arc.probe.copy(point);
        arc.probing = true;
        sound.play("click", { gain: 0.12, pitch: 1.6 });
      } else {
        sound.play("creak", { gain: 0.25, pitch: 1.6 });
      }
    },
    drag: (point) => {
      const g = grip.current;
      if (!g) return;
      if (g.kind === "arc") {
        arc.probe.copy(point);
        return;
      }
      // The rod pivots at the throat to pass under the hand, at the height it was taken hold of; both rods move together.
      const lateral = Math.abs(point.x * aim.normal.z - point.z * aim.normal.x);
      const wanted = ((lateral - THROAT_HALF) * (TIP_Y - THROAT_Y)) / (g.height - THROAT_Y);
      const next = Math.round(settingOf(wanted) * 100) / 100;
      if (next !== store.get("spread")) {
        store.set("spread", next);
        sound.play("tick", { gain: 0.08, pitch: 0.8 + next * 0.6, gap: 0.04 });
      }
    },
    release: () => {
      arc.probing = false;
      grip.current = null;
    }
  });

  const state = useRef({ zapAge: 0, zap: 0, light: 0, focus: 2, flicker: 1, smokeDebt: 0 });
  const spot = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, raw) => {
    const s = state.current;
    const real = Math.min(raw, 1 / 20);
    const dt = real * (slow ? 0.18 : 1);
    arc.voltage = voltage;
    arc.update(dt);

    // What happened this frame: strikes crack and throw a spark or two at the throat; snaps pop.
    for (const e of arc.events) {
      if (e === "strike") {
        strikeSound(0.25 + voltage * 0.25);
        spot.set(0, THROAT_Y, 0);
        if (Math.random() < 0.6) for (let i = 0; i < 2 + Math.floor(Math.random() * 4); i++) emitSpark(sparks, spot, 1.6);
      } else {
        snapSound(0.2 + Math.min(1, arc.strain) * 0.25);
        if (arc.probing) {
          played.pulledSnaps++;
          if (!played.earned && played.pulledSnaps >= 3) {
            played.earned = true;
            followPrompt.earn("snapped");
            shareResult.set("Just stretched a Jacob's ladder arc until it snapped");
          }
        }
      }
    }
    arc.events.length = 0;

    // How bright the arc burns: by voltage, a flash as it strikes, and the frame-to-frame flicker of mains current.
    s.flicker = 0.82 + Math.random() * 0.3;
    const stretch = THREE.MathUtils.clamp(arc.strain, 0, 1.2);
    const live = arc.on ? (0.6 + voltage * 0.7) * (1 + arc.flash * 0.9) * s.flicker : 0;
    const ghost = arc.ghostAge < 1 ? Math.exp(-arc.ghostAge * 14) * 0.7 : 0;
    arcTint.value.copy(SHORT).lerp(LONG, THREE.MathUtils.smoothstep(stretch, 0.2, 1));

    // A spark jumps from the arc to a hand held near it, until it is close enough to catch the arc itself.
    const near = arc.probing && arc.on && arc.caught < 0 ? THREE.MathUtils.clamp(1 - (arc.nearestDistance - 0.02) / 0.07, 0, 1) : 0;
    s.zap = near > 0 ? Math.max(near, s.zap * 0.7) : s.zap * Math.exp(-real * 20);
    s.zapAge += real;
    const zapFresh = near > 0 && s.zapAge > 0.035;
    if (zapFresh) s.zapAge = 0;
    const zapLive = near > 0 ? near * (0.55 + Math.random() * 0.6) * (0.6 + voltage * 0.6) : 0;

    // The ribbons.
    ribbon.eye.value.copy(camera.position);
    ribbon.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);
    ribbon.core.value = 0.0011 + voltage * 0.0011;
    ribbon.glow.value = 0.014 + voltage * 0.012;
    ribbon.live.value = live;
    ribbon.ghost.value = ghost;
    ribbon.zap.value = zapLive;
    updateRibbon(strip, arc, 0.0011 + stretch * 0.0012, zapFresh, arc.p[arc.nearest], arc.probe);

    // The hot spots: the two feet, the hand when a spark or the arc reaches it, the throat at a strike.
    const d = spots.data;
    const footGlow = live * 0.9;
    d.set([arc.p[0].x, arc.p[0].y, arc.p[0].z, footGlow], 0);
    d.set([arc.p[POINTS - 1].x, arc.p[POINTS - 1].y, arc.p[POINTS - 1].z, footGlow], 4);
    const handGlow = arc.caught > 0 && arc.on ? live * 0.8 : zapLive * 0.7;
    d.set([arc.probe.x, arc.probe.y, arc.probe.z, handGlow], 8);
    d.set([0, THROAT_Y, 0, arc.on ? arc.flash * 1.3 : 0], 12);
    spots.attribute.needsUpdate = true;

    // Its light through the air: seven points along it (or its fading ghost) and one on the spark to the hand.
    const length = arc.on ? arc.length : 0;
    const power = THREE.MathUtils.clamp(0.7 + length * 1.2, 0.7, 1.4);
    const points = glowPoints.array as THREE.Vector4[];
    for (let k = 0; k < GLOW - 1; k++) {
      const i = Math.round((k / (GLOW - 2)) * (POINTS - 1));
      const src = arc.on ? arc.p[i] : arc.ghost[i];
      const w = arc.on ? live * power * 0.0011 : ghost * 0.0003;
      points[k].set(src.x, src.y, src.z, w);
    }
    const mid = arc.p[arc.nearest];
    points[GLOW - 1].set((mid.x + arc.probe.x) / 2, (mid.y + arc.probe.y) / 2, (mid.z + arc.probe.z) / 2, zapLive * 0.0012);

    // The lamps that light the copper, the porcelain, the floor and the wall.
    s.light += ((arc.on ? live * power : ghost * 0.2) - s.light) * (arc.on ? 1 : 1 - Math.exp(-real * 30));
    lamps.forEach((lamp, k) => {
      const i = Math.round([0.18, 0.5, 0.82][k] * (POINTS - 1));
      const src = arc.on ? arc.p[i] : arc.ghost[i];
      lamp.position.copy(src);
      lamp.intensity = s.light * (k === 1 ? 0.42 : 0.22);
      lamp.color.copy(arcTint.value);
    });

    // Smoke off the arc, more the brighter and longer it burns.
    if (arc.on) {
      s.smokeDebt += dt * (18 + 50 * live * Math.min(1, length * 3));
      while (s.smokeDebt >= 1) {
        s.smokeDebt -= 1;
        const i = 1 + Math.floor(Math.random() * (POINTS - 2));
        const p = arc.p[i];
        const v = arc.v[i];
        emitSmoke(smoke, p.x, p.y + 0.004, p.z, v.x * 0.25, 0.08 + v.y * 0.25, v.z * 0.25, 2.2 + Math.random() * 2.4);
      }
    }
    stepSmoke(smoke, dt, arc.time);
    stepSparks(sparks, dt, 0.002);

    buzz.set(arc.on, 0.4 + voltage * 0.6, stretch, s.zap, slow);

    // The lens holds the arc, wherever it has got to.
    const target = arc.on ? arc.p[POINTS >> 1] : orbitPoint.current ?? arc.p[POINTS >> 1];
    s.focus += (camera.position.distanceTo(target) - s.focus) * (1 - Math.exp(-real * 3));
    focusDistance.value = Math.max(0.4, s.focus);
    focusBlur.value = 0.9;
  });

  return (
    <>
      <StudioEnvironment
        ambient="#030304"
        intensity={0.55}
        boxes={[
          { position: [-5, 5, 2], scale: [0.2, 3, 3], color: "#b9c8e8", intensity: 0.9 },
          { position: [4, 1.5, 3], scale: [0.2, 2, 2], color: "#ffd9b8", intensity: 0.25 },
          { position: [0, 6, 0], scale: [4, 0.2, 4], color: "#d8d4e8", intensity: 0.12 }
        ]}
      />
      <KeyLight position={[KEY.x, KEY.y, KEY.z]} target={[0.1, 0.45, -0.1]} color="#a9bce0" intensity={110} angle={0.75} penumbra={0.85} shadowFar={8} />
      {lamps.map((lamp, k) => (
        <primitive key={k} object={lamp} />
      ))}
      <Suspense fallback={null}>
        <Room />
      </Suspense>
      <Ladder rods={rods} />
      <ArcRibbon r={strip} />
      <Spots spots={spots} />
      <SmokeCloud smoke={smoke} />
      <SparkTrails sparks={sparks} />
      <Air dust={startTier === "low" ? 700 : 1800} />
    </>
  );
}

const ladder: DayDefinition = {
  camera: {
    position: [0.3, 0.5, 2.15],
    target: [0, 0.68, 0],
    fov: 40,
    phone: { position: [0.42, 0.52, 2.15], target: [0, 0.72, 0], fov: 54 },
    limits: { turn: { left: 55, right: 55, up: 24, down: 16 }, move: { left: 0.2, right: 0.2, down: 0.25, up: 0.25, nearer: 1.2, further: 0.7 } }
  },
  hover: true,
  extents: { centre: [0, 0.6, 0], radius: 3.2, color: "#c9bcff" },
  // Black behind: the overlay pass (the arc, its glow in the haze, smoke and dust) is added over the whole frame.
  look: { background: "#000000", exposure: 1.05, bloom: 0.42, bloomThreshold: 0.95, gi: 0, ao: 0.9, aoRadius: 0.12, vignette: 0.55, grain: 0.02, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, depthOfField: { range: 1.4 } },
  settings: {
    voltage: { type: "range", label: "Voltage", min: 0, max: 1, step: 0.01, value: 0.7, reset: 0.7 },
    spread: { type: "range", label: "Rod spread", short: "Spread", min: 0, max: 1, step: 0.01, value: 0.34, reset: 0.34 },
    slow: { type: "toggle", label: "Slow motion", short: "Slow-mo", value: false }
  },
  phoneDock: ["voltage", "spread"],
  phoneDockPills: ["slow"],
  prompt: { title: "Reach into the arc", detail: "Catch it, and stretch it till it snaps", low: true },
  hint: "Press between the rods to reach into the arc: it bends toward you, sparks jump to your hand, and close enough it catches, to be stretched until it snaps. Drag a rod to bend the V; more voltage, a longer climb.",
  notes: "A Jacob's ladder in a dark workshop: an arc strikes between two copper rods, rides its own hot air up the V, stretches into a loop and snaps.",
  overview: [
    {
      title: "The arc",
      points: [
        "A string of 44 points stepped 240 times a second: buoyant heat lifts it, stirred air wobbles it, and its feet slide up the rods behind it.",
        "Points are re-spaced along it each frame; past a length set by the voltage it snaps, and strikes again at the throat in a tenth of a second."
      ]
    },
    {
      title: "Your hand",
      points: [
        "The pointer pulls the arc toward it; within a few centimetres a fresh spark jumps across each frame, and closer it catches and holds.",
        "A caught arc stretches 30% further before it lets go; dragging a rod pivots both about the throat, rewriting their tubes in place."
      ]
    },
    {
      title: "Light",
      points: [
        "The haze glows by the inverse-square integral along each line of sight to eight points on the arc, in closed form, stopped by depth.",
        "Three lamps ride the arc to light copper, porcelain and concrete, one throwing the rods' shadows; smoke and dust are lit by the same points."
      ]
    }
  ],
  Scene
};

export default ladder;
