"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { dot, float, Fn, smoothstep, uv, instanceIndex, instancedArray, max, mix, normalWorld, positionWorld, vec2, vec3, vec4 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { sound } from "../shared/engine/sound";
import { followPrompt } from "../shared/ui/Follow";
import { shareResult } from "../shared/ui/Share";
import { type Desert, homeAt, PATCH } from "./desert";
import { type Bone, type Joints, Kind } from "./creatures";
import { world } from "./render";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The animals the oasis draws in: birds wheeling high over the desert all the while; flamingos flying in once the first
// palms are up, in twos and threes, to wade and feed in the shallows; and, when the oasis is well grown, camels walking
// in out of the mirage, alone, as a pair, or as a family with a calf, to drink.
//
// Every part of every animal (body, each bone of a neck, leg or wing, each flight feather) is one stretched sphere, all
// drawn as instances of a single mesh, posed each frame on the processor from a few joint angles: one draw for the lot.
// The animals are a tenth of life size, like the palms.

const V = THREE.Vector3;
const MAX_PARTS = 2400;
const FLAMINGOS = 24;
const CAMELS = 8;
// Bones in a flamingo's neck and a camel's, and how far a camel's foot swings each way in a stride, in its own units.
const NECK = 10;
const CAMEL_NECK = 6;
const STRIDE = 0.17;
// How close two camels may come, centre to centre: a little more than half of each one's length, so they never walk
// into or through each other.
const clearance = (a: { size: number }, b: { size: number }) => 1.2 * (a.size + b.size);
const SKY_BIRDS = 30;
const PROBES = 24 * 24 + FLAMINGOS + CAMELS;

export type Life = { oasis: number; palms: number };

// Colours, linear.
const C = (hex: string) => new THREE.Color(hex);
const PINK = C("#f3a2a4");
const PINK_DEEP = C("#ea7d8a");
const PINK_PALE = C("#f8d0c9");
const BLACK = C("#16110f");
const BILL = C("#f4d7cf");
const LEG = C("#e98b93");
const EYE = C("#f2d34a");
const CAMEL = C("#c2a383");
const CAMEL_DARK = C("#977a5b");
const CAMEL_PALE = C("#dac4a6");
const BIRD = C("#2c2622");

// Places one stretched sphere: its middle, three unit axes and its half-size along each.
class Parts {
  mesh: THREE.InstancedMesh;
  n = 0;
  private m = new THREE.Matrix4();
  constructor(mesh: THREE.InstancedMesh) {
    this.mesh = mesh;
  }
  put(at: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3, sx: number, sy: number, sz: number, colour: THREE.Color) {
    if (!this.mesh || this.n >= MAX_PARTS) return;
    const e = this.m.elements;
    e[0] = x.x * sx;
    e[1] = x.y * sx;
    e[2] = x.z * sx;
    e[4] = y.x * sy;
    e[5] = y.y * sy;
    e[6] = y.z * sy;
    e[8] = z.x * sz;
    e[9] = z.y * sz;
    e[10] = z.z * sz;
    e[12] = at.x;
    e[13] = at.y;
    e[14] = at.z;
    e[3] = e[7] = e[11] = 0;
    e[15] = 1;
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.setColorAt(this.n, colour);
    this.n++;
  }
  // A bone from a to b, round, of this radius, a little longer than the gap so neighbours overlap at the joints.
  bone(a: THREE.Vector3, b: THREE.Vector3, r: number, colour: THREE.Color, r2 = r) {
    const y = _d.subVectors(b, a);
    const length = y.length();
    if (length < 1e-6) return;
    y.divideScalar(length);
    const x = _x.crossVectors(y, Math.abs(y.y) < 0.9 ? UP : RIGHT).normalize();
    const z = _z.crossVectors(x, y);
    this.put(_c.addVectors(a, b).multiplyScalar(0.5), x, y, z, Math.max(r, r2), length * 0.5 + Math.min(r, r2) * 1.1, Math.max(r, r2), colour);
  }
  // A flat blade (a feather, a wing panel) from a to b, its flat side facing `facing`, this wide and this thick.
  blade(a: THREE.Vector3, b: THREE.Vector3, facing: THREE.Vector3, wide: number, thick: number, colour: THREE.Color) {
    const y = _d.subVectors(b, a);
    const length = y.length();
    if (length < 1e-6) return;
    y.divideScalar(length);
    const x = _x.crossVectors(y, facing).normalize();
    const z = _z.crossVectors(x, y);
    this.put(_c.addVectors(a, b).multiplyScalar(0.5), x, y, z, wide, length * 0.5, thick, colour);
  }
  // A blob: an ellipsoid of these half-sizes along a frame's own axes.
  blob(at: THREE.Vector3, f: Frame, sx: number, sy: number, sz: number, colour: THREE.Color) {
    this.put(at, f.x, f.y, f.z, sx, sy, sz, colour);
  }
}
const UP = new V(0, 1, 0);
const _shadow = new THREE.Matrix4();
const _at = new V();
const _turn = new THREE.Quaternion();
const _size = new V();
const RIGHT = new V(1, 0, 0);
const _d = new V();
const _x = new V();
const _z = new V();
const _c = new V();

// A frame in the world: where an animal stands and which way it faces, with its axes; local points map into the world.
class Frame {
  o = new V();
  x = new V(1, 0, 0);
  y = new V(0, 1, 0);
  z = new V(0, 0, 1);
  s = 1;
  set(at: THREE.Vector3, yaw: number, pitch: number, roll: number, scale: number) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
    this.o.copy(at);
    this.x.set(1, 0, 0).applyQuaternion(q);
    this.y.set(0, 1, 0).applyQuaternion(q);
    this.z.set(0, 0, 1).applyQuaternion(q);
    this.s = scale;
    return this;
  }
  p(x: number, y: number, z: number, out = new V()) {
    return out
      .copy(this.o)
      .addScaledVector(this.x, x * this.s)
      .addScaledVector(this.y, y * this.s)
      .addScaledVector(this.z, z * this.s);
  }
  d(x: number, y: number, z: number, out = new V()) {
    return out.set(0, 0, 0).addScaledVector(this.x, x).addScaledVector(this.y, y).addScaledVector(this.z, z).normalize();
  }
}

