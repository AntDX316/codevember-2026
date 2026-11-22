"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three/webgpu";
import { attribute, output, vec4 } from "three/tsl";
import { worldShifted } from "../shared/engine/extents";
import { fetchRetried } from "../shared/engine/retry";
import { sound } from "../shared/engine/sound";
import type { QualityTier } from "../shared/engine/types";
import { walking } from "../shared/engine/walk";
import { game } from "./game";
import { liveHeights, SIZE } from "./hedge";
import { aim, inSight, sight } from "./view";
import { type Air, CELL, fading, made, throughMist } from "./hedge-look";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// White rabbits about the paths near the camera, hopping from the middle of one cell to the middle of the next wherever
// no hedge stands between, in short hops with a pause on each landing, sitting a while where they arrive before going on,
// mostly onward and seldom back. One gone too far behind turns up again somewhere ahead in the paths. In game mode they
// can be caught on foot, and run from you, quicker, when you come near.

const HOP = 0.26;
const HOPS = 7;
const NEAR = 6;
const FAR = 24;
const GONE = 30;
// How near on foot catches one, and how near sets it running.
const CATCH = 0.75;
const WARY = 4.5;

const slotOf = (cell: number) => ((cell % SIZE) + SIZE) % SIZE;
// Whether a hedge stands, or is standing up, between a cell and the next one along `di`, `dj`.
function blocked(i: number, j: number, di: number, dj: number) {
  const heights = liveHeights.current;
  if (!heights) return true;
  const at = (ci: number, cj: number) => slotOf(cj) * SIZE + slotOf(ci);
  if (di === 1) return heights[at(i, j) * 2] > 0.05;
  if (di === -1) return heights[at(i - 1, j) * 2] > 0.05;
  if (dj === 1) return heights[at(i, j) * 2 + 1] > 0.05;
  return heights[at(i, j - 1) * 2 + 1] > 0.05;
}

// A rabbit, nose to -z, about thirty-five centimetres long: a scanned white rabbit cut down to 300 triangles, its colours
// (cream fur, pink ears and nose, dark eyes) baked into the corners in place of a texture, 4 kB in all.
const BUNNY = "/assets/13-labyrinth/bunny/bunny";
async function loadBunny() {
  const [info, data] = await Promise.all([fetchRetried(`${BUNNY}.json`).then((r) => r.json() as Promise<{ vertices: number; indices: number }>), fetchRetried(`${BUNNY}.bin`).then((r) => r.arrayBuffer())]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(data, 0, info.vertices * 3), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(data, info.vertices * 12, info.vertices * 4), 4, true));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(data, info.vertices * 16, info.indices), 1));
  geometry.computeVertexNormals();
  return geometry;
}

type Bunny = { i: number; j: number; x: number; z: number; fromX: number; fromZ: number; di: number; dj: number; hop: number; t: number; rest: number; yaw: number; facing: number };

