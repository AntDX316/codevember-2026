"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, atan, cameraPosition, clamp, cos, dot, exp, float, Fn, If, int, Loop, Break, length, max, min, mix, normalize, positionWorld, pow, reflect, select, sin, smoothstep, sqrt, texture, uniform, uniformArray, vec2, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { filmTable } from "./film";
import { bakedBare, bakedNode, bakeField, BOUNDS, fieldNode, gustNode, slack } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The hall of mirrors, traced per pixel. The room is a prism of smoked mirror walls standing on a black polished
// floor under one round softbox. Every pixel's ray leaves the eye and is followed off wall after wall (and the floor),
// meeting the bubble anew on each leg, so the copies are true reflections, not pictures of pictures. Each leg sees the
// bubble as it was a beat earlier, so a pop runs out through the copies ring by ring, the way its sound echoes back.

// The room: the walls' distance from the middle, the floor, the ceiling, and the softbox's radius.
export const APOTHEM = 5;
export const FLOOR = -2.3;
const CEIL = 2.9;
const LIGHT = 0.85;
// Where the bubble floats, and how it sways: the processor's picking uses the same.
export const CENTRE_Y = 0.2;
export const bob = (time: number) => CENTRE_Y + 0.05 * Math.sin(time * 0.8);
export const yaw = (time: number) => 0.09 * Math.sin(time * 0.31) + 0.03 * Math.sin(time * 0.73);
// Each reflection is this much later than the last, in seconds.
export const DELAY = 0.42;
// The most legs a ray is followed for, and droplets a pop sheds.
export const MOST_BOUNCES = 11;
export const DROPS = 28;
// How fast the tear's rim races across the letters (their own units a second), and the shockwave through the air.
export const TEAR = 3.4;
const WAVE = 7.5;
export const GRAVITY = 2.6;
export const DROP_LIFE = 1.7;