// Two bones from a root to reach a target, the joint bending toward `hint`: the elbow or knee.
function reach(root: THREE.Vector3, target: THREE.Vector3, a: number, b: number, hint: THREE.Vector3) {
  const to = new V().subVectors(target, root);
  const d = Math.min(Math.max(to.length(), Math.abs(a - b) + 1e-4), a + b - 1e-4);
  to.normalize();
  const along = (a * a - b * b + d * d) / (2 * d);
  const out = Math.sqrt(Math.max(a * a - along * along, 0));
  const side = hint.clone().addScaledVector(to, -hint.dot(to)).normalize();
  return root.clone().addScaledVector(to, along).addScaledVector(side, out);
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
// How many come together: one now and then, most often two or three, sometimes four.
const groupSize = () => {
  const r = Math.random();
  return r < 0.15 ? 1 : r < 0.55 ? 2 : r < 0.85 ? 3 : 4;
};
const angleTo = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

type Flamingo = {
  state: "fly" | "stroll" | "wade" | "feed" | "rest" | "preen";
  neck?: THREE.Vector3[];
  billWay?: THREE.Vector3;
  seen?: number;
  pond: THREE.Vector3;
  bank: number;
  pitch: number;
  at: THREE.Vector3;
  yaw: number;
  from: THREE.Vector3;
  via: THREE.Vector3;
  goal: THREE.Vector3;
  t: number;
  span: number;
  until: number;
  walk: number;
  flap: number;
  size: number;
  tint: number;
  probe: number;
  ground: number;
  water: number;
  lift: number;
};

type Camel = {
  state: "walk" | "drink" | "idle";
  at: THREE.Vector3;
  yaw: number;
  goal: THREE.Vector3;
  until: number;
  gait: number;
  size: number;
  calf: boolean;
  tint: THREE.Color;
  probe: number;
  ground: number;
  head: number;
  speed: number;
};

type SkyBird = { centre: THREE.Vector3; radius: number; speed: number; phase: number; height: number; flap: number; size: number; tilt: number };

export function Animals({ desert, life }: { desert: Desert; life: { current: Life } }) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;

  // One mesh for every part: a round, smooth unit sphere, lit as the plants are, with the palms' and clouds' shade.
  const { mesh, material, geometry } = useMemo(() => {
    const geometry = new THREE.IcosahedronGeometry(1, 2);
    const material = new THREE.MeshBasicNodeMaterial({ fog: false });
    material.colorNode = Fn(() => {
      const n = normalWorld.toVar();
      const sun = world.sun.mul(world.power) as any;
      const facing = max(dot(n, world.toSun), float(0)) as any;
      const wrap = max(dot(n, world.toSun).add(0.35).div(1.35), float(0)) as any;
      const shade = desert.palmShade(positionWorld.xz) as any;
      const sky = mix(world.horizon, world.zenith, n.y.mul(0.5).add(0.5)) as any;
      const bounce = (world.sand as any).mul(sun).mul(float(0.5).sub(n.y.mul(0.5)).mul(0.35)) as any;
      return vec4(
        sun
          .mul(mix(facing, wrap, 0.35))
          .mul(shade)
          .mul(0.95)
          .add(sky.mul(0.5))
          .add(bounce),
        1
      );
    })() as any;
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_PARTS);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color());
    mesh.frustumCulled = false;
    mesh.count = 0;
    return { mesh, material, geometry };
  }, [desert]);
  useDispose(geometry, material);

  // Probes: points where the processor wants the sand's height and the water's depth, read back each frame. A grid
  // over the patch finds the water; one under each animal keeps its feet on the sand.
  const probe = useMemo(() => {
    const at = instancedArray(PROBES, "vec2") as any;
    const out = instancedArray(PROBES, "vec2") as any;
    const pass = Fn(() => {
      const p = at.element(instanceIndex) as any;
      const k = desert.columnOf(p) as any;
      const c = desert.cells.element(k) as any;
      out.element(instanceIndex).assign(desert.onPatch(p).select(vec2(c.x, c.y), vec2(-99, 0)));
    })().compute(PROBES);
    const where = at.value.array as Float32Array;
    const N = 24;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        where[(j * N + i) * 2] = ((i + 0.5) / N - 0.5) * (PATCH - 0.2);
        where[(j * N + i) * 2 + 1] = ((j + 0.5) / N - 0.5) * (PATCH - 0.2);
      }
    at.value.needsUpdate = true;
    return { at, out, pass, where, read: new Float32Array(PROBES * 2), busy: false, ready: false, last: 0 };
  }, [desert]);

  const herd = useRef({
    flamingos: [] as Flamingo[],
    camels: [] as Camel[],
    birds: [] as SkyBird[],
    nextFlock: 0,
    nextHerd: 0,
    honk: 0,
    step: 0,
    water: [] as THREE.Vector3[],
    shore: [] as THREE.Vector3[]
  });

  useEffect(() => {
    const h = herd.current;
    // Birds over the desert, in a few loose flocks wheeling at their own heights.
    for (let f = 0; f < 4; f++) {
      const centre = new V(rand(-14, 14), 0, rand(-14, 14));
      const height = rand(3.5, 7);
      const speed = rand(0.25, 0.4) * (Math.random() < 0.5 ? -1 : 1);
      for (let k = 0; k < SKY_BIRDS / 4; k++)
        h.birds.push({ centre, radius: rand(4, 9), speed, phase: rand(0, 0.6) + f * 1.7, height: height + rand(-0.4, 0.4), flap: rand(0, 6), size: rand(0.85, 1.15), tilt: 0 });
    }
  }, []);

  const parts = useMemo(() => new Parts(mesh), [mesh]);
  // Soft dark ovals on the ground under each animal, where it stands.
  const shadows = useMemo(() => {
    const geometry = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    const r = uv().sub(0.5).mul(2).length() as any;
    material.colorNode = vec3(0.05, 0.035, 0.02) as any;
    material.opacityNode = smoothstep(1, 0.15, r).mul(0.45) as any;
    const m = new THREE.InstancedMesh(geometry, material, FLAMINGOS + CAMELS);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.renderOrder = 1.5;
    return m;
  }, []);
  useEffect(
    () => () => {
      shadows.geometry.dispose();
      (shadows.material as THREE.Material).dispose();
    },
    [shadows]
  );
  const kinds = useMemo(() => buildKinds(desert), [desert]);
  useEffect(
    () => () => {
      kinds.flamingo.dispose();
      kinds.camel.dispose();
    },
    [kinds]
  );
  const f = useMemo(() => new Frame(), []);

  useFrame(({ clock }, raw) => {
    const delta = Math.min(raw, 1 / 20);
    const now = clock.elapsedTime;
    const h = herd.current;
    const { oasis, palms } = life.current;

    // Ask for the probes' heights, and take the last answer.
    const where = probe.where;
    h.flamingos.forEach((b, k) => {
      where[(576 + k) * 2] = b.at.x;
      where[(576 + k) * 2 + 1] = b.at.z;
      b.probe = 576 + k;
    });
    h.camels.forEach((c, k) => {
      where[(576 + FLAMINGOS + k) * 2] = c.at.x;
      where[(576 + FLAMINGOS + k) * 2 + 1] = c.at.z;
      c.probe = 576 + FLAMINGOS + k;
    });
    probe.at.value.needsUpdate = true;
    // A few times a second is plenty: a readback each frame would hold the GPU up.
    if (!probe.busy && now - probe.last > 0.25) {
      probe.last = now;
      probe.busy = true;
      gl.compute(probe.pass);
      (gl.getArrayBufferAsync(probe.out.value) as Promise<ArrayBuffer>)
        .then((buffer) => {
          probe.read.set(new Float32Array(buffer).subarray(0, PROBES * 2));
          probe.ready = true;
          // Where the water is, and the dry sand at its edge.
          h.water.length = 0;
          h.shore.length = 0;
          const N = 24;
          const wet = (i: number, j: number) => i >= 0 && j >= 0 && i < N && j < N && probe.read[(j * N + i) * 2 + 1] > 0.0015;
          for (let j = 0; j < N; j++)
            for (let i = 0; i < N; i++) {
              const x = where[(j * N + i) * 2];
              const z = where[(j * N + i) * 2 + 1];
              if (wet(i, j)) h.water.push(new V(x, 0, z));
              else if (wet(i + 1, j) || wet(i - 1, j) || wet(i, j + 1) || wet(i, j - 1)) h.shore.push(new V(x, 0, z));
            }
        })
        .catch(() => {})
        .finally(() => (probe.busy = false));
    }
    const groundAt = (x: number, z: number, index: number) => {
      const y = probe.ready ? probe.read[index * 2] : -99;
      return y > -50 ? { y, water: probe.read[index * 2 + 1] } : { y: homeAt(x, z), water: 0 };
    };

    // New arrivals. Flamingos once the first palms are up and there is water to wade in, more the further the oasis has
    // come; camels once it is well grown.
    // Flamingos as soon as there is a pond to wade in, more as the oasis grows.
    if (h.water.length > 3 && oasis > 0.02 && now > h.nextFlock) {
      const wanted = Math.min(FLAMINGOS, Math.round(2 + oasis * 14 + palms * 0.1));
      if (h.flamingos.length < wanted) {
        const size = Math.min(groupSize(), FLAMINGOS - h.flamingos.length);
        const spot = h.water[Math.floor(Math.random() * h.water.length)];
        const heading = rand(0, Math.PI * 2);
        const from = new V(Math.cos(heading) * 14, rand(3, 4.5), Math.sin(heading) * 14);
        for (let k = 0; k < size; k++) {
          // They land on the dry sand by the water, walk about a little, then go in.
          const shore = h.shore.length ? h.shore.reduce((a, c) => (c.distanceTo(spot) < a.distanceTo(spot) ? c : a)) : spot;
          const goal = shore.clone().add(new V(rand(-0.2, 0.2), 0, rand(-0.2, 0.2)));
          const start = from.clone().add(new V(rand(-0.6, 0.6), rand(-0.3, 0.3), rand(-0.6, 0.6)));
          const via = goal.clone().lerp(start, 0.25).setY(1.2);
          h.flamingos.push({
            state: "fly",
            pond: spot.clone().add(new V(rand(-0.2, 0.2), 0, rand(-0.2, 0.2))),
            bank: 0,
            pitch: 0,
            at: start.clone(),
            yaw: 0,
            from: start,
            via,
            goal,
            t: -k * 0.06,
            span: start.distanceTo(goal) / 1.5,
            until: 0,
            walk: 0,
            flap: rand(0, 6),
            size: rand(0.9, 1.1),
            tint: rand(0, 1),
            probe: 0,
            ground: 0,
            water: 0,
            lift: 0
          });
        }
        h.honk = now + 2;
      }
      h.nextFlock = now + rand(5, 11);
    }
    // A spot by the water near `near` that no other camel is standing on or making for.
    const freeSpot = (spots: THREE.Vector3[], near: THREE.Vector3, size: number, self: Camel | null) => {
      const spot = new V();
      for (let tries = 0; tries < 12; tries++) {
        const base = tries < 4 ? near : (spots[Math.floor(Math.random() * spots.length)] ?? near);
        spot.set(base.x + rand(-0.4, 0.4), 0, base.z + rand(-0.4, 0.4));
        if (h.camels.every((o) => o === self || (o.goal.distanceTo(spot) > clearance(o, { size }) && Math.hypot(o.at.x - spot.x, o.at.z - spot.z) > clearance(o, { size })))) break;
      }
      return spot;
    };
    if (oasis > 0.03 && h.water.length > 3 && now > h.nextHerd && h.camels.length < CAMELS) {
      const wanted = oasis > 0.5 ? CAMELS : 4;
      if (h.camels.length < wanted) {
        const r = Math.random();
        const family = r < 0.35 ? ["adult"] : r < 0.65 ? ["adult", "adult"] : ["adult", "adult", "calf"];
        const heading = rand(0, Math.PI * 2);
        const spots = h.shore.length ? h.shore : h.water;
        const drink = spots[Math.floor(Math.random() * spots.length)];
        family.slice(0, CAMELS - h.camels.length).forEach((kind, k) => {
          const calf = kind === "calf";
          const start = new V(Math.cos(heading) * 7 + rand(-0.5, 0.5), 0, Math.sin(heading) * 7 + rand(-0.5, 0.5)).addScaledVector(new V(Math.cos(heading), 0, Math.sin(heading)), k * 0.5);
          const tint = CAMEL.clone().lerp(Math.random() < 0.5 ? CAMEL_PALE : CAMEL_DARK, rand(0, 0.6));
          h.camels.push({
            state: "walk",
            at: start,
            yaw: heading + Math.PI,
            goal: freeSpot(spots, drink, calf ? 0.62 * 0.21 : 0.21, null),
            until: 0,
            gait: rand(0, 6),
            size: (calf ? 0.62 : rand(0.92, 1.08)) * 0.21,
            calf,
            tint: calf ? CAMEL_PALE.clone() : tint,
            probe: 0,
            ground: homeAt(start.x, start.z),
            head: 0,
            speed: calf ? 0.16 : 0.13
          });
        });
      }
      h.nextHerd = now + rand(9, 16);
    }

    parts.n = 0;
    let flamingoCount = 0;
    let shadowCount = 0;
    const lay = (x: number, y: number, z: number, yaw: number, wide: number, long: number) => {
      _shadow.compose(_at.set(x, y + 0.002, z), _turn.setFromAxisAngle(UP, yaw), _size.set(wide, 1, long));
      shadows.setMatrixAt(shadowCount++, _shadow);
    };
    let camelCount = 0;
    const joints: Joints = {};

    // Flamingos.
    for (const b of h.flamingos) {
      const g = groundAt(b.at.x, b.at.z, b.probe);
      b.ground += (g.y - b.ground) * Math.min(1, delta * 6);
      b.water = g.water;
      if (b.state === "fly") {
        b.t += delta / b.span;
        const t = Math.min(Math.max(b.t, 0), 1);
        // Along a curve from far off, down over the water, to the spot, slowing all the way in to touch down softly.
        const u = 1 - Math.pow(1 - t, 1.7);
        const goal = b.goal.clone().setY(b.ground);
        const p = new V()
          .copy(b.from)
          .multiplyScalar((1 - u) * (1 - u))
          .addScaledVector(b.via, 2 * u * (1 - u))
          .addScaledVector(goal, u * u);
        const ahead = new V().subVectors(p, b.at);
        if (ahead.lengthSq() > 1e-10) {
          // Turning smoothly, banking into the turn.
          const turn = angleTo(b.yaw, Math.atan2(ahead.x, ahead.z)) * Math.min(1, delta * 2.5);
          b.yaw += turn;
          b.bank += (THREE.MathUtils.clamp((-turn / Math.max(delta, 1e-3)) * 0.5, -0.5, 0.5) - b.bank) * Math.min(1, delta * 3);
        }
        b.at.copy(p);
        // Flaring at the end: the body tips up, the wings brake in slow deep beats and the legs swing down.
        const flare = THREE.MathUtils.smoothstep(t, 0.78, 1);
        b.pitch = -0.08 + flare * 0.5;
        b.lift = Math.min(1, t * 5) * (1 - THREE.MathUtils.smoothstep(t, 0.9, 1));
        b.flap += delta * (16 - flare * 8);
        if (t >= 1) {
          b.state = "stroll";
          b.bank = 0;
          b.pitch = 0;
          b.goal.set(b.at.x + rand(-0.25, 0.25), 0, b.at.z + rand(-0.25, 0.25));
          b.until = now + 5;
        }
      } else {
        b.lift = 0;
        // Standing on the bed, the water round its legs.
        b.at.y = b.ground;
        if (b.state === "stroll") {
          const to = new V(b.goal.x - b.at.x, 0, b.goal.z - b.at.z);
          if (to.length() > 0.03) {
            b.yaw += angleTo(b.yaw, Math.atan2(to.x, to.z)) * Math.min(1, delta * 2.5);
            const step = 0.045 * delta;
            b.at.x += Math.sin(b.yaw) * step;
            b.at.z += Math.cos(b.yaw) * step;
            b.walk += delta * 5;
          } else b.goal.set(b.at.x + rand(-0.25, 0.25), 0, b.at.z + rand(-0.25, 0.25));
          if (now > b.until) {
            b.state = "wade";
            b.goal.copy(b.pond);
            b.until = now + rand(1, 3);
          }
        } else if (b.state === "wade") {
          const to = new V(b.goal.x - b.at.x, 0, b.goal.z - b.at.z);
          if (to.length() > 0.03) {
            b.yaw += angleTo(b.yaw, Math.atan2(to.x, to.z)) * Math.min(1, delta * 3);
            const step = 0.05 * delta;
            b.at.x += Math.sin(b.yaw) * step;
            b.at.z += Math.cos(b.yaw) * step;
            b.walk += delta * 5.5;
          } else if (now > b.until) {
            const r = Math.random();
            b.state = r < 0.45 ? "feed" : r < 0.75 ? "rest" : "preen";
            b.until = now + (b.state === "feed" ? rand(4, 10) : b.state === "rest" ? rand(6, 14) : rand(3, 6));
          }
        } else if (now > b.until) {
          // Off to another spot in the shallows near by.
          const near = h.water.filter((w) => w.distanceTo(new V(b.at.x, 0, b.at.z)) < 0.9);
          const pick = near.length ? near[Math.floor(Math.random() * near.length)] : b.at;
          b.goal.set(pick.x + rand(-0.12, 0.12), 0, pick.z + rand(-0.12, 0.12));
          b.state = "wade";
          b.until = now + rand(1, 4);
        }
      }
      drawFlamingo(parts, f, b, now, joints);
      if (b.state !== "fly" || b.lift < 0.3) lay(b.at.x, b.ground, b.at.z, b.yaw, 0.12 * 0.12 * b.size * 1.4, 0.2 * 0.12 * b.size * 1.4);
      kinds.flamingo.pose(flamingoCount++, joints, f.x, 0.12 * b.size, WHITE.clone().lerp(BLUSH, b.tint));
    }

    // Camels. Any two closer than they should be are eased apart, a standing one giving way less than a walking one.
    for (let i = 0; i < h.camels.length; i++)
      for (let j = i + 1; j < h.camels.length; j++) {
        const a = h.camels[i];
        const b = h.camels[j];
        const dx = b.at.x - a.at.x;
        const dz = b.at.z - a.at.z;
        const d = Math.hypot(dx, dz);
        const gap = clearance(a, b) - d;
        if (gap <= 0) continue;
        const [nx, nz] = d > 1e-4 ? [dx / d, dz / d] : [Math.cos(i), Math.sin(i)];
        const wa = a.state === "walk" ? 1 : 0.25;
        const wb = b.state === "walk" ? 1 : 0.25;
        const push = Math.min(gap, 0.6 * delta + gap * Math.min(1, delta * 4)) / (wa + wb);
        a.at.x -= nx * push * wa;
        a.at.z -= nz * push * wa;
        b.at.x += nx * push * wb;
        b.at.z += nz * push * wb;
      }
    for (const c of h.camels) {
      const g = groundAt(c.at.x, c.at.z, c.probe);
      c.ground += (g.y - c.ground) * Math.min(1, delta * 5);
      let moving = 0;
      if (c.state === "walk") {
        const to = new V(c.goal.x - c.at.x, 0, c.goal.z - c.at.z);
        // Someone already standing where it was making for: it stops beside them instead.
        const taken = h.camels.some((o) => o !== c && o.state !== "walk" && Math.hypot(o.at.x - c.goal.x, o.at.z - c.goal.z) < clearance(o, c));
        if (to.length() > (taken ? clearance(c, c) * 1.6 : 0.12)) {
          // Round any camel in its way: turn aside from those close ahead, the closer the harder.
          let want = Math.atan2(to.x, to.z);
          for (const o of h.camels) {
            if (o === c) continue;
            const dx = o.at.x - c.at.x;
            const dz = o.at.z - c.at.z;
            const d = Math.hypot(dx, dz);
            const room = clearance(o, c) * 2.2;
            const ahead = (Math.sin(c.yaw) * dx + Math.cos(c.yaw) * dz) / Math.max(d, 1e-4);
            if (d < room && ahead > 0.2) {
              const side = Math.cos(c.yaw) * dx - Math.sin(c.yaw) * dz > 0 ? -1 : 1;
              want += side * 1.1 * (1 - d / room) * ahead;
            }
          }
          c.yaw += angleTo(c.yaw, want) * Math.min(1, delta * 1.6);
          // As fast as the strides carry it, so the planted feet never slide.
          const step = 4 * STRIDE * c.size * (c.calf ? 1.35 : 0.9) * delta;
          c.at.x += Math.sin(c.yaw) * step;
          c.at.z += Math.cos(c.yaw) * step;
          moving = 1;
        } else {
          c.state = "drink";
          c.until = now + rand(7, 14);
          // The camels reaching the water is the oasis done: the follow card's moment.
          shareResult.set("I grew an oasis in the desert and the camels came to drink, in Mirage");
          followPrompt.earn();
        }
      } else if (now > c.until) {
        if (c.state === "drink") {
          c.state = "idle";
          c.until = now + rand(6, 14);
        } else {
          const spots = h.shore.length ? h.shore : h.water;
          const pick = spots.length ? spots[Math.floor(Math.random() * spots.length)] : c.at;
          c.goal.copy(freeSpot(spots, pick, c.size, c));
          c.state = Math.random() < 0.6 ? "walk" : "idle";
          c.until = now + rand(5, 10);
        }
      }
      c.gait += delta * (moving ? (c.calf ? 1.35 : 0.9) * Math.PI * 2 : 0);
      c.head += ((c.state === "drink" ? 1 : 0) - c.head) * Math.min(1, delta * 1.2);
      c.at.y = c.ground;
      camelJoints(f, c, now, moving, joints);
      kinds.camel.pose(camelCount++, joints, f.x, c.size, c.tint);
      drawCamelFace(parts, c.size);
      lay(c.at.x, c.ground, c.at.z, c.yaw, 0.32 * c.size, 0.75 * c.size);
      if (moving && Math.sin(c.gait) > 0.97 && now > h.step) {
        h.step = now + 0.25;
        const near = c.at.distanceTo(new V(0, 0, 0)) < 7;
        if (near) sound.play("hoof", { gain: 0.05, pitch: c.calf ? 1.3 : 0.7 });
      }
    }

    // Birds high over the desert.
    for (const s of h.birds) {
      s.phase += (s.speed * delta) / Math.max(1, s.radius / 6);
      s.flap += delta * 9;
      const a = s.phase;
      const at = new V(s.centre.x + Math.cos(a) * s.radius, s.height + Math.sin(a * 3 + s.flap * 0.02) * 0.3, s.centre.z + Math.sin(a) * s.radius);
      const yaw = Math.atan2(-Math.sin(a), Math.cos(a)) + (s.speed < 0 ? Math.PI : 0);
      drawSkyBird(parts, f, at, yaw, s, now);
    }

    if (h.honk && now > h.honk) {
      h.honk = 0;
      sound.play("caw", { gain: 0.05, pitch: 1.5, pan: rand(-0.6, 0.6) });
      setTimeout(() => sound.play("caw", { gain: 0.04, pitch: 1.65, pan: rand(-0.6, 0.6) }), 260);
    }

    if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __herd: h });
    kinds.flamingo.show(flamingoCount);
    shadows.count = shadowCount;
    shadows.instanceMatrix.needsUpdate = true;
    kinds.camel.show(camelCount);
    mesh.count = parts.n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <primitive object={mesh} />
      <primitive object={kinds.flamingo.mesh} />
      <primitive object={kinds.camel.mesh} />
      <primitive object={shadows} />
    </>
  );
}