export function Bunnies({ air, tier }: { air: Air; tier: QualityTier }) {
  const camera = useThree((state) => state.camera);
  const count = tier === "high" ? 110 : tier === "medium" ? 75 : 30;
  const detail = tier === "high" ? 1 : tier === "medium" ? 0.6 : 0.4;
  const [shape, setShape] = useState<THREE.BufferGeometry | null>(null);
  useEffect(() => {
    let live = true;
    // The maze is whole without its rabbits, so if they cannot be had it goes on without them.
    loadBunny().then(
      (g) => (live ? setShape(g) : g.dispose()),
      (failure) => console.warn("Codevember Labyrinth: the rabbits did not load.", failure)
    );
    return () => {
      live = false;
    };
  }, []);
  const { mesh, material } = useMemo(() => {
    const material = made(new THREE.MeshStandardNodeMaterial({ roughness: 0.9 }));
    const fur = (attribute("color", "vec4") as any).xyz as any;
    material.colorNode = fading(air, fur.mul(0.85));
    material.outputNode = vec4(throughMist(air, (output as any).rgb), 1) as any;
    const mesh = new THREE.InstancedMesh(shape ?? new THREE.BufferGeometry(), material, count);
    // Shadows only where there is the time to draw them twice.
    mesh.castShadow = detail > 0.5;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    return { mesh, material };
  }, [air, count, detail, shape]);
  useEffect(
    () => () => {
      material.dispose();
      mesh.dispose();
    },
    [mesh, material]
  );
  useEffect(() => () => shape?.dispose(), [shape]);

  const bunnies = useMemo<Bunny[]>(() => [], []);
  const seen = useMemo(sight, []);
  const scratch = useMemo(() => ({ matrix: new THREE.Matrix4(), quaternion: new THREE.Quaternion(), euler: new THREE.Euler(0, 0, 0, "YXZ"), position: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1) }), []);

  useEffect(() => {
    const listener = (shift: THREE.Vector3) => {
      for (const b of bunnies) {
        b.x += shift.x;
        b.z += shift.z;
        b.fromX += shift.x;
        b.fromZ += shift.z;
        b.i += Math.round(shift.x / CELL);
        b.j += Math.round(shift.z / CELL);
      }
    };
    worldShifted.add(listener);
    return () => {
      worldShifted.delete(listener);
    };
  }, [bunnies]);

  // Into a cell somewhere in the paths around the camera, not too near, sitting.
  const place = (b: Bunny) => {
    const angle = Math.random() * Math.PI * 2;
    const distance = NEAR + Math.random() * (FAR - NEAR);
    b.i = Math.floor((camera.position.x + Math.cos(angle) * distance) / CELL);
    b.j = Math.floor((camera.position.z + Math.sin(angle) * distance) / CELL);
    b.x = b.fromX = (b.i + 0.5) * CELL;
    b.z = b.fromZ = (b.j + 0.5) * CELL;
    b.di = b.dj = 0;
    b.hop = HOPS;
    b.t = 0;
    b.rest = Math.random() * 3;
    b.yaw = b.facing = Math.random() * Math.PI * 2;
  };

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    while (bunnies.length < count) {
      const b = {} as Bunny;
      place(b);
      bunnies.push(b);
    }
    bunnies.length = count;
    const { matrix, quaternion, euler, position, scale } = scratch;
    // Only those in or near the view are drawn: a hundred-odd rabbits all round, each drawn again for its shadow, are a
    // good part of the frame, and a shadow falls no further than a rabbit's length from it.
    aim(seen, camera as THREE.PerspectiveCamera);
    let drawn = 0;
    const playing = game.on;
    const { x: cx, z: cz } = camera.position;
    for (let n = 0; n < count; n++) {
      const b = bunnies[n];
      const near = Math.hypot(b.x - cx, b.z - cz);
      if (near > GONE) place(b);
      // Caught: a whoop, a handful of coins, and it turns up again somewhere else.
      if (playing && walking.on && near < CATCH && camera.position.y < 2.4) {
        const passed = game.catchBunny();
        sound.play("bunny", { gain: 1.5 });
        if (passed === 5) sound.play("ping", { gain: 1.4 });
        if (passed === 10) sound.play("chime", { gain: 1.5 });
        if (passed === 100) sound.play("fanfare", { gain: 1.6 });
        place(b);
      }
      const wary = playing && walking.on && near < WARY;
      // Seeing you coming, it stops sitting about.
      if (wary && b.rest > 0.15) b.rest = 0.15;
      let lift = 0;
      let pitch = 0;
      if (b.rest > 0) {
        b.rest -= delta;
        // Sitting, it looks about now and then.
        if (Math.random() < delta * 0.4) b.facing = b.yaw + (Math.random() - 0.5) * 1.6;
      } else if (b.hop >= HOPS) {
        // Arrived in the middle of a cell: on to an open neighbour, onward if it can, back only if it must.
        const ways = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1]
        ].filter(([di, dj]) => !blocked(b.i, b.j, di, dj));
        const onward = ways.filter(([di, dj]) => di !== -b.di || dj !== -b.dj);
        const pool = onward.length && Math.random() < 0.9 ? onward : ways;
        // Running from you: whichever way leads furthest off.
        const away = (d: number[]) => Math.hypot((b.i + d[0] + 0.5) * CELL - cx, (b.j + d[1] + 0.5) * CELL - cz);
        const choice = wary && ways.length ? ways.reduce((best, d) => (away(d) > away(best) ? d : best)) : pool[Math.floor(Math.random() * pool.length)];
        if (!choice) b.rest = 1 + Math.random() * 2;
        else {
          [b.di, b.dj] = choice;
          b.hop = 0;
          b.t = 0;
          b.fromX = b.x;
          b.fromZ = b.z;
          b.yaw = b.facing = Math.atan2(-b.di, -b.dj);
        }
      } else {
        // A hop: a short arc a seventh of the way, nose up as it leaves and down as it lands.
        if (b.hop === 0 && b.t === 0 && blocked(b.i, b.j, b.di, b.dj)) {
          // A hedge has come up in the way: turn back to the middle of the cell it left.
          b.di = -b.di;
          b.dj = -b.dj;
          b.i -= b.di;
          b.j -= b.dj;
        }
        b.t += (delta / HOP) * (wary ? 1.5 : 1);
        const k = Math.min(1, b.t);
        const step = (b.hop + k) / HOPS;
        b.x = b.fromX + b.di * CELL * step;
        b.z = b.fromZ + b.dj * CELL * step;
        lift = Math.sin(k * Math.PI) * 0.13;
        pitch = Math.cos(k * Math.PI) * 0.35;
        if (b.t >= 1) {
          b.hop++;
          b.t = 0;
          if (b.hop >= HOPS) {
            b.i += b.di;
            b.j += b.dj;
            b.x = (b.i + 0.5) * CELL;
            b.z = (b.j + 0.5) * CELL;
            b.rest = wary ? 0 : Math.random() < 0.55 ? 0.6 + Math.random() * 3 : 0;
          } else b.rest = wary ? 0.02 : 0.04 + Math.random() * 0.12;
        }
      }
      // Turned toward where it faces, never snapped round.
      let turn = b.facing - b.yaw;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      b.yaw += turn * (1 - Math.exp(-delta * 6));
      euler.set(pitch, b.yaw, 0);
      quaternion.setFromEuler(euler);
      // Offset a little from the middle of the path, each its own way, so they do not all run along one line.
      const lane = ((n * 0.37) % 1) - 0.5;
      position.set(b.x + (b.dj ? lane * 0.6 : 0), lift, b.z + (b.di ? lane * 0.6 : 0));
      if (inSight(seen, position.x, 0.2, position.z, 1.5)) mesh.setMatrixAt(drawn++, matrix.compose(position, quaternion, scale));
    }
    mesh.count = drawn;
    mesh.instanceMatrix.needsUpdate = true;
    if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __bunnies: bunnies });
  });

  return shape ? <primitive object={mesh} /> : null;
}
