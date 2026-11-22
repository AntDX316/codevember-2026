import * as THREE from "three/webgpu";
import { abs, cos, dot, exp, float, Fn, instancedArray, instanceIndex, length, max, min, mix, select, sin, smoothstep, step, uniform, vec3, vec4 } from "three/tsl";
import { lehmer } from "../../shared/engine/random";
import type { QualityTier } from "../../shared/engine/types";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The sculpture: a head scan (Lee Perry-Smith, CC BY 3.0) sampled into points over its surface, and a wide drift of dust
// round it. Each point lives on the GPU: a compute pass each frame works out every ping's wavefront against it, snaps the
// head's points onto the surface as a front passes, lets them loosen back into dust, and works out how each is drawn.

// Where the scan's own units are brought to: about 2.3 tall from the collarbones to the crown, the head round the origin.
const SCALE = 0.3;
const LIFT = 1.55;
// How fast a ping's wavefront travels, in world units a second.
export const SPEED = 2.3;
// Up to this many wavefronts at once: pings and their echoes.
export const PINGS = 16;
// How far round the head the dust reaches.
const VOID = 7.5;
// How far each flat facet is bulged toward its corners' normals, and how deep the relief map cuts, in the scan's units.
const PHONG = 0.0;
const RELIEF = 0.35;

export const COUNTS: Record<QualityTier, { head: number; dust: number }> = {
  high: { head: 440000, dust: 60000 },
  medium: { head: 280000, dust: 42000 },
  low: { head: 130000, dust: 20000 }
};

type Scan = { position: Float32Array; normal: Float32Array; uv: Float32Array; index: Uint16Array | Uint32Array; relief: { data: Uint8ClampedArray; size: number } };

// The scan's fine relief (lips, eyelids, the folds of the ears), as a height map over its uvs, read once on the processor.
async function loadRelief(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  const bitmap = await createImageBitmap(await r.blob());
  const size = bitmap.width;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { data: context.getImageData(0, 0, size, size).data, size };
}

// The scan, with its hidden inner parts (mouth, sockets) already taken out (clean-head.py), read by hand: one mesh with
// positions, normals, uvs and indices is all this needs.
async function readGlb(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  const bytes = await r.arrayBuffer();
  const view = new DataView(bytes);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
  const binStart = 20 + jsonLength + 8;
  const read = (k: number) => {
    const a = json.accessors[k];
    const bv = json.bufferViews[a.bufferView];
    const at = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as string] ?? 1;
    if (a.componentType === 5126) return new Float32Array(bytes.slice(at, at + a.count * size * 4));
    if (a.componentType === 5125) return new Uint32Array(bytes.slice(at, at + a.count * size * 4));
    return new Uint16Array(bytes.slice(at, at + a.count * size * 2));
  };
  const p = json.meshes[0].primitives[0];
  return { position: read(p.attributes.POSITION) as Float32Array, normal: read(p.attributes.NORMAL) as Float32Array, uv: read(p.attributes.TEXCOORD_0) as Float32Array, index: read(p.indices) as Uint16Array };
}

let scan: Promise<Scan> | null = null;
export function loadScan() {
  if (scan) return scan;
  scan = Promise.all([readGlb("/assets/22-echo/dust/head.glb"), loadRelief("/assets/22-echo/dust/head-relief.jpg")]).then(([mesh, relief]) => ({ ...mesh, relief }));
  scan.catch(() => (scan = null));
  return scan;
}

