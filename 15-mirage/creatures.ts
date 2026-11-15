import * as THREE from "three/webgpu";
import { abs, attribute, dot, float, Fn, fract, instancedArray, instanceIndex, int, max, mix, mx_noise_float, normalize, positionWorld, smoothstep, varying, vec3, vec4 } from "three/tsl";
import type { Desert } from "./desert";
import { world } from "./render";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Creatures with one smooth skin. A creature is a skeleton of bones, each a rounded rod tapering from one radius to
// another. Once, at load, the rods are blended into a single surface, as metaballs blend (a smooth union of their
// distance fields), and that surface is meshed. Each point of the mesh then rides the two bones nearest it, blended,
// so the skin bends at the joints instead of breaking into separate pieces. Every frame the processor works out where
// each bone of each creature is, and the vertex shader moves the skin; all creatures of a kind are one draw.

const V = THREE.Vector3;

export type Bone = { from: string; to: string; r0: number; r1: number; colour: THREE.Color };
export type Joints = Record<string, THREE.Vector3>;

// Distance from p to a rod from a to b whose radius tapers from r0 to r1.
function rod(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number) {
  const ab = _ab.subVectors(b, a);
  const ap = _ap.subVectors(p, a);
  const t = Math.min(Math.max(ap.dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0), 1);
  const dx = ap.x - ab.x * t;
  const dy = ap.y - ab.y * t;
  const dz = ap.z - ab.z * t;
  return { d: Math.sqrt(dx * dx + dy * dy + dz * dz) - (r0 + (r1 - r0) * t), t };
}
const _ab = new V();
const _ap = new V();

// A smooth union: near where two rods meet they swell into each other.
const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

// Meshes the blended rods by surface nets: a vertex in each grid cell the surface passes through, at the mean of its
// crossings, joined into quads across each crossing edge.
function skin(bones: Bone[], joints: Joints, cell: number, blend: number) {
  const box = new THREE.Box3();
  for (const b of bones) {
    const r = Math.max(b.r0, b.r1) + blend + cell * 2;
    box.expandByPoint(joints[b.from].clone().addScalar(-r)).expandByPoint(joints[b.from].clone().addScalar(r));
    box.expandByPoint(joints[b.to].clone().addScalar(-r)).expandByPoint(joints[b.to].clone().addScalar(r));
  }
  const nx = Math.ceil((box.max.x - box.min.x) / cell) + 1;
  const ny = Math.ceil((box.max.y - box.min.y) / cell) + 1;
  const nz = Math.ceil((box.max.z - box.min.z) / cell) + 1;
  const ends = bones.map((b) => [joints[b.from], joints[b.to]] as const);
  const field = (p: THREE.Vector3) => {
    let d = 1e9;
    for (let k = 0; k < bones.length; k++) d = smin(d, rod(p, ends[k][0], ends[k][1], bones[k].r0, bones[k].r1).d, blend);
    return d;
  };
  const values = new Float32Array(nx * ny * nz);
  const p = new V();
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        p.set(box.min.x + x * cell, box.min.y + y * cell, box.min.z + z * cell);
        values[(z * ny + y) * nx + x] = field(p);
      }
  const at = (x: number, y: number, z: number) => values[(z * ny + y) * nx + x];
  const index = new Int32Array(nx * ny * nz).fill(-1);
  const positions: number[] = [];
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1]
  ];
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7]
  ];
  for (let z = 0; z < nz - 1; z++)
    for (let y = 0; y < ny - 1; y++)
      for (let x = 0; x < nx - 1; x++) {
        const v = corners.map(([a, b, c]) => at(x + a, y + b, z + c));
        if (v.every((s) => s > 0) || v.every((s) => s <= 0)) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [i, j] of edges) {
          if (v[i] > 0 === v[j] > 0) continue;
          const t = v[i] / (v[i] - v[j]);
          sx += corners[i][0] + (corners[j][0] - corners[i][0]) * t;
          sy += corners[i][1] + (corners[j][1] - corners[i][1]) * t;
          sz += corners[i][2] + (corners[j][2] - corners[i][2]) * t;
          n++;
        }
        index[(z * ny + y) * nx + x] = positions.length / 3;
        positions.push(box.min.x + (x + sx / n) * cell, box.min.y + (y + sy / n) * cell, box.min.z + (z + sz / n) * cell);
      }
  const triangles: number[] = [];
  const cellAt = (x: number, y: number, z: number) => index[(z * ny + y) * nx + x];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) triangles.push(a, c, b, a, d, c);
    else triangles.push(a, b, c, a, c, d);
  };
  for (let z = 1; z < nz - 1; z++)
    for (let y = 1; y < ny - 1; y++)
      for (let x = 1; x < nx - 1; x++) {
        const inside = at(x, y, z) <= 0;
        if (inside !== at(x + 1, y, z) <= 0) quad(cellAt(x, y - 1, z - 1), cellAt(x, y, z - 1), cellAt(x, y, z), cellAt(x, y - 1, z), !inside);
        if (inside !== at(x, y + 1, z) <= 0) quad(cellAt(x - 1, y, z - 1), cellAt(x - 1, y, z), cellAt(x, y, z), cellAt(x, y, z - 1), !inside);
        if (inside !== at(x, y, z + 1) <= 0) quad(cellAt(x - 1, y - 1, z), cellAt(x, y - 1, z), cellAt(x, y, z), cellAt(x - 1, y, z), !inside);
      }
  // Each quad wound so its front faces out of the creature, toward where the field is positive.
  // Normals from the field's slope, so the blended skin shades smoothly.
  const normals: number[] = [];
  const e = cell * 0.5;
  const q = new V();
  for (let k = 0; k < positions.length; k += 3) {
    q.set(positions[k], positions[k + 1], positions[k + 2]);
    const gx = field(q.clone().setX(q.x + e)) - field(q.clone().setX(q.x - e));
    const gy = field(q.clone().setY(q.y + e)) - field(q.clone().setY(q.y - e));
    const gz = field(q.clone().setZ(q.z + e)) - field(q.clone().setZ(q.z - e));
    const n = new V(gx, gy, gz).normalize();
    normals.push(n.x, n.y, n.z);
  }
  // How shut in each point is, from how soon the field closes back in a little way out along its normal: deep in the
  // folds (armpits, under the neck, between the legs) it darkens.
  const shut: number[] = [];
  for (let k = 0; k < positions.length; k += 3) {
    q.set(positions[k], positions[k + 1], positions[k + 2]);
    const n = new V(normals[k], normals[k + 1], normals[k + 2]);
    let occluded = 0;
    for (const step of [1.5, 3, 6]) {
      const d = cell * step;
      occluded += Math.max(0, d - field(q.clone().addScaledVector(n, d))) / d / step;
    }
    shut.push(Math.max(0.35, 1 - occluded * 1.1));
  }
  return { positions, normals, triangles, shut };
}