const WHITE = new THREE.Color(1, 1, 1);
const BLUSH = new THREE.Color(1, 0.8, 0.86);

// The skeletons, each bone a rod tapering between two joints, its colour, and how the skins are made from them.
function buildKinds(desert: Desert) {
  const flamingoBones: Bone[] = [
    { from: "tail", to: "rump", r0: 0.035, r1: 0.1, colour: PINK_PALE },
    { from: "rump", to: "breast", r0: 0.115, r1: 0.105, colour: PINK },
    { from: "breast", to: "n0", r0: 0.085, r1: 0.032, colour: PINK },
    { from: "wingL", to: "elbowL", r0: 0.06, r1: 0.05, colour: PINK_DEEP },
    { from: "wingR", to: "elbowR", r0: 0.06, r1: 0.05, colour: PINK_DEEP },
    { from: "elbowL", to: "quillL", r0: 0.035, r1: 0.012, colour: BLACK },
    { from: "elbowR", to: "quillR", r0: 0.035, r1: 0.012, colour: BLACK }
  ];
  for (let k = 0; k < NECK; k++) flamingoBones.push({ from: "n" + k, to: "n" + (k + 1), r0: 0.029 - k * 0.0008, r1: 0.028 - k * 0.0008, colour: PINK });
  flamingoBones.push(
    { from: "n" + NECK, to: "skull", r0: 0.027, r1: 0.034, colour: PINK },
    { from: "skull", to: "mid", r0: 0.02, r1: 0.014, colour: BILL },
    { from: "mid", to: "tip", r0: 0.013, r1: 0.005, colour: BLACK }
  );
  const restBird = { state: "wade", at: new V(), yaw: 0, walk: 0, tint: 0, lift: 0, flap: 0, size: 1 / 0.12, pitch: 0, bank: 0 } as unknown as Flamingo;
  const flamingoRest: Joints = {};
  drawFlamingo(new Parts(null as unknown as THREE.InstancedMesh), new Frame(), restBird, 0, flamingoRest);
  const flamingo = new Kind(desert, flamingoBones, flamingoRest, FLAMINGOS, 0.006, 0.025, "feather");

  const coat = (k: number) => new THREE.Color(k, k, k);
  const camelBones: Bone[] = [
    { from: "rump", to: "withers", r0: 0.18, r1: 0.2, colour: coat(1) },
    { from: "bellyBack", to: "bellyFront", r0: 0.17, r1: 0.22, colour: coat(1.06) },
    { from: "withers", to: "chest", r0: 0.17, r1: 0.16, colour: coat(1) },
    // One hump rising to a rounded peak a little behind the middle, steeper behind than before.
    { from: "humpBack", to: "humpTop", r0: 0.15, r1: 0.1, colour: coat(1.08) },
    { from: "humpTop", to: "humpFront", r0: 0.1, r1: 0.15, colour: coat(1.08) }
  ];
  for (const leg of ["lf", "rf", "lh", "rh"]) {
    const front = leg.endsWith("f");
    camelBones.push(
      { from: leg + "Top", to: leg + "Root", r0: front ? 0.1 : 0.13, r1: front ? 0.075 : 0.085, colour: coat(1) },
      { from: leg + "Root", to: leg + "Joint", r0: 0.06, r1: 0.04, colour: coat(0.95) },
      { from: leg + "Joint", to: leg + "Foot", r0: 0.034, r1: 0.027, colour: coat(0.82) },
      { from: leg + "Foot", to: leg + "ToeL", r0: 0.042, r1: 0.03, colour: coat(0.55) },
      { from: leg + "Foot", to: leg + "ToeR", r0: 0.042, r1: 0.03, colour: coat(0.55) },
      { from: leg + "Joint", to: leg + "Pad", r0: 0.04, r1: 0.04, colour: coat(front ? 0.62 : 0.85) },
      { from: leg + "Root", to: leg + "Muscle", r0: front ? 0.075 : 0.09, r1: front ? 0.06 : 0.07, colour: coat(0.98) }
    );
  }
  // Deep where it leaves the chest, slimming to the throat.
  for (let k = 0; k < CAMEL_NECK; k++) camelBones.push({ from: "n" + k, to: "n" + (k + 1), r0: 0.11 - k * 0.011, r1: 0.1 - k * 0.011, colour: coat(1) });
  camelBones.push(
    // A long narrow head: the skull, the long face to a soft, heavy muzzle, the brow, the jaw, the drooping lip.
    { from: "n" + CAMEL_NECK, to: "skull", r0: 0.05, r1: 0.052, colour: coat(1) },
    { from: "skull", to: "muzzle", r0: 0.044, r1: 0.04, colour: coat(1.06) },
    { from: "skull", to: "brow", r0: 0.04, r1: 0.034, colour: coat(0.95) },
    { from: "skull", to: "jaw", r0: 0.038, r1: 0.032, colour: coat(1.04) },
    { from: "muzzle", to: "lip", r0: 0.042, r1: 0.034, colour: coat(1.15) },
    { from: "chest", to: "chestPad", r0: 0.11, r1: 0.075, colour: coat(0.72) },
    { from: "n" + CAMEL_NECK, to: "earL", r0: 0.02, r1: 0.012, colour: coat(0.8) },
    { from: "n" + CAMEL_NECK, to: "earR", r0: 0.02, r1: 0.012, colour: coat(0.8) },
    { from: "tail0", to: "tail1", r0: 0.03, r1: 0.022, colour: coat(1) },
    { from: "tail1", to: "tail2", r0: 0.024, r1: 0.034, colour: coat(0.55) }
  );
  const restCamel = { at: new V(), yaw: 0, gait: 0, size: 1, head: 0, tint: CAMEL.clone(), calf: false } as unknown as Camel;
  const camelRest: Joints = {};
  camelJoints(new Frame(), restCamel, 0, 0, camelRest);
  const camel = new Kind(desert, camelBones, camelRest, CAMELS, 0.02, 0.07, "fur");
  return { flamingo, camel };
}

