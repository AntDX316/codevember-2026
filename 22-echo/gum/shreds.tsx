"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, cameraPosition, color, dot, mix, normalize, normalWorld, positionWorld } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { lehmer } from "../../shared/engine/random";
import { ROOM } from "./echo";
import { DEEP, PALE } from "./gum";
import { scatter } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Shreds of gum torn off as the break runs across the letters: each a small curled flake set free as the tear's rim
// passes it, flung out along the film's normal and away from the break, tumbling, falling; where it meets the tiles it
// splats flat and sticks. Simulated on the processor, a few hundred at a time, drawn as one instanced mesh. Splats stay
// on the tiles until their slot is needed for a later pop, so the hall collects them.

const IDLE = 0;
const WAITING = 1;
const FLYING = 2;
const STUCK = 3;

const GRAVITY = 9.8;

export function makeShreds(gumGeometry: THREE.BufferGeometry, pool: number, perPop: number) {
  // A curled flake: a squashed sphere bent into a shallow cup.
  const geometry = new THREE.SphereGeometry(1, 12, 8);
  const p = geometry.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i) * 0.72;
    p.setXYZ(i, x, p.getY(i) * 0.22 + 0.3 * x * x + 0.12 * z * z, z);
  }
  geometry.computeVertexNormals();

  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.36, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.12 });
  const V = normalize(cameraPosition.sub(positionWorld)) as any;
  const facing = abs(dot(normalize(normalWorld), V)) as any;
  m.colorNode = mix(color(DEEP), color(PALE), facing.mul(0.3)).mul(0.92) as any;
  m.emissiveNode = mix(color(DEEP).mul(0.06), color(PALE).mul(0.1), facing.mul(0.5)) as any;

  const mesh = new THREE.InstancedMesh(geometry, m, pool);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  mesh.raycast = () => null;
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < pool; i++) mesh.setMatrixAt(i, hidden);

  const sites = scatter(gumGeometry, perPop * 3, 4411);
  const random = lehmer(9071);
  const s = {
    mesh,
    geometry,
    material: m,
    pool,
    perPop,
    next: 0,
    mode: new Uint8Array(pool),
    local: new Float32Array(pool * 3),
    normal: new Float32Array(pool * 3),
    pos: new Float32Array(pool * 3),
    vel: new Float32Array(pool * 3),
    quat: new Float32Array(pool * 4),
    spin: new Float32Array(pool * 3),
    size: new Float32Array(pool * 3),
    splat: new Float32Array(pool),
    reach: new Float32Array(pool),
    random
  };
  for (let i = 0; i < pool; i++) s.quat[i * 4 + 3] = 1;
  return { ...s, sites };
}
export type Shreds = ReturnType<typeof makeShreds>;

// Lay out this pop's shreds over the gum, each waiting for the tear to reach it.
export function armShreds(s: Shreds, tearLocal: THREE.Vector3, scale: number) {
  const r = s.random;
  for (let n = 0; n < s.perPop; n++) {
    const i = s.next;
    s.next = (s.next + 1) % s.pool;
    const site = Math.floor(r() * (s.sites.at.length / 3));
    const lx = s.sites.at[site * 3];
    const ly = s.sites.at[site * 3 + 1];
    const lz = s.sites.at[site * 3 + 2];
    s.local.set([lx, ly, lz], i * 3);
    s.normal.set([s.sites.dir[site * 3], s.sites.dir[site * 3 + 1], s.sites.dir[site * 3 + 2]], i * 3);
    s.reach[i] = Math.hypot(lx - tearLocal.x, ly - tearLocal.y, lz - tearLocal.z);
    const big = r() < 0.1 ? 1.8 : 1;
    const k = (0.022 + r() * 0.042) * big * Math.sqrt(scale);
    // Most are flakes; some are torn strands, long and thin.
    const strand = r() < 0.25 ? 2.2 + r() * 1.5 : 1;
    s.size.set([k * (0.8 + r() * 0.5) * strand, k * (0.7 + r() * 0.5), (k * (0.7 + r() * 0.5)) / Math.sqrt(strand)], i * 3);
    s.mode[i] = WAITING;
  }
}

const scratch = { v: new THREE.Vector3(), n: new THREE.Vector3(), q: new THREE.Quaternion(), dq: new THREE.Quaternion(), axis: new THREE.Vector3(), m: new THREE.Matrix4(), sc: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), nm: new THREE.Matrix3() };

