"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, abs, attribute, cameraPosition, cross, exp, floor, length, max, mix, normalize, select, sin, step, uniform, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER } from "../../shared/engine/Post";
import { storm } from "./state";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A bolt is a list of straight segments: the main channel from the cloud's base to the sea, and the branches the
// stepped leader threw out on its way down, each knowing when the leader reached its two ends. The strips are all
// drawn every frame; what shows of each, and how bright, is worked out on the graphics card from the bolt's clock,
// so a strike costs one upload of its segments and nothing else.

export type Segment = { a: THREE.Vector3; b: THREE.Vector3; t0: number; t1: number; bright: number; width: number; main: boolean };

// How many segments each of the two bolts may have: one striking, one still fading as the next comes.
export const CAPACITY = 1400;
// How fast the leader feels its way down, in world units a second of the bolt's clock.
const LEADER_SPEED = 36;

// Grow a bolt from where it leaves the cloud to where it lands, a step at a time: each step leans toward the target
// (more as it nears it), keeps some of the last step's heading, and kinks at random. Branches leave the main channel
// now and then, more of them high up, each wandering down and out until it dies.
export function growBolt(top: THREE.Vector3, bottom: THREE.Vector3, random: () => number) {
  const segments: Segment[] = [];
  const unit = () => {
    const z = random() * 2 - 1;
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    return new THREE.Vector3(r * Math.cos(a), z, r * Math.sin(a));
  };
  const height = Math.max(0.5, top.y - bottom.y);

  const branch = (from: THREE.Vector3, heading: THREE.Vector3, time: number, reach: number, level: number, bright: number) => {
    let pos = from.clone();
    const dir = heading.clone();
    let travelled = 0;
    let t = time;
    while (travelled < reach && pos.y > 0.05 && segments.length < CAPACITY - 1) {
      const len = 0.08 + random() * 0.17;
      dir
        .multiplyScalar(0.55)
        .add(unit().multiplyScalar(0.75))
        .add(new THREE.Vector3(0, -0.35, 0))
        .normalize();
      const next = pos.clone().addScaledVector(dir, len);
      if (next.y < 0.02) next.y = 0.02;
      const fade = 1 - travelled / reach;
      const dt = len / LEADER_SPEED;
      segments.push({ a: pos, b: next, t0: t, t1: t + dt, bright: bright * (0.35 + 0.65 * fade), width: 0.012 / level + 0.004, main: false });
      if (level < 3 && random() < 0.1) {
        const side = unit();
        side.y = -Math.abs(side.y) * 0.6;
        branch(next, dir.clone().add(side).normalize(), t + dt, (reach - travelled) * (0.35 + random() * 0.4), level + 1, bright * 0.6);
      }
      travelled += len;
      t += dt;
      pos = next;
    }
  };

  let pos = top.clone();
  const dir = new THREE.Vector3().subVectors(bottom, top).normalize();
  let t = 0;
  for (let guard = 0; guard < 400 && segments.length < CAPACITY - 2; guard++) {
    const toward = new THREE.Vector3().subVectors(bottom, pos);
    const left = toward.length();
    const drop = 1 - pos.y / height;
    const len = 0.1 + random() * 0.2;
    if (left < len * 1.2) {
      const dt = left / LEADER_SPEED;
      segments.push({ a: pos, b: bottom.clone(), t0: t, t1: t + dt, bright: 1, width: 0.026, main: true });
      t += dt;
      break;
    }
    toward.normalize();
    // A big kink now and then: the tortuous zigzag of a real channel, not a wobble.
    const kink = random() < 0.12 ? 1.6 : 0.65;
    dir
      .multiplyScalar(0.4)
      .addScaledVector(toward, 0.35 + drop * drop * 1.1)
      .add(unit().multiplyScalar(kink))
      .normalize();
    if (dir.y > 0.15) dir.y = 0.15;
    const next = pos.clone().addScaledVector(dir, len);
    if (next.y < 0) next.y = 0;
    const dt = len / LEADER_SPEED;
    segments.push({ a: pos, b: next, t0: t, t1: t + dt, bright: 1, width: 0.026, main: true });
    // Branches, many near the cloud and few near the sea, pointing down and out.
    if (random() < 0.32 * (1 - drop * 0.7)) {
      const side = unit();
      side.y = -Math.abs(side.y) * 0.4;
      branch(next, dir.clone().multiplyScalar(0.6).add(side).normalize(), t + dt, (0.8 + random() * 2.4) * (1 - drop * 0.6), 1, 0.55 + random() * 0.3);
    }
    t += dt;
    pos = next;
  }
  return { segments, land: t };
}

