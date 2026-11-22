import * as THREE from "three/webgpu";
import { atomicAdd, tanh, cos, cross, dot, exp, float, Fn, hash, If, instancedArray, instanceIndex, int, length, Loop, max, min, normalize, sin, smoothstep, storage, uint, uniform, vec3, vec4 } from "three/tsl";
import { BAND, ring, ringCount, shapeAt } from "./form";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The skin of dust on the form, and the dust in the air, both kept on the graphics card.
//
// The skin is a map over the form's directions (longitude across, latitude down): how much dust lies there, and how hot
// the stone beneath is where it was freshly shed. Each frame every texel asks each ring whether its front is passing:
// if so it loses a share of its dust, glows, and lets that dust go as motes, thrown off along the surface's normal. The
// skin then slowly fills back in, as the dust settles.
//
// The motes are Erosion's: four rows each (where and when let go; which way thrown and a seed; where now and when it
// landed; how it moves), carried by the same eddies and pushed by the same hand. Late in life each drifts back down to
// the form and settles on it.

// The share of dust a full-strength front takes as it passes: exp(-1.1) leaves a third.
const TAKE = 1.1;
// The error function, near enough.
const erf = (x: any) => tanh(x.mul(1.1283).add(x.mul(x).mul(x).mul(0.1009))) as any;
// The skin fills back in over about this many seconds.
const REFILL = 24;

