import * as THREE from "three/webgpu";
import {
  abs,
  atomicAdd,
  atomicLoad,
  atomicStore,
  atomicSub,
  bitNot,
  Break,
  ceil,
  countOneBits,
  countTrailingZeros,
  cross,
  dot,
  exp,
  float,
  floor,
  Fn,
  hash,
  If,
  instancedArray,
  instanceIndex,
  int,
  ivec3,
  length,
  Loop,
  max,
  min,
  normalize,
  select,
  sin,
  smoothstep,
  sqrt,
  storage,
  uint,
  uniform,
  uvec2,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { FORMS, REACH } from "./form";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// TSL's types do not model integer vectors from floats, nor every operator.
const ivec = ivec3 as any;

// Mathematical morphology on the graphics card: the sculpture is a set of cells in a G×G×G grid (G set at run time, up
// to the most the buffers were made for), one bit a cell, 32 cells to a word along x. Every operation works a word at a
// time: a word's neighbours along x are the word shifted by one bit (with the bit carried in from the next word), and
// along y and z they are the words of the neighbouring rows, so one thread wears or grows 32 cells at once with a
// handful of ANDs and ORs. Nothing comes back to the processor except a coarse map of where the sculpture is, for the
// pointer to land on, and a count of its cells.
//
//   erode   a cell goes if any cell under the element round it is empty: A ⊖ B
//   dilate  an empty cell fills if any cell under the element round it is full: A ⊕ B
//
// The element is a ball, approximated as libraries do by stepping with the cube (all 26 neighbours) and the cross (the
// 6 face neighbours) in turn, which grows an octagonal, nearly round reach.

// Room round the forms, a fifth again, for growing them out.
export const SPAN = (REACH * 1.2 + 0.07) * 2;
// The coarse map, for the pointer to land on, is about this many blocks a side.
export const COARSE = 64;
// The heat of fresh work (an erosion front smoulders, new growth glows) is kept on a coarse grid this many a side.
export const HEAT = 48;
const ONES = 0xffffffff;
// The bit of a cell's neighbour mask for each face's neighbour: −x, +x, −y, +y, −z, +z.
export const FACE_BITS = [12, 14, 10, 16, 4, 22];

export function createMorph(MAXG: number, capacity: number, pool: number) {
  const MAXW = Math.ceil(MAXG / 32);
  const MAXWORDS = MAXG * MAXG * MAXW;
  const MAXRMAX = Math.round(MAXG * 0.17);
  const MAXSPAN = MAXRMAX * 2 + 1;
  const MAXBW = Math.ceil(MAXSPAN / 32) + 1;
  const MAXBOX = MAXBW * MAXSPAN * MAXSPAN;
  const MAXBLOCK = Math.ceil(MAXG / COARSE);

  const grid = instancedArray(MAXWORDS, "uint") as any;
  // What a step decides for each word of the brush's box: the new word, and whether it applies.
  const changes = instancedArray(MAXBOX, "uvec2") as any;
  // The open faces of the surface, one entry each: cell, and which of its 26 neighbours are full with the face in the
  // top three bits. Drawing faces rather than cubes skips the faces that would only fold away.
  const list = instancedArray(capacity, "uvec2") as any;
  const args = new THREE.IndirectStorageBufferAttribute(new Uint32Array([6, 0, 0, 0, 0]), 1);
  const drawn = storage(args, "uint", 5).toAtomic() as any;
  // 0: how many ash motes have been let go, round the pool; 1: how many cells are full.
  const counterBuffer = new THREE.StorageBufferAttribute(new Uint32Array(4), 1);
  const counters = storage(counterBuffer, "uint", 4).toAtomic() as any;
  // How many cells each form has at the present resolution, counted as it is filled.
  const formCountBuffer = new THREE.StorageBufferAttribute(new Uint32Array(FORMS.length), 1);
  const formCounts = storage(formCountBuffer, "uint", FORMS.length).toAtomic() as any;
  // Where the pointer's line first meets the sculpture, in cells, with how far along it as w (negative for a miss).
  const hit = instancedArray(1, "vec4") as any;
  // Each mote, four rows: where it was let go and when; which way it was thrown and a random number; where it is now;
  // and how it is moving.
  const motes = instancedArray(pool * 4, "vec4") as any;
  const coarse = instancedArray(COARSE * COARSE * COARSE, "uint") as any;
  // Fresh erosion (x) and fresh growth (y), fading over a second or so.
  const heat = instancedArray(HEAT * HEAT * HEAT, "vec2") as any;

  const u = {
    // The grid as it is now: cells a side, words a row, and the numbers that follow from it.
    g: uniform(MAXG, "int"),
    w: uniform(MAXW, "int"),
    words: uniform(MAXWORDS, "int"),
    rmax: uniform(MAXRMAX, "int"),
    bw: uniform(MAXBW, "int"),
    span: uniform(MAXSPAN, "int"),
    block: uniform(MAXBLOCK, "int"),
    c: uniform(COARSE, "int"),
    cellSize: uniform(SPAN / MAXG),
    // Where a fill starts this frame, in words.
    fillFrom: uniform(0, "int"),
    // The pointer's line in grid cells.
    origin: uniform(new THREE.Vector3()),
    direction: uniform(new THREE.Vector3(0, 0, 1)),
    reach: uniform(14),
    // 1 to dilate, 0 to erode; 1 to step with the cube's neighbourhood, 0 with the cross's.
    dilate: uniform(0),
    cube: uniform(1),
    // When, in seconds, and how long this frame was.
    seconds: uniform(0),
    delta: uniform(1 / 60),
    // The sculpture's place in the world, for letting motes go where the cells were.
    toWorld: uniform(new THREE.Matrix4()),
    // How many of the lost cells let go a mote.
    shed: uniform(0.5),
    salt: uniform(0),
    form: uniform(0, "int"),
    // 0 or 1 by turns, a step at a time.
    parity: uniform(0),
    // How fast the air carries the dust.
    drift: uniform(1),
    // The hand: the pointer's line in the world, how it is moving, and whether it is in the air at all.
    handFrom: uniform(new THREE.Vector3()),
    handAlong: uniform(new THREE.Vector3(0, 0, -1)),
    handMove: uniform(new THREE.Vector3()),
    hand: uniform(0),
    // Whether the brush is at work this frame, for the heat.
    working: uniform(0)
  };

  const G = u.g as any;
  const W = u.w as any;
  const wordIndex = (wx: any, y: any, z: any) => z.mul(G).add(y).mul(W).add(wx);
  // A word, or nothing outside the grid.
  const wordAt = (wx: any, y: any, z: any) => {
    const inside = wx.greaterThanEqual(0).and(wx.lessThan(W)).and(y.greaterThanEqual(0)).and(y.lessThan(G)).and(z.greaterThanEqual(0)).and(z.lessThan(G)) as any;
    const i = wordIndex(wx.clamp(0, W.sub(1)), y.clamp(0, G.sub(1)), z.clamp(0, G.sub(1))) as any;
    return select(inside, grid.element(i), uint(0)) as any;
  };
  const centreOf = (c: any) => vec3(c).add(0.5).div(float(G)).sub(0.5).mul(SPAN);
  const cellBit = (c: any) =>
    wordAt(c.x.div(32), c.y, c.z)
      .shiftRight(uint(c.x.mod(32)))
      .bitAnd(uint(1)) as any;
  // Bits lo to hi of a word (0 to 31, lo ≤ hi).
  const bitsBetween = (lo: any, hi: any) =>
    uint(ONES)
      .shiftRight(uint(int(31).sub(hi)))
      .bitAnd(bitNot(uint(1).shiftLeft(uint(lo)).sub(1))) as any;
  // The cells of a row a word holds that lie within the grid's margin.
  const marginBits = (wx: any, y: any, z: any) => {
    const lo = (max as any)(int(3).sub(wx.mul(32)), int(0)) as any;
    const hi = (min as any)(G.sub(4).sub(wx.mul(32)), int(31)) as any;
    const rowIn = y
      .greaterThan(2)
      .and(y.lessThan(G.sub(3)))
      .and(z.greaterThan(2))
      .and(z.lessThan(G.sub(3))) as any;
    return select(rowIn.and(lo.lessThanEqual(hi)), bitsBetween(lo, hi), uint(0)) as any;
  };

  // The 3×3 rows round a word, each as its neighbours to the left (x - 1), itself, and to the right (x + 1).
  const neighbourhood = (wx: any, y: any, z: any) => {
    const rows: Record<string, { L: any; C: any; R: any }> = {};
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y.add(dy) as any;
        const zz = z.add(dz) as any;
        const prev = wordAt(wx.sub(1), yy, zz) as any;
        const cur = wordAt(wx, yy, zz).toVar() as any;
        const next = wordAt(wx.add(1), yy, zz) as any;
        rows[`${dy},${dz}`] = {
          L: cur
            .shiftLeft(uint(1))
            .bitOr(prev.shiftRight(uint(31)))
            .toVar(),
          C: cur,
          R: cur
            .shiftRight(uint(1))
            .bitOr(next.shiftLeft(uint(31)))
            .toVar()
        };
      }
    return rows;
  };

  // Every form, one bit a cell: each thread fills one word, and counts it. At the starting resolution all of it runs
  // while the page loads; after a change of resolution it runs a slice a frame. Switching form or restoring then only
  // copies words into the grid, which costs no more than a step.
  const shapes = instancedArray(FORMS.length * MAXWORDS, "uint") as any;
  const fills = FORMS.map((form, k) =>
    Fn(() => {
      const word = int(instanceIndex).add(u.fillFrom) as any;
      If(word.lessThan(u.words), () => {
        const wx = word.mod(W) as any;
        const row = word.div(W) as any;
        const y = row.mod(G) as any;
        const z = row.div(G) as any;
        const keep = marginBits(wx, y, z) as any;
        const bits = uint(0).toVar() as any;
        If(keep.notEqual(uint(0)), () => {
          Loop(32, ({ i }: any) => {
            If(keep.shiftRight(uint(i)).bitAnd(uint(1)).equal(uint(1)), () => {
              If(form.solid(centreOf(ivec(wx.mul(32).add(int(i)), y, z))).greaterThan(0.5), () => {
                bits.assign(bits.bitOr(uint(1).shiftLeft(uint(i))));
              });
            });
          });
        });
        shapes.element(word.add(u.words.mul(k))).assign(bits);
        atomicAdd(formCounts.element(k), countOneBits(bits));
      });
    })().compute(MAXWORDS)
  );
  const zeroCounts = Fn(() => {
    for (let k = 0; k < FORMS.length; k++) atomicStore(formCounts.element(k), uint(0));
  })().compute(1);

  // Bring the chosen form into the grid.
  const restore = Fn(() => {
    const word = int(instanceIndex) as any;
    grid.element(word).assign(shapes.element(u.form.mul(u.words).add(word)));
  })().compute(MAXWORDS);
  const recount = Fn(() => {
    atomicStore(counters.element(1), atomicLoad(formCounts.element(u.form)));
  })().compute(1);

  // Walk the pointer's line through the grid to the first full cell.
  const STEPS = Math.ceil((MAXG * 1.75) / 0.4);
  const aim = Fn(() => {
    const o = u.origin as any;
    const d = u.direction as any;
    const safe = (select as any)((abs(d) as any).lessThan(vec3(1e-6)), vec3(1e-6), d) as any;
    const a = vec3(1).sub(o).div(safe) as any;
    const b = vec3(float(G.sub(1)))
      .sub(o)
      .div(safe) as any;
    const near = min(a, b) as any;
    const far = max(a, b) as any;
    const from = max(max(near.x, near.y), max(near.z, float(0))) as any;
    const to = min(min(far.x, far.y), far.z) as any;
    const result = vec4(0, 0, 0, -1).toVar() as any;
    const t = from.toVar() as any;
    If(from.lessThan(to), () => {
      Loop(STEPS, () => {
        If(t.greaterThan(to), () => {
          Break();
        });
        const q = o.add(d.mul(t)) as any;
        const c = ivec(floor(q)).clamp(ivec(0), ivec(G.sub(1))) as any;
        If(cellBit(c).equal(uint(1)), () => {
          result.assign(vec4(q, t));
          Break();
        });
        t.addAssign(0.4);
      });
    });
    hit.element(0).assign(result);
  })().compute(1);

  // The word of the brush's box a thread looks after: the box spans the brush's reach, a few words wide and as many rows
  // high and deep as cells.
  const boxWord = (lid: any) => {
    const h = hit.element(0) as any;
    const S = u.span as any;
    const bx = lid.mod(u.bw) as any;
    const rest = lid.div(u.bw) as any;
    const wx = int(floor(h.x.sub(float(u.rmax)).div(32))).add(bx) as any;
    const y = int(floor(h.y)).sub(u.rmax).add(rest.mod(S)) as any;
    const z = int(floor(h.z)).sub(u.rmax).add(rest.div(S)) as any;
    const valid = h.w
      .greaterThanEqual(0)
      .and(wx.greaterThanEqual(0))
      .and(wx.lessThan(W))
      .and(y.greaterThan(1))
      .and(y.lessThan(G.sub(2)))
      .and(z.greaterThan(1))
      .and(z.lessThan(G.sub(2))) as any;
    return { h, wx, y, z, valid };
  };
  // The cells of a word within the brush: the ball meets a row of cells in one run, worked out directly. The outer
  // third of the reach works every other step, so a stroke leaves a fringe where the thin spots have holed through and
  // the thick have not: the lace between bitten and untouched.
  const brushBits = (h: any, wx: any, y: any, z: any) => {
    const reach = select(u.parity.lessThan(0.5), u.reach, u.reach.mul(0.66)) as any;
    const dy = float(y).add(0.5).sub(h.y) as any;
    const dz = float(z).add(0.5).sub(h.z) as any;
    const across = reach.mul(reach).sub(dy.mul(dy)).sub(dz.mul(dz)) as any;
    const half = sqrt(max(across, float(0))) as any;
    const lo = (max as any)(int(ceil(h.x.sub(half).sub(0.5))).sub(wx.mul(32)), int(0)) as any;
    const hi = (min as any)(int(floor(h.x.add(half).sub(0.5))).sub(wx.mul(32)), int(31)) as any;
    return select(across.greaterThan(0).and(lo.lessThanEqual(hi)), bitsBetween(lo, hi), uint(0)).bitAnd(marginBits(wx, y, z)) as any;
  };

  // One step, first worked out for every word in reach from the grid as it stands...
  const decide = Fn(() => {
    const lid = int(instanceIndex) as any;
    const { h, wx, y, z, valid } = boxWord(lid);
    const out = uvec2(0, 0).toVar() as any;
    If(valid, () => {
      const brush = brushBits(h, wx, y, z).toVar() as any;
      If(brush.notEqual(uint(0)), () => {
        const n = neighbourhood(wx, y, z);
        const c = n["0,0"].C as any;
        // Cross: the six face neighbours. Cube: all twenty-six.
        const crossAll = n["0,0"].L.bitAnd(n["0,0"].R).bitAnd(n["-1,0"].C).bitAnd(n["1,0"].C).bitAnd(n["0,-1"].C).bitAnd(n["0,1"].C) as any;
        const crossAny = n["0,0"].L.bitOr(n["0,0"].R).bitOr(n["-1,0"].C).bitOr(n["1,0"].C).bitOr(n["0,-1"].C).bitOr(n["0,1"].C) as any;
        let cubeAll: any = uint(ONES);
        let cubeAny: any = uint(0);
        for (const r of Object.values(n)) {
          cubeAll = cubeAll.bitAnd(r.L).bitAnd(r.C).bitAnd(r.R);
          cubeAny = cubeAny.bitOr(r.L).bitOr(r.C).bitOr(r.R);
        }
        const useCube = u.cube.greaterThan(0.5) as any;
        const allFull = select(useCube, cubeAll, crossAll) as any;
        const anyFull = select(useCube, cubeAny, crossAny) as any;
        If(u.dilate.lessThan(0.5), () => {
          // Erode: a cell in reach stays only if everything round it is full.
          out.assign(uvec2(c.bitAnd(bitNot(brush).bitOr(allFull)), 1));
        }).Else(() => {
          // Grow: an empty cell in reach fills if anything round it is full, anywhere, as far as you like, up to the room
          // the grid has: a ball inside it whose outer part fills ever more sparsely, so a build-up frays into the air
          // rather than meeting a wall.
          const grow = anyFull.bitAnd(bitNot(c)).bitAnd(brush).toVar() as any;
          const keep = grow.toVar() as any;
          Loop(32, () => {
            If(keep.equal(uint(0)), () => {
              Break();
            });
            const i = countTrailingZeros(keep) as any;
            keep.assign(keep.bitAnd(keep.sub(1)));
            const cell = vec3(float(wx.mul(32).add(int(i))), float(y), float(z)).add(0.5) as any;
            const room = length(cell.sub(float(G).mul(0.5))).div(float(G).mul(0.5).sub(4)) as any;
            const id = wordIndex(wx, y, z).mul(32).add(int(i)) as any;
            If(hash(uint(id).add(uint(u.salt))).lessThan(smoothstep(0.84, 1, room)), () => {
              grow.assign(grow.bitAnd(bitNot(uint(1).shiftLeft(uint(i)))));
            });
          });
          out.assign(uvec2(c.bitOr(grow), 1));
        });
      });
    });
    changes.element(lid).assign(out);
  })().compute(MAXBOX);

  // ...then written back, each lost cell letting go a mote of ash, thrown out from the brush.
  const apply = Fn(() => {
    const lid = int(instanceIndex) as any;
    const change = changes.element(lid) as any;
    If(change.y.equal(uint(1)), () => {
      const { h, wx, y, z } = boxWord(lid);
      const i0 = wordIndex(wx, y, z) as any;
      const old = grid.element(i0).toVar() as any;
      const next = change.x as any;
      If(next.notEqual(old), () => {
        grid.element(i0).assign(next);
        const lost = old.bitAnd(bitNot(next)).toVar() as any;
        const gained = next.bitAnd(bitNot(old)) as any;
        atomicAdd(counters.element(1), countOneBits(gained));
        atomicSub(counters.element(1), countOneBits(lost));
        Loop(32, () => {
          If(lost.equal(uint(0)), () => {
            Break();
          });
          const i = countTrailingZeros(lost) as any;
          lost.assign(lost.bitAnd(lost.sub(1)));
          const id = i0.mul(32).add(int(i)) as any;
          If(hash(uint(id).add(uint(u.salt))).lessThan(u.shed), () => {
            const slot = (atomicAdd(counters.element(0), uint(1)) as any).mod(uint(pool)) as any;
            const row = int(slot).mul(4) as any;
            const c = ivec(wx.mul(32).add(int(i)), y, z) as any;
            const centre = centreOf(c) as any;
            const away = normalize(
              vec3(c)
                .add(0.5)
                .sub(h.xyz)
                .add(vec3(0, 0.001, 0))
            ) as any;
            const world = u.toWorld.mul(vec4(centre, 1)).xyz as any;
            const thrown = normalize(u.toWorld.mul(vec4(away, 0)).xyz) as any;
            const seed = hash(uint(id).add(uint(7))) as any;
            motes.element(row).assign(vec4(world, u.seconds));
            motes.element(row.add(1)).assign(vec4(thrown, seed));
            motes.element(row.add(2)).assign(vec4(world, 0));
            motes.element(row.add(3)).assign(vec4(thrown.mul(seed.mul(0.45).add(0.25)), 0));
          });
        });
      });
    });
  })().compute(MAXBOX);

  // The heat of fresh work, on its coarse grid: each frame it fades, and where the brush is working it is lit, as
  // erosion (x) or growth (y).
  const warm = Fn(() => {
    const id = int(instanceIndex) as any;
    const at = vec3(id.mod(HEAT), id.div(HEAT).mod(HEAT), id.div(HEAT * HEAT))
      .add(0.5)
      .div(HEAT)
      .mul(float(G)) as any;
    const h = hit.element(0) as any;
    const fade = exp(u.delta.div(-0.45)) as any;
    const now = heat.element(id).mul(fade).toVar() as any;
    If(h.w.greaterThanEqual(0).and(u.working.greaterThan(0.5)), () => {
      const d = length(at.sub(h.xyz)) as any;
      const near = float(1).sub(smoothstep(u.reach.mul(0.7), u.reach.add(float(G).div(HEAT).mul(1.5)), d)) as any;
      now.assign(select(u.dilate.lessThan(0.5), vec2(max(now.x, near), now.y), vec2(now.x, max(now.y, near))));
    });
    heat.element(id).assign(now);
  })().compute(HEAT * HEAT * HEAT);

  // The dust in the air, a step a frame: each mote is carried by the air (a slow drift up and toward the light, turning
  // in eddies), slowed by it after the throw, and pushed by the hand: the pointer's line sweeps the air round it along
  // with it and stirs a little swirl, as a hand waved through smoke does. Fresh dust, under half a second old, is left
  // be, so a stroke does not blow away its own.
  const drift = Fn(() => {
    const row = int(instanceIndex).mul(4) as any;
    const born = motes.element(row) as any;
    const age = u.seconds.sub(born.w) as any;
    If(age.greaterThanEqual(0).and(age.lessThan(45)), () => {
      const p = motes.element(row.add(2)).xyz.toVar() as any;
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
      v.addAssign(air.sub(v).mul(float(1).sub(exp(u.delta.mul(-1.5)))));
      If(age.greaterThan(0.5).and(u.hand.greaterThan(0.5)), () => {
        const rel = p.sub(u.handFrom) as any;
        const off = rel.sub(u.handAlong.mul(dot(rel, u.handAlong))) as any;
        const d = length(off) as any;
        // Fresh dust takes half a second to come loose, and a third more to answer fully.
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
      motes.element(row.add(2)).assign(vec4(p, 0));
      motes.element(row.add(3)).assign(vec4(v, 0));
    });
  })().compute(pool);

  // List the open faces of the surface for drawing, a word at a time: the surface bits
  // come from one AND of the word's six face neighbours, and each surface cell's 26-neighbour mask from the 27 words
  // already in hand.
  const clear = Fn(() => {
    atomicStore(drawn.element(1), uint(0));
  })().compute(1);
  const gather = Fn(() => {
    const word = int(instanceIndex) as any;
    const c = grid.element(word).toVar() as any;
    If(c.notEqual(uint(0)), () => {
      const wx = word.mod(W) as any;
      const row = word.div(W) as any;
      const y = row.mod(G) as any;
      const z = row.div(G) as any;
      const n = neighbourhood(wx, y, z);
      const inner = n["0,0"].L.bitAnd(n["0,0"].R).bitAnd(n["-1,0"].C).bitAnd(n["1,0"].C).bitAnd(n["0,-1"].C).bitAnd(n["0,1"].C) as any;
      const surface = c.bitAnd(bitNot(inner)).toVar() as any;
      Loop(32, () => {
        If(surface.equal(uint(0)), () => {
          Break();
        });
        const i = (uint as any)(countTrailingZeros(surface)).toVar() as any;
        surface.assign(surface.bitAnd(surface.sub(1)));
        let mask: any = uint(0);
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++) {
            const r = n[`${dy},${dz}`];
            const base = (dy + 1) * 3 + (dz + 1) * 9;
            mask = mask
              .bitOr(r.L.shiftRight(i).bitAnd(uint(1)).shiftLeft(uint(base)))
              .bitOr(
                r.C.shiftRight(i)
                  .bitAnd(uint(1))
                  .shiftLeft(uint(base + 1))
              )
              .bitOr(
                r.R.shiftRight(i)
                  .bitAnd(uint(1))
                  .shiftLeft(uint(base + 2))
              );
          }
        // One entry for each open face, its direction (−x, +x, −y, +y, −z, +z) in the top three bits.
        const id = uint(z.mul(G).add(y).mul(G).add(wx.mul(32)).add(int(i))).toVar() as any;
        const neighbours = mask.toVar() as any;
        FACE_BITS.forEach((bit, face) => {
          If(neighbours.shiftRight(uint(bit)).bitAnd(uint(1)).equal(uint(0)), () => {
            const slot = (atomicAdd(drawn.element(1), uint(1)) as any).toVar();
            If(slot.lessThan(uint(capacity)), () => {
              list.element(slot).assign(uvec2(id, neighbours.bitOr(uint(face << 27))));
            });
          });
        });
      });
    });
  })().compute(MAXWORDS);
  // Never draw past the end of the list.
  const cap = Fn(() => {
    const n = (atomicAdd(drawn.element(1), uint(0)) as any).toVar();
    atomicStore(drawn.element(1), (min as any)(n, uint(capacity)));
  })().compute(1);

  // The coarse map, one cell a block of cells, for the pointer to land on.
  const shrink = Fn(() => {
    const id = int(instanceIndex) as any;
    const C = u.c as any;
    const B = u.block as any;
    const b = ivec(id.mod(C), id.div(C).mod(C), id.div(C.mul(C))).mul(B) as any;
    const any = uint(0).toVar() as any;
    // The block's run along x, within its one or two words.
    const x0 = b.x as any;
    const x1 = min(b.x.add(B).sub(1), G.sub(1)) as any;
    Loop(MAXBLOCK, ({ i: dz }: any) => {
      Loop(MAXBLOCK, ({ i: dy }: any) => {
        const yy = b.y.add(int(dy)) as any;
        const zz = b.z.add(int(dz)) as any;
        If(int(dy).lessThan(B).and(int(dz).lessThan(B)), () => {
          const w0 = x0.div(32) as any;
          const w1 = x1.div(32) as any;
          const first = wordAt(w0, yy, zz).bitAnd(bitsBetween(x0.mod(32), select(w0.equal(w1), x1.mod(32), int(31)))) as any;
          const second = select(w1.greaterThan(w0), wordAt(w1, yy, zz).bitAnd(bitsBetween(int(0), x1.mod(32))), uint(0)) as any;
          any.assign(any.bitOr(first).bitOr(second));
        });
      });
    });
    coarse.element(id).assign(select(any.notEqual(uint(0)), uint(1), uint(0)));
  })().compute(COARSE * COARSE * COARSE);

  // Motes all start long dead.
  {
    const array = motes.value.array as Float32Array;
    for (let i = 0; i < pool; i++) array[i * 16 + 3] = -1000;
  }

  // Set the grid to G cells a side: only uniforms and how many threads each pass runs.
  const size = { G: MAXG, W: MAXW, WORDS: MAXWORDS, C: COARSE, BLOCK: MAXBLOCK, RMAX: MAXRMAX };
  const resize = (next: number) => {
    const G2 = Math.min(next, MAXG);
    const w = Math.ceil(G2 / 32);
    const rmax = Math.round(G2 * 0.17);
    const span = rmax * 2 + 1;
    const bw = Math.ceil(span / 32) + 1;
    const block = Math.ceil(G2 / COARSE);
    const C = Math.ceil(G2 / block);
    Object.assign(size, { G: G2, W: w, WORDS: G2 * G2 * w, C, BLOCK: block, RMAX: rmax });
    u.g.value = G2;
    u.w.value = w;
    u.words.value = size.WORDS;
    u.rmax.value = rmax;
    u.span.value = span;
    u.bw.value = bw;
    u.block.value = block;
    u.c.value = C;
    u.cellSize.value = SPAN / G2;
    restore.count = size.WORDS;
    gather.count = size.WORDS;
    decide.count = bw * span * span;
    apply.count = bw * span * span;
    shrink.count = C * C * C;
  };
  // Fill words [from, from + count) of one form.
  const fillSlice = (k: number, from: number, count: number) => {
    u.fillFrom.value = from;
    fills[k].count = Math.max(1, Math.min(count, size.WORDS - from));
    return fills[k];
  };

  // GPU memory these buffers take, in bytes, for the report.
  const bytes = 4 * (MAXWORDS * (1 + FORMS.length) + MAXBOX * 2 + capacity * 2 + pool * 16 + COARSE ** 3 + HEAT ** 3 * 2);

  return {
    MAXG,
    size,
    bytes,
    resize,
    fillSlice,
    capacity,
    pool,
    grid,
    list,
    args,
    motes,
    hit,
    heat,
    coarse,
    shapes,
    counterBuffer,
    formCountBuffer,
    u,
    passes: { zeroCounts, restore, recount, aim, decide, apply, warm, drift, clear, gather, cap, shrink }
  };
}

export type Morph = ReturnType<typeof createMorph>;
