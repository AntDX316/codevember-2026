"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting } from "../../shared/engine/settings";
import { useBed } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Air, SPLASHES, type SplashWriter } from "./air";
import { clap, prepareClap, warmClap } from "./clap";
import { DROP_LIFE, DROP_REACH, FIELD, GRID, PINGS, SLOTS, echo, fieldData, fieldEnergy, fieldTexture, gridData, gridTexture } from "./echo";
import { GardenMesh } from "./garden";
import { Leaves } from "./leaves";
import { GUTTER, RAIN, buildGarden, heightAt } from "./world";

// Drops landing each second over the whole garden, by tier, at the Rain setting's middle.
const RATE = { low: 230, medium: 280, high: 340 };
// Extra drops each second under a held, dragged pointer, within this reach of it.
const HEAVY_RATE = 520;
const HEAVY_REACH = 1.1;
const CAPACITY = 2048;
// How much each landing adds to the lingering field, and how fast it dies away.
const SPLAT = 0.3;
const FIELD_FADE = 0.45;
// Where the gutter drips along the porch's lip, each on its own beat.
const DRIPS = [-2.6, -1.85, -0.7, 0.45, 1.3, 2.2, 2.85];

const scratch = { ndc: new THREE.Vector2(), ray: new THREE.Raycaster(), point: new THREE.Vector3(), forward: new THREE.Vector3() };