export function createDust(SW: number, SH: number, pool: number, density: number) {
  const texels = SW * SH;
  const skinArray = new Float32Array(texels * 4);
  for (let i = 0; i < texels; i++) skinArray[i * 4] = 1;
  const skin = instancedArray(skinArray, "vec4") as any;
  const motes = instancedArray(pool * 4, "vec4") as any;
  const counterBuffer = new THREE.StorageBufferAttribute(new Uint32Array(4), 1);
  const counters = storage(counterBuffer, "uint", 4).toAtomic() as any;

  const u = {
    seconds: uniform(0),
    delta: uniform(1 / 60),
    salt: uniform(0),
    density: uniform(density),
    drift: uniform(2.5),
    handFrom: uniform(new THREE.Vector3()),
    handAlong: uniform(new THREE.Vector3(0, 0, -1)),
    handMove: uniform(new THREE.Vector3()),
    hand: uniform(0)
  };

  // A direction from a point on the map, in texels.
  const dirAt = (x: any, y: any) => {
    const lon = x.div(SW).mul(Math.PI * 2) as any;
    const lat = y.div(SH).sub(0.5).mul(Math.PI) as any;
    return { n: vec3(cos(lat).mul(cos(lon)), sin(lat), cos(lat).mul(sin(lon))) as any, lat };
  };

  // Each texel: shed what the passing fronts take, glow, let it go as motes, and fill back in.
  const field = Fn(() => {
    const id = int(instanceIndex) as any;
    const x = float(id.mod(SW)) as any;
    const y = float(id.div(SW)) as any;
    const { n, lat } = dirAt(x.add(0.5), y.add(0.5));
    const t = u.seconds as any;
    const take = float(0).toVar() as any;
    const push = vec3(0, 0, 0).toVar() as any;
    Loop(ringCount, ({ i }: any) => {
      const r = ring(i, n, t);
      const prev = ring(i, n, t.sub(u.delta));
      // How much of the front's band has swept past since the last frame, as a share of the whole (0 to 2), so a
      // long frame sheds exactly as much as several short ones.
      const g = max(erf(prev.ahead.div(BAND)).sub(erf(r.ahead.div(BAND))), float(0)).mul(r.strength) as any;
      take.addAssign(g);
      // The way the front runs here, across the surface, for the spray to lean along.
      const away = n.mul(dot(n, r.at.xyz)).sub(r.at.xyz) as any;
      push.addAssign(away.div(max(length(away), float(1e-4))).mul(g.mul(r.dir)));
    });
    const cell = skin.element(id).toVar() as any;
    const before = cell.x as any;
    const kept = before.mul(exp(take.mul(-TAKE / 2))) as any;
    const lost = before.sub(kept).toVar() as any;
    const heat = min(cell.y.mul(exp(u.delta.div(-0.45))).add(lost.mul(1.8)), float(1)) as any;
    const refill = u.delta.div(REFILL).mul(float(1).sub(smoothstep(0, 0.6, heat))) as any;
    skin.element(id).assign(vec4(min(kept.add(refill), float(1)), heat, 0, 0));

    // Let the lost dust go, one mote at most a texel a frame, fewer toward the poles where texels are small.
    const salt = uint(id).add(uint(u.salt)) as any;
    If(hash(salt).lessThan(lost.mul(u.density).mul(cos(lat))), () => {
      const j = dirAt(x.add(hash(salt.add(uint(1013)))), y.add(hash(salt.add(uint(2027)))));
      const m = normalize(j.n) as any;
      const shape = shapeAt(m, t);
      const normal = normalize(m.mul(shape.r).sub(shape.grad)) as any;
      const seed = hash(salt.add(uint(7))) as any;
      const wobble = vec3(hash(salt.add(uint(11))), hash(salt.add(uint(13))), hash(salt.add(uint(17))))
        .sub(0.5)
        .mul(0.5) as any;
      const along = push.div(max(length(push), float(1e-4))) as any;
      const thrown = normalize(normal.add(along.mul(0.45)).add(wobble)) as any;
      const world = m.mul(shape.r.add(0.012)) as any;
      const slot = (atomicAdd(counters.element(0), uint(1)) as any).mod(uint(pool)) as any;
      const row = int(slot).mul(4) as any;
      motes.element(row).assign(vec4(world, t));
      motes.element(row.add(1)).assign(vec4(thrown, seed));
      motes.element(row.add(2)).assign(vec4(world, 0));
      motes.element(row.add(3)).assign(vec4(thrown.mul(seed.mul(seed).mul(0.9).add(0.12)), 0));
    });
  })().compute(texels);

  // The dust in the air, a step a frame: thrown off, slowed by the air, carried up and toward the light on its eddies,
  // swept by the hand; and late in life drawn gently back to settle on the form.
  const drift = Fn(() => {
    const row = int(instanceIndex).mul(4) as any;
    const born = motes.element(row) as any;
    const age = u.seconds.sub(born.w) as any;
    const now = motes.element(row.add(2)) as any;
    If(age.greaterThanEqual(0).and(age.lessThan(45)).and(now.w.equal(0)), () => {
      const seed = motes.element(row.add(1)).w as any;
      const p = now.xyz.toVar() as any;
      const v = motes.element(row.add(3)).xyz.toVar() as any;
      const t = u.seconds as any;
      const swirl = vec3(
        sin(
          p.y
            .mul(1.7)
            .add(t.mul(0.13))
            .add(sin(p.z.mul(1.1).sub(t.mul(0.07))))
        ),
        sin(
          p.z
            .mul(1.3)
            .add(t.mul(0.11))
            .add(sin(p.x.mul(0.9).add(t.mul(0.05))))
        ).mul(0.6),
        sin(
          p.x
            .mul(1.5)
            .sub(t.mul(0.12))
            .add(sin(p.y.mul(1.2).add(t.mul(0.06))))
        )
      ) as any;
      const air = vec3(-0.035, 0.05, 0.012).add(swirl.mul(0.045)).mul(u.drift) as any;
      // Settling: from its own moment on, the air's pull gives way to a slow fall back toward the form.
      const settleAt = seed.mul(9).add(8) as any;
      const settle = smoothstep(settleAt, settleAt.add(4), age) as any;
      const m = normalize(p) as any;
      const ground = shapeAt(m, t).r as any;
      const height = length(p).sub(ground) as any;
      const home = m.negate().mul(min(height.mul(0.35).add(0.06), float(0.28))) as any;
      const want = air.mul(float(1).sub(settle.mul(0.85))).add(home.mul(settle)) as any;
      v.addAssign(want.sub(v).mul(float(1).sub(exp(u.delta.mul(-1.5)))));
      If(age.greaterThan(0.5).and(u.hand.greaterThan(0.5)), () => {
        const rel = p.sub(u.handFrom) as any;
        const off = rel.sub(u.handAlong.mul(dot(rel, u.handAlong))) as any;
        const d = length(off) as any;
        const reach = exp(d.div(0.38).pow(2).negate()).mul(smoothstep(0.5, 0.8, age)) as any;
        const speed = length(u.handMove) as any;
        const turn = cross(u.handAlong, off.div(max(d, float(1e-3)))).mul(speed.mul(0.35)) as any;
        v.addAssign(
          u.handMove
            .mul(1.1)
            .add(turn)
            .sub(v)
            .mul(reach)
            .mul(float(1).sub(exp(u.delta.mul(-7))))
        );
      });
      p.addAssign(v.mul(u.delta));
      // Down on the form again: it lands, and fades into the skin.
      const landed = settle.greaterThan(0.2).and(height.lessThan(0.006)) as any;
      motes.element(row.add(2)).assign(vec4(p, landed.select(u.seconds, float(0))));
      motes.element(row.add(3)).assign(vec4(v, 0));
    });
  })().compute(pool);

  // Motes all start long dead.
  {
    const array = motes.value.array as Float32Array;
    for (let i = 0; i < pool; i++) array[i * 16 + 3] = -1000;
  }

  return { SW, SH, pool, skin, motes, counterBuffer, u, passes: { field, drift } };
}

export type Dust = ReturnType<typeof createDust>;