// A flamingo, about 1.2 units tall before its scale: long pink legs bending at the ankle (the knee is up in the body),
// a long S of neck, a heavy bent bill pale with a black tip, and wings of pink coverts over black flight feathers, shown
// only in flight. Flying, neck straight out ahead and legs trailing; wading, stepping slowly; feeding, the head down
// in the water upside down, sweeping; resting on one leg with the head laid back; preening.
function drawFlamingo(parts: Parts, f: Frame, b: Flamingo, now: number, joints: Joints) {
  const scale = 0.12 * b.size;
  const flying = b.state === "fly" && b.lift > 0.02;
  const pink = PINK.clone().lerp(PINK_DEEP, b.tint * 0.6);
  const pitch = flying ? b.pitch : 0;
  f.set(b.at, b.yaw, pitch, flying ? b.bank : 0, scale);
  const L = b.lift;

  // Legs: where each foot is, in the bird's frame; the body rises over them.
  const walking = b.state === "wade" || b.state === "stroll";
  const step = walking ? b.walk : 0;
  const stand = 0.62;
  const legs: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [];
  for (const side of [-1, 1]) {
    const phase = step + (side > 0 ? Math.PI : 0);
    const swing = Math.sin(phase);
    const lift = Math.max(0, Math.cos(phase)) * 0.12 * (walking ? 1 : 0);
    const hip = new V(side * 0.05, stand, -0.02);
    let foot = new V(side * 0.045, lift, swing * 0.14 * (walking ? 1 : 0));
    // Resting on one leg: the other drawn up, its foot tucked under the body.
    if (b.state === "rest" && side > 0) foot = new V(0.04, 0.42, 0.02);
    // In flight both legs trail straight back.
    foot.lerp(new V(side * 0.03, stand - 0.05, -0.68), L);
    const ankle = reach(hip, foot, 0.31, 0.33, new V(0, -0.2, -1));
    legs.push([f.p(hip.x, hip.y, hip.z), f.p(ankle.x, ankle.y, ankle.z), f.p(foot.x, foot.y, foot.z)]);
  }
  const legR = 0.012 * scale;
  for (const [hip, ankle, foot] of legs) {
    parts.bone(hip, ankle, legR, LEG);
    parts.bone(ankle, foot, legR * 0.85, LEG);
    parts.put(ankle, f.x, f.y, f.z, legR * 1.6, legR * 1.6, legR * 1.6, LEG);
    // The webbed foot, flat.
    if (!flying) parts.put(foot.clone().addScaledVector(f.z, 0.03 * scale), f.x, f.y, f.z, 0.03 * scale, 0.006 * scale, 0.045 * scale, LEG);
  }

  // Body: a deep oval, tapering to the tail behind, the breast fuller, all one with the neck in the skin.
  joints.tail = f.p(0, stand + 0.16, -0.36);
  joints.rump = f.p(0, stand + 0.12, -0.13);
  joints.breast = f.p(0, stand + 0.09, 0.1);
  // The folded wings, part of the same skin: deeper pink coverts along each flank, the black flight feathers just
  // showing at the tail. In flight they fold flat into the back, and the spread wings below take over.
  const tuck = flying ? 0.4 : 1;
  for (const [name, side] of [
    ["L", -1],
    ["R", 1]
  ] as const) {
    joints["wing" + name] = f.p(side * 0.075 * tuck, stand + 0.17, 0.08);
    joints["elbow" + name] = f.p(side * 0.07 * tuck, stand + 0.16, -0.2);
    joints["quill" + name] = f.p(side * 0.045 * tuck, stand + 0.15, -0.38);
  }

  // Neck: a smooth curve from the breast to the head, its shape set by the pose and eased from one pose to the next, so
  // the bird lowers its head to feed or lays it back to rest in one flowing movement rather than a jump.
  //  Standing or wading, an S held high. Feeding, the neck arches up and over and comes down in front, the head upside
  //  down with the bill in the water by its feet, sweeping side to side. Resting, the head laid back along the body.
  //  Preening, the neck turned round to the wing. Flying, straight out ahead.
  const base = new V(0, stand + 0.17, 0.14);
  const sway = Math.sin(now * 0.8 + b.tint * 9) * 0.03;
  const sweep = Math.sin(now * 2.2 + b.tint * 5) * 0.07;
  let wanted: THREE.Vector3[];
  let bill: THREE.Vector3;
  if (flying) {
    wanted = [new V(0, stand + 0.17, 0.4), new V(0, stand + 0.16, 0.65), new V(0, stand + 0.15, 0.9)];
    bill = new V(0, -0.25, 1);
  } else if (b.state === "feed") {
    wanted = [new V(0, stand + 0.36, 0.3), new V(sweep * 0.5, 0.42, 0.5), new V(sweep, 0.035, 0.42)];
    bill = new V(sweep * 2, -1, -0.45);
  } else if (b.state === "rest") {
    wanted = [new V(0, stand + 0.3, 0.12), new V(0.05, stand + 0.33, -0.04), new V(0.06, stand + 0.21, -0.1)];
    bill = new V(0.1, -0.25, -1);
  } else if (b.state === "preen") {
    const turn = Math.sin(now * 1.3);
    wanted = [new V(0, stand + 0.3, 0.16), new V(0.08 * turn, stand + 0.32, 0.02), new V(0.12 * turn, stand + 0.16, -0.08)];
    bill = new V(0.5 * turn, -0.6, -0.6);
  } else {
    const nod = Math.sin(b.walk) * 0.02;
    wanted = [new V(0, stand + 0.3, 0.26), new V(sway * 0.5, stand + 0.44, 0.06), new V(sway, stand + 0.58, 0.18 + nod)];
    bill = new V(0, -0.55, 1);
  }
  // Ease toward the pose; a bird seen for the first time takes it at once.
  const dt = b.seen === undefined ? 1 : Math.min(now - b.seen, 0.1);
  b.seen = now;
  const k = 1 - Math.exp(-dt * 2.6);
  if (!b.neck) b.neck = wanted.map((p) => p.clone());
  if (!b.billWay) b.billWay = bill.clone().normalize();
  b.neck.forEach((p, i) => p.lerp(wanted[i], dt >= 1 ? 1 : k));
  b.billWay.lerp(bill.normalize(), dt >= 1 ? 1 : k).normalize();
  const [P1, P2, P3] = b.neck;
  const points: THREE.Vector3[] = [];
  const SEG = NECK;
  for (let s = 0; s <= SEG; s++) {
    const t = s / SEG;
    const a = 1 - t;
    const q = new V()
      .addScaledVector(base, a * a * a)
      .addScaledVector(P1, 3 * a * a * t)
      .addScaledVector(P2, 3 * a * t * t)
      .addScaledVector(P3, t * t * t);
    points.push(f.p(q.x, q.y, q.z));
  }
  points.forEach((point, n) => (joints["n" + n] = point));

  // Head and bill: the bill held as the pose wants it, bending down at its middle, pale, black at the tip.
  const head = points[SEG];
  const billDir = f.d(b.billWay.x, b.billWay.y, b.billWay.z);
  const headFrame = new Frame();
  headFrame.o.copy(head);
  headFrame.z.copy(billDir);
  headFrame.x.crossVectors(f.y, billDir).normalize();
  headFrame.y.crossVectors(billDir, headFrame.x).normalize();
  const mid = head.clone().addScaledVector(billDir, 0.07 * scale);
  const tipDir = billDir.clone().applyAxisAngle(headFrame.x, 0.7).normalize();
  joints.skull = head.clone().addScaledVector(billDir, 0.012 * scale);
  joints.mid = mid;
  joints.tip = mid.clone().addScaledVector(tipDir, 0.055 * scale);
  for (const side of [-1, 1])
    parts.put(
      head
        .clone()
        .addScaledVector(headFrame.x, side * 0.026 * scale)
        .addScaledVector(billDir, 0.008 * scale),
      f.x,
      f.y,
      f.z,
      0.006 * scale,
      0.006 * scale,
      0.006 * scale,
      EYE
    );

  // Wings. Folded, a pink panel along each flank with the black tips just showing at the tail. Flying, three bones out
  // from the shoulder, beating: down hard, the forearm and hand folding in a little on the way back up.
  for (const side of [-1, 1]) {
    if (!flying) continue;
    const beat = Math.sin(b.flap);
    const brake = b.state === "fly" && b.lift < 0.9 ? 0.5 : 0;
    const raise = 0.15 + beat * 0.85 + brake * 0.4;
    const fold = Math.max(0, Math.cos(b.flap)) * 0.45;
    const shoulder = new V(side * 0.09, stand + 0.17, 0.08);
    const dir1 = new V(side * Math.cos(raise), Math.sin(raise), -0.15).normalize();
    const elbow = shoulder.clone().addScaledVector(dir1, 0.2);
    const dir2 = new V(side * Math.cos(raise - 0.1), Math.sin(raise - 0.1), 0.1 + fold * 0.6).normalize();
    const wrist = elbow.clone().addScaledVector(dir2, 0.24);
    const dir3 = new V(side * Math.cos(raise - 0.25 - fold * 0.5), Math.sin(raise - 0.25 - fold * 0.5), -0.25 - fold * 0.8).normalize();
    const hand = wrist.clone().addScaledVector(dir3, 0.3);
    const [S, E, W, H] = [shoulder, elbow, wrist, hand].map((p) => f.p(p.x, p.y, p.z));
    const up = new V().crossVectors(new V().subVectors(W, S), f.z).normalize().multiplyScalar(side);
    // The arm and forearm, with their pink coverts and black secondaries trailing behind.
    parts.blade(S, E, up, 0.09 * scale, 0.012 * scale, pink);
    parts.blade(E, W, up, 0.1 * scale, 0.012 * scale, pink);
    const back = f.z.clone().multiplyScalar(-0.1 * scale);
    parts.blade(E.clone().add(back), W.clone().add(back), up, 0.07 * scale, 0.008 * scale, BLACK);
    parts.blade(S.clone().add(back), E.clone().add(back), up, 0.06 * scale, 0.008 * scale, BLACK);
    // The hand: black primaries, fanned and parted at their tips.
    for (let k = 0; k < 6; k++) {
      const spread = (k / 5 - 0.5) * 0.5;
      const tipAt = new V()
        .subVectors(H, W)
        .applyAxisAngle(up, spread * side)
        .add(W);
      parts.blade(W, tipAt, up, 0.022 * scale, 0.006 * scale, BLACK);
    }
    parts.blade(W, H.clone().lerp(W, 0.35), up, 0.06 * scale, 0.01 * scale, pink);
  }
}

