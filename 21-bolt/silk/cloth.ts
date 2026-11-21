import * as THREE from "three/webgpu";
import { abs, cos, exp, float, Fn, If, instancedArray, instanceIndex, int, length, max, min, mix, normalize, select, sin, smoothstep, sqrt, step, uniform, vec3, vec4 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// An index held within [0, top]; TSL's types do not allow min and max on integers.
const clampInt = (k: any, top: number) => (max as any)((min as any)(k, int(top)), int(0));

// A bolt of silk: eight metres of cloth wound on a cardboard core, simulated on the graphics card.
//
// The cloth is one grid of particles, COLS across its width and ROWS along its length, row 0 the loose end. How much of
// it is off the roll is a single number, the unrolled length s: every row further along than s is wound on the bolt and
// placed there exactly, on the spiral it was wound to, and every row short of it is free cloth, stepped by position-based
// dynamics (Verlet, then Jacobi constraint passes ping-ponged between two buffers). A wound row carries the roll's own
// surface speed, so when s grows past it, it leaves the bolt already moving.
//
// The roll itself (its spin, and so s) is stepped on the processor from how hard the hand pulls, which it knows without
// reading anything back: the grabbed row is s minus its own distance from the roll, so the roll must feed cloth whenever
// the hand is further away than that.

export const WIDTH = 1.2;
export const LENGTH = 8;
// The cardboard core, and the bolt's radius when full: each wrap adds THICK to the radius.
export const CORE = 0.045;
export const FULL = 0.175;
export const THICK = (Math.PI * (FULL * FULL - CORE * CORE)) / LENGTH;
// The loose end left hanging from the bolt at rest, and the most that can come off (the last few centimetres are glued to the core).
export const TAIL = 0.6;
export const MOST = LENGTH - 0.12;
export const CENTRE = new THREE.Vector3(0, 0.62, 0);

// The radius at which the cloth at a given distance from the loose end lies, once wound: also the bolt's radius when that
// much is off it.
export const radiusAt = (v: number) => Math.sqrt(CORE * CORE + (Math.max(0, LENGTH - v) * THICK) / Math.PI);

// Where the cloth is held when a hand takes it: a patch of 5 columns by 3 rows round the particle taken.
const PATCH_I = 2;
const PATCH_J = 1;
const PATCH = (PATCH_I * 2 + 1) * (PATCH_J * 2 + 1);

export type Cloth = ReturnType<typeof createCloth>;

export function createCloth(COLS: number, ROWS: number) {
  const N = COLS * ROWS;
  const du = WIDTH / (COLS - 1);
  const dv = LENGTH / (ROWS - 1);
  const A = instancedArray(N, "vec4") as any;
  const B = instancedArray(N, "vec4") as any;
  const prev = instancedArray(N, "vec4") as any;
  const offsets = instancedArray(PATCH, "vec4") as any;

  const u = {
    dt: uniform(1 / 120),
    // The unrolled length and the angle the cloth leaves the bolt at, now and at the step before.
    s: uniform(TAIL),
    sPrev: uniform(TAIL),
    lift: uniform(0),
    liftPrev: uniform(0),
    centre: uniform(CENTRE.clone()),
    gravity: uniform(0.9),
    breeze: uniform(0.3),
    time: uniform(0),
    // The hand: whether it holds the cloth, the particle it took (column, row) and where it wants it.
    holding: uniform(0),
    gi: uniform(0),
    gj: uniform(0),
    target: uniform(new THREE.Vector3()),
    // Winding back: guides the cloth near the bolt onto it.
    reel: uniform(0),
    // A soft bound the cloth is drawn back inside, so it never drifts out of the light.
    home: uniform(new THREE.Vector3(0, -0.05, 0.55)),
    homeRadius: uniform(1.3)
  };

  const TAU = Math.PI * 2;
  const radiusNode = (v: any) => sqrt(float(CORE * CORE).add(max(float(LENGTH).sub(v), 0).mul(THICK / Math.PI))) as any;
  // A row's place on the bolt: the spiral it was wound to, measured back from where the cloth leaves. Past the first
  // turn it is out of sight under the cloth above, so it is folded away inside the core.
  const wound = (x: any, v: any, s: any, lift: any) => {
    const Rs = radiusNode(s);
    const Rv = radiusNode(v);
    const a = lift.add(Rs.sub(Rv).mul(TAU / THICK)) as any;
    const hidden = step(Rs.mul(TAU * 1.04), v.sub(s)) as any;
    const r = mix(Rv, float(CORE + 0.004), hidden) as any;
    const xx = x.mul(mix(float(1), float(0.94), hidden)) as any;
    return u.centre.add(vec3(xx, r.mul(sin(a)), r.mul(cos(a)))) as any;
  };
  const anchorOf = (x: any) => wound(x, u.s, u.s, u.lift);
  // Which way cloth leaves the bolt at the lift angle.
  const leaving = () => vec3(0, cos(u.lift).negate(), sin(u.lift)) as any;

  const coords = () => {
    const id = int(instanceIndex);
    const i = id.mod(COLS);
    const j = id.div(COLS);
    return {
      id,
      i,
      j,
      x: float(i)
        .mul(du)
        .sub(WIDTH / 2),
      v: float(j).mul(dv)
    };
  };
  const at = (buffer: any, i: any, j: any) =>
    buffer.element(
      clampInt(j, ROWS - 1)
        .mul(COLS)
        .add(clampInt(i, COLS - 1))
    ).xyz as any;
  const held = (i: any, j: any) =>
    u.holding
      .greaterThan(0.5)
      .and(abs(float(i).sub(u.gi)).lessThanEqual(PATCH_I))
      .and(abs(float(j).sub(u.gj)).lessThanEqual(PATCH_J)) as any;
  // Where the hand may take the cloth: no further from the bolt than the cloth between them reaches.
  const reachable = () => {
    const anchor = anchorOf(u.gi.mul(du).sub(WIDTH / 2));
    const most = max(u.s.sub(u.gj.mul(dv)), 0.001) as any;
    const off = u.target.sub(anchor) as any;
    const far = length(off).max(1e-5) as any;
    return anchor.add(off.mul(min(far, most).div(far))) as any;
  };

  // The air the cloth moves through: a slow wandering eddy and a faint rise toward the light.
  const air = (p: any) => {
    const t = u.time as any;
    const q = p.mul(1.9) as any;
    const big = vec3(
      sin(
        q.y
          .mul(1.1)
          .add(t.mul(0.53))
          .add(sin(q.z.mul(0.9).sub(t.mul(0.29))).mul(1.4))
      ),
      sin(
        q.z
          .mul(1.2)
          .add(t.mul(0.41))
          .add(sin(q.x.mul(0.8).add(t.mul(0.23))).mul(1.4))
      ).mul(0.7),
      sin(
        q.x
          .mul(1.3)
          .sub(t.mul(0.47))
          .add(sin(q.y.mul(1.1).add(t.mul(0.31))).mul(1.4))
      )
    ) as any;
    const small = vec3(sin(q.z.mul(2.7).add(t.mul(0.9))), sin(q.x.mul(2.3).sub(t.mul(0.8))), sin(q.y.mul(2.9).add(t.mul(0.7)))).mul(0.45) as any;
    return big
      .add(small)
      .add(vec3(0, 0.08, 0))
      .mul(u.breeze) as any;
  };

  // Verlet: carry each free particle on with its speed, through air that drags hardest on cloth moving face first.
  const integrate = Fn(() => {
    const { id, i, j, x, v } = coords();
    If(v.greaterThanEqual(u.s), () => {
      A.element(id).assign(vec4(wound(x, v, u.s, u.lift), 1));
      prev.element(id).assign(vec4(wound(x, v, u.sPrev, u.liftPrev), 1));
    }).Else(() => {
      const p = A.element(id).xyz.toVar();
      const q = prev.element(id).xyz;
      const dt = u.dt;
      const vel = p.sub(q).mul(0.999).toVar();
      const across = at(A, i.add(1), j).sub(at(A, i.sub(1), j));
      const along = at(A, i, j.add(1)).sub(at(A, i, j.sub(1)));
      const n = normalize(across.cross(along).add(vec3(0, 1e-6, 0))) as any;
      const rel = vel.div(dt).sub(air(p)) as any;
      const acc = vec3(0, u.gravity.negate(), 0)
        .sub(n.mul(rel.dot(n)).mul(1.8))
        .sub(rel.mul(0.1))
        .toVar();
      // Drawn back softly past the bound.
      const off = p.sub(u.home);
      const far = length(off).max(1e-4);
      acc.subAssign(off.div(far).mul(far.sub(u.homeRadius).max(0).mul(3)));
      const next = p
        .add(vel)
        .add(acc.mul(dt.mul(dt)))
        .toVar();
      // Winding back: the cloth nearest the bolt is laid along the line it leaves by, so it goes on smooth.
      const left = u.s.sub(v);
      const guide = u.reel.mul(float(1).sub(smoothstep(0.05, 0.7, left))).mul(0.3);
      next.assign(mix(next, anchorOf(x).add(leaving().mul(left)), guide));
      If(held(i, j), () => {
        const k = j
          .sub(int(u.gj))
          .add(PATCH_J)
          .mul(PATCH_I * 2 + 1)
          .add(i.sub(int(u.gi)).add(PATCH_I));
        const want = reachable().add(offsets.element(k).xyz);
        next.assign(mix(p, want, float(1).sub(exp(dt.mul(-34)))));
      });
      prev.element(id).assign(vec4(p, 1));
      A.element(id).assign(vec4(next, 1));
    });
  });

  // The cloth's constraints, Jacobi style: every particle works out its own correction from all of its neighbours at
  // once (lengths to the four beside it, the four diagonals for shear, and the four two along to resist bending),
  // averaged and over-relaxed. Then two long-range tethers, each a single projection that no amount of iterations could
  // match: no particle may be further from where the cloth leaves the bolt, or from the hand, than the cloth between
  // them reaches. Last, the bolt itself pushes free cloth out.
  const NEIGHBOURS: [number, number, number][] = [];
  for (const [di, dj] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ])
    NEIGHBOURS.push([di, dj, 1]);
  for (const [di, dj] of [
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1]
  ])
    NEIGHBOURS.push([di, dj, 0.5]);
  for (const [di, dj] of [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2]
  ])
    NEIGHBOURS.push([di, dj, 0.15]);
  const solve = (src: any, dst: any) =>
    Fn(() => {
      const { id, i, j, x, v } = coords();
      const p = src.element(id).xyz.toVar();
      If(v.greaterThanEqual(u.s).or(held(i, j)), () => {
        dst.element(id).assign(vec4(p, 1));
      }).Else(() => {
        const sum = vec3(0).toVar();
        const weight = float(0).toVar();
        for (const [di, dj, stiff] of NEIGHBOURS) {
          const ni = i.add(di);
          const nj = j.add(dj);
          If(ni.greaterThanEqual(0).and(ni.lessThan(COLS)).and(nj.greaterThanEqual(0)).and(nj.lessThan(ROWS)), () => {
            const q = src.element(nj.mul(COLS).add(ni)).xyz;
            const d = p.sub(q);
            const len = length(d).max(1e-6);
            const rest = Math.hypot(di * du, dj * dv);
            const fixed = float(nj).mul(dv).greaterThanEqual(u.s).or(held(ni, nj));
            const share = select(fixed, float(1), float(0.5));
            // Cloth gives easily under compression and buckles into folds; it holds firm against stretch.
            const c = float(rest).sub(len).div(len).toVar();
            c.assign(select(c.greaterThan(0), c.mul(0.3), c));
            sum.addAssign(d.mul(c.mul(share).mul(stiff)));
            weight.addAssign(stiff);
          });
        }
        const next = p.add(sum.mul(float(1.45).div(weight.max(1)))).toVar();
        // Tether to the bolt.
        const anchor = anchorOf(x);
        const most = u.s.sub(v).mul(1.012).add(0.002);
        const off = next.sub(anchor).toVar();
        const far = length(off).max(1e-6);
        If(far.greaterThan(most), () => {
          next.assign(anchor.add(off.mul(most.div(far))));
        });
        // Tether to the hand.
        If(u.holding.greaterThan(0.5), () => {
          const g = reachable();
          const ai = float(i).sub(u.gi).mul(du) as any;
          const aj = float(j).sub(u.gj).mul(dv) as any;
          const reach = sqrt(ai.mul(ai).add(aj.mul(aj)))
            .mul(1.03)
            .add(0.01);
          const away = next.sub(g).toVar();
          const gap = length(away).max(1e-6);
          If(gap.greaterThan(reach), () => {
            next.assign(g.add(away.mul(reach.div(gap))));
          });
        });
        // The bolt: free cloth rests on it, never in it.
        const rel = next.sub(u.centre);
        const radial = length(rel.yz).max(1e-6);
        const outside = radiusNode(u.s).add(0.006);
        If(
          abs(rel.x)
            .lessThan(WIDTH / 2 + 0.03)
            .and(radial.lessThan(outside)),
          () => {
            next.assign(u.centre.add(vec3(rel.x, rel.yz.mul(outside.div(radial)))));
          }
        );
        dst.element(id).assign(vec4(next, 1));
      });
    })().compute(N);

  // Taking hold: the patch round the particle taken keeps its shape as it is now, relative to that particle.
  const takeHold = Fn(() => {
    const k = int(instanceIndex);
    const di = k.mod(PATCH_I * 2 + 1).sub(PATCH_I);
    const dj = k.div(PATCH_I * 2 + 1).sub(PATCH_J);
    const gi = int(u.gi);
    const gj = int(u.gj);
    offsets.element(k).assign(vec4(at(A, gi.add(di), gj.add(dj)).sub(at(A, gi, gj)), 0));
  })().compute(PATCH);

  // At rest: the loose end hanging straight down from the front of the bolt, everything else wound on.
  const reset = Fn(() => {
    const { id, x, v } = coords();
    const lifted = wound(x, v.max(u.s), u.s, u.lift);
    const hang = lifted.add(vec3(0, v.sub(u.s).min(0), 0)) as any;
    A.element(id).assign(vec4(hang, 1));
    prev.element(id).assign(vec4(hang, 1));
  })().compute(N);

  return {
    N,
    COLS,
    ROWS,
    du,
    dv,
    A,
    u,
    integrate: integrate().compute(N),
    forth: solve(A, B),
    back: solve(B, A),
    takeHold,
    reset
  };
}
