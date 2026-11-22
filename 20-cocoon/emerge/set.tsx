"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  color,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  fract,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalLocal,
  normalMap,
  normalWorld,
  normalize,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  smoothstep,
  texture,
  uv,
  varying,
  vec2,
  vec3
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { useDispose } from "../../shared/engine/dispose";
import { sky } from "../../14-tension/backdrop";
import { KINDS, type Look, LOOKS, type Version } from "../../14-tension/versions";
import { mulberry32 } from "../../14-tension/web";
import { ON, dropSize, makeDrops, type Drop } from "./drops";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The tree round the branch: Tension's garden grown again for this view (its limbs are placed for the web there, and
// one of them crossed above the chrysalis here). A trunk off to the left that the branch comes out of, and heavy limbs
// low down and far behind, out of focus; nothing above the branch. Made as Tension's is, with the same scanned bark.

const v = (p: [number, number, number]) => new THREE.Vector3(...p);

type Limb = {
  points: THREE.Vector3[];
  from: number;
  to: number;
  twigs: number;
  leaves: number;
};
const LIMBS: Limb[] = [
  // The trunk, behind and to the left: the branch grows out of it.
  { points: [v([-5.6, -12, -4.2]), v([-5.4, -6, -3.9]), v([-5.25, -2.5, -3.7]), v([-5.2, -0.4, -3.6]), v([-5.3, 2.5, -3.8]), v([-5.7, 7, -4.4])], from: 0.75, to: 0.4, twigs: 0, leaves: 0 },
  // A low limb sweeping out under the view to the right, far behind.
  { points: [v([-5.2, -2.6, -3.7]), v([-3.2, -2.5, -3.2]), v([-0.8, -2.2, -2.9]), v([1.8, -1.75, -3.0]), v([4.4, -1.2, -3.5]), v([7.0, -0.4, -4.4])], from: 0.34, to: 0.07, twigs: 5, leaves: 4 },
  // Down and forward from it, under the eye.
  { points: [v([1.8, -1.75, -3.0]), v([2.9, -2.4, -1.6]), v([3.9, -3.4, 0.2])], from: 0.13, to: 0.03, twigs: 3, leaves: 3 },
  // Back and away to the left.
  { points: [v([-5.25, -1.4, -3.7]), v([-6.8, -0.6, -5.0]), v([-8.6, 0.6, -6.6])], from: 0.26, to: 0.07, twigs: 3, leaves: 2 },
  // Far behind on the right, rising out of view.
  { points: [v([5.2, -6, -6.5]), v([5.6, -2, -6.2]), v([6.3, 1.5, -6.4]), v([7.4, 5.5, -7.0])], from: 0.3, to: 0.14, twigs: 3, leaves: 3 }
];

const smoothstep01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
// Smooth value noise in three dimensions, for shaping on the CPU.
function makeNoise(seed: number) {
  const random = mulberry32(seed);
  const table = new Float32Array(512).map(() => random() * 2 - 1);
  const hash = (x: number, y: number, z: number) => table[(((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0) & 511];
  const fade = (t: number) => t * t * (3 - 2 * t);
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const u = fade(x - xi);
    const w = fade(y - yi);
    const t = fade(z - zi);
    const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz);
    return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), w), lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), w), t);
  };
}

// How much bark one copy of the scan covers, in scene units, so its fissures are the right size on a twig.
const TILE = 0.3;