// Where the head points, for the face drawn over it: set by camelJoints for the camel it last posed.
const face = { head: new V(), snout: new V(), up: new V(), side: new V() };
const CAMEL_EYE = C("#1a120d");
const NOSE = C("#3a2a1e");
const _e = new V();
const _f = new V();
// The face, too fine for the skin's grid: dark eyes under the brow on each side, set back on the head; slit nostrils at
// the top of the muzzle; the line of the mouth along the side of the long lower lip.
function drawCamelFace(parts: Parts, size: number) {
  const { head, snout, up, side } = face;
  const at = (out: number, rise: number, across: number, into = _e) =>
    into
      .copy(head)
      .addScaledVector(snout, out * size)
      .addScaledVector(up, rise * size)
      .addScaledVector(side, across * size);
  for (const s of [-1, 1]) {
    // A dark eye, wider than tall, looking out and a little forward, under its heavy lid; a third of the way down the long
    // head, clear of the swelling where the neck, ears and brow blend.
    const facing = _f.copy(side).multiplyScalar(s).addScaledVector(snout, 0.35).normalize();
    parts.put(at(0.125, 0.026, s * 0.056), snout, up, facing, 0.02 * size, 0.014 * size, 0.012 * size, CAMEL_EYE);
    parts.put(at(0.123, 0.039, s * 0.053), snout, up, facing, 0.024 * size, 0.007 * size, 0.012 * size, CAMEL_DARK);
    // A nostril, a slit angled up and back on the muzzle's top.
    const slit = _f
      .copy(snout)
      .addScaledVector(side, -s * 0.5)
      .normalize();
    parts.put(at(0.34, 0.022, s * 0.03), slit, up, side, 0.016 * size, 0.005 * size, 0.008 * size, NOSE);
    // The mouth: a thin dark line along the lip, curving down a little at its corner.
    parts.bone(at(0.37, -0.062, s * 0.034), at(0.24, -0.07, s * 0.044, _f), 0.0045 * size, NOSE);
  }
}

