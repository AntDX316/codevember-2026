"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt, resetPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { sound, useBed } from "../../shared/engine/sound";
import { KeyLight, StudioEnvironment } from "../../shared/engine/studio";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Air, Backdrop, KEY, room } from "./air";
import { Bolt, boltGeometry, boltMaterial, flashAt, Grains, LEAD, Sparks, strike } from "./effects";
import { Glass, glassLook, glassMaterial } from "./glass";
import { createSand, keyDir, proxyGeometry, sandMaterial, VARIANTS } from "./sand";
import { bakeField, boltSegments, BOX_MIN, BOX_SIZE, glassGeometry, gridFor, growGlass, HALF, sandDistance } from "./shape";
import { thunder } from "./thunder";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A line under the specimen once it has been struck, until the wind has been tried.
const coach = {
  value: "",
  listeners: new Set<() => void>(),
  set(next: string) {
    if (next === this.value) return;
    this.value = next;
    this.listeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    coach.listeners.add(listener);
    return () => coach.listeners.delete(listener);
  }
};

const scratch = {
  inverse: new THREE.Matrix4(),
  origin: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  p: new THREE.Vector3(),
  ndc: new THREE.Vector2(),
  caster: new THREE.Raycaster(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(),
  wind: new THREE.Vector3(),
  key: new THREE.Vector3()
};

// Where a ray (in the specimen's frame) first meets sand: inside the core as cut, in a block the coarse map says still
// holds some. Null if it misses.
function landOn(origin: THREE.Vector3, direction: THREE.Vector3, map: Uint32Array | null, C: { x: number; y: number; z: number }) {
  let near = 0;
  let far = Infinity;
  for (const axis of ["x", "y", "z"] as const) {
    const v = Math.abs(direction[axis]) < 1e-6 ? 1e-6 : direction[axis];
    const a = (BOX_MIN[axis] - origin[axis]) / v;
    const b = (BOX_MIN[axis] + BOX_SIZE[axis] - origin[axis]) / v;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  if (near > far) return null;
  const p = scratch.p;
  for (let t = near; t <= far; t += 0.008) {
    p.copy(origin).addScaledVector(direction, t);
    if (sandDistance(p.x, p.y, p.z) > 0) continue;
    if (!map) return t;
    const bx = Math.min(C.x - 1, Math.floor(((p.x - BOX_MIN.x) / BOX_SIZE.x) * C.x));
    const by = Math.min(C.y - 1, Math.floor(((p.y - BOX_MIN.y) / BOX_SIZE.y) * C.y));
    const bz = Math.min(C.z - 1, Math.floor(((p.z - BOX_MIN.z) / BOX_SIZE.z) * C.z));
    if ((map[bx + by * C.x + bz * C.x * C.y] & 255) > 90) return t;
  }
  return null;
}

// Arrival of the melt front at the end of the slowest branch, in glass seconds, so sound and work know when growth ends.
const GROWN_BY = 2.4;

function Scene() {
  const { tier } = useQuality();
  // Sized by the tier the visit starts on, so a later step down never wipes the sand.
  const startTier = useRef(tier).current;
  const low = startTier === "low";
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;

  const built = useMemo(() => {
    const grid = gridFor(low);
    const glasses = Array.from({ length: VARIANTS }, (_, k) => growGlass(k + 1));
    const field = new Float32Array(VARIANTS * grid.count * 2);
    glasses.forEach((g, k) => bakeField(g, grid, field, k * grid.count));
    const sand = createSand(grid, field, low ? 18000 : 52000);
    const glassGeometries = glasses.map((g) => glassGeometry(g, low ? 9 : 14));
    const boltGeometries = glasses.map((g, k) => boltGeometry(boltSegments(k + 3, g.root)));
    const proxy = proxyGeometry();
    const sandLook = sandMaterial(sand, low ? 70 : 150);
    const glassLookMaterial = glassMaterial(sand);
    const boltLook = boltMaterial(sand.u.seconds);
    return { grid, glasses, sand, glassGeometries, boltGeometries, proxy, sandLook, glassLookMaterial, boltLook };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- made once for the tier the visit starts on.
  }, [startTier]);
  const { sand } = built;
  useDispose(built.proxy, built.sandLook, built.glassLookMaterial, built.boltLook, sand.texture);

  const group = useRef<THREE.Group>(null);
  const glassRefs = useRef<(THREE.Group | null)[]>([]);
  const boltRefs = useRef<(THREE.Group | null)[]>([]);
  const flash = useRef<THREE.PointLight>(null);
  const ember = useRef<THREE.PointLight>(null);
  const body = useRef<THREE.Mesh>(null);
  const wind = useSettingRef<number>("wind");
  const growth = useSettingRef<number>("growth");

  const state = useRef({
    ready: false,
    seconds: 0,
    held: false,
    over: false,
    touching: false,
    pointer: { x: 0, y: 0, has: false },
    last: { x: 0, y: 0 },
    move: { x: 0, y: 0 },
    moved: 0,
    downAt: 0,
    speed: 0,
    gust: 0,
    puff: 0,
    dir: new THREE.Vector3(0.6, 0.1, -0.8).normalize(),
    struck: false,
    strikeAt: -100,
    glass: -100,
    variant: 0,
    refillAt: -100,
    sinceSpawn: 100,
    publish: 2,
    reading: false,
    sinceRead: 0,
    dirty: true,
    map: null as Uint32Array | null,
    full: 0,
    left: 1,
    blown: 0,
    sinceSizzle: 0,
    nextTick: 0,
    earned: false
  });

  // Every pass runs once behind the loader, so nothing compiles on the first strike or gust.
  useEffect(() => {
    const s = state.current;
    const p = sand.passes;
    sand.u.refill.value = 10;
    sand.u.gust.value = 0;
    gl.compute([p.fill, p.erode, p.publish, p.fly, p.shrink] as any);
    sand.u.refill.value = -10;
    s.ready = true;
    read(gl, sand, s, true);
  }, [gl, sand]);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __fulg: state, __fulgStrike: () => doStrike(), __fulgCamera: camera, __fulgBody: body, __fulgBuilt: built });

  // The pointer, followed over the canvas: where it is, and how it moves.
  useEffect(() => {
    const el = gl.domElement;
    const move = (e: PointerEvent) => {
      const s = state.current;
      const rect = el.getBoundingClientRect();
      s.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      s.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      s.pointer.has = true;
      s.over = e.pointerType === "mouse";
      const dx = e.clientX - s.last.x;
      const dy = e.clientY - s.last.y;
      s.last.x = e.clientX;
      s.last.y = e.clientY;
      if (s.held) {
        s.moved += Math.hypot(dx, dy);
        s.move.x += dx;
        s.move.y += dy;
      }
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") state.current.touching = true;
      state.current.last.x = e.clientX;
      state.current.last.y = e.clientY;
      move(e);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") state.current.touching = false;
    };
    const leave = () => {
      state.current.over = false;
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
    };
  }, [gl]);

  const toLocal = (ray: THREE.Ray) => {
    const g = group.current as THREE.Group;
    scratch.inverse.copy(g.matrixWorld).invert();
    const origin = scratch.origin.copy(ray.origin).applyMatrix4(scratch.inverse);
    const direction = scratch.direction.copy(ray.direction).transformDirection(scratch.inverse);
    return { origin, direction };
  };

  const doStrike = () => {
    const s = state.current;
    if (s.struck || s.refillAt > s.seconds - 1.4) return;
    s.struck = true;
    s.strikeAt = s.seconds;
    strike.at.value = s.seconds;
    strike.root.value.copy(built.glasses[s.variant].root);
    s.nextTick = 4 + Math.random() * 3;
    thunder();
    coach.set("Swipe across the sand to blow it away");
  };

  // A press on the sand takes hold of the wind; anywhere else turns the view. A tap strikes.
  useGrabbable({
    pick: (ray) => {
      const s = state.current;
      if (!group.current || !s.ready || s.refillAt > s.seconds - 1.3) return null;
      const { origin, direction } = toLocal(ray);
      const t = landOn(origin, direction, s.map, sand.C);
      if (t === null) return null;
      // The local frame is not scaled, so the distance is the world's.
      return { distance: t, point: ray.at(t, new THREE.Vector3()) };
    },
    grab: () => {
      const s = state.current;
      s.held = true;
      s.moved = 0;
      s.move.x = 0;
      s.move.y = 0;
      s.downAt = s.seconds;
      dismissPrompt();
    },
    drag: () => {},
    release: () => {
      const s = state.current;
      s.held = false;
      if (s.moved < 10 && s.seconds - s.downAt < 0.45) {
        if (!s.struck) doStrike();
        else s.puff = 0.35;
      }
    }
  });

  useSettingAction("refill", () => {
    const s = state.current;
    if (s.refillAt > s.seconds - 1.4) return;
    s.refillAt = s.seconds;
    resetPrompt();
    coach.set("");
    sound.play("whoosh", { gain: 0.3, pitch: 0.7 });
  });

  // Sound: a faint desert air; sand hissing and wind under the gust.
  useBed("breeze", 0.025);
  const hiss = useBed("sand", 0);
  const gale = useBed("wind", 0);

  useFrame((_, raw) => {
    const s = state.current;
    const g = group.current;
    if (!g || !s.ready) return;
    const delta = Math.min(raw, 1 / 20) * (process.env.NODE_ENV !== "production" ? ((globalThis as any).__fulgSlow ?? 1) : 1);
    const u = sand.u;
    const p = sand.passes;
    s.seconds += delta;
    u.seconds.value = s.seconds;
    u.delta.value = delta;

    // It hangs in the air, turning a touch and rising and falling on a slow breath.
    g.rotation.y = Math.sin(s.seconds * 0.11) * 0.1;
    g.position.y = Math.sin(s.seconds * 0.37) * 0.015;
    g.updateMatrixWorld();
    scratch.key.copy(KEY).sub(g.position).normalize();
    keyDir.value.copy(scratch.key).applyQuaternion(g.quaternion.clone().invert());

    // Pouring back: the glass sinks away, sand fills from the bottom up, and the next strike will grow a new shape.
    const sinceRefill = s.seconds - s.refillAt;
    if (sinceRefill < 1.6) {
      glassLook.dissolve.value = Math.min(1, sinceRefill / 0.7);
      u.refill.value = -HALF - 0.05 + (2 * HALF + 0.1) * THREE.MathUtils.smoothstep(sinceRefill, 0.25, 1.45);
      gl.compute(p.fill as any);
      s.publish = 2;
      s.dirty = true;
      hiss.current?.level(0.12 * Math.sin(Math.PI * Math.min(1, sinceRefill / 1.6)), 0.1);
      if (sinceRefill > 0.7 && s.struck) {
        s.struck = false;
        s.variant = (s.variant + 1) % VARIANTS;
        strike.at.value = -100;
      }
    } else if (glassLook.dissolve.value > 0 && !s.struck) {
      glassLook.dissolve.value = 0;
      u.refill.value = -10;
    }
    u.variant.value = s.variant;
    glassRefs.current.forEach((m, k) => m && (m.visible = k === s.variant));
    boltRefs.current.forEach((m, k) => m && (m.visible = k === s.variant));

    // The glass's clock runs from the return stroke, slowed or hastened by the growth speed.
    if (s.struck) s.glass += (s.seconds - s.strikeAt < LEAD ? 0 : delta) * growth.current;
    else s.glass = -100;
    if (s.struck && s.seconds - s.strikeAt < LEAD + delta) s.glass = Math.max(0, (s.seconds - s.strikeAt - LEAD) * growth.current);
    u.glass.value = s.glass;
    const t = s.seconds - s.strikeAt;
    const lightning = s.struck ? flashAt(t) : 0;
    room.flash.value = lightning;
    if (flash.current) flash.current.intensity = lightning * 90;
    // The melt lights the sand round the mouth.
    const age = s.glass;
    const heat = s.struck && age > 0 ? 1.5 * Math.exp(-age / 0.06) + 0.9 * Math.exp(-age / 1.2) + 0.2 * Math.exp(-age / 14) : 0;
    if (ember.current) {
      ember.current.intensity = heat * 1.6;
      ember.current.position.copy(built.glasses[s.variant].root).add(scratch.p.set(0, 0.05, 0));
    }

    // The wind: while held, a gust along the pointer's line, as strong as the stroke is quick, blowing the way it moves.
    scratch.ndc.set(s.pointer.x, s.pointer.y);
    scratch.caster.setFromCamera(scratch.ndc, camera);
    const { origin, direction } = toLocal(scratch.caster.ray);
    u.rayFrom.value.copy(origin);
    u.rayDir.value.copy(direction);
    const blowing = s.held && s.refillAt < s.seconds - 1.3;
    if (blowing) {
      s.speed += (Math.hypot(s.move.x, s.move.y) / Math.max(delta, 1e-3) - s.speed) * (1 - Math.exp(-delta * 8));
      if (Math.hypot(s.move.x, s.move.y) > 0.5) {
        // Screen motion as a direction in the world, leaning a little away from the eye.
        scratch.right.setFromMatrixColumn(camera.matrixWorld, 0);
        scratch.up.setFromMatrixColumn(camera.matrixWorld, 1);
        scratch.wind
          .set(0, 0, 0)
          .addScaledVector(scratch.right, s.move.x)
          .addScaledVector(scratch.up, -s.move.y)
          .normalize()
          .addScaledVector(scratch.caster.ray.direction, 0.35)
          .normalize()
          .transformDirection(scratch.inverse);
        s.dir.lerp(scratch.wind, 1 - Math.exp(-delta * 10)).normalize();
      }
      s.move.x = 0;
      s.move.y = 0;
    } else {
      s.speed *= Math.exp(-delta * 6);
    }
    s.puff = Math.max(0, s.puff - delta);
    const want = (blowing ? THREE.MathUtils.clamp(0.3 + s.speed / 700, 0, 1.6) : 0) + (s.puff > 0 ? 0.9 : 0);
    s.gust += (want * wind.current - s.gust) * (1 - Math.exp(-delta * (want > s.gust ? 10 : 4)));
    u.gust.value = s.gust;
    u.wind.value.copy(s.dir);
    u.reach.value = low ? 0.17 : 0.14;
    const passes: unknown[] = [];
    if (s.gust > 0.02) {
      u.salt.value = (u.salt.value + 7919) % 1000003;
      passes.push(p.erode);
      s.sinceSpawn = 0;
      s.publish = 2;
      s.dirty = true;
      if (s.struck) s.blown += delta;
      if (s.blown > 1.2) coach.set("");
    }
    s.sinceSpawn += delta;
    if (s.struck && s.glass < 70) s.publish = Math.max(s.publish, 1);
    if (s.publish > 0) {
      passes.push(p.publish);
      s.publish--;
    }
    if (s.sinceSpawn < 7) passes.push(p.fly);
    if (passes.length) gl.compute(passes as any);

    // Sound follows: a crackle of fusing sand while the glass grows, small ticks as it cools, hiss and wind as it blows.
    if (sinceRefill >= 1.6) hiss.current?.level(Math.min(0.2, s.gust * 0.16), 0.08);
    gale.current?.level(Math.min(0.12, s.gust * 0.09), 0.15);
    s.sinceSizzle += delta;
    if (s.struck && s.glass > 0 && s.glass < GROWN_BY && s.sinceSizzle > 0.06) {
      s.sinceSizzle = 0;
      sound.play("sizzle", { gain: 0.5 * (1 - s.glass / GROWN_BY) + 0.15, pitch: 0.7 + Math.random() * 0.4 });
    }
    if (s.struck && s.glass > s.nextTick && s.glass < 40) {
      s.nextTick = s.glass + 1.5 + Math.random() * 5 * (1 + s.glass / 10);
      sound.play("tinkle", { gain: 0.07 + Math.random() * 0.05, pitch: 1.6 + Math.random() * 0.8 });
    }

    // The coarse map and what is left, a few times a second while sand moves.
    s.sinceRead += delta;
    if (s.dirty && !s.reading && s.sinceRead > 0.25) read(gl, sand, s, false);

    // The moment: most of the sand blown off a struck core, the glass standing alone.
    if (!s.earned && s.struck && s.left < 0.45) {
      s.earned = true;
      followPrompt.earn("revealed");
      shareResult.set("Struck a core of sand with lightning, then blew the sand away to find the glass it left");
    }

    focusDistance.value = Math.max(0.8, camera.position.length() - 0.25);
    focusBlur.value = 0.5;
  });

  return (
    <>
      <Backdrop />
      <StudioEnvironment
        ambient="#0b0a0a"
        intensity={0.55}
        boxes={[
          { position: [-6, 6, 4], scale: [4, 4, 0.2], color: "#ffe6cc", intensity: 3.2 },
          { position: [7, 2, -5], scale: [0.2, 5, 3], color: "#d4dcf0", intensity: 1.0 },
          { position: [0, 8, 0], scale: [5, 0.2, 5], color: "#fff4e8", intensity: 0.8 },
          { position: [2, -6, 3], scale: [5, 0.2, 5], color: "#3a2c22", intensity: 0.6 },
          { position: [3, 1, 8], scale: [4, 3, 0.2], color: "#fff6ec", intensity: 1.3 }
        ]}
      />
      <KeyLight position={[KEY.x, KEY.y, KEY.z]} target={[0, 0, 0]} color="#fff0de" intensity={210} angle={0.36} penumbra={0.75} shadowFar={14} />
      <RimLight />
      <directionalLight position={[3.5, 1.2, 4]} color="#dfe6f4" intensity={0.35} />
      <pointLight ref={flash} position={[0.4, 3.2, 1.2]} color="#c9d4ff" intensity={0} distance={0} decay={2} />
      <group ref={group}>
        <mesh ref={body} geometry={built.proxy} material={built.sandLook} frustumCulled={false} />
        <pointLight ref={ember} color="#ff7a2c" intensity={0} distance={2.5} decay={2} />
        {built.glassGeometries.map((geometry, k) => (
          <group key={k} ref={(m) => void (glassRefs.current[k] = m)}>
            <Glass geometry={geometry} material={built.glassLookMaterial} />
          </group>
        ))}
        {built.boltGeometries.map((geometry, k) => (
          <group key={k} ref={(m) => void (boltRefs.current[k] = m)}>
            <Bolt geometry={geometry} material={built.boltLook} />
          </group>
        ))}
        <Grains sand={sand} />
        <Sparks count={low ? 160 : 420} seconds={sand.u.seconds} />
      </group>
      <Air dust={low ? 1000 : 2600} />
    </>
  );
}

