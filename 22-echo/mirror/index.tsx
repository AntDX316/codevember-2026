"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { cameraTaken, orbitControls, orbitPoint, useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { lehmer } from "../../shared/engine/random";
import { useSettingRef } from "../../shared/engine/settings";
import { useMusic } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Gpus, scatterGpus } from "./gpus";
import { Motes } from "./motes";
import { bob, CENTRE_Y, DELAY, DROP_LIFE, DROPS, GRAVITY, MOST_BOUNCES, Room, room, TEAR, yaw } from "./room";
import { BOUNDS, field, gradient, march } from "./shape";
import { creak, pop } from "./sound";
import { Toss, toss } from "./toss";

// After the film is all gone, this long of quiet before a new bubble starts to blow, and how long it takes to fill.
const REST = 1.6;
const GROW = 6.5;
// A press shorter than this, that hardly moved, is a tap: it pops. Held still longer, it pumps. A finger wanders a little
// more than a mouse does.
const TAP_MS = 230;
const TAP_MOVE = { mouse: 8, touch: 14 };
const PUMP_MS = 250;
// Legs traced per pixel by tier: the eye's own view and then each reflection.
const BOUNCES = { low: 6, medium: 8, high: 10 } as const;
// Frames of history kept, enough to look back past the furthest reflection at any frame rate.
const HISTORY = 2048;
// Cards a pop sets loose, and dust in the air, by tier.
const CARDS = { low: 70, medium: 160, high: 240 } as const;
const MOTES = { low: 320, medium: 1800, high: 2600 } as const;

// A phone held upright. Its view looks at a point below the bubble, so the bubble sits in the open middle of the screen,
// clear of the bar above and the title below; and a tap anywhere close to the film counts, as a fingertip is broad.
const PHONE = typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;
const AIM_Y = PHONE ? CENTRE_Y - 0.6 : CENTRE_Y;
const REACH = PHONE ? 0.14 : 0.03;

const scratch = { ray: new THREE.Ray(), origin: new THREE.Vector3(), dir: new THREE.Vector3(), hit: new THREE.Vector3(), g: new THREE.Vector3(), pull: new THREE.Vector3(), pointer: new THREE.Vector2(), caster: new THREE.Raycaster(), centre: new THREE.Vector3(), lo: new THREE.Vector3(), hi: new THREE.Vector3() };

// A point from the world into the letters' own space at a moment, and back.
function toLocal(p: THREE.Vector3, time: number, scale: number, out: THREE.Vector3) {
  const a = -yaw(time);
  const x = p.x;
  const z = p.z;
  return out.set(x * Math.cos(a) + z * Math.sin(a), p.y - bob(time), z * Math.cos(a) - x * Math.sin(a)).divideScalar(scale);
}
function dirToLocal(d: THREE.Vector3, time: number, out: THREE.Vector3) {
  const a = -yaw(time);
  return out.set(d.x * Math.cos(a) + d.z * Math.sin(a), d.y, d.z * Math.cos(a) - d.x * Math.sin(a));
}