export const room = {
  now: uniform(0) as any,
  sides: uniform(6) as any,
  bounces: uniform(9) as any,
  // Radians across one pixel, for softening edges by how big a pixel is where a ray lands.
  pixel: uniform(0.001) as any,
  // Per reflection: scale (negative once the film is all gone), pop age (below 0 while whole), wobble, plumpness; then
  // where it popped, and which set of drops.
  shape: uniformArray(
    Array.from({ length: MOST_BOUNCES }, () => new THREE.Vector4(1, -1, 0.2, 0)),
    "vec4"
  ) as any,
  popAt: uniformArray(
    Array.from({ length: MOST_BOUNCES }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  ) as any,
  // Two sets of droplets, so a new pop never rewrites the one still running out through the far copies.
  dropAt: uniformArray(
    Array.from({ length: DROPS * 2 }, () => new THREE.Vector4(0, 0, 0, 99)),
    "vec4"
  ) as any,
  dropVel: uniformArray(
    Array.from({ length: DROPS * 2 }, () => new THREE.Vector4(0, 0, 0, 0.01)),
    "vec4"
  ) as any,
  // Per reflection, a sphere round all its droplets live at that moment (radius 0 when none are), worked out on the
  // processor each frame, so rays that pass wide of it skip testing the droplets one by one.
  dropBound: uniformArray(
    Array.from({ length: MOST_BOUNCES }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  ) as any,
  // 1 draws the bubble's normals as colour.
  debug: uniform(0) as any
};

// A vector turned about the vertical by `a`.
const turn = (v: any, a: any) => {
  const c = cos(a) as any;
  const s = sin(a) as any;
  return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
};

const erf = (x: any) => {
  const x2 = x.mul(x) as any;
  const k = x2.mul(0.147).add(1) as any;
  return sqrt(float(1).sub(exp(x2.negate().mul(x2.mul(0.147).add(4 / Math.PI)).div(k)))).mul(select(x.lessThan(0), float(-1), float(1)));
};

const LAMP = vec3(1, 0.93, 0.84);

// The softbox seen from below at a distance r from its middle, with its glow on the ceiling round it.
const softbox = (r: any, soft: any) => {
  const disc = smoothstep(soft.add(LIGHT), float(LIGHT - 0.04).sub(soft), r) as any;
  const core = float(1).sub(r.div(LIGHT).mul(r.div(LIGHT)).mul(0.35)) as any;
  const rim = exp(r.sub(LIGHT + 0.06).div(0.05).pow(2).negate()) as any;
  return LAMP.mul(disc.mul(core).mul(6).add(rim.mul(0.4)).add(exp(r.mul(r).mul(-0.35)).mul(0.035)).add(0.004));
};

// The pool of light the softbox throws on the floor.
const pool = (r: any) => exp(r.mul(r).mul(-0.16)).mul(0.07).add(0.004);

// What the film mirrors, cheaply: the softbox overhead, a band of its copies round the walls up high, the dim green of
// the smoked glass, the dark seams between panels, and the lit pool on the floor below.
const surroundings = (from: any, dir: any) => {
  const up = dir.y as any;
  const atCeil = from.xz.add(dir.xz.mul(float(CEIL).sub(from.y).div(max(up, float(0.02))))) as any;
  const atFloor = from.xz.add(dir.xz.mul(from.y.sub(FLOOR).div(max(up.negate(), float(0.02))))) as any;
  const ceil = softbox(length(atCeil), float(0.08)) as any;
  const floor = vec3(pool(length(atFloor))).mul(1.6) as any;
  const seam = smoothstep(0.93, 0.985, cos(atan(dir.x, dir.z).mul(room.sides)).negate()) as any;
  // The softbox's copies in the walls sit in rings closing on the horizon.
  const band = exp(up.sub(0.31).div(0.07).pow(2).negate())
    .mul(0.8)
    .add(exp(up.sub(0.16).div(0.04).pow(2).negate()).mul(0.4))
    .add(exp(up.sub(0.105).div(0.03).pow(2).negate()).mul(0.2)) as any;
  const glass = vec3(0.02, 0.032, 0.03).add(LAMP.mul(band)).mul(float(1).sub(seam.mul(0.85))) as any;
  const onCeil = smoothstep(APOTHEM * 1.1, APOTHEM * 0.85, length(atCeil)).mul(smoothstep(0, 0.05, up)) as any;
  const onFloor = smoothstep(APOTHEM * 1.1, APOTHEM * 0.85, length(atFloor)).mul(smoothstep(0, -0.05, up)) as any;
  return mix(mix(glass, ceil, onCeil), floor, onFloor);
};

export function makeRoom() {
  const table = filmTable();
  const baked = bakeField(120, 84, 36);

  const sdf = Fn(([p, fat, wobble, time]: any[]) => fieldNode(p, fat, wobble, time)) as any;
  const normalAt = Fn(([p, fat, wobble, time]: any[]) => {
    const e = 0.002;
    const a = vec3(e, -e, -e) as any;
    const b = vec3(-e, -e, e) as any;
    const c = vec3(-e, e, -e) as any;
    const d = vec3(e, e, e) as any;
    return normalize(
      a
        .mul(sdf(p.add(a), fat, wobble, time))
        .add(b.mul(sdf(p.add(b), fat, wobble, time)))
        .add(c.mul(sdf(p.add(c), fat, wobble, time)))
        .add(d.mul(sdf(p.add(d), fat, wobble, time)))
        .add(vec3(0, 0, 1e-7))
    );
  }) as any;

  // The same from the baked samples, for the reflections, where a hit is a few pixels across.
  const normalBaked = Fn(([p, fat, wobble, time]: any[]) => {
    const e = 0.012;
    const a = vec3(e, -e, -e) as any;
    const b = vec3(-e, -e, e) as any;
    const c = vec3(-e, e, -e) as any;
    const d = vec3(e, e, e) as any;
    const at = (q: any) => bakedNode(baked, q, fat, wobble, time);
    return normalize(a.mul(at(p.add(a))).add(b.mul(at(p.add(b)))).add(c.mul(at(p.add(c)))).add(d.mul(at(p.add(d)))).add(vec3(0, 0, 1e-7)));
  }) as any;

  const trace = Fn(() => {
    const ro = vec3(cameraPosition).toVar() as any;
    const rd = normalize(positionWorld.sub(cameraPosition)).toVar() as any;
    const colour = vec3(0).toVar() as any;
    const through = vec3(1).toVar() as any;
    const travelled = float(0).toVar() as any;
    const sides = int(room.sides) as any;
    const half = float(Math.PI).div(room.sides) as any;
    const halfSide = float(APOTHEM).mul(sin(half).div(cos(half))) as any;

    // Every loop is named: nested loops otherwise all count in `i`, and the inner one hides the outer's.
    Loop({ start: int(0), end: int(room.bounces), type: "int", name: "leg" } as any, ({ leg: i }: any) => {
      const shape = room.shape.element(i).toVar() as any;
      const popAt = room.popAt.element(i).toVar() as any;
      const time = room.now.sub(float(i).mul(DELAY)).toVar() as any;

      // The way out of the room: the nearest of the walls ahead, the floor or the ceiling.
      const far = float(1e4).toVar() as any;
      const facing = vec3(0, 1, 0).toVar() as any;
      const kind = int(0).toVar() as any;
      const along = vec3(1, 0, 0).toVar() as any;
      Loop({ start: int(0), end: sides, type: "int", name: "side" } as any, ({ side: k }: any) => {
        const a = float(k).mul(half.mul(2)) as any;
        const n = vec3(sin(a), 0, cos(a)) as any;
        const dn = dot(rd, n) as any;
        const t = float(APOTHEM).sub(dot(ro, n)).div(max(dn, float(1e-5))) as any;
        If(dn.greaterThan(1e-5).and(t.lessThan(far)), () => {
          far.assign(t);
          facing.assign(n);
          along.assign(vec3(cos(a), 0, sin(a).negate()));
        });
      });
      If(rd.y.lessThan(0), () => {
        const t = float(FLOOR).sub(ro.y).div(rd.y) as any;
        If(t.lessThan(far), () => {
          far.assign(t);
          facing.assign(vec3(0, -1, 0));
          kind.assign(1);
        });
      }).Else(() => {
        const t = float(CEIL).sub(ro.y).div(max(rd.y, float(1e-5))) as any;
        If(t.lessThan(far), () => {
          far.assign(t);
          facing.assign(vec3(0, 1, 0));
          kind.assign(2);
        });
      });

      // Light in the air: a soft column under the softbox, stirred by slow smoke; a faint haze everywhere; and a low mist
      // lying on the floor, lit by the pool, that the mirrors carry off to every copy of the room.
      {
        const w2 = 1.05 * 1.05;
        const A = max(dot(rd.xz, rd.xz), float(1e-4)).div(w2) as any;
        const B = dot(ro.xz, rd.xz).mul(2).div(w2) as any;
        const C = dot(ro.xz, ro.xz).div(w2) as any;
        const sa = sqrt(A) as any;
        const mid = B.div(A.mul(2)) as any;
        const shaft = exp(B.mul(B).div(A.mul(4)).sub(C).min(0))
          .mul(0.8862)
          .div(sa)
          .mul(erf(sa.mul(far.add(mid))).sub(erf(sa.mul(mid)))) as any;
        const fog = exp(far.mul(-0.035)) as any;
        // The smoke, sampled where this leg passes closest to the column's axis.
        const now = room.now as any;
        const q = ro.add(rd.mul(clamp(mid.negate(), 0, far))) as any;
        const curl = sin(q.x.mul(3.1).add(now.mul(0.2)).add(q.y.mul(0.7))).mul(1.5) as any;
        const smoke = sin(q.y.mul(2.3).add(curl).sub(now.mul(0.35)))
          .mul(sin(q.z.mul(2.7).add(q.y.mul(1.1)).add(now.mul(0.27))))
          .mul(0.45)
          .add(0.75) as any;
        // Mist: density falling off with height above the floor, summed exactly along the leg.
        const H = 0.55;
        const dy = rd.y as any;
        const low = exp(ro.y.sub(FLOOR).div(-H)) as any;
        const flat = abs(dy).lessThan(1e-3) as any;
        const mist = low.mul(select(flat, far, float(H).div(dy.add(1e-7)).mul(float(1).sub(exp(dy.mul(far).div(-H)))))) as any;
        const mid2 = ro.add(rd.mul(far.mul(0.5))) as any;
        const swirl = sin(mid2.x.mul(0.9).add(now.mul(0.12)).add(sin(mid2.z.mul(1.3).sub(now.mul(0.09))).mul(1.6)))
          .mul(0.35)
          .add(0.8) as any;
        const mistLight = vec3(0.6, 0.66, 0.7).mul(0.012).add(LAMP.mul(pool(length(mid2.xz)).mul(0.25))) as any;
        colour.addAssign(
          through
            .mul(LAMP.mul(shaft.mul(0.02).mul(smoke)).add(vec3(0.0011, 0.0015, 0.0017).mul(far)).add(mistLight.mul(mist.mul(swirl))))
            .mul(fog.mul(0.5).add(0.5))
        );
      }

      // The bubble, as it was this many beats ago.
      If(shape.x.greaterThan(0.01), () => {
        const scale = shape.x as any;
        const centre = vec3(0, sin(time.mul(0.8)).mul(0.05).add(CENTRE_Y), 0) as any;
        const swing = sin(time.mul(0.31)).mul(0.09).add(sin(time.mul(0.73)).mul(0.03)) as any;
        const ol = turn(ro.sub(centre), swing.negate()).div(scale).toVar() as any;
        const dl = turn(rd, swing.negate()).toVar() as any;
        const inv = vec3(1).div(dl.add(vec3(1e-6))) as any;
        const t1 = vec3(BOUNDS).negate().sub(ol).mul(inv) as any;
        const t2 = vec3(BOUNDS).sub(ol).mul(inv) as any;
        const tn = min(t1, t2) as any;
        const tf = max(t1, t2) as any;
        const enter = max(max(tn.x, max(tn.y, tn.z)), float(0)) as any;
        const leave = min(min(tf.x, min(tf.y, tf.z)), far.div(scale)) as any;
        If(enter.lessThan(leave), () => {
          const t = enter.toVar() as any;
          const hits = int(0).toVar() as any;
          const popped = shape.y.greaterThanEqual(0) as any;
          const rimAt = shape.y.mul(TEAR) as any;
          const budget = int(max(float(22), float(68).sub(float(i).mul(10)))) as any;
          const most = select(i.lessThan(2), int(4), int(2)) as any;
          const gust = gustNode(time).toVar() as any;
          const loose = slack(shape.z, gust).toVar() as any;
          Loop({ start: int(0), end: budget, type: "int", name: "step" } as any, () => {
            If(t.greaterThan(leave), () => {
              Break();
            });
            const p = ol.add(dl.mul(t)).toVar() as any;
            // Far from the film, a safe short step from the bare distance; close in, the full blown and wobbled one.
            const d = abs(bakedBare(baked, p, shape.w)).toVar() as any;
            If(d.lessThan(loose.add(0.03)), () => {
              d.assign(abs(bakedNode(baked, p, shape.w, shape.z, time, gust)));
            }).Else(() => {
              d.subAssign(loose);
            });
            const eps = max(travelled.add(t.mul(scale)).mul(room.pixel).mul(0.5).div(scale), float(0.0008)) as any;
            If(d.lessThan(eps), () => {
              const n = vec3(0, 0, 1).toVar() as any;
              If(i.equal(0), () => {
                n.assign(normalAt(p, shape.w, shape.z, time));
              }).Else(() => {
                n.assign(normalBaked(p, shape.w, shape.z, time));
              });
              const front = select(popped, length(p.sub(popAt.xyz)).sub(rimAt), float(9)) as any;
              If(front.greaterThan(-0.045), () => {
                const toward = select(dot(n, dl).greaterThan(0), n.negate(), n) as any;
                const cosi = clamp(dot(toward, dl.negate()), 0, 1) as any;
                // The film's thickness: drained thin at the crown, thick below, marbled by a slow swirl, stretched thin
                // as it is pumped, and pulled to black film just ahead of the tear.
                const warp = sin(p.x.mul(1.3).add(sin(p.y.mul(1.9).sub(time.mul(0.23))).mul(1.6)).add(time.mul(0.17)))
                  .mul(sin(p.y.mul(1.1).add(sin(p.z.mul(3.1).add(p.x.mul(1.4)).add(time.mul(0.29))).mul(1.4)).sub(time.mul(0.11)))) as any;
                const swirl = sin(p.x.mul(2.7).add(warp.mul(2.6)).add(p.z.mul(1.9)).sub(time.mul(0.21)))
                  .mul(sin(p.y.mul(2.3).sub(warp.mul(2.1)).add(time.mul(0.33))))
                  .mul(0.8) as any;
                const nm = mix(float(1050), float(240), smoothstep(-1.2, 1.2, p.y))
                  .add(swirl.mul(380))
                  .add(warp.mul(160))
                  .mul(float(1).sub(shape.w.mul(1.2)))
                  .mul(smoothstep(0, 0.6, front).mul(0.93).add(0.07)) as any;
                const film = texture(table.texture, vec2(clamp(nm.div(table.most), 0.001, 0.999), cosi)).level(float(0)).rgb as any;
                const out = turn(reflect(dl, toward), swing) as any;
                const at = ro.add(rd.mul(t.mul(scale))) as any;
                const seen = surroundings(at, out) as any;
                const whole = smoothstep(-0.005, 0.012, front) as any;
                const rim = exp(front.add(0.012).div(0.022).pow(2).negate()) as any;
                const beads = sin(p.x.mul(23).add(p.y.mul(19)).add(p.z.mul(17))).mul(0.15).add(0.9) as any;
                const lit = film.mul(seen).mul(2.2).mul(whole).add(seen.mul(0.25).add(vec3(0.85, 0.9, 1).mul(0.6)).mul(rim.mul(beads))) as any;
                colour.addAssign(through.mul(lit));
                through.mulAssign(float(1).sub(film.g.mul(0.7).add(rim.mul(0.5)).mul(whole.max(rim)).min(0.8)));
                If(room.debug.greaterThan(0.5).and(i.equal(0)).and(hits.equal(0)), () => {
                  colour.assign(n.mul(0.5).add(0.5));
                  through.assign(vec3(0));
                });
                hits.addAssign(1);
              });
              t.addAssign(0.045);
              If(hits.greaterThanEqual(most), () => {
                Break();
              });
            }).Else(() => {
              t.addAssign(max(d, eps.mul(0.5)));
            });
          });
        });
      });

      // The pop's spray: droplets flung off the rim, glinting, falling. And the shockwave, a ring of bent light round it.
      const bound = room.dropBound.element(i) as any;
      const nearest = clamp(dot(bound.xyz.sub(ro), rd), 0, far) as any;
      const wide = length(ro.add(rd.mul(nearest)).sub(bound.xyz)) as any;
      If(shape.y.greaterThanEqual(0).and(shape.y.lessThan(DROP_LIFE + 0.8)).and(wide.lessThan(bound.w)), () => {
        const scale = abs(shape.x) as any;
        const centre = vec3(0, sin(time.mul(0.8)).mul(0.05).add(CENTRE_Y), 0) as any;
        const swing = sin(time.mul(0.31)).mul(0.09).add(sin(time.mul(0.73)).mul(0.03)) as any;
        const base = int(popAt.w).mul(DROPS) as any;
        Loop({ start: int(0), end: int(DROPS), type: "int", name: "drop" } as any, ({ drop: k }: any) => {
          const at = room.dropAt.element(base.add(k)) as any;
          const vel = room.dropVel.element(base.add(k)) as any;
          const age = shape.y.sub(at.w) as any;
          If(age.greaterThan(0).and(age.lessThan(DROP_LIFE)), () => {
            const pos = centre
              .add(turn(at.xyz, swing).mul(scale))
              .add(vel.xyz.mul(age))
              .add(vec3(0, age.mul(age).mul(-0.5 * GRAVITY), 0)) as any;
            const tc = clamp(dot(pos.sub(ro), rd), 0, far) as any;
            const miss = length(ro.add(rd.mul(tc)).sub(pos)) as any;
            const foot = travelled.add(tc).mul(room.pixel).mul(1.3) as any;
            const r = max(vel.w, foot) as any;
            const glint = vel.w.div(r).pow(2).mul(exp(miss.div(r).pow(2).mul(-2.5))) as any;
            const fade = smoothstep(DROP_LIFE, DROP_LIFE * 0.4, age).mul(smoothstep(0, 0.05, age)) as any;
            const hue = float(k).mul(2.399) as any;
            const tint = vec3(cos(hue), cos(hue.add(2.09)), cos(hue.add(4.19))).mul(0.12).add(0.95) as any;
            colour.addAssign(through.mul(tint).mul(glint.mul(fade).mul(6)));
          });
        });
      });
      If(shape.y.greaterThanEqual(0).and(shape.y.lessThan(1.4)), () => {
        const centre = vec3(0, CENTRE_Y, 0) as any;
        const radius = shape.y.mul(WAVE).add(0.3) as any;
        const fade = smoothstep(1.1, 0.1, shape.y).mul(smoothstep(0, 0.04, shape.y)) as any;
        const tc = clamp(dot(centre.sub(ro), rd), 0, far) as any;
        const miss = length(ro.add(rd.mul(tc)).sub(centre)) as any;
        const ring = exp(miss.sub(radius).div(0.035).pow(2).negate()) as any;
        colour.addAssign(through.mul(vec3(0.75, 0.88, 1)).mul(ring.mul(fade).mul(0.4)));
      });

      // The surface this leg ends on.
      const hit = ro.add(rd.mul(far)).toVar() as any;
      travelled.addAssign(far);
      const foot = travelled.mul(room.pixel) as any;
      If(kind.equal(2), () => {
        colour.addAssign(through.mul(softbox(length(hit.xz), foot)));
        through.assign(vec3(0));
        Break();
      });
      If(kind.equal(1), () => {
        // Black polished stone: a little light from the pool, then a dim mirror that brightens at a glance.
        const cosi = abs(rd.y) as any;
        const fresnel = mix(float(0.05), float(0.5), pow(float(1).sub(cosi), 5)) as any;
        colour.addAssign(through.mul(vec3(pool(length(hit.xz)))));
        through.mulAssign(fresnel);
        rd.assign(reflect(rd, vec3(0, 1, 0)));
      }).Else(() => {
        // Smoked mirror, in panels framed in black: darker and a touch green each time, as real glass is.
        const u = abs(dot(hit, along)) as any;
        const soft = max(foot.mul(1.5), float(0.004)) as any;
        const corner = halfSide.sub(u) as any;
        const frame = float(1)
          .sub(smoothstep(0.025, soft.add(0.025), corner))
          .max(float(1).sub(smoothstep(FLOOR + 0.16, soft.add(FLOOR + 0.164), hit.y)))
          .max(smoothstep(float(CEIL - 0.12).sub(soft), float(CEIL - 0.12), hit.y)) as any;
        const bevel = exp(corner.sub(0.03).div(soft.mul(1.5).add(0.004)).pow(2).negate()).mul(smoothstep(FLOOR, CEIL, hit.y).mul(0.06).add(0.01)) as any;
        const settle = smoothstep(0.004, 0.05, foot) as any;
        const mask = mix(frame, float(0.1), settle) as any;
        colour.addAssign(through.mul(LAMP.mul(bevel.mul(settle.oneMinus())).add(vec3(0.008, 0.009, 0.01).mul(mask))));
        through.mulAssign(vec3(0.68, 0.76, 0.74).mul(mask.oneMinus()));
        rd.assign(reflect(rd, facing));
      });
      ro.assign(hit.sub(facing.mul(0.002)));
      If(max(through.x, max(through.y, through.z)).lessThan(0.01), () => {
        Break();
      });
    });
    colour.addAssign(through.mul(vec3(0.004, 0.005, 0.005)));
    return vec4(colour, 1);
  });

  return { table, baked, trace };
}

// The room's shell, drawn from inside: every pixel of it runs the tracer.
export function Room() {
  const parts = useMemo(() => {
    const { table, baked, trace } = makeRoom();
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
    material.colorNode = trace();
    const geometry = new THREE.CylinderGeometry(APOTHEM / Math.cos(Math.PI / 4), APOTHEM / Math.cos(Math.PI / 4), CEIL - FLOOR, 8, 1);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = (CEIL + FLOOR) / 2;
    mesh.frustumCulled = false;
    return { table: table.texture, baked, material, geometry, mesh };
  }, []);
  useDispose(parts.table, parts.baked, parts.material, parts.geometry);
  return <primitive object={parts.mesh} />;
}