// Two bolts share one geometry, half each; `slot` picks which half. Every segment is a quad of four corners that
// face the eye.
export function createBolts() {
  const quads = CAPACITY * 2;
  const geometry = new THREE.BufferGeometry();
  const a = new Float32Array(quads * 4 * 3);
  const b = new Float32Array(quads * 4 * 3);
  // side, end, slot, main
  const c = new Float32Array(quads * 4 * 4);
  // t0, t1, bright, width
  const d = new Float32Array(quads * 4 * 4);
  const index = new Uint32Array(quads * 6);
  for (let q = 0; q < quads; q++) {
    for (let k = 0; k < 4; k++) {
      const v = q * 4 + k;
      c[v * 4] = k % 2 === 0 ? -1 : 1;
      c[v * 4 + 1] = k < 2 ? 0 : 1;
      c[v * 4 + 2] = q < CAPACITY ? 0 : 1;
      // Nothing yet: never arrives.
      d[v * 4] = 1e6;
      d[v * 4 + 1] = 1e6;
    }
    index.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
  }
  const attributes = {
    a: new THREE.BufferAttribute(a, 3),
    b: new THREE.BufferAttribute(b, 3),
    c: new THREE.BufferAttribute(c, 4),
    d: new THREE.BufferAttribute(d, 4)
  };
  for (const [name, attribute_] of Object.entries(attributes)) {
    attribute_.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("bolt" + name.toUpperCase(), attribute_);
  }
  // Unread, as the shader places every corner itself, but three expects one.
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(quads * 4 * 3), 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  // Write a bolt into a slot; what is left of the slot is set never to arrive.
  const write = (slot: number, segments: Segment[]) => {
    const first = slot * CAPACITY;
    for (let s = 0; s < CAPACITY; s++) {
      const seg = segments[s];
      for (let k = 0; k < 4; k++) {
        const v = (first + s) * 4 + k;
        if (seg) {
          a.set([seg.a.x, seg.a.y, seg.a.z], v * 3);
          b.set([seg.b.x, seg.b.y, seg.b.z], v * 3);
          c[v * 4 + 3] = seg.main ? 1 : 0;
          d.set([seg.t0, seg.t1, seg.bright, seg.width], v * 4);
        } else {
          d[v * 4] = 1e6;
          d[v * 4 + 1] = 1e6;
          d[v * 4 + 2] = 0;
        }
      }
    }
    for (const attribute_ of Object.values(attributes)) {
      const size = attribute_.itemSize;
      attribute_.clearUpdateRanges();
      attribute_.addUpdateRange(first * 4 * size, CAPACITY * 4 * size);
      attribute_.needsUpdate = true;
    }
  };

  // Per slot: x the time on the bolt's clock since it began, y the main channel's brightness, z the branches', w the
  // glow of the leader still on its way down.
  const slots = [uniform(new THREE.Vector4(-1, 0, 0, 0)), uniform(new THREE.Vector4(-1, 0, 0, 0))];
  // How quickly a freshly reached step fades back from its first glare, on the bolt's clock.
  const freshness = uniform(40);

  const material = (mirror: boolean) => {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    // Each of the corner's numbers built afresh for every use, as a node shared between the position and a varying
    // breaks the strip.
    const corner = () => {
      const A = attribute("boltA", "vec3") as any;
      const B = attribute("boltB", "vec3") as any;
      const C = attribute("boltC", "vec4") as any;
      const D = attribute("boltD", "vec4") as any;
      const P = mix(A, B, C.y) as any;
      const eye = length(P.sub(cameraPosition)) as any;
      const pixel = eye.mul(storm.pixel);
      const core = max(D.w, pixel.mul(0.75)) as any;
      const halo = max(core.mul(7), pixel.mul(5)) as any;
      return { A, B, C, D, P, core, halo };
    };
    m.positionNode = Fn(() => {
      const { A, B, C, P, halo } = corner();
      const along = normalize(B.sub(A).add(vec3(0, 1e-5, 0))) as any;
      const across = cross(along, storm.forward) as any;
      const side = select(length(across).lessThan(1e-3), vec3(1, 0, 0), normalize(across));
      const placed = P.add(side.mul(C.x).mul(halo)).add(along.mul(C.y.mul(2).sub(1)).mul(halo.mul(0.5))) as any;
      if (!mirror) return placed;
      // Upside down under the water, swaying a little with the swell the deeper it goes.
      const deep = placed.y.max(0);
      const sway = sin(deep.mul(6.0).add(storm.time.mul(3.0))).mul(deep.mul(0.012).add(0.01));
      return vec3(placed.x.add(sway), deep.negate(), placed.z.add(sway.mul(0.6)));
    })();
    const shape = varying(
      Fn(() => {
        const { C, D, core, halo } = corner();
        // Across the strip in halo widths; the core's share of that; along it; how much a strip held wider than it
        // is dims to keep its light the same.
        return vec4(C.x, core.div(halo), C.y, D.w.div(core));
      })(),
      "vBoltShape"
    );
    const timing = varying(
      Fn(() => {
        const { C, D } = corner();
        return vec4(D.x, D.y, D.z, C.z.mul(2).add(C.w));
      })(),
      "vBoltTiming"
    );
    m.colorNode = Fn(() => {
      const code = timing.w;
      const slot = floor(code.mul(0.5).add(0.01));
      const main = code.sub(slot.mul(2));
      const s = select(slot.greaterThan(0.5), slots[1], slots[0]) as any;
      const arrived = mix(timing.x, timing.y, shape.z) as any;
      const shown = step(arrived, s.x);
      const since = s.x.sub(arrived).max(0);
      // While the leader feels its way down, each new step flares and settles to a dim glow; the tip is brightest.
      const leader = s.w.mul(exp(since.mul(freshness).negate()).mul(1.4).add(0.12)).mul(timing.z);
      const stroke = select(main.greaterThan(0.5), s.y, s.z.mul(timing.z));
      const power = max(leader, stroke).mul(shown).mul(shape.w);
      const x = shape.x.div(shape.y) as any;
      const profile = exp(x.mul(x).negate()).add(exp(abs(shape.x).mul(-4)).mul(0.12));
      const tint = mix(vec3(0.62, 0.6, 1.0), vec3(1.0, 0.98, 1.0), exp(x.mul(x).mul(-0.5)));
      const strength = mirror ? 1.8 : 9;
      return vec4(tint.mul(profile).mul(power).mul(strength), 1);
    })();
    return m;
  };

  const direct = new THREE.Mesh(geometry, material(false));
  const mirrored = new THREE.Mesh(geometry, material(true));
  for (const mesh of [direct, mirrored]) {
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
  }
  return { geometry, direct, mirrored, write, slots, freshness };
}

export type Bolts = ReturnType<typeof createBolts>;

export function BoltMeshes({ bolts }: { bolts: Bolts }) {
  useDispose(bolts.geometry, bolts.direct.material as THREE.Material, bolts.mirrored.material as THREE.Material);
  return (
    <>
      <primitive object={bolts.direct} />
      <primitive object={bolts.mirrored} />
    </>
  );
}

export const useBolts = () => useMemo(createBolts, []);
