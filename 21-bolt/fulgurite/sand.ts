import * as THREE from "three/webgpu";
import {
  abs,
  atomicAdd,
  Break,
  clamp,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  color,
  Discard,
  dot,
  exp,
  float,
  floor,
  Fn,
  fract,
  hash,
  If,
  instancedArray,
  instanceIndex,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  mx_noise_float,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  normalGeometry,
  normalize,
  positionGeometry,
  select,
  sin,
  smoothstep,
  storage,
  texture3D,
  textureStore,
  transformNormalToView,
  uint,
  uniform,
  uvec3,
  vec2,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { BOX_MIN, BOX_SIZE, CUT_A, CUT_B, HALF, RADIUS, WEDGE_AT, type Grid } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// How many glass shapes are grown at load; each strike after a reset takes the next.
export const VARIANTS = 3;
// Flying grains a cell of sand breaks into as the wind takes it.
const GRAINS_PER_CELL = 7;

// The glass's heat, by how long ago the melt front passed (in seconds of the glass's clock): white hot as the front
// goes by, orange for a second or two, a dull red ember for a good while after. Shared by the glass and the sand.
export const heatAfter = (age: any) =>
  select(age.lessThan(0), float(0), exp(age.mul(-1 / 0.06)).mul(1.5).add(exp(age.mul(-1 / 1.2)).mul(0.9)).add(exp(age.mul(-1 / 14)).mul(0.2))) as any;

// Hot colour, from a deep red through orange to white as heat rises past 1.
export const glowColour = (heat: any) =>
  mix(mix(color("#5a0c02"), color("#ff4a0c"), smoothstep(0.04, 0.45, heat)), mix(color("#ffa040"), color("#fff3dc"), smoothstep(1.0, 1.6, heat)), smoothstep(0.35, 1.0, heat)).mul(heat) as any;

// The sand's signed distance, as the processor's sandDistance.
export const sandSd = (p: any) => {
  const cylinder = max(length(p.xz).sub(RADIUS), abs(p.y).sub(HALF));
  const a = dot(p.xz, vec2(CUT_A[0], CUT_A[1]));
  const b = dot(p.xz, vec2(CUT_B[0], CUT_B[1]));
  return max(cylinder, min(a, b)) as any;
};

export function createSand(grid: Grid, field: Float32Array, pool: number) {
  const { x: GX, y: GY, z: GZ, count: N } = grid;
  const cell = BOX_SIZE.x / GX;
  const u = {
    seconds: uniform(0),
    delta: uniform(0),
    // The glass's own clock: seconds since the front set out, times the growth speed; very negative before a strike.
    glass: uniform(-100),
    variant: uniform(0, "int"),
    // The wind: how hard, which way (in the specimen's frame), and the pointer's line it blows along.
    gust: uniform(0),
    wind: uniform(new THREE.Vector3(1, 0, 0)),
    rayFrom: uniform(new THREE.Vector3(0, 0, 10)),
    rayDir: uniform(new THREE.Vector3(0, 0, -1)),
    reach: uniform(0.13),
    // Sand pouring back: everything below this height fills again.
    refill: uniform(-10),
    salt: uniform(0, "uint")
  };

  const density = instancedArray(N, "float") as any;
  const fieldBuffer = new THREE.StorageBufferAttribute(field, 2);
  const fieldNode = storage(fieldBuffer, "vec2", VARIANTS * N).toReadOnly() as any;
  const grains = instancedArray(pool * 2, "vec4") as any;
  const counterBuffer = new THREE.StorageBufferAttribute(new Uint32Array(4), 1);
  const counter = storage(counterBuffer, "uint", 4).toAtomic() as any;
  const C = { x: Math.ceil(GX / 4), y: Math.ceil(GY / 4), z: Math.ceil(GZ / 4) };
  const coarseCount = C.x * C.y * C.z;
  const coarseBuffer = new THREE.StorageBufferAttribute(new Uint32Array(coarseCount), 1);
  const coarse = storage(coarseBuffer, "uint", coarseCount) as any;

  const texture = new THREE.Storage3DTexture(GX, GY, GZ);
  texture.type = THREE.HalfFloatType;
  texture.format = THREE.RGBAFormat;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;

  const coords = () => {
    const i = instanceIndex as any;
    return uvec3(i.mod(uint(GX)), i.div(uint(GX)).mod(uint(GY)), i.div(uint(GX * GY))) as any;
  };
  const centreOf = (c: any) => vec3(c).add(0.5).div(vec3(GX, GY, GZ)).mul(vec3(BOX_SIZE.x, BOX_SIZE.y, BOX_SIZE.z)).add(vec3(BOX_MIN.x, BOX_MIN.y, BOX_MIN.z)) as any;
  const fieldAt = (i: any) => fieldNode.element(int(i).add(u.variant.mul(N))) as any;
  // Heat in the sand: the glass's, falling off over a couple of centimetres from it.
  const sandHeat = (f: any) => heatAfter(u.glass.sub(f.x)).mul(exp(max(f.y, 0).mul(-1 / 0.016))).mul(0.85) as any;

  // Fill: the core as cut, every cell a little way outside it too, so the analytic surface draws crisp. Cells below the
  // refill height come back.
  const fill = Fn(() => {
    const c = coords();
    const p = centreOf(c);
    const inside = select(sandSd(p).lessThan(cell * 0.9), float(1), float(0)) as any;
    const d = density.element(instanceIndex) as any;
    If(p.y.lessThan(u.refill), () => {
      d.assign(max(d, inside));
    });
  })().compute(N);

  // Wind: where the pointer's line passes, sand open to the air goes, the faces turned to the eye and into the wind
  // first. What goes breaks into flying grains, carrying the cell's heat.
  const erode = Fn(() => {
    const c = coords();
    const d = density.element(instanceIndex) as any;
    If(d.greaterThan(0.001), () => {
      const p = centreOf(c);
      const at = (dx: number, dy: number, dz: number) => {
        const q = vec3(c).add(vec3(dx, dy, dz)) as any;
        const inside = q.x.greaterThanEqual(0).and(q.y.greaterThanEqual(0)).and(q.z.greaterThanEqual(0)).and(q.x.lessThan(GX)).and(q.y.lessThan(GY)).and(q.z.lessThan(GZ));
        const k = clamp(q, vec3(0), vec3(GX - 1, GY - 1, GZ - 1)) as any;
        const idx = int(k.x).add(int(k.y).mul(GX)).add(int(k.z).mul(GX * GY));
        return select(inside, density.element(idx), float(0)) as any;
      };
      const xp = at(1, 0, 0);
      const xm = at(-1, 0, 0);
      const yp = at(0, 1, 0);
      const ym = at(0, -1, 0);
      const zp = at(0, 0, 1);
      const zm = at(0, 0, -1);
      const open = clamp(float(6).sub(xp.add(xm).add(yp).add(ym).add(zp).add(zm)).div(2.5), 0, 1) as any;
      const grad = vec3(xm.sub(xp), ym.sub(yp), zm.sub(zp)) as any;
      const n = grad.div(max(length(grad), float(0.001))) as any;
      const v = p.sub(u.rayFrom) as any;
      const along = dot(v, u.rayDir) as any;
      const off = length(v.sub(u.rayDir.mul(along))) as any;
      const brush = exp(off.div(u.reach).pow(2).negate()) as any;
      const face = clamp(dot(n, u.rayDir.negate()).mul(0.85).add(0.1).add(dot(n, u.wind.negate()).mul(0.3)), 0, 1) as any;
      // Loose crumbs left standing in the air go with any gust.
      const rate = u.gust.mul(brush.mul(open).mul(face).mul(24 * (0.01325 / cell)).add(smoothstep(0.75, 0.95, open).mul(5))) as any;
      const next = max(d.sub(rate.mul(u.delta)), 0) as any;
      const lost = d.sub(next) as any;
      d.assign(next);
      const seed = instanceIndex.add(u.salt) as any;
      const count = floor(lost.mul(GRAINS_PER_CELL).add(hash(seed))) as any;
      const f = fieldAt(instanceIndex);
      const heat = sandHeat(f);
      for (let j = 0; j < 3; j++) {
        If(count.greaterThan(j), () => {
          const slot = (atomicAdd(counter.element(0), uint(1)) as any).mod(uint(pool)) as any;
          const h1 = hash(seed.add(uint(j * 7919 + 1))) as any;
          const h2 = hash(seed.add(uint(j * 7919 + 2))) as any;
          const h3 = hash(seed.add(uint(j * 7919 + 3))) as any;
          const jitter = vec3(h1, h2, h3).sub(0.5) as any;
          const start = p.add(jitter.mul(cell)) as any;
          const speed = h1.mul(1.1).add(0.6).mul(u.gust.mul(0.6).add(0.6)) as any;
          const vel = u.wind.mul(speed).add(n.mul(0.35)).add(vec3(0, 0.22, 0)).add(jitter.mul(0.5)) as any;
          grains.element(slot.mul(2)).assign(vec4(start, u.seconds));
          grains.element(slot.mul(2).add(1)).assign(vec4(vel, heat));
        });
      }
    });
  })().compute(N);

  // Publish to the texture the sand is drawn from: how much sand, how hot, how scorched. Where the glass now is, the
  // sand has melted into it and goes.
  const publish = Fn(() => {
    const c = coords();
    const d = density.element(instanceIndex) as any;
    const f = fieldAt(instanceIndex);
    const reached = u.glass.greaterThan(f.x) as any;
    If(reached.and(f.y.lessThan(cell * 0.3)), () => {
      d.assign(0);
    });
    const heat = sandHeat(f);
    const scorch = select(reached, exp(max(f.y, 0).mul(-1 / 0.009)), float(0)) as any;
    // Drawn a touch softened, so worn ground reads as smooth drifts rather than terraces of cells. A full cell keeps its
    // value, so the core as cut stays crisp.
    const at = (dx: number, dy: number, dz: number) => {
      const q = clamp(vec3(c).add(vec3(dx, dy, dz)), vec3(0), vec3(GX - 1, GY - 1, GZ - 1)) as any;
      return density.element(int(q.x).add(int(q.y).mul(GX)).add(int(q.z).mul(GX * GY))) as any;
    };
    const around = at(1, 0, 0).add(at(-1, 0, 0)).add(at(0, 1, 0)).add(at(0, -1, 0)).add(at(0, 0, 1)).add(at(0, 0, -1)).div(6) as any;
    const soft = select(around.greaterThan(0.999), d, mix(d, around, 0.45)) as any;
    textureStore(texture, c, vec4(soft, heat, scorch, 1));
  })().compute(N);

  // Flying grains: carried on the wind, which slows them as they leave the gust, falling a little, turning in eddies.
  const fly = Fn(() => {
    const a = grains.element(instanceIndex.mul(2)) as any;
    const b = grains.element(instanceIndex.mul(2).add(1)) as any;
    const age = u.seconds.sub(a.w) as any;
    If(age.lessThan(6).and(age.greaterThan(0)), () => {
      const p = a.xyz as any;
      const v = b.xyz as any;
      const swirl = vec3(sin(p.y.mul(9).add(u.seconds.mul(1.3))), sin(p.z.mul(8).add(u.seconds.mul(1.1))).mul(0.6), sin(p.x.mul(10).sub(u.seconds.mul(1.2)))).mul(0.6) as any;
      const drag = float(1).sub(exp(u.delta.mul(-0.9))) as any;
      const nv = v
        .add(swirl.mul(u.delta))
        .add(vec3(0, -0.55, 0).mul(u.delta))
        .sub(v.mul(drag)) as any;
      a.assign(vec4(p.add(nv.mul(u.delta)), a.w));
      // A hot grain cools as it flies.
      b.assign(vec4(nv, b.w.mul(exp(u.delta.mul(-0.9)))));
    });
  })().compute(pool);

  // A coarse map of where sand is, for the pointer to land on and to count what is left: each block of 4³ cells keeps
  // its fullest cell (0–255) and its total (in the high bits).
  const shrink = Fn(() => {
    const i = instanceIndex as any;
    const bx = i.mod(uint(C.x));
    const by = i.div(uint(C.x)).mod(uint(C.y));
    const bz = i.div(uint(C.x * C.y));
    const most = float(0).toVar() as any;
    const sum = float(0).toVar() as any;
    for (let dz = 0; dz < 4; dz++)
      for (let dy = 0; dy < 4; dy++)
        for (let dx = 0; dx < 4; dx++) {
          const x = (min as any)(bx.mul(4).add(dx), uint(GX - 1)) as any;
          const y = (min as any)(by.mul(4).add(dy), uint(GY - 1)) as any;
          const z = (min as any)(bz.mul(4).add(dz), uint(GZ - 1)) as any;
          const v = density.element(x.add(y.mul(GX)).add(z.mul(GX * GY))) as any;
          most.assign(max(most, v));
          sum.addAssign(v);
        }
    coarse.element(i).assign(uint(most.mul(255)).add(uint(sum.mul(64)).shiftLeft(uint(8))));
  })().compute(coarseCount);

  return { u, density, texture, grains, pool, counterBuffer, coarseBuffer, C, cell, passes: { fill, erode, publish, fly, shrink }, fieldBuffer };
}

export type Sand = ReturnType<typeof createSand>;

// The surface the sand is drawn on: the core as cut, each face of which starts a ray into the grid. A ray that finds sand
// at once shows the cut face exactly; one through ground the wind has opened marches on until it finds sand or leaves.
export function proxyGeometry() {
  const positions: number[] = [];
  const normals: number[] = [];
  const seg = 120;
  const span = Math.PI * 1.5;
  const at = (a: number) => [Math.sin(a), Math.cos(a)];
  const tri = (p: number[][], n: number[]) => {
    // Wind each triangle to face its normal.
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const order = c[0] * n[0] + c[1] * n[1] + c[2] * n[2] >= 0 ? [0, 1, 2] : [0, 2, 1];
    for (const k of order) {
      positions.push(...p[k]);
      normals.push(...n);
    }
  };
  // The cut runs from the angle of one face round to the other; the sand is the 270° between.
  const start = WEDGE_AT + Math.PI / 4;
  for (let i = 0; i < seg; i++) {
    const a = start + (i / seg) * span;
    const b = start + ((i + 1) / seg) * span;
    const [sa, ca] = at(a);
    const [sb, cb] = at(b);
    const pa = [sa * RADIUS, ca * RADIUS];
    const pb = [sb * RADIUS, cb * RADIUS];
    const mid = at((a + b) / 2);
    tri(
      [
        [pa[0], -HALF, pa[1]],
        [pb[0], -HALF, pb[1]],
        [pb[0], HALF, pb[1]]
      ],
      [mid[0], 0, mid[1]]
    );
    tri(
      [
        [pa[0], -HALF, pa[1]],
        [pb[0], HALF, pb[1]],
        [pa[0], HALF, pa[1]]
      ],
      [mid[0], 0, mid[1]]
    );
    tri(
      [
        [0, HALF, 0],
        [pa[0], HALF, pa[1]],
        [pb[0], HALF, pb[1]]
      ],
      [0, 1, 0]
    );
    tri(
      [
        [0, -HALF, 0],
        [pa[0], -HALF, pa[1]],
        [pb[0], -HALF, pb[1]]
      ],
      [0, -1, 0]
    );
  }
  // The two cut faces, from the axis out to the rim.
  for (const [n, a] of [
    [CUT_A, start],
    [CUT_B, start + span]
  ] as const) {
    const [s, c] = at(a);
    const rim = [s * RADIUS, c * RADIUS];
    const normal = [n[0], 0, n[1]];
    tri(
      [
        [0, -HALF, 0],
        [rim[0], -HALF, rim[1]],
        [rim[0], HALF, rim[1]]
      ],
      normal
    );
    tri(
      [
        [0, -HALF, 0],
        [rim[0], HALF, rim[1]],
        [0, HALF, 0]
      ],
      normal
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

// The key light's direction in the specimen's frame (it barely turns), for the sand's own shadowing.
export const keyDir = uniform(new THREE.Vector3(-0.6, 0.65, 0.4).normalize());

// The sand, ray marched through the grid. Fine sand reads from the strata of a core sample (pale bands, darker seams),
// grain-sized facets that glint here and there, the shadow the sand casts on itself, and the glow and scorch of the glass
// inside, which shows through the cut and warms the sand round it.
export function sandMaterial(sand: Sand, steps: number) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
  const cell = sand.cell;
  const tex = sand.texture;
  const uvw = (p: any) => p.sub(vec3(BOX_MIN.x, BOX_MIN.y, BOX_MIN.z)).div(vec3(BOX_SIZE.x, BOX_SIZE.y, BOX_SIZE.z)) as any;
  const look = (p: any) => texture3D(tex, uvw(p), float(0)) as any;
  const solid = (p: any) => min(look(p).r, clamp(float(0.5).sub(sandSd(p).div(cell)), 0, 1)) as any;

  const ro = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz as any;
  const start = varying(positionGeometry, "vSandStart") as any;
  const faceN = varying(normalGeometry, "vSandNormal") as any;

  // One march a pixel, shared by everything below: where it met sand, and whether that was the cut face itself (1) or
  // sand further in (2). A ray that meets none is discarded, so the glass and the dark behind show through.
  const marched = Fn(() => {
    const rd = normalize(start.sub(ro)).toVar() as any;
    const kind = float(0).toVar() as any;
    const t = float(0).toVar() as any;
    If(solid(start.add(rd.mul(cell * 0.3))).greaterThan(0.5), () => {
      kind.assign(1);
    }).Else(() => {
      const step = cell * 0.7;
      const prev = float(0).toVar() as any;
      Loop(steps, () => {
        t.addAssign(step);
        const p = start.add(rd.mul(t)) as any;
        If(solid(p).greaterThan(0.5), () => {
          // Close in on the crossing.
          const lo = prev.toVar() as any;
          const hi = t.toVar() as any;
          for (let k = 0; k < 4; k++) {
            const mid = lo.add(hi).mul(0.5) as any;
            If(solid(start.add(rd.mul(mid))).greaterThan(0.5), () => {
              hi.assign(mid);
            }).Else(() => {
              lo.assign(mid);
            });
          }
          t.assign(hi);
          kind.assign(2);
          Break();
        });
        If(sandSd(p).greaterThan(cell * 1.2), () => {
          Break();
        });
        prev.assign(t);
      });
    });
    Discard(kind.lessThan(0.5));
    return vec4(start.add(rd.mul(t)), kind);
  })().toVar("sandMarch") as any;
  const hit = marched.xyz as any;
  const e = cell * 1.1;
  const grad = vec3(
    solid(hit.add(vec3(e, 0, 0))).sub(solid(hit.sub(vec3(e, 0, 0)))),
    solid(hit.add(vec3(0, e, 0))).sub(solid(hit.sub(vec3(0, e, 0)))),
    solid(hit.add(vec3(0, 0, e))).sub(solid(hit.sub(vec3(0, 0, e))))
  ) as any;
  // On the cut faces and the curved side, the exact normal of the shape; inside, the grid's.
  const k = 0.002;
  const sd0 = sandSd(hit) as any;
  const exact = normalize(vec3(sandSd(hit.add(vec3(k, 0, 0))).sub(sd0), sandSd(hit.add(vec3(0, k, 0))).sub(sd0), sandSd(hit.add(vec3(0, 0, k))).sub(sd0)).add(faceN.mul(1e-4))) as any;
  const gridN = grad.negate().div(max(length(grad), float(1e-4))) as any;
  const nearCut = smoothstep(cell * -1.5, cell * -0.2, sd0) as any;
  const normalOut = select(marched.w.lessThan(1.5), exact, normalize((mix as any)(gridN, exact, nearCut.mul(0.85)))) as any;
  const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(modelWorldMatrix).mul(vec4(hit, 1)) as any;
  const depthOut = clip.z.div(clip.w) as any;
  const fieldOut = look(hit) as any;
  const found = float(1);

  // Grains: a cell a few millimetres across, each its own tint and facet. Faded by distance, as they shrink below a pixel.
  const p = hit as any;
  const g = 0.0032;
  const id = floor(p.div(g)) as any;
  const h = fract(sin(dot(id, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;
  const h2 = fract(h.mul(61.7).add(0.13)) as any;
  const h3 = fract(h.mul(17.3).add(0.71)) as any;
  const away = length(modelWorldMatrix.mul(vec4(p, 1)).xyz.sub(cameraPosition)) as any;
  const near = float(1).sub(smoothstep(1.2, 9, away).mul(0.65)) as any;
  const tilt = vec3(h.sub(0.5), h2.sub(0.5), h3.sub(0.5)).mul(0.7).mul(near) as any;
  const n = normalize(normalOut.add(tilt.mul(found))) as any;
  m.normalNode = transformNormalToView(n) as any;
  m.depthNode = depthOut as any;

  // Strata: pale bands of slightly different sands, wavering, with thin darker seams, as wind laid them down.
  const warp = sin(p.x.mul(6.1).add(p.z.mul(4.3)))
    .mul(0.012)
    .add(sin(p.x.mul(17).sub(p.z.mul(13)).add(p.y.mul(3))).mul(0.004)) as any;
  const y = p.y.add(warp) as any;
  const band = sin(y.mul(17)).mul(0.5).add(0.5) as any;
  const band2 = sin(y.mul(47).add(1.3)).mul(0.5).add(0.5) as any;
  const seam = smoothstep(0.96, 0.995, sin(y.mul(8.3).add(0.4))) as any;
  const seam2 = smoothstep(0.985, 0.998, sin(y.mul(29).add(2.1))) as any;
  const mottle = mx_noise_float(p.mul(38)).mul(0.5).add(0.5) as any;
  let base: any = mix(color("#dcc6a0"), color("#c7a77c"), band.mul(0.65));
  base = mix(base, color("#d3b598"), band2.mul(0.3));
  base = mix(base, color("#957a5c"), seam.mul(0.5).add(seam2.mul(0.3)));
  base = base.mul(mottle.mul(0.12).add(0.94));
  // Grain tints, only up close: bright quartz, dark minerals, a few rusty ones.
  const grain = select(h.greaterThan(0.93), vec3(1.12), select(h.lessThan(0.05), vec3(0.55, 0.52, 0.5), select(h2.lessThan(0.06), vec3(1.05, 0.86, 0.74), vec3(h3.mul(0.1).add(0.95))))) as any;
  base = base.mul(mix(vec3(1), grain, near));
  // Scorched: dark brown-black near the glass.
  const scorch = fieldOut.z as any;
  base = mix(base, color("#2a1d14"), clamp(scorch.mul(0.9), 0, 0.92));

  // The sand's own shadow toward the key, and a little hollow darkness.
  const shadow = Fn(() => {
    const occ = float(0).toVar() as any;
    for (const s of [1.6, 3.2, 5.5, 9]) occ.addAssign(max(solid(p.add(keyDir.mul(cell * s))).sub(0.35), 0));
    const hollow = max(solid(p.add(n.mul(cell * 2.2))).sub(0.3), 0) as any;
    return exp(occ.mul(-0.75)).mul(float(1).sub(hollow.mul(0.45)));
  })() as any;
  m.colorNode = base.mul(mix(float(0.32), float(1), shadow)) as any;
  m.roughnessNode = select(h.greaterThan(0.965).and(near.greaterThan(0.3)), float(0.22), float(0.93)) as any;

  // Glow: the heat here and just under the surface, so a branch behind the cut shows through it.
  const inward = normalize(hit.sub(ro)) as any;
  let under: any = float(0);
  for (const [k, w] of [
    [1.2, 0.8],
    [2.4, 0.6],
    [4, 0.42],
    [6, 0.28],
    [8.5, 0.18]
  ])
    under = max(under, look(p.add(inward.mul(cell * k))).g.mul(w));
  const heat = max(fieldOut.y, under) as any;
  m.emissiveNode = glowColour(heat).mul(2.2) as any;
  return m;
}