// A dromedary, about 2 units tall at the hump before its scale (a calf a little over half that): a deep barrel of a
// body with one hump, a long neck dipping low from the chest and rising to the head, long thin legs with thick thighs
// and broad pads, all one skin. It paces, both legs on a side swinging together, in long slow strides, rolling as it
// goes; the knees of the forelegs and the hocks of the hind fold and straighten; the head nods with each stride, the
// tail swishes. Drinking, the neck reaches down to the water.
function camelJoints(f: Frame, c: Camel, now: number, moving: number, joints: Joints) {
  const roll = Math.sin(c.gait) * 0.05 * moving;
  f.set(c.at, c.yaw, 0, roll, c.size);
  const top = 1.0;
  const bob = Math.abs(Math.cos(c.gait)) * 0.025 * moving;
  const legs: [string, number, number, boolean][] = [
    ["lf", -0.12, 0.36, true],
    ["rf", 0.12, 0.36, true],
    ["lh", -0.13, -0.4, false],
    ["rh", 0.13, -0.4, false]
  ];
  for (const [name, x, z, front] of legs) {
    // Long, slow strides: the foot planted and the body passing over it, then lifted high and swung far forward.
    const phase = c.gait + (x < 0 ? 0 : Math.PI);
    const along = Math.sin(phase) * STRIDE * moving;
    const lift = Math.pow(Math.max(0, Math.cos(phase)), 1.5) * 0.17 * moving;
    const root = new V(x, top - bob, z);
    const foot = new V(x * 0.85, 0.035 + lift, z + along);
    const joint = reach(root, foot, 0.5, 0.5, front ? new V(0, 0.1, 1) : new V(0, 0.1, -1));
    joints[name + "Top"] = f.p(x, top + 0.17 - bob, z * 0.95);
    joints[name + "Root"] = f.p(root.x, root.y, root.z);
    joints[name + "Joint"] = f.p(joint.x, joint.y, joint.z);
    joints[name + "Foot"] = f.p(foot.x, foot.y, foot.z);
    // Two broad toes on a soft pad, and a hard callus on the front knee.
    joints[name + "ToeL"] = f.p(foot.x - 0.028, foot.y - 0.012, foot.z + 0.085);
    joints[name + "ToeR"] = f.p(foot.x + 0.028, foot.y - 0.012, foot.z + 0.085);
    joints[name + "Pad"] = f.p(joint.x, joint.y, joint.z + (front ? 0.03 : -0.02));
    // The gaskin and forearm muscle, swelling the upper leg below the body.
    const mid = new V().lerpVectors(root, joint, 0.35);
    joints[name + "Muscle"] = f.p(mid.x, mid.y, mid.z + (front ? 0.01 : -0.02));
  }
  // The barrel, belly, chest and hump.
  // The rump falls away behind the hump toward the tail.
  joints.rump = f.p(0, top + 0.1 - bob, -0.5);
  joints.withers = f.p(0, top + 0.2 - bob, 0.34);
  // The belly tucks up toward the hind legs, deepest behind the forelegs.
  joints.bellyBack = f.p(0, top + 0.02 - bob, -0.28);
  joints.bellyFront = f.p(0, top - 0.08 - bob, 0.2);
  joints.chest = f.p(0, top - 0.06 - bob, 0.42);
  // The chest pad a camel kneels on.
  joints.chestPad = f.p(0, top - 0.2 - bob, 0.3);
  const jiggle = Math.sin(c.gait * 2) * 0.012 * moving;
  joints.humpBack = f.p(0, top + 0.26 - bob + jiggle * 0.5, -0.26);
  joints.humpTop = f.p(0, top + 0.47 - bob + jiggle, -0.06);
  joints.humpFront = f.p(0, top + 0.3 - bob + jiggle * 0.5, 0.16);
  // The neck: a curve from the chest, dipping forward and low, then up to the head; down to the water to drink.
  const nod = Math.sin(c.gait * 2) * 0.04 * moving;
  const look = Math.sin(now * 0.3 + c.tint.r * 20) * 0.25 * (1 - moving) * (1 - c.head);
  const P0 = new V(0, top + 0.2 - bob, 0.46);
  const P1 = new V(look * 0.3, top + 0.02 + nod, 0.78);
  const P2 = new V(look * 0.6, top + 0.36 + nod * 2, 0.98);
  const P3 = new V(look, top + 0.52 + nod * 2, 1.1);
  P1.lerp(new V(0, top * 0.4, 0.86), c.head);
  P2.lerp(new V(0, 0.16, 1.08), c.head);
  P3.lerp(new V(0, 0.08, 1.18), c.head);
  for (let k = 0; k <= CAMEL_NECK; k++) {
    const t = k / CAMEL_NECK;
    const a = 1 - t;
    const q = new V()
      .addScaledVector(P0, a * a * a)
      .addScaledVector(P1, 3 * a * a * t)
      .addScaledVector(P2, 3 * a * t * t)
      .addScaledVector(P3, t * t * t);
    joints["n" + k] = f.p(q.x, q.y, q.z);
  }
  // The head, long, the muzzle soft and drooping, small ears.
  const toward = new V().subVectors(joints["n" + CAMEL_NECK], joints["n" + (CAMEL_NECK - 1)]).normalize();
  const snout = toward
    .clone()
    .lerp(f.d(0, -0.6, 1), 0.6 - c.head * 0.2)
    .normalize();
  const head = joints["n" + CAMEL_NECK];
  const up = f.y.clone();
  joints.skull = head.clone().addScaledVector(snout, 0.09 * c.size);
  joints.muzzle = head.clone().addScaledVector(snout, 0.3 * c.size);
  // A heavy brow over the eyes, the jaw beneath, and the soft drooping lips with their split upper lip.
  joints.brow = head
    .clone()
    .addScaledVector(snout, 0.07 * c.size)
    .addScaledVector(up, 0.045 * c.size);
  joints.jaw = head
    .clone()
    .addScaledVector(snout, 0.18 * c.size)
    .addScaledVector(up, -0.055 * c.size);
  joints.lip = head
    .clone()
    .addScaledVector(snout, 0.36 * c.size)
    .addScaledVector(up, -0.045 * c.size);
  const side = new V().crossVectors(up, snout).normalize();
  face.head.copy(head);
  face.snout.copy(snout);
  face.up.copy(new V().crossVectors(snout, side).normalize());
  face.side.copy(side);
  joints.earL = head
    .clone()
    .addScaledVector(up, 0.08 * c.size)
    .addScaledVector(side, 0.05 * c.size);
  joints.earR = head
    .clone()
    .addScaledVector(up, 0.08 * c.size)
    .addScaledVector(side, -0.05 * c.size);
  // The tail, swishing.
  const swish = Math.sin(now * 1.7 + c.tint.g * 13) * 0.1;
  joints.tail0 = f.p(0, top + 0.18 - bob, -0.56);
  joints.tail1 = f.p(swish, top - 0.14, -0.62);
  joints.tail2 = f.p(swish * 1.3, top - 0.32, -0.6);
  return joints;
}