// A cool light from behind on the right, outlining the far edge against the dark.
function RimLight() {
  const light = useMemo(() => {
    const l = new THREE.DirectionalLight("#e4e8f2", 1.1);
    l.position.set(4, 2.5, -5);
    return l;
  }, []);
  useDispose(light);
  return <primitive object={light} />;
}

// Bring back the coarse map: where sand still is, and how much is left of a full core.
function read(gl: THREE.WebGPURenderer, sand: ReturnType<typeof createSand>, s: { reading: boolean; dirty: boolean; sinceRead: number; map: Uint32Array | null; full: number; left: number }, first: boolean) {
  s.reading = true;
  s.dirty = false;
  s.sinceRead = 0;
  gl.compute(sand.passes.shrink as any);
  (gl.getArrayBufferAsync(sand.coarseBuffer as any) as Promise<ArrayBuffer>)
    .then((buffer) => {
      const map = new Uint32Array(buffer);
      let total = 0;
      for (let i = 0; i < map.length; i++) total += map[i] >>> 8;
      s.map = map;
      if (first || s.full === 0) s.full = total;
      s.left = s.full > 0 ? total / s.full : 1;
    })
    .catch(() => {})
    .finally(() => (s.reading = false));
}

function Coach() {
  const text = useSyncExternalStore(
    coach.subscribe,
    () => coach.value,
    () => ""
  );
  return (
    <div
      aria-live="polite"
      className="cv-fulgurite-coach"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 104,
        transform: `translate(-50%, ${text ? 0 : 8}px)`,
        opacity: text ? 1 : 0,
        transition: "opacity 0.6s ease, transform 0.6s ease",
        pointerEvents: "none",
        padding: "8px 16px",
        borderRadius: 999,
        background: "rgba(16, 16, 18, 0.55)",
        backdropFilter: "blur(10px)",
        color: "rgba(255, 255, 255, 0.86)",
        fontSize: 13,
        letterSpacing: 0.2,
        whiteSpace: "nowrap"
      }}
    >
      {text || " "}
      <style>{`@media (max-width: 720px) { .cv-fulgurite-coach { bottom: auto !important; top: 64px; font-size: 12px !important; } }`}</style>
    </div>
  );
}