// One step: launch those the tear has reached (in the gum's own units), fly the rest, stick what lands.
export function stepShreds(s: Shreds, dt: number, tear: number, group: THREE.Object3D, tearLocal: THREE.Vector3, onSplat: (count: number) => void) {
  const { v, n, q, dq, axis, up, nm } = scratch;
  const r = s.random;
  nm.getNormalMatrix(group.matrixWorld);
  let splats = 0;
  for (let i = 0; i < s.pool; i++) {
    const mode = s.mode[i];
    if (mode === IDLE) continue;
    const i3 = i * 3;
    if (mode === WAITING) {
      if (tear < s.reach[i]) continue;
      v.set(s.local[i3], s.local[i3 + 1], s.local[i3 + 2]).applyMatrix4(group.matrixWorld);
      s.pos.set([v.x, v.y, v.z], i3);
      n.set(s.normal[i3], s.normal[i3 + 1], s.normal[i3 + 2]).applyMatrix3(nm).normalize();
      // Out along the film, away from the break, and a little up.
      const away = v.set(s.local[i3] - tearLocal.x, s.local[i3 + 1] - tearLocal.y, s.local[i3 + 2] - tearLocal.z).normalize();
      const speed = 2.2 + r() * 4.5;
      s.vel.set([n.x * speed + away.x * 1.6 + (r() - 0.5) * 1.5, n.y * speed + away.y * 1.6 + 1.2 + r() * 1.5, n.z * speed + away.z * 1.6 + (r() - 0.5) * 1.5], i3);
      q.setFromUnitVectors(up, n);
      s.quat.set([q.x, q.y, q.z, q.w], i * 4);
      s.spin.set([(r() - 0.5) * 22, (r() - 0.5) * 22, (r() - 0.5) * 22], i3);
      s.mode[i] = FLYING;
    } else if (mode === FLYING) {
      s.vel[i3 + 1] -= GRAVITY * dt;
      const drag = Math.exp(-dt * 0.35);
      s.vel[i3] *= drag;
      s.vel[i3 + 1] *= drag;
      s.vel[i3 + 2] *= drag;
      s.pos[i3] += s.vel[i3] * dt;
      s.pos[i3 + 1] += s.vel[i3 + 1] * dt;
      s.pos[i3 + 2] += s.vel[i3 + 2] * dt;
      const w = Math.hypot(s.spin[i3], s.spin[i3 + 1], s.spin[i3 + 2]);
      q.set(s.quat[i * 4], s.quat[i * 4 + 1], s.quat[i * 4 + 2], s.quat[i * 4 + 3]);
      if (w > 1e-4) {
        dq.setFromAxisAngle(axis.set(s.spin[i3] / w, s.spin[i3 + 1] / w, s.spin[i3 + 2] / w), w * dt);
        q.premultiply(dq);
      }
      // Meets the floor, the wall or the ceiling: flat against it, stuck.
      const x = s.pos[i3];
      const y = s.pos[i3 + 1];
      const z = s.pos[i3 + 2];
      const rho = Math.hypot(x, z);
      let hit = false;
      if (y < ROOM.floor + 0.004) {
        s.pos[i3 + 1] = ROOM.floor + 0.004;
        n.set(0, 1, 0);
        hit = true;
      } else if (rho > ROOM.radius - 0.006) {
        s.pos[i3] = (x / rho) * (ROOM.radius - 0.006);
        s.pos[i3 + 2] = (z / rho) * (ROOM.radius - 0.006);
        n.set(-x / rho, 0, -z / rho);
        hit = true;
      } else if (y > ROOM.ceiling - 0.004) {
        s.pos[i3 + 1] = ROOM.ceiling - 0.004;
        n.set(0, -1, 0);
        hit = true;
      }
      if (hit) {
        q.setFromUnitVectors(up, n);
        q.multiply(dq.setFromAxisAngle(up, r() * Math.PI * 2));
        s.mode[i] = STUCK;
        s.splat[i] = 0;
        splats++;
      }
      s.quat.set([q.x, q.y, q.z, q.w], i * 4);
    } else if (mode === STUCK) {
      s.splat[i] = Math.min(1, s.splat[i] + dt * 14);
    }
  }
  if (splats) onSplat(splats);
}

// Write the instances: waiting ones hidden, splats spread flat.
export function drawShreds(s: Shreds) {
  const { q, m, sc } = scratch;
  const v = scratch.v;
  for (let i = 0; i < s.pool; i++) {
    const mode = s.mode[i];
    const i3 = i * 3;
    if (mode === IDLE || mode === WAITING) {
      m.makeScale(0, 0, 0);
    } else {
      q.set(s.quat[i * 4], s.quat[i * 4 + 1], s.quat[i * 4 + 2], s.quat[i * 4 + 3]);
      const f = mode === STUCK ? s.splat[i] : 0;
      const spread = 1 + f * 0.9;
      sc.set(s.size[i3] * spread, s.size[i3 + 1] * (1 - f * 0.6), s.size[i3 + 2] * spread);
      v.set(s.pos[i3], s.pos[i3 + 1], s.pos[i3 + 2]);
      m.compose(v, q, sc);
    }
    s.mesh.setMatrixAt(i, m);
  }
  s.mesh.instanceMatrix.needsUpdate = true;
}

export function useShreds(gumGeometry: THREE.BufferGeometry, pool: number, perPop: number) {
  const s = useMemo(() => makeShreds(gumGeometry, pool, perPop), [gumGeometry, pool, perPop]);
  useDispose(s.geometry, s.material);
  return s;
}