const smooth = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Points over the scan's surface, evenly by area. Each triangle is bulged a little toward its corners' normals (Phong
// tessellation), so the scan's flat facets don't show as planes of dots. The shoulders thin out downward into nothing,
// and a share of the points lie in fine horizontal rows, as a scanner lays them.
function sampleHead(s: Scan, count: number, random: () => number) {
  const { position: P, normal: N, uv: T, index: I, relief } = s;
  // The relief map, bilinearly, 0 to 1.
  const height = (x: number, y: number) => {
    const n = relief.size;
    const fx = Math.min(n - 1.001, Math.max(0, x * n - 0.5));
    const fy = Math.min(n - 1.001, Math.max(0, y * n - 0.5));
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const at = (i: number, j: number) => relief.data[(j * n + i) * 4];
    const top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx;
    const bottom = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx;
    return (top * (1 - ty) + bottom * ty) / 255;
  };
  const tris = I.length / 3;
  const cdf = new Float64Array(tris);
  let total = 0;
  for (let t = 0; t < tris; t++) {
    const a = I[t * 3] * 3;
    const b = I[t * 3 + 1] * 3;
    const c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a];
    const uy = P[b + 1] - P[a + 1];
    const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a];
    const vy = P[c + 1] - P[a + 1];
    const vz = P[c + 2] - P[a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    // The shoulders count for less the lower they lie, so the budget goes to the face.
    const y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    total += 0.5 * Math.hypot(cx, cy, cz) * (0.04 + 0.96 * smooth(y, -3.2, 0.6));
    cdf[t] = total;
  }
  const home = new Float32Array(count * 4);
  const normal = new Float32Array(count * 4);
  const ROW = 0.024 / SCALE;
  let made = 0;
  let tries = 0;
  while (made < count && tries < count * 8) {
    tries++;
    const pick = random() * total;
    let lo = 0;
    let hi = tris - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < pick) lo = mid + 1;
      else hi = mid;
    }
    const a = I[lo * 3];
    const b = I[lo * 3 + 1];
    const c = I[lo * 3 + 2];
    const r1 = Math.sqrt(random());
    const r2 = random();
    const wa = 1 - r1;
    const wb = r1 * (1 - r2);
    const wc = r1 * r2;
    let px = wa * P[a * 3] + wb * P[b * 3] + wc * P[c * 3];
    let py = wa * P[a * 3 + 1] + wb * P[b * 3 + 1] + wc * P[c * 3 + 1];
    let pz = wa * P[a * 3 + 2] + wb * P[b * 3 + 2] + wc * P[c * 3 + 2];
    // Phong tessellation: the flat point pulled toward each corner's tangent plane, by its weight.
    let qx = 0;
    let qy = 0;
    let qz = 0;
    for (const [v, w] of [
      [a, wa],
      [b, wb],
      [c, wc]
    ]) {
      const nx = N[v * 3];
      const ny = N[v * 3 + 1];
      const nz = N[v * 3 + 2];
      const d = (px - P[v * 3]) * nx + (py - P[v * 3 + 1]) * ny + (pz - P[v * 3 + 2]) * nz;
      qx += w * (px - d * nx);
      qy += w * (py - d * ny);
      qz += w * (pz - d * nz);
    }
    px += (qx - px) * PHONG;
    py += (qy - py) * PHONG;
    pz += (qz - pz) * PHONG;
    let nx = wa * N[a * 3] + wb * N[b * 3] + wc * N[c * 3];
    let ny = wa * N[a * 3 + 1] + wb * N[b * 3 + 1] + wc * N[c * 3 + 1];
    let nz = wa * N[a * 3 + 2] + wb * N[b * 3 + 2] + wc * N[c * 3 + 2];
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // The relief, out along the normal: mid grey is the surface. Not on the eyes, whose uvs are all one point.
    const tu = wa * T[a * 2] + wb * T[b * 2] + wc * T[c * 2];
    const tv = wa * T[a * 2 + 1] + wb * T[b * 2 + 1] + wc * T[c * 2 + 1];
    const spanned = Math.abs((T[b * 2] - T[a * 2]) * (T[c * 2 + 1] - T[a * 2 + 1]) - (T[c * 2] - T[a * 2]) * (T[b * 2 + 1] - T[a * 2 + 1])) > 1e-9;
    if (spanned) {
      const lift = (height(tu, 1 - tv) - 0.5) * RELIEF;
      px += nx * lift;
      py += ny * lift;
      pz += nz * lift;
    }
    // A third of the points keep only to fine rows; the rest fill between them.
    if (made % 3 === 0) {
      const f = (((py / ROW) % 1) + 1) % 1;
      if (Math.abs(f - 0.5) > 0.11) continue;
    }
    home.set([px * SCALE, (py - LIFT) * SCALE, pz * SCALE, random()], made * 4);
    normal.set([nx, ny, nz, 0], made * 4);
    made++;
  }
  return { home, normal, made };
}