// This module only ever loads in the browser, so the screen can be asked here.
const PHONE = typeof window !== "undefined" && window.matchMedia("(max-width: 900px), (hover: none)").matches;

const day: DayDefinition = {
  camera: {
    position: [1.25, 1.55, 4.05],
    target: [0, -0.06, 0],
    fov: 34,
    limits: { turn: { left: 75, right: 75, up: 40, down: 30 }, move: 0.35 },
    phone: { position: [1.5, 1.9, 5.3], target: [0, -0.04, 0], fov: 42 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 9, color: "#ffd7b0" },
  // Black behind: the overlay pass (shafts, dust, grains, sparks, the bolt) is added over the whole frame.
  look: { background: "#000000", exposure: 1.1, bloom: 0.34, bloomThreshold: 1.2, gi: 0, ao: 1, aoRadius: 0.14, vignette: 0.6, grain: 0.014, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true },
  autoFloor: "medium",
  settings: {
    refill: { type: "action", label: "Reset" },
    wind: { type: "range", label: "Wind strength", min: 0.3, max: 2, step: 0.01, value: 1, reset: 1 },
    growth: { type: "range", label: "Glass growth speed", min: 0.2, max: 2, step: 0.01, value: 1, reset: 1 }
  },
  phonePills: ["refill"],
  // Above the specimen on a desktop; on a phone, small in the top left, clear of it.
  prompt: { title: "Tap the sand to strike it", detail: "Then swipe to blow the sand away", ...(PHONE ? { low: true } : { high: true }) },
  hint: "Tap the sand to call down lightning: it fuses a root of glass through the core. Then swipe across the sand to blow it away and find the glass. Reset pours the sand back for a new strike.",
  notes: "A fulgurite: lightning frozen in glass. A core of desert sand is struck, and the wind uncovers the branching glass the bolt left behind.",
  overview: [
    {
      title: "Sand",
      points: [
        "An 80×104×80 grid of sand on the GPU, ray marched per pixel from the core's cut faces, so a cut face is exact and a blown hollow is real.",
        "Wind wears away exposed cells under the pointer's line, faces into the wind first; each lost cell breaks into flying GPU grains."
      ]
    },
    {
      title: "Glass",
      points: [
        "Three fulgurites grown at load as random walks that fork, wander and taper, kept inside the sand, meshed as lumpy tubes.",
        "Each vertex knows when the melt front reaches it: the tube grows from nothing, white hot at the front, and cools to a dark crust."
      ]
    },
    {
      title: "Strike",
      points: [
        "A midpoint-displaced bolt steps down, flashes in a return stroke and two restrikes, lighting the room and spraying analytic sparks.",
        "The sand's heat and scorch come from a distance field to the glass baked at load, so the cut glows where branches run behind it."
      ]
    }
  ],
  Overlay: Coach,
  Scene
};

export default day;