function Scene() {
  const { tier } = useQuality();
  // A mournful piano for the bubble, under everything.
  useMusic("/codevember/music/sad-documentary-piano.mp3", 0.3);
  const sides = useSettingRef<string>("room");
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const dpr = useThree((state) => state.viewport.dpr);

  const state = useMemo(
    () => ({
      now: 0,
      // whole: floating; torn: tearing, then gone; growing: a new one blowing.
      phase: "whole" as "whole" | "torn" | "growing",
      popStart: -100,
      tearEnd: 1,
      popAt: new THREE.Vector3(),
      set: 1,
      grow: 1,
      growStart: 0,
      pump: 0,
      pumping: false,
      wobble: 0,
      pops: 0,
      earned: false,
      voice: null as null | ReturnType<typeof creak>,
      random: lehmer(9157),
      // A ring of what the bubble was each frame: time, scale, wobble, plumpness, pop start, pop point, drop set.
      times: new Float64Array(HISTORY).fill(-1e9),
      rows: new Float32Array(HISTORY * 8),
      head: 0
    }),
    []
  );

  const scaleNow = () => state.grow * (1 + state.pump * 0.16);

  const hitBubble = (ray: THREE.Ray) => {
    if (state.phase === "torn" || state.grow < 0.25) return null;
    const scale = scaleNow();
    toLocal(ray.origin, state.now, scale, scratch.origin);
    dirToLocal(ray.direction, state.now, scratch.dir).normalize();
    const t = march(scratch.origin, scratch.dir, scratch.hit, state.pump * 0.22, REACH, state.now);
    if (t === null) return null;
    return { local: scratch.hit.clone(), world: ray.origin.clone().addScaledVector(ray.direction, t * scale) };
  };

  // Droplets flung from points over the film, each when the rim reaches it: out along the film's normal and away from
  // where it broke. Returns how far the furthest point is, which sets when the tear is done.
  const spray = (local: THREE.Vector3, fat: number, set: number) => {
    const s = state;
    const at = room.dropAt.array as THREE.Vector4[];
    const vel = room.dropVel.array as THREE.Vector4[];
    const scale = scaleNow();
    let furthest = 0;
    const p = new THREE.Vector3();
    for (let n = 0, made = 0; made < DROPS + 160 && n < 4000; n++) {
      p.set((s.random() * 2 - 1) * BOUNDS.x, (s.random() * 2 - 1) * BOUNDS.y, (s.random() * 2 - 1) * BOUNDS.z);
      for (let it = 0; it < 4; it++) {
        const d = field(p.x, p.y, p.z, fat);
        gradient(p.x, p.y, p.z, scratch.g, fat);
        p.addScaledVector(scratch.g, -d / Math.max(scratch.g.lengthSq(), 1e-6));
      }
      if (Math.abs(field(p.x, p.y, p.z, fat)) > 0.004) continue;
      const away = p.distanceTo(local);
      furthest = Math.max(furthest, away);
      if (made < DROPS) {
        const k = set * DROPS + made;
        gradient(p.x, p.y, p.z, scratch.g, fat).normalize();
        const spin = -yaw(s.now);
        scratch.g.set(scratch.g.x * Math.cos(spin) - scratch.g.z * Math.sin(spin), scratch.g.y, scratch.g.z * Math.cos(spin) + scratch.g.x * Math.sin(spin));
        const out = scratch.g.multiplyScalar((0.35 + s.random() * 0.9) * (s.random() < 0.5 ? 1 : -1));
        const along = p.clone().sub(local).normalize().multiplyScalar(0.5 + s.random() * 0.7);
        at[k].set(p.x, p.y, p.z, away / TEAR + s.random() * 0.04);
        vel[k].set(out.x + along.x, out.y + along.y + 0.35, out.z + along.z, (0.004 + s.random() * s.random() * 0.012) * scale);
      }
      made++;
    }
    return furthest;
  };

  // The sphere round one reflection's live droplets, as the tracer will place them, padded by how wide a droplet's glint
  // can spread there (a pixel's footprint grows with the distance the ray has come). Radius 0 when none are live.
  const bound = (b: number, time: number, scale: number, age: number, set: number) => {
    const out = room.dropBound.array[b] as THREE.Vector4;
    if (age < 0 || age >= DROP_LIFE + 0.8) return out.set(0, 0, 0, 0);
    const at = room.dropAt.array as THREE.Vector4[];
    const vel = room.dropVel.array as THREE.Vector4[];
    const spin = yaw(time);
    const lift = bob(time);
    const lo = scratch.lo.set(Infinity, Infinity, Infinity);
    const hi = scratch.hi.set(-Infinity, -Infinity, -Infinity);
    let biggest = 0;
    for (let k = set * DROPS; k < set * DROPS + DROPS; k++) {
      const a = age - at[k].w;
      if (a <= 0 || a >= DROP_LIFE) continue;
      const { x, y, z } = at[k];
      const v = vel[k];
      scratch.g.set((x * Math.cos(spin) + z * Math.sin(spin)) * scale + v.x * a, y * scale + lift + v.y * a - 0.5 * GRAVITY * a * a, (z * Math.cos(spin) - x * Math.sin(spin)) * scale + v.z * a);
      lo.min(scratch.g);
      hi.max(scratch.g);
      biggest = Math.max(biggest, v.w);
    }
    if (lo.x > hi.x) return out.set(0, 0, 0, 0);
    // A ray has come at most the eye's distance plus a room's diagonal (about 11) per leg by the time it ends one.
    const pad = 3 * Math.max(biggest, (18 + b * 12) * room.pixel.value * 1.3);
    scratch.g.addVectors(lo, hi).multiplyScalar(0.5);
    return out.set(scratch.g.x, scratch.g.y, scratch.g.z, scratch.g.distanceTo(hi) + pad);
  };

  // Run once behind the loader, so the first pop pays nothing to warm it up.
  useEffect(() => {
    spray(new THREE.Vector3(), 0, 0);
  }, []);

  const burst = (local: THREE.Vector3) => {
    const s = state;
    s.set = 1 - s.set;
    const furthest = spray(local, s.pump * 0.22, s.set);
    s.tearEnd = (furthest + 0.1) / TEAR;
    s.popAt.copy(local);
    s.popStart = s.now;
    s.phase = "torn";
    s.pops++;
    pop(DELAY, BOUNCES[tier] - 1, s.pump);
    scatterGpus(local, s.pump * 0.22, scaleNow(), s.now);
    dismissPrompt();
  };

  // Holding still on the bubble pumps it; pumped to the full, it bursts where it is held.
  const held = useRef<THREE.Vector3 | null>(null);
  useGrabbable({
    pick: (ray) => {
      const hit = hitBubble(ray);
      if (hit) held.current = hit.local;
      return hit ? { distance: ray.origin.distanceTo(hit.world), point: hit.world } : null;
    },
    grab: () => {
      if (state.phase === "torn") return;
      state.pumping = true;
      dismissPrompt();
    },
    drag: () => {},
    release: () => {
      state.pumping = false;
    },
    holdToGrab: PUMP_MS
  });

  // Where the mouse last moved, for the hover, which is worked out once a frame at most however often the mouse moves.
  const hover = useRef<{ x: number; y: number } | null>(null);

  // A quick tap on the bubble throws a graphics card at it, at the point tapped, and it pops where the card lands. A
  // mouse over the bubble holds the card ready, in place of the pointer.
  useEffect(() => {
    const dom = gl.domElement;
    const down = new Map<number, { x: number; y: number; t: number }>();
    const cast = (event: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      scratch.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      scratch.caster.setFromCamera(scratch.pointer, camera);
      return hitBubble(scratch.caster.ray);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || down.size) return;
      hover.current = { x: event.clientX, y: event.clientY };
    };
    const onLeave = () => {
      hover.current = null;
      toss.aim = null;
      dom.style.cursor = "";
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      down.set(event.pointerId, { x: event.clientX, y: event.clientY, t: performance.now() });
      // A finger has no hover: pressing on the bubble raises the card and its arc, and letting go throws it.
      if (event.pointerType !== "mouse") hover.current = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      const press = down.get(event.pointerId);
      down.delete(event.pointerId);
      if (event.pointerType !== "mouse") {
        hover.current = null;
        toss.aim = null;
      }
      const slack = event.pointerType === "mouse" ? TAP_MOVE.mouse : TAP_MOVE.touch;
      if (!press || performance.now() - press.t > TAP_MS || Math.hypot(event.clientX - press.x, event.clientY - press.y) > slack) return;
      const hit = cast(event);
      if (!hit || state.phase === "torn" || toss.flight) return;
      dismissPrompt();
      const land = () => {
        if (state.phase !== "torn") burst(hit.local);
      };
      if (toss.throwAt) toss.throwAt(hit.world, land);
      else land();
    };
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerup", onUp);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerleave", onLeave);
    dom.addEventListener("pointercancel", onLeave);
    return () => {
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("pointercancel", onLeave);
    };
  });

  useEffect(
    () => () => {
      state.voice?.stop();
      state.voice = null;
    },
    [state]
  );

  useFrame((_, raw) => {
    const s = state;
    const dt = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1 / 20) : 1 / 60;
    s.now += dt;
    const now = s.now;
    room.now.value = now;
    room.sides.value = Number(sides.current ?? "6");
    const bounces = BOUNCES[tier];
    room.bounces.value = bounces;
    room.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height * dpr);

    // The burst and what follows it. The first one earns the follow prompt once its echoes have died away, so nothing
    // pops up over the moment itself.
    if (!s.earned && s.pops > 0 && now - s.popStart > bounces * DELAY + 0.3) {
      s.earned = true;
      followPrompt.earn("mirror");
      shareResult.set("Popped the AI bubble in a hall of mirrors. It echoed all the way to infinity.");
    }
    if (s.phase === "torn" && now - s.popStart > s.tearEnd + REST) {
      s.phase = "growing";
      s.growStart = now;
      s.pump = 0;
    }
    if (s.phase === "growing") {
      const x = Math.min(1, (now - s.growStart) / GROW);
      s.grow = 0.06 + 0.94 * (1 - Math.pow(1 - x, 3));
      if (x >= 1) s.phase = "whole";
    }

    // Pumping: swells, plumps, wobbles, creaks; let go, it slowly settles back. Pumped full, it bursts.
    const pumping = s.pumping && s.phase !== "torn";
    const before = s.pump;
    if (pumping) s.pump = Math.min(1, s.pump + dt * 0.36 * (1 - s.pump * 0.5));
    else if (s.phase !== "torn") s.pump = Math.max(0, s.pump - dt * 0.06);
    const rate = (s.pump - before) / dt;
    s.wobble += (Math.min(1, Math.abs(rate) * 2.4) - s.wobble) * (1 - Math.exp(-dt * (pumping ? 6 : 1.4)));
    if (pumping && !s.voice) s.voice = creak();
    if (s.voice) {
      s.voice.set(pumping ? 0.4 + s.wobble : 0, s.pump);
      if (!pumping) {
        s.voice.stop();
        s.voice = null;
      }
    }
    if (pumping && s.pump >= 0.999 && held.current) {
      s.pumping = false;
      burst(held.current);
    }

    // Record this frame, then give each reflection the bubble as it was that many beats ago.
    const gone = s.phase === "torn" && now - s.popStart > s.tearEnd;
    const h = s.head;
    s.times[h] = now;
    s.rows.set([(gone ? -1 : 1) * scaleNow(), 0.3 + s.wobble * 1.4 + (s.phase === "growing" ? (1 - s.grow) * 1.2 : 0), s.pump * 0.22, s.phase === "torn" ? s.popStart : -1e9, s.popAt.x, s.popAt.y, s.popAt.z, s.set], h * 8);
    s.head = (h + 1) % HISTORY;
    let k = h;
    let steps = 0;
    for (let b = 0; b < Math.min(bounces, MOST_BOUNCES); b++) {
      const when = now - b * DELAY;
      while (s.times[k] > when && steps < HISTORY - 1) {
        k = (k - 1 + HISTORY) % HISTORY;
        steps++;
      }
      if (s.times[k] < -1e8) k = (k + 1) % HISTORY;
      const r = s.rows.subarray(k * 8, k * 8 + 8);
      (room.shape.array[b] as THREE.Vector4).set(r[0], r[3] > -1e8 ? when - r[3] : -1, r[1], r[2]);
      (room.popAt.array[b] as THREE.Vector4).set(r[4], r[5], r[6], r[7]);
      bound(b, when, Math.abs(r[0]), r[3] > -1e8 ? when - r[3] : -1, r[7]);
    }

    // The hover: the card is held ready, and the pointer hidden, while the mouse is over the bubble.
    if (hover.current) {
      const rect = gl.domElement.getBoundingClientRect();
      scratch.pointer.set(((hover.current.x - rect.left) / rect.width) * 2 - 1, -((hover.current.y - rect.top) / rect.height) * 2 + 1);
      scratch.caster.setFromCamera(scratch.pointer, camera);
      const hit = hitBubble(scratch.caster.ray);
      toss.aim = hit ? hit.world : null;
      toss.pointer.copy(scratch.pointer);
      gl.domElement.style.cursor = hit ? "none" : "";
    }

    // The eye may go all the way round the bubble, so the day sets no turn limits (the engine's stop short of the back);
    // it keeps its own: a band of heights round the bubble and a distance well inside the mirrors.
    const orbit = orbitControls.current;
    if (orbit) {
      orbit.minPolarAngle = 1.03;
      orbit.maxPolarAngle = 2.25;
      orbit.minDistance = 2.3;
      orbit.maxDistance = 4.4;
      orbit.enablePan = false;
    }

    // A study of one thing: the orbit point is drawn gently back to the bubble, the eye carried with it.
    const at = orbitPoint.current;
    if (at && !cameraTaken.current) {
      scratch.pull.copy(at).sub(scratch.centre.set(0, AIM_Y, 0)).multiplyScalar(-(1 - Math.exp(-dt * 0.8)));
      at.add(scratch.pull);
      camera.position.add(scratch.pull);
    }
  });

  return (
    <>
      <Room />
      <Motes count={MOTES[tier]} />
      <Gpus count={CARDS[tier]} />
      <Toss />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.8, -0.05, 3.6],
    target: [0, CENTRE_Y, 0],
    fov: 52,
    phone: { position: [0.6, AIM_Y + 0.25, 4.3], target: [0, AIM_Y, 0], fov: 86 }
  },
  hover: true,
  maxDpr: 1,
  look: { background: "#020203", exposure: 1, bloom: 0.42, bloomThreshold: 0.8, gi: 0, ao: 0, vignette: 0.55, grain: 0.02, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false, temporal: false },
  settings: {
    confetti: { type: "range", label: "Confetti", min: 0, max: 3, step: 0.1, value: PHONE ? 1.3 : 2 },
    faces: { type: "range", label: "Faces", min: 0, max: 1, step: 0.05, value: 0.3 },
    room: {
      type: "choice",
      label: "Room",
      options: [
        { value: "4", label: "Square" },
        { value: "6", label: "Hexagon" },
        { value: "8", label: "Octagon" }
      ],
      value: "6"
    }
  },
  prompt: { title: "Tap the bubble", detail: "Hold to pump it", ...(PHONE ? { low: true } : { high: true }) },
  hint: "Tap the bubble to throw a GPU at it; hold to pump it up. Drag to look round the mirrors.",
  notes: "The AI bubble in a hall of mirrors. Throw a GPU at it, and the pop echoes out through the reflections, one ring of copies after another.",
  Scene
};

export default day;