export type Cloud = ReturnType<typeof createCloud>;

export function createCloud(s: Scan, tier: QualityTier) {
  const random = lehmer(22022);
  const { head, dust } = COUNTS[tier];
  const sampled = sampleHead(s, head, random);
  const heads = sampled.made;
  const count = heads + dust;
  const home = new Float32Array(count * 4);
  const normal = new Float32Array(count * 4);
  home.set(sampled.home.subarray(0, heads * 4));
  normal.set(sampled.normal.subarray(0, heads * 4));
  // The dust: thickest near the head and thinning out to VOID, reaching past the eye so some of it drifts by the lens.
  for (let i = heads; i < count; i++) {
    const z = random() * 2 - 1;
    const a = random() * Math.PI * 2;
    const r = 0.9 + (VOID - 0.9) * Math.pow(random(), 1.5);
    const ring = Math.sqrt(1 - z * z);
    home.set([Math.cos(a) * ring * r, z * r * 0.75, Math.sin(a) * ring * r, random()], i * 4);
    normal.set([0, 0, 1, 1], i * 4);
  }
  // Every point starts as dust, a little off its place.
  const start = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    start[i * 4] = home[i * 4] + (random() - 0.5) * 0.4;
    start[i * 4 + 1] = home[i * 4 + 1] + (random() - 0.5) * 0.4;
    start[i * 4 + 2] = home[i * 4 + 2] + (random() - 0.5) * 0.4;
  }

  // A subset of the head's points kept on the processor, to find where a tap lands on the head.
  const probeStep = Math.max(1, Math.floor(heads / 24000));
  const probe = new Float32Array(Math.ceil(heads / probeStep) * 3);
  let probes = 0;
  for (let i = 0; i < heads; i += probeStep) probe.set([home[i * 4], home[i * 4 + 1], home[i * 4 + 2]], probes++ * 3);

  const homes = instancedArray(home, "vec4") as any;
  const normals = instancedArray(normal, "vec4") as any;
  const pos = instancedArray(start, "vec4") as any;
  const vel = instancedArray(count, "vec4") as any;
  const shade = instancedArray(count, "vec4") as any;

  const u = {
    now: uniform(0),
    prev: uniform(0),
    dt: uniform(0),
    eye: uniform(new THREE.Vector3(0, 0, 6)),
    // A pixel's width at a distance of one, and where the lens is focused.
    pixel: uniform(0.0005),
    focus: uniform(6),
    sway: uniform(0),
    // How long a revealed form holds, in seconds, before it has fully gone back to dust.
    linger: uniform(8),
    hot: uniform(new THREE.Color("#fff4e6")),
    mid: uniform(new THREE.Color("#69c8ff")),
    deep: uniform(new THREE.Color("#2747ff")),
    // Each wavefront: its source and the moment it set out, and how strong it is (0 for an empty slot).
    pingAt: Array.from({ length: PINGS }, () => uniform(new THREE.Vector4(0, 0, 0, -100))),
    pingStrength: Array.from({ length: PINGS }, () => uniform(0)),
    camRight: uniform(new THREE.Vector3(1, 0, 0)),
    camUp: uniform(new THREE.Vector3(0, 1, 0))
  };

  const update = Fn(() => {
    const i = instanceIndex;
    const h = homes.element(i) as any;
    const nk = normals.element(i) as any;
    const seed = h.w as any;
    const dusty = nk.w as any;
    const solid = float(1).sub(dusty) as any;
    // The sculpture turns slowly back and forth.
    const c = cos(u.sway) as any;
    const sn = sin(u.sway) as any;
    const home = vec3(h.x.mul(c).add(h.z.mul(sn)), h.y, h.z.mul(c).sub(h.x.mul(sn))) as any;
    const n = vec3(nk.x.mul(c).add(nk.z.mul(sn)), nk.y, nk.z.mul(c).sub(nk.x.mul(sn))) as any;
    const p = pos.element(i) as any;
    const v = vel.element(i) as any;

    // Every wavefront against this point where it is now, at true travel time: when its front reaches the point, how hard (falling off
    // with distance, and for the head with how squarely the surface faces the source, as a scanner's return does).
    const front = float(0).toVar() as any;
    const tail = float(0).toVar() as any;
    const crossed = float(0).toVar() as any;
    const kick = vec3(0).toVar() as any;
    // The cool tail behind a front: long on the head, short in the open dust so each front reads as a shell.
    const lasts = mix(float(1.1), float(0.25), dusty) as any;
    for (let k = 0; k < PINGS; k++) {
      const at = u.pingAt[k] as any;
      const strength = u.pingStrength[k] as any;
      const rel = p.xyz.sub(at.xyz) as any;
      const d = length(rel).add(1e-4) as any;
      const travel = d.div(SPEED) as any;
      const age = u.now.sub(at.w).sub(travel) as any;
      const before = u.prev.sub(at.w).sub(travel) as any;
      const dir = rel.div(d) as any;
      const square = mix(float(1), abs(dot(n, dir)).mul(0.8).add(0.2), solid) as any;
      const reach = strength.div(d.mul(d).mul(0.05).add(1)).mul(square) as any;
      const lead = exp(min(age, 0).div(0.045).pow(2).negate()) as any;
      const hot = exp(max(age, 0).div(-0.07)) as any;
      front.addAssign(reach.mul(select(age.lessThan(0), lead, hot)));
      tail.addAssign(reach.mul(exp(max(age, 0).div(lasts).negate())).mul(step(0, age)));
      const just = step(before, 0).mul(step(0, age)).mul(step(0.2, strength)) as any;
      crossed.assign(max(crossed, just));
      kick.addAssign(dir.mul(just.mul(reach)));
    }

    // Snapped onto the surface as a front passes; held for a while, then let go slowly back to dust.
    const snap = max(p.w.sub(u.dt.div(u.linger)), crossed).mul(solid) as any;
    const form = smoothstep(0, 0.55, snap) as any;
    // Dust: each point wanders its own slow loop round its place, some far, most near.
    const q = home.mul(1.7).add(seed.mul(17)) as any;
    const w = u.now.mul(0.22) as any;
    const wander = vec3(
      sin(q.y.add(w.mul(1.1)).add(seed.mul(6.3))).add(sin(q.z.mul(2.3).sub(w.mul(1.7))).mul(0.5)),
      sin(q.z.add(w.mul(0.9)).add(seed.mul(3.1))).add(sin(q.x.mul(2.1).add(w.mul(1.3))).mul(0.5)),
      sin(q.x.sub(w).add(seed.mul(4.7))).add(sin(q.y.mul(1.9).sub(w.mul(1.5))).mul(0.5))
    ) as any;
    const far = seed.mul(7.31).fract() as any;
    const scatter = mix(far.mul(far).mul(0.42).add(0.1), float(0.4), dusty) as any;
    const loose = home.add(wander.mul(scatter)).add(n.mul(far.mul(0.12).mul(solid))) as any;
    const target = mix(loose, home, form) as any;
    // A spring toward it: stiff and a touch springy while snapped, loose as dust.
    const stiff = mix(float(3), float(150), form) as any;
    const damp = mix(float(3.2), float(14), form) as any;
    const nv = v.xyz
      .add(target.sub(p.xyz).mul(stiff).sub(v.xyz.mul(damp)).mul(u.dt))
      .add(kick.mul(mix(float(0.06), float(0.5), dusty))) as any;
    const np = p.xyz.add(nv.mul(u.dt)) as any;

    // How it is seen: the head's back faces dim while it is formed, as a scan read from this side.
    const toEye = u.eye.sub(np) as any;
    const away = length(toEye) as any;
    const facing = dot(n, toEye.div(away)) as any;
    // Dust right at the lens is fainter, or its broad discs crowd the view.
    const near = smoothstep(0.6, 3, away).mul(0.75).add(0.25) as any;
    const seen = mix(float(1), mix(float(0.65), smoothstep(-0.3, 0.55, facing).mul(0.88).add(0.12), form), solid) as any;
    const glint = seed.mul(13.7).fract() as any;
    const rest = mix(float(0.018), float(0.03), dusty).mul(glint.mul(1.2).add(0.4)) as any;
    const colour = u.deep
      .mul(rest)
      .add(mix(u.deep, u.mid, 0.22).mul(form.mul(0.32)))
      .add(mix(u.deep, u.mid, 0.75).mul(tail.mul(mix(float(0.4), float(0.7), dusty))))
      .add(mix(u.mid, u.hot, min(front, 1)).mul(front.mul(mix(float(1.4), float(1.6), dusty))))
      .mul(seen)
      .mul(near) as any;
    // Its size on screen: a fine grain, never under about half a pixel (dimmer instead), swelling a little at the front,
    // and spread into a soft disc the further it is from the focus, as a lens does, never wider than about two degrees.
    const grain = mix(float(0.0036).mul(glint.mul(0.6).add(0.75)), float(0.0045).mul(far.pow(6).mul(2.5).add(0.6)), dusty).mul(min(front, 1.5).mul(0.5).add(1)) as any;
    const px = u.pixel.mul(away) as any;
    const sharp = max(grain, px.mul(0.55)) as any;
    const dim = grain.div(sharp).pow(2) as any;
    const blur = min(abs(away.sub(u.focus)).div(away).mul(mix(float(0.012), float(0.02), dusty)), away.mul(0.022)) as any;
    const radius = sharp.add(blur) as any;
    const spread = max(sharp.div(radius).pow(2), float(0.025)) as any;
    const soft = smoothstep(0.4, 2.5, blur.div(px)) as any;

    p.assign(vec4(np, snap));
    v.assign(vec4(nv, soft));
    shade.element(i).assign(vec4(colour.mul(dim).mul(spread), radius));
  })().compute(count);

  return { count, heads, homes, normals, pos, vel, shade, u, update, probe, probes };
}