// A frame for a bone: its start, its length's direction and a side, from a hint.
function boneFrame(a: THREE.Vector3, b: THREE.Vector3, hint: THREE.Vector3, scale: number, stretch: number, out: THREE.Matrix4) {
  const y = new V().subVectors(b, a).normalize();
  let x = new V().crossVectors(y, hint);
  if (x.lengthSq() < 1e-6) x = new V().crossVectors(y, new V(0, 0, 1));
  x.normalize();
  const z = new V().crossVectors(x, y);
  return out.makeBasis(x.multiplyScalar(scale), y.multiplyScalar(scale * stretch), z.multiplyScalar(scale)).setPosition(a);
}

// A kind of creature: its mesh, made once from its skeleton at rest, and a buffer of every bone's move for every one
// of them, written each frame.
export class Kind {
  bones: Bone[];
  rest: Joints;
  restInverse: THREE.Matrix4[];
  restLength: number[];
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicNodeMaterial;
  moves: any;
  tints: any;
  max: number;
  private m = new THREE.Matrix4();
  private side = new V();

  constructor(desert: Desert, bones: Bone[], rest: Joints, limit: number, cell: number, blend: number, pattern: "fur" | "feather") {
    this.bones = bones;
    this.rest = rest;
    this.max = limit;
    const made = skin(bones, rest, cell, blend);
    const B = bones.length;
    // Each point rides the two bones nearest its surface, more of the nearer; and takes its colour from them.
    const count = made.positions.length / 3;
    const ride = new Float32Array(count * 4);
    const colours = new Float32Array(count * 3);
    const p = new V();
    for (let k = 0; k < count; k++) {
      p.set(made.positions[k * 3], made.positions[k * 3 + 1], made.positions[k * 3 + 2]);
      let best = -1;
      let next = -1;
      let dBest = 1e9;
      let dNext = 1e9;
      for (let i = 0; i < B; i++) {
        const d = rod(p, rest[bones[i].from], rest[bones[i].to], bones[i].r0, bones[i].r1).d;
        if (d < dBest) {
          next = best;
          dNext = dBest;
          best = i;
          dBest = d;
        } else if (d < dNext) {
          next = i;
          dNext = d;
        }
      }
      const spread = blend * 0.6;
      const wNext = next < 0 ? 0 : Math.exp(-(dNext - dBest) / spread);
      const w = 1 / (1 + wNext);
      ride[k * 4] = best;
      ride[k * 4 + 1] = next < 0 ? best : next;
      ride[k * 4 + 2] = w;
      const c = bones[best].colour.clone().lerp(bones[next < 0 ? best : next].colour, 1 - w);
      const ao = made.shut[k];
      colours[k * 3] = c.r * ao;
      colours[k * 3 + 1] = c.g * ao;
      colours[k * 3 + 2] = c.b * ao;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.Float32BufferAttribute(made.positions, 3));
    this.geometry.setAttribute("normal", new THREE.Float32BufferAttribute(made.normals, 3));
    this.geometry.setAttribute("ride", new THREE.Float32BufferAttribute(ride, 4));
    this.geometry.setAttribute("tone", new THREE.Float32BufferAttribute(colours, 3));
    this.geometry.setIndex(made.triangles);
    this.restInverse = bones.map((b) => boneFrame(rest[b.from], rest[b.to], RIGHT, 1, 1, new THREE.Matrix4()).invert());
    this.restLength = bones.map((b) => rest[b.from].distanceTo(rest[b.to]));

    this.moves = instancedArray(limit * B * 4, "vec4");
    this.tints = instancedArray(limit, "vec4");
    const material = new THREE.MeshBasicNodeMaterial({ fog: false });
    const ride4 = attribute("ride", "vec4") as any;
    const rest4 = attribute("position", "vec3") as any;
    const restNormal = attribute("normal", "vec3") as any;
    const moved = (bone: any, v: any, w: any) => {
      const base = int(instanceIndex).mul(B).add(int(bone)).mul(4) as any;
      const c0 = this.moves.element(base) as any;
      const c1 = this.moves.element(base.add(1)) as any;
      const c2 = this.moves.element(base.add(2)) as any;
      const c3 = this.moves.element(base.add(3)) as any;
      return c0.xyz.mul(v.x).add(c1.xyz.mul(v.y)).add(c2.xyz.mul(v.z)).add(c3.xyz.mul(w));
    };
    material.positionNode = moved(ride4.x, rest4, float(1))
      .mul(ride4.z)
      .add(moved(ride4.y, rest4, float(1)).mul(float(1).sub(ride4.z))) as any;
    const normal = varying(
      normalize(
        moved(ride4.x, restNormal, float(0))
          .mul(ride4.z)
          .add(moved(ride4.y, restNormal, float(0)).mul(float(1).sub(ride4.z)))
          .add(vec3(0, 1e-5, 0))
      )
    ) as any;
    const tint = varying(this.tints.element(instanceIndex).xyz) as any;
    const tone = varying(attribute("tone", "vec3")) as any;
    const at = varying(attribute("position", "vec3")) as any;
    material.colorNode = Fn(() => {
      const n = normalize(normal).toVar();
      const sun = world.sun.mul(world.power) as any;
      const facing = max(dot(n, world.toSun), float(0)) as any;
      const wrap = max(dot(n, world.toSun).add(0.4).div(1.4), float(0)) as any;
      const shade = desert.palmShade(positionWorld.xz) as any;
      const sky = mix(world.horizon, world.zenith, n.y.mul(0.5).add(0.5)) as any;
      const bounce = (world.sand as any).mul(sun).mul(float(0.5).sub(n.y.mul(0.5)).mul(0.3)) as any;
      // The coat, drawn from where each point sits on the creature at rest, so it moves with it: fur in fine streaks
      // that run down the body, mottled in soft patches, a little shaggier and darker over the hump, neck and thighs;
      // or feathers, lying in overlapping rows, each a shade paler at its edge.
      let coat: any;
      if (pattern === "fur") {
        const streak = mx_noise_float(at.mul(vec3(90, 14, 90)))
          .mul(0.5)
          .add(0.5) as any;
        const mottle = mx_noise_float(at.mul(5)).mul(0.5).add(0.5) as any;
        const shag = smoothstep(0.9, 1.35, at.y) as any;
        coat = float(0.86)
          .add(streak.mul(0.18))
          .mul(mix(float(0.92), float(1.06), mottle))
          .mul(float(1).sub(shag.mul(0.12)));
      } else {
        const rows = fract(
          at.z
            .mul(-38)
            .add(abs(at.x).mul(20))
            .add(mx_noise_float(at.mul(30)).mul(0.4))
        ) as any;
        coat = float(0.9).add(smoothstep(0.55, 1, rows).mul(0.14));
      }
      const albedo = tone.mul(tint).mul(coat) as any;
      return vec4(
        albedo.mul(
          sun
            .mul(mix(facing, wrap, 0.4))
            .mul(shade)
            .mul(0.95)
            .add(sky.mul(0.5))
            .add(bounce)
        ),
        1
      );
    })() as any;
    this.material = material;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  // Poses creature `index` from its joints in the world, scaled by `scale`; `right` is its right-hand direction.
  pose(index: number, joints: Joints, right: THREE.Vector3, scale: number, tint: THREE.Color) {
    const B = this.bones.length;
    const moves = this.moves.value.array as Float32Array;
    for (let i = 0; i < B; i++) {
      const b = this.bones[i];
      const a = joints[b.from];
      const z = joints[b.to];
      const stretch = a.distanceTo(z) / Math.max(this.restLength[i] * scale, 1e-6);
      boneFrame(a, z, right, scale, stretch, this.m).multiply(this.restInverse[i]);
      moves.set(this.m.elements, (index * B + i) * 16);
    }
    const tints = this.tints.value.array as Float32Array;
    tints[index * 4] = tint.r;
    tints[index * 4 + 1] = tint.g;
    tints[index * 4 + 2] = tint.b;
    this.side.copy(right);
  }

  // After posing: draw this many, and send the moves up.
  show(count: number) {
    this.mesh.count = count;
    this.moves.value.needsUpdate = true;
    this.tints.value.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
const RIGHT = new V(1, 0, 0);
