"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { cameraTaken, orbitPoint, useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSettingRef } from "../../shared/engine/settings";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Backdrop, Bubble, RADIUS } from "./bubble";
import { Dust, focus } from "./dust";
import { age, makeField, step } from "./film";
import { hum, thrum } from "./sound";
import { clock, hold, HOLD_AXES, LIFE, rows, sendRows, SPEED, TAPS } from "./waves";

// A press held this long starts the tone.
const HOLD = 0.35;
// The tone climbs through these patterns, one every STEP seconds, and back down; each a little higher.
const ORDERS = [8, 10, 12, 14.5, 17, 20];
const NOTES = [0, 3, 5, 7, 10, 12];
const STEP = 1.8;
// How fast the standing pattern rocks, in radians a second: slow enough to see.
const ROCK = Math.PI * 2 * 2.2;
// When a tap's ring closes on the far side, and when it comes home.
const FAR_SIDE = Math.PI / SPEED;
// Steps run behind the loader so the film starts drained and marbled.
const WARM_STEPS = 300;

type Tap = { t0: number; dir: THREE.Vector3; pitch: number; pan: number; echoes: number };

const scratch = { ray: new THREE.Ray(), sphere: new THREE.Sphere(new THREE.Vector3(), RADIUS * 1.02), hit: new THREE.Vector3(), pull: new THREE.Vector3(), q: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0) };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const filmAge = useSettingRef<number>("age");
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const field = useMemo(() => makeField(startTier === "low" ? 96 : startTier === "medium" ? 128 : 160), [startTier]);

  const state = useMemo(
    () => ({
      now: 0,
      warm: false,
      taps: [] as (Tap | null)[],
      count: 0,
      earned: false,
      press: null as null | { since: number; dir: THREE.Vector3; pan: number },
      tone: { level: 0, step: 0, way: 1, stepAt: 0, order: ORDERS[0], dir: new THREE.Vector3(0, 1, 0), voice: null as null | ReturnType<typeof hum> }
    }),
    []
  );
  state.taps.length = TAPS;

  const strike = (dir: THREE.Vector3, pan: number) => {
    const s = state;
    let slot = s.taps.findIndex((r) => !r);
    if (slot < 0) {
      let oldest = 0;
      for (let k = 1; k < TAPS; k++) if (s.taps[k]!.t0 < s.taps[oldest]!.t0) oldest = k;
      slot = oldest;
    }
    // Higher on the bubble sounds higher.
    const pitch = 392 * Math.pow(2, dir.y * 0.35 + (Math.random() - 0.5) * 0.1);
    s.taps[slot] = { t0: s.now, dir: dir.clone(), pitch, pan, echoes: 0 };
    thrum(pitch, pan);
    s.count++;
    dismissPrompt();
  };

  const onBubble = (ray: THREE.Ray, out: THREE.Vector3) => ray.intersectSphere(scratch.sphere, out);
  const panOf = (dir: THREE.Vector3) => THREE.MathUtils.clamp(scratch.hit.copy(dir).project(camera).x, -1, 1);

  useGrabbable({
    pick: (ray) => {
      const at = onBubble(ray, new THREE.Vector3());
      return at ? { distance: ray.origin.distanceTo(at), point: at } : null;
    },
    grab: (point) => {
      const dir = point.clone().normalize();
      const pan = panOf(dir);
      strike(dir, pan);
      state.press = { since: state.now, dir, pan };
    },
    drag: (point) => {
      if (!state.press) return;
      scratch.ray.origin.copy(camera.position);
      scratch.ray.direction.copy(point).sub(camera.position).normalize();
      if (onBubble(scratch.ray, scratch.hit)) state.press.dir.copy(scratch.hit).normalize();
    },
    release: () => {
      state.press = null;
    }
  });

  useEffect(
    () => () => {
      state.tone.voice?.stop();
      state.tone.voice = null;
    },
    [state]
  );

  useFrame((_, raw) => {
    const dt = Number.isFinite(raw) ? Math.min(raw, 1 / 20) : 1 / 60;
    const s = state;
    age.value += (THREE.MathUtils.clamp(filmAge.current ?? 0.45, 0, 1) - age.value) * (1 - Math.exp(-dt * 3));

    if (!s.warm) {
      s.warm = true;
      age.value = filmAge.current ?? 0.45;
      sendRows();
      gl.compute(field.seed);
      step.value = 1 / 30;
      for (let k = 0; k < WARM_STEPS; k++) {
        clock.value = (k - WARM_STEPS) / 30;
        gl.compute(field.advect);
        gl.compute(field.copy);
      }
    }

    s.now += dt;
    const now = s.now;
    clock.value = now;
    step.value = dt;

    // Taps: each echoes as its ring closes on the far side and as it comes home.
    for (let k = 0; k < TAPS; k++) {
      const tap = s.taps[k];
      if (!tap) {
        rows.at[k * 4 + 3] = 0;
        continue;
      }
      const a = now - tap.t0;
      if (a > LIFE) {
        s.taps[k] = null;
        rows.at[k * 4 + 3] = 0;
        continue;
      }
      if (tap.echoes === 0 && a > FAR_SIDE) {
        tap.echoes = 1;
        thrum(tap.pitch, -tap.pan, 1);
      } else if (tap.echoes === 1 && a > FAR_SIDE * 2) {
        tap.echoes = 2;
        thrum(tap.pitch, tap.pan, 2);
      }
      rows.at.set([tap.dir.x, tap.dir.y, tap.dir.z, 1 - THREE.MathUtils.smoothstep(a, LIFE - 2, LIFE)], k * 4);
      rows.age[k] = a;
    }
    sendRows();

    // The held tone: swells in, climbs through the patterns and back, and fades when let go.
    const t = s.tone;
    const holding = !!s.press && now - s.press.since > HOLD;
    if (holding && t.level < 0.02) {
      t.step = 0;
      t.way = 1;
      t.stepAt = now + STEP;
      t.order = ORDERS[0];
      t.dir.copy(s.press!.dir);
    }
    if (holding) {
      t.dir.lerp(s.press!.dir, 1 - Math.exp(-dt * 6)).normalize();
      if (now > t.stepAt) {
        t.stepAt = now + STEP;
        if (t.step + t.way >= ORDERS.length || t.step + t.way < 0) t.way = -t.way;
        t.step += t.way;
      }
      if (!t.voice) t.voice = hum(196 * Math.pow(2, NOTES[t.step] / 12));
    }
    t.level += ((holding ? 1 : 0) - t.level) * (1 - Math.exp(-dt * (holding ? 1.6 : 1)));
    t.order += (ORDERS[t.step] - t.order) * (1 - Math.exp(-dt * 2.5));
    t.voice?.note(196 * Math.pow(2, NOTES[t.step] / 12), t.level);
    if (!holding && t.voice && t.level < 0.6) {
      t.voice.stop();
      t.voice = null;
    }
    hold.level.value = t.level > 0.002 ? t.level : 0;
    hold.order.value = t.order;
    hold.swing.value = (hold.swing.value + ROCK * dt) % (Math.PI * 2);
    scratch.q.setFromUnitVectors(scratch.up, t.dir);
    HOLD_AXES.forEach((axis, k) => hold.axes[k].value.copy(axis).applyQuaternion(scratch.q));

    gl.compute(field.advect);
    gl.compute(field.copy);

    // A study of one thing: the orbit point is drawn gently back to the bubble, the eye carried with it, so the view's
    // drift never walks it off centre.
    const at = orbitPoint.current;
    if (at && !cameraTaken.current) {
      scratch.pull.copy(at).multiplyScalar(-(1 - Math.exp(-dt * 0.8)));
      at.add(scratch.pull);
      camera.position.add(scratch.pull);
    }
    focus.value = camera.position.length();

    if (!s.earned && (s.count >= 4 || (holding && t.step >= 2))) {
      s.earned = true;
      followPrompt.earn("bubble");
      shareResult.set("Rang a soap bubble and watched its colours race round and echo back");
    }
  });

  return (
    <>
      <Backdrop />
      <Bubble cells={startTier === "low" ? 96 : startTier === "medium" ? 140 : 180} field={field} />
      <Dust count={startTier === "low" ? 500 : 1400} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.5, 0.3, 4.4],
    target: [0, 0, 0],
    fov: 36,
    limits: { turn: { left: 80, right: 80, up: 60, down: 60 }, move: { left: 0.4, right: 0.4, down: 0.4, up: 0.4, nearer: 1.4, further: 2 } },
    phone: { position: [0.2, 0.22, 7.8], target: [0, 0, 0], fov: 44 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 12, color: "#c8d4ff" },
  look: { background: "#020203", exposure: 1, bloom: 0.45, bloomThreshold: 0.7, gi: 0, ao: 0, vignette: 0.55, grain: 0.016, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false, temporal: false },
  settings: {
    age: { type: "range", label: "Film age", min: 0, max: 1, step: 0.01, value: 0.45, reset: 0.45 }
  },
  prompt: { title: "Tap the bubble", detail: "Hold to make it hum", high: true },
  hint: "Tap the bubble to ring it; hold to hum a tone. Drag around it to turn.",
  notes: "A soap bubble rung like a drum: each tap's ring stirs the film's colours as it races round, closes on the far side and echoes home.",
  overview: [
    {
      title: "Film",
      points: [
        "Thin-film interference worked out over the visible spectrum for every thickness and angle, through the eye's colour response",
        "The film's thickness is a live field on a cube-sphere grid, moved on the GPU each frame: gravity drainage, rising thin plumes, slow turbulence, and the waves' drag and eddies"
      ]
    },
    {
      title: "Membrane",
      points: [
        "Each tap is a wave packet over the angle from the point struck, mirrored at both poles, so it closes on the far side and returns",
        "Holding sets up a standing pattern of six crossing waves that gathers the film into bands"
      ]
    }
  ],
  Scene
};

export default day;
