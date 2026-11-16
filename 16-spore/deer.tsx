"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, abs, cameraPosition, dot, normalWorld, normalize, positionWorld, pow, vec3 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { giantLight, groundAt } from "./world";

// Deer out in the dark among the trees, seen only as black shapes against the mist and the giants' glow. Each is drawn
// from stretched spheres, one draw for the herd, posed on the processor every frame: a real deer's walk, four beats,
// left hind, left fore, right hind, right fore, each hoof planted and left behind as the body passes over it, the hind
// leg's hock and the fore leg's knee folding as it swings through; the head nodding twice a stride. They stop to graze,
// lift their heads to look about, flick an ear or a tail, and wander on.

const V = THREE.Vector3;
const UP = new V(0, 1, 0);
const _a = new V();
const _b = new V();
const _c = new V();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new V();

const MAX_PARTS = 64 * 12;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const angleTo = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

type Deer = {
  at: THREE.Vector3;
  yaw: number;
  goal: THREE.Vector3;
  state: "walk" | "graze" | "look";
  until: number;
  phase: number;
  size: number;
  buck: boolean;
  head: number;
  look: number;
  lookWanted: number;
  ear: number;
  tail: number;
  move: number;
};

// A frame on the deer: x to its right, y up, z ahead, in metres at its size.
class Frame {
  o = new V();
  x = new V();
  y = new V(0, 1, 0);
  z = new V();
  k = 1;
  set(at: THREE.Vector3, yaw: number, k: number) {
    this.o.copy(at);
    this.z.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.x.set(this.z.z, 0, -this.z.x);
    this.k = k;
  }
  p(x: number, y: number, z: number, out = new V()) {
    return out
      .copy(this.o)
      .addScaledVector(this.x, x * this.k)
      .addScaledVector(this.y, y * this.k)
      .addScaledVector(this.z, z * this.k);
  }
}