// Where a ray first meets the head (within a hair of one of its points), turned as the sculpture is; null if it misses.
export function hitHead(cloud: Cloud, ray: THREE.Ray, sway: number, out: THREE.Vector3) {
  const c = Math.cos(sway);
  const s = Math.sin(sway);
  const { probe, probes } = cloud;
  let best = Infinity;
  const o = ray.origin;
  const d = ray.direction;
  for (let k = 0; k < probes; k++) {
    const hx = probe[k * 3];
    const hz = probe[k * 3 + 2];
    const x = hx * c + hz * s - o.x;
    const y = probe[k * 3 + 1] - o.y;
    const z = hz * c - hx * s - o.z;
    const along = x * d.x + y * d.y + z * d.z;
    if (along <= 0 || along >= best) continue;
    const miss = x * x + y * y + z * z - along * along;
    if (miss < 0.0016) best = along;
  }
  return best === Infinity ? null : out.copy(o).addScaledVector(d, best);
}

// How far a point is from the nearest part of the head, and where that is.
export function nearestOnHead(cloud: Cloud, at: THREE.Vector3, sway: number, out: THREE.Vector3) {
  const c = Math.cos(sway);
  const s = Math.sin(sway);
  const { probe, probes } = cloud;
  let best = Infinity;
  for (let k = 0; k < probes; k++) {
    const hx = probe[k * 3];
    const hz = probe[k * 3 + 2];
    const x = hx * c + hz * s;
    const y = probe[k * 3 + 1];
    const z = hz * c - hx * s;
    const d = (x - at.x) ** 2 + (y - at.y) ** 2 + (z - at.z) ** 2;
    if (d < best) {
      best = d;
      out.set(x, y, z);
    }
  }
  return Math.sqrt(best);
}