// Where a ray first meets the garden (not the roof or the crowns of leaves), marched over the heightmap; past it, the
// ground beyond, out to the far roofs. Null for the sky.
function gardenPoint(ground: Float32Array, ray: THREE.Ray, out: THREE.Vector3) {
  const o = ray.origin;
  const d = ray.direction;
  for (let t = 0.3; t < 26; t += 0.025) {
    const x = o.x + d.x * t;
    const y = o.y + d.y * t;
    const z = o.z + d.z * t;
    const h = heightAt(ground, x, z);
    if (h >= 0 && y <= h) {
      out.set(x, h, z);
      return t;
    }
    if (y < 0 && h < 0) break;
  }
  if (d.y > -1e-3) return null;
  const t = -o.y / d.y;
  if (t > 40) return null;
  out.copy(o).addScaledVector(d, t);
  return t;
}

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const garden = useMemo(() => buildGarden(startTier), [startTier]);
  useDispose(garden.geometry);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const rain = useSetting<number>("rain");
  const splashes = useRef<SplashWriter | null>(null);

  const state = useRef({
    clock: 0,
    // For checking frames by hand in development: the garden's clock slowed or held.
    rate: 1,
    random: Math.random,
    // The ring of drops' echoes: where each landed and when.
    ripples: new Float32Array(CAPACITY * 4).fill(-1e4),
    next: 0,
    owed: 0,
    heavyOwed: 0,
    splash: 0,
    drips: DRIPS.map((x, i) => ({ x, at: 0.3 + i * 0.37 })),
    cellCount: new Int32Array(GRID.nx * GRID.nz),
    nextPing: 0,
    held: false,
    heldAt: 0,
    moved: 0,
    down: { x: 0, y: 0 },
    pointer: new THREE.Vector2(),
    hold: new THREE.Vector3(),
    charge: 0,
    heavy: 0,
    focus: new THREE.Vector3(),
    claps: 0,
    earned: false
  });

  useEffect(prepareClap, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") console.info(`[echo/rain] ${garden.triangles} triangles, ${garden.leaves.length / 6} leaves, ${garden.flipped} rewound, ${garden.inward} normals facing in`);
  }, [garden]);

  // A clap at a point, as loud as it was held.
  const ping = (at: THREE.Vector3, strength: number) => {
    const s = state.current;
    const k = s.nextPing;
    s.nextPing = (k + 1) % PINGS;
    echo.pings[k].value.set(at.x, at.y + 0.06, at.z, s.clock);
    echo.power[k].value = strength;
    scratch.point.copy(at).project(camera);
    clap(strength, scratch.point.x * 0.6);
    s.claps++;
    if (!s.earned && s.claps >= 3) {
      s.earned = true;
      followPrompt.earn("clap");
      shareResult.set("Clapped in the rain and saw a dark garden by its echo");
    }
  };

  // A drop landing: its echo and a splash.
  const land = (x: number, y: number, z: number) => {
    const s = state.current;
    const i = s.next;
    s.next = (i + 1) % CAPACITY;
    s.ripples.set([x, y + 0.004, z, s.clock], i * 4);
    // A soft splat of energy round it, about 0.4 m across.
    const fx = (x - FIELD.x0) / FIELD.cell - 0.5;
    const fz = (z - FIELD.z0) / FIELD.cell - 0.5;
    const cx = Math.round(fx);
    const cz = Math.round(fz);
    for (let dz = -2; dz <= 2; dz++) {
      const iz = cz + dz;
      if (iz < 0 || iz >= FIELD.nz) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const ix = cx + dx;
        if (ix < 0 || ix >= FIELD.nx) continue;
        const d2 = (ix - fx) * (ix - fx) + (iz - fz) * (iz - fz);
        fieldEnergy[iz * FIELD.nx + ix] += SPLAT * Math.exp(-d2 * 0.9);
      }
    }
    if (s.random() < 0.6) {
      splashes.current?.write(s.splash, x, y + 0.004, z, s.clock);
      s.splash = (s.splash + 1) % SPLASHES;
    }
  };

  // A press on the garden takes hold there: held still, a clap builds; dragged, the rain gathers under it.
  useGrabbable({
    pick: (ray) => {
      const point = new THREE.Vector3();
      const t = gardenPoint(garden.ground, ray, point);
      return t === null ? null : { distance: t, point };
    },
    grab: (point) => {
      const s = state.current;
      s.held = true;
      s.heldAt = s.clock;
      s.moved = 0;
      s.hold.copy(point);
      s.focus.copy(point);
      s.charge = 0;
      warmClap();
      // On the press rather than the clap, so the prompt's going never lands on the clap's first frames.
      dismissPrompt();
    },
    drag: () => {},
    release: () => {
      const s = state.current;
      if (!s.held) return;
      s.held = false;
      if (s.moved < 14) ping(s.hold, 0.6 + Math.min(1, (s.clock - s.heldAt) / 1.1) * 1.0);
    }
  });

  // The pointer, followed so a drag can carry the heavy rain.
  useEffect(() => {
    const el = gl.domElement;
    const at = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      state.current.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    };
    const down = (e: PointerEvent) => {
      at(e);
      state.current.down = { x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      at(e);
      const s = state.current;
      if (s.held) s.moved = Math.max(s.moved, Math.hypot(e.clientX - s.down.x, e.clientY - s.down.y));
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
    };
  }, [gl]);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __rain: { state, ping, camera, scene, garden, echo } });

  useBed("rain", 0.05 + rain * 0.07);

  useFrame((_, raw) => {
    const s = state.current;
    const delta = Math.min(raw, 1 / 20) * s.rate;
    s.clock += delta;
    echo.time.value = s.clock;

    camera.getWorldDirection(scratch.forward);
    echo.forward.value.copy(scratch.forward);
    echo.right.value.setFromMatrixColumn(camera.matrixWorld, 0);
    echo.up.value.setFromMatrixColumn(camera.matrixWorld, 1);
    // In CSS pixels, so lines keep the same weight on a dense screen.
    echo.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / (gl.domElement.clientHeight || 1);

    // The rain over the whole garden.
    s.owed += RATE[startTier] * rain * delta;
    while (s.owed >= 1) {
      s.owed -= 1;
      const x = RAIN.x0 + s.random() * (RAIN.x1 - RAIN.x0);
      const z = RAIN.z0 + s.random() * (RAIN.z1 - RAIN.z0);
      const y = heightAt(garden.top, x, z);
      if (y >= 0) land(x, y, z);
    }
    // Heavier under a dragged pointer, following it.
    if (s.held && s.moved >= 14) {
      scratch.ndc.copy(s.pointer);
      scratch.ray.setFromCamera(scratch.ndc, camera);
      if (gardenPoint(garden.ground, scratch.ray.ray, scratch.point) !== null) s.focus.lerp(scratch.point, 1 - Math.exp(-delta * 10));
    }
    s.heavy += ((s.held && s.moved >= 14 ? 1 : 0) - s.heavy) * (1 - Math.exp(-delta * (s.held ? 3 : 1.5)));
    s.heavyOwed += HEAVY_RATE * s.heavy * delta;
    while (s.heavyOwed >= 1) {
      s.heavyOwed -= 1;
      const a = s.random() * Math.PI * 2;
      const r = Math.sqrt(s.random()) * HEAVY_REACH;
      const x = s.focus.x + Math.cos(a) * r;
      const z = Math.min(RAIN.z1, s.focus.z + Math.sin(a) * r);
      const y = heightAt(garden.top, x, z);
      if (y >= 0) land(x, y, z);
    }
    // The gutter's drips, each on its own beat, onto the step and the ground below.
    for (const d of s.drips) {
      if (s.clock < d.at) continue;
      d.at = s.clock + 0.5 + s.random() * 1.1 / Math.max(0.3, rain);
      const y = heightAt(garden.top, d.x, GUTTER.z - 0.03);
      if (y >= 0) land(d.x, y, GUTTER.z - 0.03);
    }
    splashes.current?.flush();

    // The lingering field dies away, and goes up as half floats.
    const keep = Math.exp(-delta / FIELD_FADE);
    for (let i = 0; i < fieldEnergy.length; i++) {
      fieldEnergy[i] *= keep;
      fieldData[i] = THREE.DataUtils.toHalfFloat(Math.min(fieldEnergy[i], 60000));
    }
    fieldTexture.needsUpdate = true;

    // Sort the live echoes into the grid, newest first, so a crowded cell keeps the newest.
    s.cellCount.fill(0);
    for (let i = 3; i < gridData.length; i += 4) gridData[i] = -1e4;
    for (let n = 1; n <= CAPACITY; n++) {
      const i = (s.next - n + CAPACITY) % CAPACITY;
      const born = s.ripples[i * 4 + 3];
      if (s.clock - born > DROP_LIFE) break;
      const x = s.ripples[i * 4];
      const z = s.ripples[i * 4 + 2];
      const cx0 = Math.max(0, Math.floor((x - DROP_REACH - GRID.x0) / GRID.cell));
      const cx1 = Math.min(GRID.nx - 1, Math.floor((x + DROP_REACH - GRID.x0) / GRID.cell));
      const cz0 = Math.max(0, Math.floor((z - DROP_REACH - GRID.z0) / GRID.cell));
      const cz1 = Math.min(GRID.nz - 1, Math.floor((z + DROP_REACH - GRID.z0) / GRID.cell));
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const cell = cz * GRID.nx + cx;
          const used = s.cellCount[cell];
          if (used >= SLOTS) continue;
          s.cellCount[cell] = used + 1;
          const o = ((cz * GRID.nx + cx) * SLOTS + used) * 4;
          gridData[o] = x;
          gridData[o + 1] = s.ripples[i * 4 + 1];
          gridData[o + 2] = z;
          gridData[o + 3] = born;
        }
      }
    }
    gridTexture.needsUpdate = true;

    // A clap building while held still.
    const building = s.held && s.moved < 14;
    s.charge = building ? Math.min(1, (s.clock - s.heldAt) / 1.1) : Math.max(0, s.charge - delta * 4);
    echo.charge.value.set(s.hold.x, s.hold.y + 0.05, s.hold.z, s.charge);
  });

  return (
    <>
      <GardenMesh garden={garden} />
      <Leaves garden={garden} />
      <Air drops={startTier === "low" ? 2200 : startTier === "medium" ? 3600 : 5000} motes={startTier === "low" ? 60 : 140} splashes={splashes} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0.55, 1.32, 5.7],
    target: [0.1, 0.86, 0.7],
    fov: 52,
    limits: { turn: { left: 32, right: 32, up: 10, down: 14 }, move: { left: 0.6, right: 0.6, down: 0.4, up: 0.3, nearer: 1.2, further: 0.8 } },
    phone: { position: [0.2, 1.55, 5.0], target: [0.95, 1.3, 1.0], fov: 70 }
  },
  hover: true,
  extents: { centre: [0, 1.2, 0], radius: 14, floor: 0.4, color: "#9fb8dc" },
  look: { background: "#000000", exposure: 1.0, bloom: 0.55, bloomThreshold: 0.35, gi: 0, ao: 0, vignette: 0.6, grain: 0.03, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, temporal: false, occlusion: false },
  settings: {
    rain: { type: "range", label: "Rain", min: 0.2, max: 2, step: 0.01, value: 1, reset: 1 }
  },
  phoneDock: ["rain"],
  prompt: { title: "Tap to clap", detail: "Hold for a louder clap, drag for heavier rain", low: true },
  hint: "Tap the garden to clap; hold for louder. Drag to make it rain harder where you hold.",
  notes: "A dark garden at night, seen only by sound: every raindrop throws off a small echo that sketches the edges around it. Clap and the whole garden shows for a moment.",
  overview: [
    {
      title: "Echoes",
      points: [
        "Each landing drop is a spherical shell of sound growing at 1.15 m/s; the shader draws a thin ring where it crosses a surface and lights edges inside it.",
        "Hundreds live at once, sorted each frame into a 1 m grid so every pixel checks only the 16 newest that can reach it."
      ]
    },
    {
      title: "Garden",
      points: [
        "Boxes, turned profiles and noise-lumped shrubs merged into one mesh; each vertex knows its place on its face, so edges and brick joints glow without lines.",
        "A heightmap of every upward face tells the rain where to land and a tap where it touched."
      ]
    },
    {
      title: "Clap",
      points: ["A front at 7.5 m/s with sonar rings behind it, lighting each face by how squarely it faces the clap; it catches the rain and the drizzle in the air as it passes.", "Synthesised hands, wall slaps and a convolved tail; held longer, a thunderclap."]
    }
  ],
  Scene
};

export default day;