// Where the middle joint of a two-part limb goes, reaching from `a` to `c` with segments of these lengths, bending
// toward `bend`.
function reach(a: THREE.Vector3, c: THREE.Vector3, l1: number, l2: number, bend: THREE.Vector3) {
  const d = _a.subVectors(c, a);
  const len = Math.min(d.length(), l1 + l2 - 1e-4);
  const dir = d.normalize();
  const x = (l1 * l1 - l2 * l2 + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const side = _b.copy(bend).addScaledVector(dir, -bend.dot(dir)).normalize();
  return new V().copy(a).addScaledVector(dir, x).addScaledVector(side, h);
}

export function Deer({ count }: { count: number }) {
  const { mesh, geometry, material } = useMemo(() => {
    const geometry = new THREE.IcosahedronGeometry(1, 2);
    const material = new THREE.MeshBasicNodeMaterial({ fog: false });
    // Black, but for the faintest edge of the giants' light where it comes through the fur from behind.
    material.colorNode = Fn(() => {
      const V = normalize(cameraPosition.sub(positionWorld)) as any;
      const rim = pow(abs(dot(normalize(normalWorld), V)).oneMinus(), 4) as any;
      return vec3(0.004, 0.005, 0.007).add(giantLight().mul(rim).mul(0.35));
    })() as any;
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_PARTS);
    mesh.frustumCulled = false;
    mesh.count = 0;
    return { mesh, geometry, material };
  }, []);
  const herd = useMemo(() => {
    const deer: Deer[] = [];
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const r = rand(7, 12);
      deer.push({
        at: new V(Math.cos(a) * r, 0, Math.sin(a) * r),
        yaw: rand(0, Math.PI * 2),
        goal: new V(),
        state: "look",
        until: rand(0, 4),
        phase: rand(0, 1),
        size: i === 0 ? 1.08 : i === count - 1 && count > 3 ? 0.7 : rand(0.88, 1),
        buck: i === 0 || i === 4,
        head: 0,
        look: 0,
        lookWanted: 0,
        ear: 0,
        tail: 0,
        move: 0
      });
    }
    return deer;
  }, [count]);

  useFrame((state, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const now = state.clock.elapsedTime;
    let n = 0;
    const put = (at: THREE.Vector3, along: THREE.Vector3, r1: number, r2: number, length: number) => {
      if (n >= MAX_PARTS) return;
      _q.setFromUnitVectors(UP, _c.copy(along).normalize());
      _m.compose(at, _q, _s.set(r1, length, r2));
      mesh.setMatrixAt(n++, _m);
    };
    // A rounded limb or neck from a to b, of these radii.
    const bone = (a: THREE.Vector3, b: THREE.Vector3, r: number) => {
      const d = new V().subVectors(b, a);
      const length = d.length();
      if (length < 1e-5) return;
      put(new V().addVectors(a, b).multiplyScalar(0.5), d, r, r, length / 2 + r * 0.6);
    };
    const blob = (at: THREE.Vector3, along: THREE.Vector3, w: number, h: number, l: number) => put(at, along, w, h, l);
    const f = new Frame();

    for (const d of herd) {
      // Choosing what to do next: graze a while, look about, or walk on to somewhere else round the clearing.
      if (now > d.until) {
        if (d.state === "walk") {
          d.state = Math.random() < 0.65 ? "graze" : "look";
          d.until = now + (d.state === "graze" ? rand(4, 9) : rand(2, 4));
        } else {
          d.state = "walk";
          const a = Math.atan2(d.at.z, d.at.x) + rand(-0.9, 0.9);
          const r = rand(6.5, 12.5);
          d.goal.set(Math.cos(a) * r, 0, Math.sin(a) * r);
          d.until = now + 30;
        }
        d.lookWanted = rand(-0.7, 0.7);
      }
      const walking = d.state === "walk";
      if (walking) {
        const to = _a.set(d.goal.x - d.at.x, 0, d.goal.z - d.at.z);
        if (to.length() < 0.4) d.until = now;
        d.yaw += angleTo(d.yaw, Math.atan2(to.x, to.z)) * Math.min(1, delta * 0.8);
      }
      d.move += ((walking ? 1 : 0) - d.move) * Math.min(1, delta * 1.5);
      // A stride a little under a second; each hoof travels back as far as the body goes forward while it is down, so
      // it never slides.
      const freq = 0.95;
      const speed = 0.85 * d.size * d.move;
      d.phase += delta * freq * d.move;
      d.at.x += Math.sin(d.yaw) * speed * delta;
      d.at.z += Math.cos(d.yaw) * speed * delta;
      d.at.y = groundAt(d.at.x, d.at.z) - 0.01;
      // The head: down to graze, up to walk or look, turned now and then, with an ear flick and a tail flick here and there.
      d.head += ((d.state === "graze" ? 1 : 0) - d.head) * Math.min(1, delta * 1.1);
      if (Math.random() < delta * 0.25) d.lookWanted = rand(-0.7, 0.7);
      d.look += ((d.state === "walk" ? 0 : d.lookWanted) - d.look) * Math.min(1, delta * 2);
      d.ear = Math.random() < delta * 0.5 ? 1 : d.ear * Math.exp(-delta * 8);
      d.tail = Math.random() < delta * 0.3 ? 1 : d.tail * Math.exp(-delta * 5);

      const k = d.size;
      f.set(d.at, d.yaw, k);
      const p = d.phase;
      const bob = Math.cos(p * Math.PI * 4) * 0.012 * d.move;
      const stance = 0.62;
      const stride = ((speed / Math.max(freq, 1e-3)) * stance * 0.5) / k + 0.0001;
      // A direction on the deer: ahead, tipped up (or down) by `up`.
      const tip = (up: number, out = new V()) => out.copy(f.z).addScaledVector(f.y, up).normalize();
      // Body, a doe's proportions at about 0.95 m to the withers: a deep ribcage behind the shoulders, the belly tucked
      // up toward the flank, a level back rising a little at the withers, and a rounded rump over the hind legs.
      const y0 = bob;
      // Every part's top sits on the one line of the back, so the outline runs smooth from withers to tail.
      blob(f.p(0, 0.78 + y0, -0.04), f.z, 0.145 * k, 0.16 * k, 0.36 * k);
      blob(f.p(0, 0.74 + y0, 0.19), tip(-0.08), 0.15 * k, 0.2 * k, 0.24 * k);
      blob(f.p(0, 0.79 + y0, -0.3), tip(0.08), 0.135 * k, 0.15 * k, 0.19 * k);
      blob(f.p(0, 0.69 + y0, -0.06), f.z, 0.12 * k, 0.07 * k, 0.3 * k);
      blob(f.p(0, 0.87 + y0, 0.26), tip(-0.15), 0.07 * k, 0.075 * k, 0.2 * k);
      blob(f.p(0, 0.7 + y0, 0.28), tip(-0.6), 0.1 * k, 0.12 * k, 0.15 * k);
      // Legs, long and fine. Fore: the shoulder blade sloping down to the elbow tucked under the chest, then forearm and
      // cannon folding forward at the knee. Hind: the thigh down and forward to the stifle, the gaskin back to the hock,
      // and the long cannon standing near upright under it.
      const legs: [number, number, number, boolean][] = [
        [-0.1, 0.0, 0.3, true],
        [0.1, 0.5, 0.3, true],
        [-0.09, 0.75, -0.36, false],
        [0.09, 0.25, -0.36, false]
      ];
      for (const [x, offset, z, front] of legs) {
        const t = (((p + offset) % 1) + 1) % 1;
        let along: number;
        let lift = 0;
        if (t < stance) along = stride * (1 - (2 * t) / stance);
        else {
          const s = (t - stance) / (1 - stance);
          along = stride * (-1 + 2 * (s * s * (3 - 2 * s)));
          lift = Math.sin(s * Math.PI) * 0.13 * d.move;
        }
        const hoof = f.p(x * 0.85, 0.025 + lift, z + along);
        hoof.y = Math.max(hoof.y, groundAt(hoof.x, hoof.z) + 0.025 * k);
        // The fetlock just above the hoof, a touch behind it; the pastern sloped.
        const fetlock = new V()
          .copy(hoof)
          .addScaledVector(f.y, 0.07 * k)
          .addScaledVector(f.z, -0.025 * k - lift * 0.25);
        if (front) {
          const withers = f.p(x * 0.6, 0.9 + y0, z - 0.08);
          const elbow = f.p(x, 0.54 + y0, z - 0.05);
          const knee = reach(elbow, fetlock, 0.25 * k, 0.22 * k, f.z);
          bone(withers, elbow, 0.05 * k);
          blob(new V().lerpVectors(withers, elbow, 0.5).addScaledVector(f.z, -0.04 * k), new V().subVectors(elbow, withers), 0.06 * k, 0.06 * k, 0.15 * k);
          bone(elbow, knee, 0.03 * k);
          blob(new V().lerpVectors(elbow, knee, 0.3), new V().subVectors(knee, elbow), 0.038 * k, 0.042 * k, 0.09 * k);
          bone(knee, fetlock, 0.017 * k);
        } else {
          const hip = f.p(x, 0.84 + y0, z + 0.04);
          // The cannon leans back from the hock while the hoof is down, and swings under as the leg folds to step.
          const hock = new V()
            .copy(fetlock)
            .addScaledVector(f.y, 0.27 * k)
            .addScaledVector(f.z, (-0.035 + lift * 0.9) * k);
          const stifle = reach(hip, hock, 0.3 * k, 0.31 * k, f.z);
          blob(new V().lerpVectors(hip, stifle, 0.45), new V().subVectors(stifle, hip), 0.085 * k, 0.12 * k, 0.2 * k);
          bone(stifle, hock, 0.028 * k);
          blob(new V().lerpVectors(stifle, hock, 0.28), new V().subVectors(hock, stifle), 0.042 * k, 0.065 * k, 0.11 * k);
          bone(hock, fetlock, 0.018 * k);
        }
        bone(fetlock, hoof, 0.016 * k);
        blob(new V().copy(hoof).addScaledVector(f.z, 0.006 * k), tip(-1.2), 0.016 * k, 0.014 * k, 0.026 * k);
      }
      // Neck and head: the neck deep where it leaves the chest and tapering to the throat, carried up and forward,
      // nodding twice a stride when walking; down to the litter to graze.
      const nod = Math.sin(p * Math.PI * 4) * 0.025 * d.move;
      const g = d.head;
      const turn = d.look;
      const base = f.p(0, 0.84 + y0, 0.36);
      const upright = f.p(Math.sin(turn) * 0.18, 1.16 + nod + y0, 0.62 + Math.cos(turn) * 0.06);
      const down = f.p(Math.sin(turn) * 0.08, 0.3, 0.86);
      const skull = new V().lerpVectors(upright, down, g);
      const mid = new V()
        .lerpVectors(base, skull, 0.5)
        .addScaledVector(f.y, 0.03 * (1 - g) * k)
        .addScaledVector(f.z, 0.02 * k);
      // Seen from the side the neck is deep, the throat running down into the brisket and the crest into the withers.
      const neckDir = new V().subVectors(mid, base);
      blob(new V().lerpVectors(base, mid, 0.3), neckDir, 0.085 * k, 0.135 * k, 0.17 * k);
      blob(new V().lerpVectors(base, skull, 0.62), new V().subVectors(skull, base), 0.065 * k, 0.085 * k, 0.15 * k);
      bone(mid, skull, 0.058 * k);
      // The crest: the top of the neck running from the withers, so the neck always leaves the shoulders from above.
      bone(f.p(0, 0.9 + y0, 0.24), new V().lerpVectors(mid, skull, 0.3), 0.055 * k);
      // The head: a rounded crown tapering to a long muzzle, pointing ahead and down, nose to the ground when grazing.
      const facing = new V()
        .copy(f.z)
        .multiplyScalar(Math.cos(turn))
        .addScaledVector(f.x, Math.sin(turn))
        .addScaledVector(f.y, -0.5 - g * 1.6)
        .normalize();
      const nose = new V().copy(skull).addScaledVector(facing, 0.23 * k);
      blob(new V().copy(skull).addScaledVector(facing, 0.02 * k), facing, 0.064 * k, 0.072 * k, 0.085 * k);
      blob(new V().copy(skull).addScaledVector(facing, 0.12 * k), facing, 0.042 * k, 0.05 * k, 0.1 * k);
      // The jaw's line under the cheek, and the nose.
      blob(new V().copy(skull).addScaledVector(facing, 0.07 * k).addScaledVector(f.y, -0.03 * k), facing, 0.045 * k, 0.04 * k, 0.09 * k);
      blob(new V().copy(nose).addScaledVector(facing, -0.015 * k), facing, 0.026 * k, 0.03 * k, 0.03 * k);
      // Ears: big, set high at the back of the head, held up and out in a V, flicking.
      for (const s of [-1, 1]) {
        const flick = d.ear * 0.4 * s;
        const out = new V()
          .copy(f.x)
          .multiplyScalar(s * 0.75)
          .addScaledVector(f.y, 0.65 + flick)
          .addScaledVector(facing, -0.3)
          .normalize();
        const earAt = new V()
          .copy(skull)
          .addScaledVector(f.y, 0.035 * k)
          .addScaledVector(facing, -0.03 * k)
          .addScaledVector(out, 0.085 * k);
        blob(earAt, out, 0.034 * k, 0.01 * k, 0.08 * k);
      }
      // A buck's antlers: a main beam curving back, out and forward, with tines rising from it.
      if (d.buck) {
        for (const s of [-1, 1]) {
          const side = new V().copy(f.x).multiplyScalar(s);
          let at = new V()
            .copy(skull)
            .addScaledVector(f.y, 0.05 * k)
            .addScaledVector(side, 0.035 * k);
          const pts: THREE.Vector3[] = [at.clone()];
          const steps: [number, number, number][] = [
            [0.06, 0.1, -0.06],
            [0.08, 0.08, -0.02],
            [0.06, 0.04, 0.06],
            [0.02, 0.02, 0.09]
          ];
          for (const [o, u, a] of steps) {
            at = new V()
              .copy(at)
              .addScaledVector(side, o * k)
              .addScaledVector(f.y, u * k)
              .addScaledVector(facing, a * k)
              .addScaledVector(f.y, a * k * -0.2);
            pts.push(at);
          }
          for (let i = 0; i < pts.length - 1; i++) bone(pts[i], pts[i + 1], 0.012 * k * (1 - i * 0.15));
          for (let i = 1; i < 4; i++)
            bone(
              pts[i],
              new V()
                .copy(pts[i])
                .addScaledVector(f.y, (0.11 - i * 0.02) * k)
                .addScaledVector(facing, 0.01 * k),
              0.008 * k
            );
        }
      }
      // Tail: short, flicked up now and then.
      const tailBase = f.p(0, 0.89 + y0, -0.43);
      const tailDir = new V()
        .copy(f.z)
        .multiplyScalar(-0.3)
        .addScaledVector(f.y, -1 + d.tail * 1.4)
        .normalize();
      blob(new V().copy(tailBase).addScaledVector(tailDir, 0.09 * k), tailDir, 0.03 * k, 0.018 * k, 0.1 * k);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __deer: herd, __deerMesh: mesh });
  });
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}