// A limb along a curve: thinning from one end to the other, swelling at knots and where twigs fork from it, and
// rounding off at its tip. Its bark is the scan, wrapped round a whole number of times so it meets itself with no seam,
// and pushed in by the scan's own heights in proportion to how thick the limb is there (aRadius).
function barkTube(curve: THREE.Curve<THREE.Vector3>, from: number, to: number, seed: number, swellings: number[], fine: number) {
  const noise = makeNoise(seed);
  const length = curve.getLength();
  // All of this tree but its trunk lies far behind the plane of focus, drawn as blur: its limbs and twigs carry half
  // the rings and fewer sides than they would need in focus. The trunk keeps its own.
  const steps = Math.min(420, Math.max(16, Math.round((length / (from > 0.2 ? 0.01 : 0.02)) * fine)));
  const sides = Math.max(8, Math.round((from > 0.2 ? 64 : from > 0.03 ? 28 : from > 0.012 ? 16 : 10) * fine));
  const frames = curve.computeFrenetFrames(steps, false);
  const position: number[] = [];
  const normal: number[] = [];
  const radius: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const n = new THREE.Vector3();
  // Turned a different way on each limb, so no two show the same stretch of bark.
  const offset = noise(seed, 1, 2) * 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const at = curve.getPointAt(t);
    const s = t * length;
    let r = from + (to - from) * t ** 0.75;
    for (const k of swellings) r *= 1 + 0.35 * Math.exp(-((((t - k) * length) / (r * 2.5)) ** 2));
    r *= 1 + 0.07 * noise(s * 3, 0, seed);
    if (t > 0.985) r *= Math.sqrt(Math.max(0, (1 - t) / 0.015));
    const around = Math.max(1, Math.round((2 * Math.PI * r) / TILE));
    // A trunk is never round: shallow flutes and bulges that run down it, wandering.
    const stout = Math.min(1, Math.max(0, (from - 0.2) / 0.2));
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      n.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a));
      const lobed = 1 + stout * (0.09 * noise(Math.cos(a) * 1.3 + 5, Math.sin(a) * 1.3, s * 0.18 + seed) + 0.035 * Math.sin(a * 4 + noise(s * 0.3, 2, seed) * 5));
      position.push(at.x + n.x * r * lobed, at.y + n.y * r * lobed, at.z + n.z * r * lobed);
      normal.push(n.x, n.y, n.z);
      radius.push(r);
      uvs.push((j / sides) * around, s / TILE + offset);
    }
  }
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      // Wound so that the outside is the front (Tension's own are wound the other way, and show their far wall).
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("aRadius", new THREE.Float32BufferAttribute(radius, 1));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}

// A bud at a twig's tip: a pointed cone of scales.
function budGeometry() {
  const g = new THREE.ConeGeometry(1, 3, 10, 4);
  g.translate(0, 1.5, 0);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 3;
    const swell = Math.sin(Math.PI * Math.min(1, y * 1.3)) * 0.6 + 0.4;
    p.setXYZ(i, p.getX(i) * swell, p.getY(i), p.getZ(i) * swell);
  }
  g.computeVertexNormals();
  return g;
}