// A bird far up: a dark body and two long wings, beating and gliding by turns, banking into its turn.
function drawSkyBird(parts: Parts, f: Frame, at: THREE.Vector3, yaw: number, s: SkyBird, now: number) {
  const scale = 0.12 * s.size;
  f.set(at, yaw, 0, -0.35 * Math.sign(s.speed), scale);
  // Bouts of quick beats between long glides; on the downstroke the wing reaches out, on the upstroke the hand sweeps
  // back and in.
  const gliding = Math.sin(now * 0.4 + s.flap * 0.01) > 0.2;
  const beat = gliding ? 0.08 : Math.sin(s.flap);
  const tuck = gliding ? 0 : Math.max(0, Math.cos(s.flap)) * 0.35;
  // A slim body, tapering to the head ahead and the tail behind.
  parts.bone(f.p(0, 0, 0.16), f.p(0, 0, -0.12), 0.042 * scale, BIRD, 0.03 * scale);
  parts.put(f.p(0, 0.005, 0.18), f.x, f.y, f.z, 0.03 * scale, 0.03 * scale, 0.035 * scale, BIRD);
  for (const side of [-1, 1]) {
    // A long crescent of a wing: arm, forearm and a hand swept back to a point.
    const shoulder = f.p(side * 0.03, 0.01, 0.05);
    const elbow = f.p(side * 0.24, beat * 0.22, 0.04);
    const wrist = f.p(side * (0.45 - tuck * 0.12), beat * 0.42, -0.02 - tuck * 0.05);
    const tip = f.p(side * (0.7 - tuck * 0.25), beat * 0.55 - 0.03, -0.2 - tuck * 0.12);
    parts.blade(shoulder, elbow, f.y, 0.085 * scale, 0.01 * scale, BIRD);
    parts.blade(elbow, wrist, f.y, 0.075 * scale, 0.008 * scale, BIRD);
    parts.blade(wrist, tip, f.y, 0.045 * scale, 0.006 * scale, BIRD);
    // The forked tail.
    parts.blade(f.p(0, 0, -0.1), f.p(side * 0.06, 0, -0.3), f.y, 0.022 * scale, 0.005 * scale, BIRD);
  }
}