// A leaf: a plane folded along its midrib and curled at the tip; its outline, teeth, veins and bites are in the shader.
function leafGeometry() {
  const geometry = new THREE.PlaneGeometry(1, 1, 18, 8);
  const p = geometry.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + 0.5;
    const y = p.getY(i) * 0.9;
    p.setXYZ(i, x, y, Math.abs(y) * 0.28 - x * x * 0.16 + Math.sin(x * 9 + y * 3) * 0.008);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// The bark scan (CC0, Poly Haven: bark_brown_02; see public/assets/14-tension/CREDITS.txt), finer on bigger screens.
type Scans = { colour: THREE.Texture; normal: THREE.Texture; height: THREE.Texture; rough: THREE.Texture };
function loadScans(fine: number): Scans {
  const size = fine < 0.75 ? "1k" : "2k";
  const load = (name: string, colour: boolean) => {
    const t = new THREE.TextureLoader().load(`/assets/14-tension/bark_brown_02_${name}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  return { colour: load(`diff_${size}`, true), normal: load(`nor_gl_${size}`, false), height: load("disp_1k", false), rough: load("rough_1k", false) };
}

// The tree's shapes, the same in every weather: grown once, and dressed by the version's materials.
function grow(fine: number) {
  const random = mulberry32(31);
  const bark: THREE.BufferGeometry[] = [];
  const leafGeo = leafGeometry();
  const budGeo = budGeometry();
  const geometries: THREE.BufferGeometry[] = [leafGeo, budGeo];
  const leaves: { at: THREE.Vector3; along: THREE.Vector3; size: number }[] = [];
  const tips: { at: THREE.Vector3; along: THREE.Vector3; r: number }[] = [];
  const drops: Drop[] = [];
  const dewNoise = makeNoise(77);

  // How many times twigs fork again: twice on a big screen, once on a phone.
  const depth = fine < 0.75 ? 1 : 2;
  // A twig from a point, heading roughly one way and wandering as it grows, thinning to a bud, and forking into up to
  // three smaller twigs of its own, each turned off it by thirty to sixty degrees.
  const twig = (start: THREE.Vector3, heading: THREE.Vector3, r: number, length: number, level: number, seed: number) => {
    const dir = heading.clone();
    // Never up into the view above the branch.
    if (start.y > -1.2) dir.y -= 0.6;
    dir.normalize();
    const points = [start.clone()];
    for (let p = 1; p <= 5; p++) {
      dir.add(new THREE.Vector3(random() - 0.5, random() * 0.35, random() - 0.5).multiplyScalar(0.3)).normalize();
      if (points[p - 1].y > -0.9 && dir.y > -0.1) dir.y -= 0.3;
      points.push(points[p - 1].clone().addScaledVector(dir.normalize(), length / 5));
    }
    const curve = new THREE.CatmullRomCurve3(points);
    const end = Math.max(0.0018, r * 0.22);
    const forks = level < depth ? Array.from({ length: 1 + Math.floor(random() * 3) }, () => 0.25 + random() * 0.6).sort() : [];
    const g = barkTube(curve, r, end, seed, [0.02, ...forks], fine * (level ? 0.6 : 0.8));
    geometries.push(g);
    bark.push(g);
    tips.push({ at: curve.getPointAt(1), along: curve.getTangentAt(1), r: end });
    forks.forEach((t, n) => {
      const along = curve.getTangentAt(t);
      // Off to one side of the parent, by thirty to sixty degrees.
      const side = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).cross(along).normalize();
      const turn = 0.5 + random() * 0.5;
      const heading = along.clone().multiplyScalar(Math.cos(turn)).addScaledVector(side, Math.sin(turn)).add(new THREE.Vector3(0, 0.15, 0));
      twig(curve.getPointAt(t), heading, (r + (end - r) * t) * 0.62, length * (0.45 + random() * 0.25), level + 1, seed * 3 + n + 1);
    });
    // Leaves toward the ends of the finest twigs.
    if (level === depth || random() < 0.4) leaves.push({ at: curve.getPointAt(0.7 + random() * 0.25), along: curve.getTangentAt(0.85), size: 0.16 + random() * 0.16 });
  };

  LIMBS.forEach((limb, li) => {
    const curve = new THREE.CatmullRomCurve3(limb.points, false, "centripetal");
    const forks = Array.from({ length: limb.twigs }, () => 0.12 + random() * 0.8).sort();
    const knots = Array.from({ length: 2 }, () => 0.1 + random() * 0.8);
    // The trunk swells into a collar wherever a limb leaves it: the two low limbs, and the branch the chrysalis hangs on.
    const collars = li === 0 ? [0.495, 0.56, 0.612] : [];
    const geometry = barkTube(curve, limb.from, limb.to, 100 + li, [...forks, ...knots, ...collars], fine);
    if (li === 0) {
      // Climbers: two thin vines winding up the trunk, close against the bark, with a few small leaves.
      for (let vine = 0; vine < 2; vine++) {
        const points: THREE.Vector3[] = [];
        const turns = 1.6 + vine * 0.7;
        const t0 = 0.4 + vine * 0.04;
        const t1 = 0.78 - vine * 0.06;
        for (let k = 0; k <= 26; k++) {
          const f = k / 26;
          const t = t0 + (t1 - t0) * f;
          const a = vine * 2.4 + f * turns * Math.PI * 2 + Math.sin(f * 9 + vine) * 0.25;
          let r = limb.from + (limb.to - limb.from) * t ** 0.75;
          for (const c of collars) r *= 1 + 0.35 * Math.exp(-((((t - c) * curve.getLength()) / (r * 2.5)) ** 2));
          const at = curve.getPointAt(t);
          points.push(at.add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(r * 1.13 + 0.035)));
        }
        const climber = new THREE.CatmullRomCurve3(points, false, "centripetal");
        const g = barkTube(climber, 0.034 - vine * 0.008, 0.012, 700 + vine, [0.3, 0.62], fine * 0.6);
        geometries.push(g);
        bark.push(g);
        for (let k = 0; k < 7; k++) {
          const t = 0.08 + random() * 0.9;
          leaves.push({ at: climber.getPointAt(t), along: climber.getTangentAt(t).add(new THREE.Vector3(random() - 0.5, 0.2, 0.9)), size: 0.12 + random() * 0.1 });
        }
      }
    }
    // Dew on it: beads caught in the bark, more of them low on each limb and on the side toward the eye. Taken from
    // the limb's own points, so each rides the bark where the bark is.
    if (li < 2) {
      const p = geometry.getAttribute("position");
      const nn = geometry.getAttribute("normal");
      const rr = geometry.getAttribute("aRadius");
      const uu = geometry.getAttribute("uv");
      const want = Math.round((li === 0 ? 260 : 90) * fine);
      for (let k = 0, tries = 0; k < want && tries < want * 30; tries++) {
        const v = Math.floor(random() * p.count);
        const y = p.getY(v);
        if (li === 0 && (y < -3.4 || y > 3.6)) continue;
        const normal = new THREE.Vector3(nn.getX(v), nn.getY(v), nn.getZ(v));
        // Seen from the front, in patches.
        if (normal.z < -0.2) continue;
        const patch = dewNoise(p.getX(v) * 2.4, y * 1.3, p.getZ(v) * 2.4);
        if (random() > 0.12 + 0.75 * Math.max(0, patch - 0.42) * 3) continue;
        const under = normal.y < -0.45;
        const r = dropSize(random, li === 0 ? 1.5 : 1.2);
        drops.push({
          at: new THREE.Vector3(p.getX(v), y, p.getZ(v)),
          up: under ? new THREE.Vector3(0, 1, 0) : normal,
          r,
          flat: under ? 1.2 : 0.62 + random() * 0.18,
          on: ON.bark,
          period: under && r > 0.02 ? 16 + random() * 30 : 0,
          bark: [uu.getX(v), uu.getY(v), rr.getX(v) * (0.35 - 0.22 * smoothstep01((rr.getX(v) - 0.12) / 0.26))]
        });
        k++;
      }
    }
    geometries.push(geometry);
    bark.push(geometry);
    tips.push({
      at: curve.getPointAt(1),
      along: curve.getTangentAt(1),
      r: limb.to
    });
    // Side twigs out from the limb, each forking again into smaller ones, away from the web's face and a little up.
    forks.forEach((t, k) => {
      const at = curve.getPointAt(t);
      const r = (limb.from + (limb.to - limb.from) * t ** 0.75) * 0.5;
      const away = new THREE.Vector3(random() - 0.5, 0.1, random() - 0.6).normalize().multiplyScalar(0.8).addScaledVector(curve.getTangentAt(t), random() - 0.3);
      // A heavy limb puts out branches, not twigs: the thicker, the longer.
      twig(at, away, r, (0.3 + random() * 0.5) * Math.max(1, r / 0.03), 0, 200 + li * 37 + k * 5);
    });
    for (let k = 0; k < limb.leaves; k++) {
      const t = 0.1 + random() * 0.85;
      const at = curve.getPointAt(t);
      leaves.push({
        at,
        along: curve.getTangentAt(t),
        size: 0.25 + random() * 0.22
      });
    }
  });

  // Buds at every tip, and leaves on short stalks, each turned its own way, behind the web.
  const place = (at: THREE.Vector3, turn: THREE.Quaternion, size: number) => new THREE.Matrix4().compose(at, turn, new THREE.Vector3(size, size, size));
  const buds = tips.map((tip) => place(tip.at, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.along), Math.max(0.004, tip.r * 1.3)));
  const leafAt = leaves.map((l) => {
    const turn = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(1, 0, 0),
      l.along
        .clone()
        .add(new THREE.Vector3(random() - 0.5, random() - 0.2, -0.8))
        .normalize()
    );
    turn.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (random() - 0.5) * 2.4));
    return place(l.at, turn, l.size);
  });
  return {
    bark,
    leafGeo,
    budGeo,
    buds,
    leafAt,
    drops,
    geometries: [...geometries, ...bark]
  };
}

// What it is made of in one version's weather.
// `detail` off leaves the trunk with only the scan, as the twigs have: for measuring what its own bark costs.
function dress(look: Look, scans: Scans, detail = true) {
  const wet = look.air === "rain";

  // Bark: the scan, its colour tinted to the version's light, its heights pushing the surface in, its normals for the
  // fine relief and its roughness for where it shines. On top: lichen on the upper side, a wet
  // darkening and sheen in the storm.
  // (Its mirror shine turned down when dry, or every furrow's edge catches the backlight as a pale line.)
  const bark = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.9, specularIntensity: wet ? 0.8 : 0.25 });
  const scan = uv() as any;
  const height = texture(scans.height, scan).r as any;
  // (Less on a trunk: pushed as far as a twig's bark is for its size, its coarser mesh breaks into spikes at the edge.)
  const push = mix(float(0.35), float(0.13), smoothstep(0.12, 0.38, attribute("aRadius", "float"))) as any;
  bark.positionNode = positionLocal.add(normalLocal.mul(height.sub(0.75).mul(attribute("aRadius", "float")).mul(push))) as any;
  bark.normalNode = Fn(() => {
    const flatness = mossy.mul(0.8).oneMinus() as any;
    const n0 = normalMap(detail ? mix(texture(scans.normal, scan), texture(scans.normal, scan2), other) : texture(scans.normal, scan), vec2(2, 2).mul(flatness)) as any;
    if (!detail) return n0;
    // The furrows cut in, and the moss stands out in cushions: by the slope of their height across the screen.
    const relief = furrow.mul(wet ? -0.03 : -0.05).add(mossy.mul(tuft.mul(0.012).add(0.02))) as any;
    const dpdx = dFdx(positionView) as any;
    const dpdy = dFdy(positionView) as any;
    const r1 = cross(dpdy, n0) as any;
    const r2 = cross(n0, dpdx) as any;
    const det = dot(dpdx, r1) as any;
    const grad = r1.mul(dFdx(relief)).add(r2.mul(dFdy(relief))).mul(det.sign()) as any;
    return normalize(n0.mul(det.abs()).sub(grad).add(n0.mul(1e-6)));
  })() as any;
  const deep = smoothstep(0.55, 0.15, height) as any;
  const N = normalWorld as any;
  // A trunk and heavy limbs are more than the scan wound round them: at that size the scan repeats, so there a second
  // stretch of it is mixed in by patches, and the trunk's own bark is drawn over both: deep irregular furrows running
  // down it and winding, flat plates between them, dark streaks where water runs, moss on the damp side toward the
  // eye and thick at the collars, pale crusts of lichen.
  const stout = (detail ? smoothstep(0.12, 0.38, attribute("aRadius", "float")) : float(0)) as any;
  const P = positionLocal as any;
  // (The slow-changing ones are worked out at the trunk's points and carried across its faces: they vary over many
  // points' width, so nothing is lost, and each pixel of trunk is spared six noises. The fine ones stay per pixel.)
  const atPoints = (node: any) => (varying as any)(node) as any;
  const wander = (detail ? atPoints(mx_noise_float(P.mul(vec3(0.9, 0.45, 0.9)))) : float(0)) as any;
  const scan2 = scan.mul(vec2(0.41, 0.33)).add(vec2(0.13, 0.57)).add(wander.mul(0.15)) as any;
  const other = (detail ? smoothstep(-0.25, 0.3, atPoints(mx_noise_float(P.mul(1.6).add(vec3(4, 1, 8))))).mul(stout) : float(0)) as any;
  const split = (detail ? mx_fractal_noise_float(vec3(P.x.mul(5.5).add(wander.mul(3.5)), P.y.mul(0.5), P.z.mul(5.5).sub(wander.mul(3))), 2, 2, 0.5) : float(0)) as any;
  const furrow = (detail ? smoothstep(0.13, 0.0, split.abs()).mul(stout) : float(0)) as any;
  const plate = (detail ? smoothstep(0.15, 0.5, split.abs()).mul(stout) : float(0)) as any;
  const streak = (detail ? smoothstep(0.05, 0.5, atPoints(mx_noise_float(vec3(P.x.mul(4.5), P.y.mul(0.22), P.z.mul(4.5)).add(vec3(9, 2, 5))))).mul(stout) : float(0)) as any;
  const damp = N.z.mul(0.55).add(N.x.mul(0.3)).add(0.1) as any;
  const mossy = (
    detail
      ? smoothstep(0.12, 0.42, atPoints(mx_fractal_noise_float(P.mul(vec3(1.9, 1.1, 1.9)), 2, 2, 0.55)).add(damp.mul(0.3)).sub(0.12))
          .mul(furrow.mul(0.4).oneMinus())
          .mul(stout)
      : float(0)
  ) as any;
  const tuft = (detail ? mx_noise_float(P.mul(210)).mul(0.5).add(0.5) : float(0)) as any;
  const facingUp = smoothstep(-0.3, 0.7, N.y.add(N.z.mul(0.35))) as any;
  // The scan's own colour: the version's light does the rest.
  let wood: any = (detail ? mix(texture(scans.colour, scan).rgb, texture(scans.colour, scan2).rgb, other) : texture(scans.colour, scan).rgb).mul(1.1);
  wood = mix(wood, mix(color("#6b5d4c"), color("#8a7c68"), atPoints(mx_noise_float(P.mul(vec3(2.3, 0.8, 2.3)))).mul(0.5).add(0.5)).mul(height.mul(0.6).add(0.55)), plate.mul(0.4));
  wood = wood.mul(furrow.mul(-0.72).add(1)).mul(streak.mul(-0.3).add(1));
  // Crusts of pale lichen on the plates.
  const crusted = (detail ? smoothstep(0.5, 0.62, mx_noise_float(P.mul(5.2).add(vec3(1, 6, 3)))).mul(plate).mul(mossy.oneMinus()) : float(0)) as any;
  wood = mix(wood, mix(color("#8f9a80"), color("#b9bea0"), tuft), crusted.mul(0.55));
  // Lichen: grey-green rosettes on the upper side, and pale crust dots, never down in the cracks.
  const patch = smoothstep(0.2, 0.36, mx_fractal_noise_float(positionLocal.mul(14), 3, 2, 0.55).add(facingUp.mul(0.25)).sub(0.15)) as any;
  const lobes = smoothstep(0.0, 0.25, mx_noise_float(positionLocal.mul(90))) as any;
  wood = mix(wood, mix(color("#7d8a6c"), color("#a9b494"), lobes).mul(height.mul(0.5).add(0.6)), patch.mul(deep.oneMinus()).mul(0.75));
  wood = mix(wood, mix(color("#243310"), color("#6f8c2a"), tuft.mul(mossy.mul(0.6).add(0.4))), mossy.mul(0.92));
  if (wet) wood = wood.mul(0.55);
  bark.colorNode = wood;
  // (A furrow is the darkest and dullest part of bark: nothing shines or glows down in it.)
  const rough = mix(texture(scans.rough, scan).r, float(1), max(mossy.mul(0.9), furrow)) as any;
  // (Wet, a trunk is dark and dull in its furrows, not a mirror.)
  bark.roughnessNode = (wet ? mix(rough.mul(0.45), rough.mul(0.8), stout) : rough) as any;
  // Backlit, the edge of a twig glows with the fine fuzz and lichen on it.
  bark.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const rim = pow(dot(normalize(normalWorld), V).abs().oneMinus(), 4) as any;
    const backlit = sky.light.mul(
      rim
        .mul(pow(max(dot(V.negate(), sky.toLight), 0), 2))
        .mul(sky.power)
        .mul(stout.mul(0.16).add(0.06))
        .mul(furrow.oneMinus())
    ) as any;
    // A trunk in the shade is still lit: by the sky it faces and by the green thrown up from the garden.
    const facingSky = smoothstep(-0.6, 0.8, normalize(normalWorld).y) as any;
    const bounce = wood.mul(mix(sky.blots[1], sky.horizon, facingSky)).mul(stout).mul(0.36) as any;
    return backlit.add(bounce);
  })() as any;

  // Leaves.
  const leafMaterial = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: look.spider === "golden" ? 0.38 : 0.6
  });
  leafMaterial.alphaTest = 0.5;
  const lx = uv().x as any;
  const ly = uv().y.sub(0.5).mul(2) as any;
  const teeth = fract(lx.mul(26)).sub(0.5).abs().mul(0.08) as any;
  const half = pow(lx.mul(Math.PI).sin().max(0), 0.75)
    .mul(float(1).sub(lx.mul(0.25)))
    .mul(0.95)
    .sub(teeth) as any;
  const inside = smoothstep(0.02, -0.02, ly.abs().sub(half)) as any;
  // Insect bites, different on every leaf by where it hangs.
  const bites = smoothstep(0.62, 0.6, mx_noise_float(vec3(lx.mul(7), ly.mul(4), positionWorld.x.mul(3).add(positionWorld.y.mul(5))))) as any;
  leafMaterial.opacityNode = inside.mul(bites) as any;
  const midrib = smoothstep(0.035, 0.0, ly.abs()) as any;
  const veins = smoothstep(
    0.06,
    0.0,
    fract(lx.mul(8).sub(ly.abs().mul(2.2)))
      .sub(0.5)
      .abs()
  ).mul(smoothstep(0.05, 0.2, ly.abs())) as any;
  const edgeBrown = smoothstep(0.75, 1, ly.abs().div(half.max(0.01))).mul(
    mx_noise_float(vec3(lx.mul(5), ly.mul(5), 3))
      .mul(0.5)
      .add(0.5)
  ) as any;
  let leaf: any = mix(color(look.leaf) as any, (color(look.leaf) as any).mul(vec3(1.25, 1.2, 0.8)), lx);
  leaf = leaf.mul(
    mx_fractal_noise_float(vec3(lx.mul(12), ly.mul(12), 1), 3, 2, 0.5)
      .mul(0.18)
      .add(1)
  );
  leaf = mix(leaf, leaf.mul(1.45).add(0.04), midrib.max(veins.mul(0.6)));
  leaf = mix(leaf, color("#8a6a30"), edgeBrown.mul(0.7));
  leafMaterial.colorNode = leaf;
  // Lit from behind, a leaf glows through, its veins dark against it.
  leafMaterial.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const through = pow(max(dot(V, sky.toLight.negate()), 0), 3) as any;
    return leaf
      .mul(sky.light)
      .mul(sky.power)
      .mul(through.mul(0.4).add(0.03))
      .mul(float(1).sub(midrib.max(veins).mul(0.5)));
  })() as any;

  const budMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.55 });
  budMaterial.colorNode = mix(color("#5a3a22"), color("#8a6a3a"), smoothstep(0, 3, positionLocal.y)) as any;

  return { bark, leafMaterial, budMaterial };
}

// The tree once, dressed for every web up front so that changing web is only a matter of which is shown, and one set of
// lights whose colours change with it, since a new light would rebuild every lit shader.
export function Tree({ version, fine = 1 }: { version: Version; fine?: number }) {
  const look = LOOKS[version];
  const shapes = useMemo(() => grow(fine), [fine]);
  const scans = useMemo(() => loadScans(fine), [fine]);
  const dressed = useMemo(() => KINDS.map((v) => dress(LOOKS[v], scans)), [scans]);
  // In development, for measuring: `window.__scene = { trunk: false }` draws the tree with the scan alone, and
  // `{ dew: false }` hides every drop (here and on the branch).
  const plain = useRef<THREE.Material[] | null>(null);
  useFrame(() => {
    const flags = (globalThis as { __scene?: { trunk?: boolean; dew?: boolean } }).__scene;
    dew.mesh.visible = flags?.dew !== false;
    const simple = flags?.trunk === false;
    if (simple && !plain.current) plain.current = KINDS.map((v) => dress(LOOKS[v], scans, false).bark);
    groups.forEach((group, i) => {
      const mesh = group.children[0] as THREE.Mesh;
      const want = simple && plain.current ? plain.current[i] : dressed[i].bark;
      if (mesh.material !== want) mesh.material = want;
    });
  });
  useDispose(scans.colour, scans.normal, scans.height, scans.rough);
  // Three draws for each: every limb and twig merged into one, and the buds and leaves each instanced.
  const merged = useMemo(() => mergeGeometries(shapes.bark), [shapes]);
  const groups = useMemo(
    () =>
      dressed.map((materials) => {
        const group = new THREE.Group();
        group.add(new THREE.Mesh(merged, materials.bark));
        const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material, at: THREE.Matrix4[]) => {
          const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, at.length));
          at.forEach((m, i) => mesh.setMatrixAt(i, m));
          mesh.count = at.length;
          mesh.computeBoundingSphere();
          group.add(mesh);
        };
        instanced(shapes.budGeo, materials.budMaterial, shapes.buds);
        instanced(shapes.leafGeo, materials.leafMaterial, shapes.leafAt);
        return group;
      }),
    [shapes, dressed, merged]
  );
  const dew = useMemo(() => makeDrops(shapes.drops, { detail: fine < 0.75 ? 1 : 2, height: scans.height, mid: 0.75 }), [shapes, scans, fine]);
  useDispose(dew.geometry, dew.geometry2, dew.material);
  useDispose(merged);
  useDispose(...shapes.geometries);
  useDispose(...dressed.flatMap((m) => [m.bark, m.leafMaterial, m.budMaterial]));

  const sun = useMemo(() => new THREE.Vector3(...look.toLight).normalize().multiplyScalar(10), [look]);
  return (
    <>
      {groups.map((group, i) => (
        <primitive key={KINDS[i]} object={group} visible={KINDS[i] === version} />
      ))}
      <primitive object={dew.mesh} />
      <directionalLight position={sun.toArray()} intensity={look.lightPower * 1.4} color={look.light} />
      {/* Fill from the front, so the bark is seen and not only its backlit rim. */}
      <directionalLight position={[1.5, 2, 6]} intensity={1.3} color={look.horizon} />
      <hemisphereLight color={look.zenith} groundColor={look.blots[1]} intensity={1.4} />
    </>
  );
}
