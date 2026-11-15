"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  bool,
  cameraViewMatrix,
  cameraFar,
  cameraNear,
  interleavedGradientNoise,
  perspectiveDepthToViewZ,
  positionView,
  screenCoordinate,
  viewportDepthTexture,
  cos,
  atomicAdd,
  atomicStore,
  instancedArray,
  storage,
  uint,
  cameraPosition,
  Discard,
  dot,
  exp,
  float,
  fract,
  Fn,
  Break,
  If,
  instanceIndex,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_float,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  sqrt,
  time,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  vertexIndex
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { BEYOND, CLOUD_HEIGHT, cloudAt, type Desert, hash, homeNode, PATCH, sandBetween, SHADOW, WIND } from "./desert";
import type { Look } from "./styles";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The light and the sky, set from the style and eased, so a change of style glides.
export const world = {
  zenith: uniform(new THREE.Color()),
  horizon: uniform(new THREE.Color()),
  sun: uniform(new THREE.Color()),
  power: uniform(1),
  toSun: uniform(new THREE.Vector3(0, 1, 0)),
  disc: uniform(1),
  stars: uniform(0),
  sand: uniform(new THREE.Color()),
  sandDark: uniform(new THREE.Color()),
  fleck: uniform(new THREE.Color()),
  water: uniform(new THREE.Color()),
  absorb: uniform(20),
  metal: uniform(0),
  soil: uniform(new THREE.Color()),
  grass: uniform(new THREE.Color()),
  grassTip: uniform(new THREE.Color()),
  frond: uniform(new THREE.Color()),
  trunk: uniform(new THREE.Color()),
  flower: uniform(new THREE.Color()),
  // How fully the desert has turned to an oasis.
  oasis: uniform(0),
  // The angle one pixel takes up, for fading out detail too small to see.
  pixel: uniform(0.001)
};
const COLOURS = ["zenith", "horizon", "sun", "sand", "sandDark", "fleck", "water", "soil", "grass", "grassTip", "frond", "trunk", "flower"] as const;
const NUMBERS = ["power", "disc", "stars", "absorb"] as const;
const wanted = {
  colours: {} as Record<string, THREE.Color>,
  numbers: {} as Record<string, number>,
  toSun: new THREE.Vector3(),
  metal: 0,
  set: false
};
export function aim(look: Look, now: boolean) {
  for (const key of COLOURS) (wanted.colours[key] ??= new THREE.Color()).set(look[key]);
  for (const key of NUMBERS) wanted.numbers[key] = look[key];
  wanted.toSun.set(...look.toSun).normalize();
  wanted.metal = look.metal ? 1 : 0;
  wanted.set = true;
  if (now) ease(1);
}
export function ease(k: number) {
  if (!wanted.set) return;
  for (const key of COLOURS) world[key].value.lerp(wanted.colours[key], k);
  for (const key of NUMBERS) world[key].value += (wanted.numbers[key] - world[key].value) * k;
  world.toSun.value.lerp(wanted.toSun, k).normalize();
  world.metal.value += (wanted.metal - world.metal.value) * Math.min(1, k * 2);
}

// The sky in a direction: deep overhead, pale at the horizon and hazed toward the sun, the sun's disc and its glow, a
// veil of high cloud, and stars when it is dark enough.
export function skyColour(direction: any): any {
  const d = normalize(direction) as any;
  const y = max(d.y, float(0)) as any;
  const toward = max(dot(d, world.toSun), float(0)) as any;
  const base = mix(world.horizon, world.zenith, pow(y, float(0.45))) as any;
  const haze = mix(base, world.horizon.mul(1.08), pow(toward, float(4)).mul(float(1).sub(y)).mul(0.6)) as any;
  const glow = (world.sun as any).mul(
    pow(toward, float(10))
      .mul(0.35)
      .add(pow(toward, float(120)).mul(0.9))
      .mul(world.disc)
  ) as any;
  const disc = (world.sun as any).mul(smoothstep(0.99955, 0.9998, toward).mul(18).mul(world.disc)) as any;
  const flat = d.xz.div(y.add(0.12)) as any;
  const veil = smoothstep(
    0.55,
    0.95,
    mx_fractal_noise_float(vec3(flat.x.mul(0.5).add(time.mul(0.004)), flat.y.mul(1.6), 3), 4, 2, 0.5, 1)
      .mul(0.5)
      .add(0.5)
  ).mul(smoothstep(0.02, 0.25, y)) as any;
  const cloud = mix(world.horizon, world.sun, pow(toward, float(3)).mul(0.6)) as any;
  const cell = d.mul(420).floor() as any;
  const twinkle = sin(
    time
      .mul(
        hash(cell.x.add(cell.y.mul(7.3)))
          .mul(3)
          .add(1)
      )
      .add(cell.z)
  )
    .mul(0.3)
    .add(0.7) as any;
  const star = smoothstep(0.9965, 1, hash(dot(cell, vec3(1.3, 17.1, 113.7))))
    .mul(twinkle)
    .mul(world.stars)
    .mul(smoothstep(0.03, 0.3, y))
    .mul(2.2) as any;
  // Fair-weather cumulus on the high layer, drifting: bright where the sun catches their tops, greyer underneath,
  // thinning toward the horizon.
  const over = cameraPosition.xz.add(
    d.xz.mul(
      float(CLOUD_HEIGHT)
        .sub(cameraPosition.y)
        .div(max(d.y, float(0.03)))
    )
  ) as any;
  const puff = cloudAt(over)
    .mul(smoothstep(0.02, 0.18, y))
    .mul(float(1).sub(world.stars.mul(0.6))) as any;
  const sunward = vec2(world.toSun.x, world.toSun.z) as any;
  const litTop = float(1).sub(cloudAt(over.add(sunward.mul(6))).mul(0.7)) as any;
  const cumulus = mix(mix(world.horizon, world.zenith, 0.25).mul(0.82), world.sun.mul(world.power).mul(0.55).add(world.horizon.mul(0.6)), litTop).add(
    world.sun.mul(pow(toward, float(6)).mul(0.5))
  ) as any;
  const sky = mix(haze, cloud, veil.mul(0.35).mul(float(1).sub(world.stars.mul(0.7)))) as any;
  return mix(sky, cumulus, puff.mul(0.88))
    .add(glow.mul(float(1).sub(puff.mul(0.8))))
    .add(disc.mul(float(1).sub(puff)))
    .add(vec3(star).mul(float(1).sub(puff)));
}

// The sky without its cloud or stars, for the haze over far sand, where nothing finer would show.
function skyPlain(direction: any): any {
  const d = normalize(direction) as any;
  const y = max(d.y, float(0)) as any;
  const toward = max(dot(d, world.toSun), float(0)) as any;
  const base = mix(world.horizon, world.zenith, pow(y, float(0.45))) as any;
  return mix(base, world.horizon.mul(1.08), pow(toward, float(4)).mul(float(1).sub(y)).mul(0.6)).add((world.sun as any).mul(pow(toward, float(10)).mul(0.35).mul(world.disc)));
}

// What a still surface mirrors in a direction: the sky, and low down the far dunes, their rim rising and falling round
// the horizon, in the light of the sand.
function mirrored(direction: any, lit: any): any {
  const d = normalize(direction) as any;
  const around = d.x.atan(d.z) as any;
  const rim = sin(around.mul(5))
    .mul(0.012)
    .add(sin(around.mul(13).add(1)).mul(0.006))
    .add(0.02) as any;
  const dunes = (world.sand as any).mul(
    world.sun
      .mul(world.power)
      .mul(0.35)
      .add(mix(world.horizon, world.zenith, 0.5).mul(0.4))
  ) as any;
  return mix(dunes, skyColour(d), smoothstep(rim.sub(0.004), rim.add(0.004), d.y)).mul(mix(float(0.75), float(1), lit));
}

// Sand in the light: the sun across its slope, as much of it as gets past the dunes, the sky's light from above and the
// warmth thrown back off the sand round about.
function litSand(albedo: any, normal: any, lit: any): any {
  const sun = (world.sun as any)
    .mul(world.power)
    .mul(max(dot(normal, world.toSun), float(0)))
    .mul(lit) as any;
  const sky = mix(world.horizon, world.zenith, normal.y.mul(0.5).add(0.5)).mul(0.5) as any;
  const bounce = (world.sand as any)
    .mul(world.sun)
    .mul(world.power)
    .mul(0.08)
    .mul(float(1).sub(normal.y.mul(0.5))) as any;
  return albedo.mul(sun.add(sky).add(bounce));
}

// The light that water gathers on the sand under it, rippling.
function caustics(p: any, depth: any): any {
  const a = mx_worley_noise_float(vec3(p.mul(30), time.mul(0.8))) as any;
  const b = mx_worley_noise_float(vec3(p.mul(47).add(3.1), time.mul(1.1))) as any;
  const pattern = pow(a, float(2.5))
    .add(pow(b, float(3)))
    .mul(1.4) as any;
  return pattern
    .mul(smoothstep(0.0005, 0.008, depth))
    .mul(float(1).sub(smoothstep(0.05, 0.25, depth).mul(0.6)))
    .mul(float(1).sub(world.metal));
}

// The sky, on a dome that goes with the eye.
export function Sky() {
  const material = useMemo(() => {
    const dome = new THREE.MeshBasicNodeMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    dome.colorNode = skyColour(positionWorld.sub(cameraPosition)) as any;
    return dome;
  }, []);
  const geometry = useMemo(() => new THREE.SphereGeometry(350, 48, 32), []);
  useDispose(geometry, material);
  const dome = useRef<THREE.Mesh>(null);
  useFrame(({ camera }) => dome.current?.position.copy(camera.position));
  // Drawn after the ground and depth tested, so only sky that shows is shaded.
  return <mesh ref={dome} geometry={geometry} material={material} renderOrder={0.5} frustumCulled={false} />;
}

// The colour of sand at a point: warm, paler on the crests and deeper in the hollows, in soft broad patches.
function sandAlbedo(p: any, height: any): any {
  const patch = mx_noise_float(vec3(p.mul(0.7), 3))
    .mul(0.5)
    .add(0.5) as any;
  const crest = smoothstep(0.02, 0.32, height) as any;
  return mix(mix(world.sandDark, world.sand, crest.mul(0.6).add(0.4)), world.sand.mul(1.06), patch.mul(0.35));
}

// Wind ripples, a few centimetres apart, bending along the dunes: how high the sand stands on them at a point, and how
// steeply it rises downwind there.
const RIPPLE = 170;
const RIPPLE_HIGH = 0.0012;
function rippleAt(p: any): any {
  const phase = dot(p, vec2(...WIND))
    .mul(RIPPLE)
    .add(mx_noise_float(vec3(p.mul(5), 0)).mul(6)) as any;
  const height = sin(phase)
    .add(sin(phase.mul(2).add(1)).mul(0.3))
    .mul(RIPPLE_HIGH) as any;
  const rise = phase
    .cos()
    .add(phase.mul(2).add(1).cos().mul(0.6))
    .mul(RIPPLE_HIGH * RIPPLE) as any;
  return vec2(height, rise);
}
// How much brighter or darker sand on the ripples is than the smooth sand under them, in the sun: a slope toward the
// sun takes more of it. Ripples only show where they are a few pixels apart, or they would shimmer.
function rippleShade(rise: any, normal: any, lit: any, settled: any, distance: any): any {
  const seen = smoothstep(3, 8, float((2 * Math.PI) / RIPPLE).div(distance.mul(world.pixel))) as any;
  const toward = dot(vec3(WIND[0], 0, WIND[1]), world.toSun) as any;
  const facing = max(dot(normal, world.toSun), float(0.12)) as any;
  return float(1).sub(rise.mul(settled).mul(seen).mul(toward).div(facing).mul(lit).mul(0.8)).clamp(0.35, 1.9);
}

// Grains finer than any drawn, each a shade of its own, down to the pixel: how much lighter or darker the sand is for
// them at a point, fading to no change where they are smaller than a pixel.
const SPECK = 0.0016;
function speckle(p: any, distance: any): any {
  const cell = p.div(SPECK).floor() as any;
  const pick = hash(cell.x.add(cell.y.mul(57.31))) as any;
  const own = pick.lessThan(0.05).select(float(0.7), pick.mul(0.3).add(0.85)) as any;
  return mix(float(1), own, smoothstep(0.6, 1.6, float(SPECK).div(distance.mul(world.pixel))));
}

// Ground the oasis has reached: the sand darkens to earth, then turf.
function oasisGround(sand: any, green: any): any {
  const earth = mix(sand, world.soil, smoothstep(0, 0.4, green).mul(0.8)) as any;
  return mix(earth, (world.grass as any).mul(0.75), smoothstep(0.4, 0.95, green).mul(0.65));
}

// The far desert's sand at a point, lit and hazed: its slope, the shadow found by stepping toward the sun just as the
// patch's is, under the palms' shade, the ripples and grains just as the patch's are, and the air between, paling
// toward the sky.
function duneColour(p: any, distance: any, view: any, steps: number, green: any = float(0), shade: any = float(1)): any {
  const e = 0.01;
  const h = homeNode(p) as any;
  const normal = normalize(vec3(homeNode(p.sub(vec2(e, 0))).sub(homeNode(p.add(vec2(e, 0)))), e * 2, homeNode(p.sub(vec2(0, e))).sub(homeNode(p.add(vec2(0, e)))))) as any;
  const sun = world.toSun as any;
  const flat = normalize(vec2(sun.x, sun.z).add(vec2(1e-5, 0))) as any;
  const climb = sun.y.div(max(length(vec2(sun.x, sun.z)), float(1e-3))) as any;
  const lit = float(1).toVar();
  const t = float(SHADOW.start).toVar();
  const grow = Math.pow(SHADOW.grow, SHADOW.steps / steps);
  Loop(steps, () => {
    const above = h
      .add(SHADOW.lift)
      .add(t.mul(climb))
      .sub(homeNode(p.add(flat.mul(t))))
      .div(t) as any;
    lit.assign(min(lit, smoothstep(-0.02, 0.06, above)));
    t.mulAssign(grow);
  });
  lit.mulAssign(shade);
  const colour = litSand(oasisGround(sandAlbedo(p, h), green), normal, lit)
    .mul(rippleShade(rippleAt(p).y, normal, lit, float(1).sub(green), distance))
    .mul(speckle(p, distance)) as any;
  return mix(colour, skyPlain(vec3(view.x, 0.02, view.z)), float(1).sub(exp(distance.mul(-0.011))));
}

// The desert past the patch, out to the horizon: the same dunes, unchanging, shaded just as the patch's sand is, so the
// two meet without a seam.
export function Dunes({ desert, fine, inner }: { desert: Desert; fine: boolean; inner: number }) {
  const geometry = useMemo(() => {
    const segments = fine ? 640 : 360;
    const g = new THREE.PlaneGeometry(2, 2, segments, segments).rotateX(-Math.PI / 2);
    const position = g.attributes.position as THREE.BufferAttribute;
    // Close together near the middle and far apart toward the horizon.
    const warp = (v: number) => 6 * v + 194 * Math.pow(v, 5);
    for (let k = 0; k < position.count; k++) position.setXYZ(k, warp(position.getX(k)), 0, warp(position.getZ(k)));
    return g;
  }, [fine]);
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ fog: false });
    m.positionNode = vec3(positionLocal.x, homeNode(positionLocal.xz), positionLocal.z) as any;
    m.colorNode = Fn(() => {
      const p = positionWorld.xz as any;
      If(max(abs(p.x), abs(p.y)).lessThan(inner), () => Discard());
      const distance = length(positionWorld.sub(cameraPosition)) as any;
      const green = max(abs(p.x), abs(p.y))
        .lessThan(PATCH / 2 + BEYOND)
        .select(desert.greenNear(p), float(0)) as any;
      return duneColour(p, distance, normalize(positionWorld.sub(cameraPosition)), fine ? SHADOW.steps : 8, green, desert.palmShade(p));
    })() as any;
    return m;
  }, [desert, fine, inner]);
  useDispose(geometry, material);
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

export type Bend = "heat" | "lake" | "towers" | "ribbons";
export const BENDS: { value: Bend; label: string }[] = [
  { value: "heat", label: "Heat haze" },
  { value: "lake", label: "Lake and heat" },
  { value: "towers", label: "Fata Morgana" },
  { value: "ribbons", label: "Ribbons" }
];

// The mirage: a band round the horizon, a little way out, through which the far desert is drawn again along bent rays.
// Each ray from the eye is turned by the hot air, then followed out over the dunes to whatever it meets, sand or sky, so
// the horizon itself bends: it wavers, doubles upside down in a flowing lake of sky, stretches into towers, or slides in sheets.
// The band is a wall standing round the patch just past where its green can spill, so the whole desert outside the patch
// shimmers and the patch itself, nearer, stays sharp; the bending fades in from the wall's foot and out above the horizon.
const WALL = (PATCH / 2) * Math.SQRT2 + BEYOND;
export function Mirage({ bend }: { bend: Bend }) {
  const geometry = useMemo(() => new THREE.CylinderGeometry(WALL, WALL, 12, 256, 1, true).translate(0, 5, 0), []);
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      fog: false
    });
    const look = Fn(() => {
      const d = normalize(positionWorld.sub(cameraPosition)) as any;
      const e = d.y as any;
      const around = d.x.atan(d.z) as any;
      // How strongly the air bends here: fully over the desert outside the patch, coming in over the first metres past the
      // wall's foot, and gone a little above the horizon.
      const wall = length(positionWorld.sub(cameraPosition)) as any;
      const floor = e.lessThan(0).select(cameraPosition.y.div(max(e.negate(), float(1e-4))), float(1e4)) as any;
      const s = smoothstep(wall, wall.add(2.5), floor)
        .mul(float(1).sub(smoothstep(0.015, 0.06, e)))
        .mul(float(1).sub(world.stars.mul(0.5))) as any;
      const line = float(-0.012).add(sin(around.mul(5).add(time.mul(0.3))).mul(0.003)) as any;
      // How far below the horizon: the effects built round the horizon give way to their own kind lower down.
      const low = smoothstep(0.03, 0.12, line.sub(e)) as any;
      let rise: any = e;
      let turn: any = around;
      let bright: any = float(1);
      if (bend === "heat") {
        // Heat rising off the sand in waves that climb and shiver.
        const wave = mx_noise_float(vec3(around.mul(28), e.mul(160).sub(time.mul(1.6)), time.mul(0.25))) as any;
        const fine = mx_noise_float(vec3(around.mul(90), e.mul(500).sub(time.mul(3.5)), 2)) as any;
        rise = e.add(wave.mul(0.009).add(fine.mul(0.0025)).mul(s));
        turn = around.add(wave.mul(0.004).mul(s));
      } else if (bend === "lake") {
        // Below a trembling line the world is mirrored, as if in water a long way off, and the water flows like something
        // poured: broad swells roll along it and fold the reflection over itself, with a sheen of colour in the folds.
        const flow = sin(
          around
            .mul(12)
            .add(time.mul(1.1))
            .add(sin(e.mul(220).add(time.mul(0.9))).mul(2.2))
        ) as any;
        const swell = sin(
          e
            .mul(260)
            .sub(time.mul(2.2))
            .add(sin(around.mul(14).add(time.mul(0.6))).mul(2.5))
        ).mul(0.0055) as any;
        const below = e.lessThan(line) as any;
        const near = below.select(line.mul(2).sub(e).add(swell), e.add(swell.mul(0.3))).add(flow.mul(0.008)) as any;
        rise = mix(e, mix(near, e.add(swell.mul(0.3)).add(flow.mul(0.004)), low), s);
        turn = around.add(
          sin(e.mul(320).sub(time.mul(1.7)))
            .mul(0.03)
            .mul(s)
        );
        bright = mix(float(1), below.select(float(1.1), float(1)), s.mul(low.oneMinus()));
        // And over it all, heat rising in broad, slow streaks.
        const heat = mx_noise_float(vec3(around.mul(10), e.mul(55).sub(time.mul(1.2)), time.mul(0.2))) as any;
        rise = rise.add(heat.mul(0.014).mul(s));
        turn = turn.add(heat.mul(0.007).mul(s));
      } else if (bend === "towers") {
        // Fata Morgana: the far dunes stretched up into cliffs and towers that rise and sink, with a mirrored band above.
        const stretch = mix(
          float(0.18),
          float(1),
          sin(around.mul(9).add(time.mul(0.35)))
            .mul(0.5)
            .add(0.5)
        ) as any;
        const above = e.greaterThan(line.add(0.012)) as any;
        const flipped = line.add(0.024).sub(e) as any;
        const stretched = line.add(e.sub(line).mul(stretch)) as any;
        // Lower down, the dunes in columns that swell up and sink, with heat shivering through them.
        const shiver = mx_noise_float(vec3(around.mul(14), e.mul(70).sub(time.mul(1.1)), time.mul(0.2))) as any;
        const columns = e.mul(mix(float(0.8), float(1.25), stretch)).add(shiver.mul(0.008)) as any;
        rise = mix(e, mix(above.select(flipped, stretched), columns, low), s);
        turn = around.add(sin(e.mul(300).add(time)).mul(0.002).mul(s));
      } else {
        // Ribbons: the horizon cut into thin sheets that slide sideways against each other and swell up and down.
        const sheet = e.mul(260).floor() as any;
        turn = around.add(
          sin(sheet.mul(1.7).add(time.mul(1.3)))
            .mul(0.03)
            .mul(s)
        );
        rise = e.add(
          sin(around.mul(22).sub(time.mul(2.5)).add(sheet.mul(0.6)))
            .mul(0.006)
            .mul(s)
        );
      }
      // Bent, the ray goes on from the eye out over the dunes until it passes under them, or past their end.
      const flat = sqrt(max(float(1).sub(rise.mul(rise)), float(0))) as any;
      const ray = vec3(turn.sin().mul(flat), rise, turn.cos().mul(flat)) as any;
      const colour = skyColour(ray).toVar();
      // In long strides, then one step back along the last stride to where it crossed under the dunes; nothing to do
      // where the air is not bending.
      const t = wall.mul(0.98).toVar();
      const before = t.toVar();
      const above = float(1).toVar();
      If(s.greaterThan(0.002), () => {
        Loop(24, () => {
          const q = cameraPosition.add(ray.mul(t)) as any;
          const h = q.y.sub(homeNode(q.xz)) as any;
          If(h.lessThan(0), () => {
            const hit = before.add(t.sub(before).mul(above.div(max(above.sub(h), float(1e-5))))) as any;
            colour.assign(duneColour(cameraPosition.add(ray.mul(hit)).xz, hit, ray, 6));
            Break();
          });
          If(t.greaterThan(200), () => {
            Break();
          });
          before.assign(t);
          above.assign(h);
          t.mulAssign(1.18);
        });
      });
      let out: any = colour.mul(bright);
      if (bend === "lake") {
        const k = e.mul(400).add(around.mul(18)).sub(time.mul(1.2)) as any;
        out = out.mul(
          vec3(1).add(
            vec3(sin(k), sin(k.add(2.1)), sin(k.add(4.2)))
              .mul(0.12)
              .mul(s)
          )
        );
      }
      return vec4(out, s);
    })() as any;
    m.colorNode = look.xyz;
    m.opacityNode = look.w;
    return m;
  }, [bend]);
  useDispose(geometry, material);
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />;
}

// One column of the patch, read fresh each time it is asked for, so no node is shared between stages.
const column = (desert: Desert, index: any) => ({
  cell: desert.cells.element(index) as any,
  light: desert.light.element(index) as any
});

// The colour of each column's sand, lit, once a frame: its own shade, darker where damp, wind ripples where the wind laid
// it and nothing has disturbed it since, and the light gathered by water over it.
export function toneOf(desert: Desert) {
  const { N, CELL } = desert;
  return Fn(() => {
    const id = int(instanceIndex) as any;
    const p = vec2(float(id.mod(N)).add(0.5), float(id.div(N)).add(0.5))
      .mul(CELL)
      .sub(PATCH / 2) as any;
    const c = desert.cells.element(id) as any;
    const l = desert.light.element(id) as any;
    const green = desert.life.element(id).y as any;
    // Ripples show only on sand the wind laid and nothing has disturbed since; they are drawn finer than a column, so
    // the colour here leaves them out and says how settled the sand is.
    const settled = float(1)
      .sub(smoothstep(0.004, 0.02, abs(c.x.sub(desert.home.element(id)))))
      .mul(float(1).sub(c.z))
      .mul(float(1).sub(green)) as any;
    const albedo = oasisGround(sandAlbedo(p, c.x), green).mul(mix(float(1), float(0.6), c.z.mul(float(1).sub(green.mul(0.6))))) as any;
    const colour = litSand(albedo, l.yzw, l.x).toVar();
    If(c.y.greaterThan(0.0005), () => {
      colour.addAssign(world.sun.mul(world.power).mul(l.x).mul(caustics(p, c.y)).mul(albedo).mul(0.9));
    });
    desert.tone.element(id).assign(vec4(colour, settled));
  })().compute(N * N);
}

// The patch's sand, one vertex to a column, under its grains.
export function Sand({ desert }: { desert: Desert }) {
  const { N, CELL } = desert;
  const geometry = useMemo(() => new THREE.PlaneGeometry(PATCH - CELL, PATCH - CELL, N - 1, N - 1).rotateX(-Math.PI / 2), [N, CELL]);
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ fog: false });
    m.positionNode = vec3(positionLocal.x, desert.cells.element(vertexIndex).x, positionLocal.z) as any;
    const tone = varying(desert.tone.element(vertexIndex)) as any;
    const light = varying(desert.light.element(vertexIndex)) as any;
    // Down to the pixel: the ripples, and grains finer than the grains drawn over it, each a shade of its own.
    m.colorNode = Fn(() => {
      const p = positionWorld.xz as any;
      const distance = length(positionWorld.sub(cameraPosition)) as any;
      const shade = rippleShade(rippleAt(p).y, normalize(light.yzw), light.x, tone.w, distance) as any;
      return tone.xyz.mul(shade).mul(speckle(p, distance));
    })() as any;
    return m;
  }, [desert]);
  useDispose(geometry, material);
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

// The grains, several to a column, each a little bead facing the eye: its own shade of sand, a few dark, a few bright
// quartz that glint when they face the sun just so. Damp grains go dark, grains under water ripple with light, and grains
// being turned to water shrink and shine. Too small to see on their own far off, they fade into the sand's own colour.
// How wide a grain is when this many share a column.
const grainSize = (desert: Desert, perColumn: number) => (desert.CELL / Math.sqrt(perColumn)) * 0.95;
// Where a grain is in its column, from its number alone.
function grainSpot(desert: Desert, perColumn: number, grain: any) {
  const { N, CELL } = desert;
  const index = grain.div(perColumn) as any;
  const seed = float(grain) as any;
  const p = vec2(float(index.mod(N)).add(hash(seed.mul(0.37)).mul(1.2).sub(0.1)), float(index.div(N)).add(hash(seed.mul(0.71).add(2)).mul(1.2).sub(0.1)))
    .mul(CELL)
    .sub(PATCH / 2) as any;
  return { index, seed, p };
}

export function Grains({ desert, perColumn }: { desert: Desert; perColumn: number }) {
  const { N, CELL } = desert;
  const count = N * N * perColumn;
  // Only the columns in view, and near enough that a grain is half a pixel or more, get their grains drawn.
  useView();
  const listing = useListed(count, 6);
  const size = grainSize(desert, perColumn);
  // Each drawn grain's height and colour, worked out once a frame in the listing pass rather than at each of its
  // sprite's four corners: the noise in its ripples alone is the most of a grain's cost.
  const looks = useMemo(() => instancedArray(count, "vec4"), [count]);
  const pass = useMemo(
    () =>
      Fn(() => {
        const index = int(instanceIndex) as any;
        const q = vec2(float(index.mod(N)).add(0.5), float(index.div(N)).add(0.5))
          .mul(CELL)
          .sub(PATCH / 2) as any;
        const at = vec3(q.x, desert.cells.element(index).x, q.y) as any;
        const big = float(size).div(length(at.sub(eye)).mul(world.pixel)) as any;
        // Without a list to draw from (the WebGL fallback) every grain is drawn, so every grain needs its look.
        const wanted = (listing.listed ? big.greaterThan(1.0).and(inView(at, float(CELL))) : bool(true)) as any;
        If(wanted, () => {
          const { cell: c, light: l } = column(desert, index);
          const t = desert.tone.element(index) as any;
          Loop(perColumn, ({ i }: any) => {
            const grain = index.mul(perColumn).add(i) as any;
            const { seed, p } = grainSpot(desert, perColumn, grain);
            // Grains only a pixel or two across cost several times their size to draw and are lost in the sand's own
            // fine grain, so far off only a third of them are drawn, all of them from four pixels across.
            const thin = hash(seed.add(0.77)).lessThan(mix(float(0.34), float(1), smoothstep(1.5, 4, big))) as any;
            listing.keep(grain, thin);
            const ripple = rippleAt(p) as any;
            const ground = sandBetween(desert, p)
              .x.add(ripple.x.mul(t.w))
              .add(size * 0.25) as any;
            // Its colour: its column's colour, made a little lighter or darker for this grain, or very much so for the
            // odd dark grain or bright fleck of quartz.
            const pick = hash(seed.add(0.91)) as any;
            const fleck = pick.greaterThan(0.975) as any;
            const own = fleck.select(
              (world.fleck as any).div((max as any)(world.sand, vec3(0.05))).mul(0.8),
              vec3(pick.lessThan(0.05).select(float(0.68), hash(seed.add(0.13)).mul(0.36).add(0.82)))
            ) as any;
            // How much a grain differs from the sand round it, fading out where it is smaller than a pixel.
            const distance = length(vec3(p.x, c.x, p.y).sub(eye)) as any;
            const seen = smoothstep(0.5, 1.4, float(size).div(distance.mul(world.pixel))) as any;
            // A glint, off a facet of its own turned a little from the sand's slope.
            const facet = normalize(
              l.yzw.add(
                vec3(hash(seed.add(3.7)), hash(seed.add(5.3)), hash(seed.add(8.9)))
                  .sub(0.5)
                  .mul(1.4)
              )
            ) as any;
            const toEye = normalize(eye.sub(vec3(p.x, c.x, p.y))) as any;
            const glint = pow(max(dot(reflect(world.toSun.negate(), facet), toEye), float(0)), float(120))
              .mul(fleck.select(float(10), float(0.6)))
              .mul(l.x)
              .mul(seen)
              .mul(float(1).sub(c.z.mul(0.7))) as any;
            const fresh = (world.water as any).add(world.fleck).mul(c.w.mul(0.08)) as any;
            const tone = t.xyz.mul(rippleShade(ripple.y, l.yzw, l.x, t.w, distance)) as any;
            const colour = tone
              .mul(mix(vec3(1), own, seen))
              .add(world.sun.mul(world.power).mul(glint))
              .add(fresh) as any;
            looks.element(grain).assign(vec4(ground, colour));
          });
        });
      })().compute(N * N),
    [desert, N, CELL, size, perColumn, listing, looks]
  );
  useFrame(({ gl }) => (gl as unknown as THREE.WebGPURenderer).compute(listing.listed ? [listing.reset, pass] : pass));
  const { sprite, material } = useMemo(() => {
    const m = new THREE.SpriteNodeMaterial({
      alphaTest: 0.5,
      depthWrite: true,
      fog: false
    });
    const grain = listing.which() as any;
    const { index, seed, p } = grainSpot(desert, perColumn, grain);
    const look = looks.element(grain) as any;
    m.positionNode = vec3(p.x, look.x, p.y) as any;
    {
      const c = desert.cells.element(index) as any;
      // Toward the rim the grains thin out, so the patch's sand meets the dunes beyond as plain sand.
      const rim = smoothstep(PATCH / 2 - 0.05, PATCH / 2 - 1.1, max(abs(p.x), abs(p.y))) as any;
      // Up close a grain would loom as a pebble: past a dozen pixels across it shrinks away, and the sand's own fine
      // grain, drawn to the pixel, carries the close view.
      const across = float(size).div(length(vec3(p.x, c.x, p.y).sub(cameraPosition)).mul(world.pixel)) as any;
      m.scaleNode = float(size)
        .mul(rim)
        .mul(hash(seed.add(0.5)).mul(0.7).add(0.6))
        .mul(float(1).sub(c.w.mul(0.6)))
        .mul(smoothstep(14, 7, across)) as any;
    }
    const colour = look.yzw as any;
    const tint = varying(colour) as any;
    const q = uv().sub(0.5).mul(2) as any;
    const r2 = dot(q, q) as any;
    // Each grain a tiny bead: lit on its sunward side and shaded on the other, with a pinpoint of sun on it, the sun's
    // direction brought into the grain's own view-facing frame. Even on the whole, so the sand keeps its tone.
    const bead = vec3(q.x, q.y.negate(), sqrt(max(float(1).sub(r2), float(0)))) as any;
    const sunInView = normalize(cameraViewMatrix.mul(vec4(world.toSun, 0)).xyz) as any;
    const sunOnBead = dot(bead, sunInView) as any;
    const beadLight = max(sunOnBead, float(0))
      .mul(0.3)
      .add(0.88)
      .sub(smoothstep(0, -0.7, sunOnBead).mul(0.08)) as any;
    const pin = pow(max(dot(reflect(sunInView.negate(), bead), vec3(0, 0, 1)), float(0)), float(40)).mul(0.35) as any;
    m.colorNode = tint.mul(beadLight).add(world.sun.mul(world.power).mul(pin).mul(0.25)) as any;
    m.opacityNode = smoothstep(1, 0.8, r2) as any;
    const sprite = new THREE.Sprite(m);
    if (listing.listed) {
      sprite.geometry = sprite.geometry.clone();
      sprite.geometry.setIndirect(listing.args);
    }
    sprite.count = count;
    sprite.frustumCulled = false;
    return { sprite, material: m };
  }, [desert, perColumn, size, count, listing, looks]);
  useDispose(material);
  return <primitive object={sprite} />;
}

// Draw only what is worth drawing: each frame a compute pass lists the instances that are grown and in view, and the mesh
// is drawn from that list, as many as were listed, so hidden and ungrown ones cost nothing. WebGPU only; elsewhere every
// instance is drawn and the vertex shader hides the rest, as before.
export const view = uniform(new THREE.Matrix4());
// Where the eye is, for compute passes, which have no camera of their own.
export const eye = uniform(new THREE.Vector3());
export function inView(point: any, radius: any): any {
  const clip = view.mul(vec4(point, 1)) as any;
  const r = radius.mul(2.5) as any;
  return clip.w
    .greaterThan(radius.negate())
    .and(abs(clip.x).lessThan(clip.w.add(r)))
    .and(abs(clip.y).lessThan(clip.w.add(r)));
}
export function useView() {
  useFrame(({ camera }) => {
    camera.updateMatrixWorld();
    view.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    eye.value.copy(camera.position);
  });
}
export function useListed(count: number, indexCount: number, per = 1) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const listed = Boolean((gl.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend);
  return useMemo(() => {
    const args = new THREE.IndirectStorageBufferAttribute(new Uint32Array([indexCount, 0, 0, 0, 0]), 1);
    const counter = storage(args, "uint", 5).toAtomic() as any;
    const list = instancedArray(Math.ceil(count / per), "uint") as any;
    const reset = Fn(() => {
      atomicStore(counter.element(1), uint(0));
    })().compute(1);
    // Call inside a compute Fn: puts this instance, or this group of `per` instances, on the list if it should be drawn.
    const keep = (id: any, wanted: any) => {
      if (!listed) return;
      If(wanted, () => {
        const slot = (atomicAdd(counter.element(1), uint(per)) as any).toVar();
        list.element(slot.div(per)).assign(uint(id));
      });
    };
    // The instance a drawn copy stands for.
    const which = (): any =>
      listed
        ? int(list.element(instanceIndex.div(per)))
            .mul(per)
            .add(int(instanceIndex.mod(per)))
        : int(instanceIndex);
    return { args, reset, keep, which, listed };
  }, [count, indexCount, per, listed]);
}

// Dust in the air: fine motes drifting with the wind over and round the patch, rising and sinking a little, faint until
// they come between the eye and the sun, when they light up. Worked out where they are from the time alone, so they
// cost no simulation.
export function Dust({ count }: { count: number }) {
  const { sprite, material } = useMemo(() => {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const BOX = vec3(11, 1.8, 11);
    const where = () => {
      const seed = float(instanceIndex) as any;
      const start = vec3(hash(seed.mul(0.31)), hash(seed.mul(0.57).add(1)), hash(seed.mul(0.83).add(2))) as any;
      const speed = hash(seed.add(4.4)).mul(0.06).add(0.03) as any;
      const drift = vec3(WIND[0], 0, WIND[1]).mul(time.mul(speed)) as any;
      const bob = vec3(sin(time.mul(0.31).add(seed)).mul(0.04), sin(time.mul(0.23).add(seed.mul(1.7))).mul(0.06), cos(time.mul(0.27).add(seed.mul(2.3))).mul(0.04)) as any;
      const p = fract(start.add(drift.div(BOX)))
        .sub(vec3(0.5, 0, 0.5))
        .mul(BOX) as any;
      return { seed, p: p.add(bob).add(vec3(0, 0.03, 0)) };
    };
    m.positionNode = where().p as any;
    m.scaleNode = hash(where().seed.add(9.1)).mul(0.006).add(0.003) as any;
    const colour = (() => {
      const { p } = where();
      const look = normalize(p.sub(cameraPosition)) as any;
      const toward = max(dot(look, world.toSun), float(0)) as any;
      const sun = world.sun.mul(world.power) as any;
      const lit = pow(toward, float(6)).mul(2.2).add(0.18) as any;
      const fade = smoothstep(9, 4, length(p.sub(cameraPosition))).mul(smoothstep(0.08, 0.5, length(p.sub(cameraPosition)))) as any;
      return mix(world.sand, vec3(1), 0.5)
        .mul(sun.mul(lit).add(world.horizon.mul(0.15)))
        .mul(fade);
    })();
    const q = uv().sub(0.5).mul(2) as any;
    m.colorNode = varying(colour)
      .mul(smoothstep(1, 0, dot(q, q)))
      .mul(0.5) as any;
    const sprite = new THREE.Sprite(m);
    sprite.count = count;
    sprite.frustumCulled = false;
    return { sprite, material: m };
  }, [count]);
  useDispose(material);
  return <primitive object={sprite} />;
}

// Light shafts: sunlight in the faint dust over the sand, stepped through along each ray from the eye as far as whatever
// it meets, lit only where the sun gets through, so the gaps between palm fronds and between clouds' shadows show as
// streaks of light, brightest looking toward the sun.
export function Shafts({ desert, steps }: { desert: Desert; steps: number }) {
  const geometry = useMemo(() => new THREE.SphereGeometry(1, 24, 16), []);
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    m.colorNode = Fn(() => {
      const d = normalize(positionWorld.sub(cameraPosition)) as any;
      // How far the ray goes before it meets something, from the scene's own depth.
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar) as any;
      const reach = min(length(positionView).mul(sceneZ.div(positionView.z)), float(7)) as any;
      const sun = world.toSun as any;
      const slant = vec2(sun.x, sun.z).div(max(sun.y, float(0.15))) as any;
      const stride = reach.div(steps) as any;
      const t = stride.mul(interleavedGradientNoise(screenCoordinate.xy)).toVar();
      const light = float(0).toVar();
      Loop(steps, () => {
        const q = cameraPosition.add(d.mul(t)) as any;
        const seen = desert.palmShade(q.xz.sub(slant.mul(max(q.y, float(0))))) as any;
        light.addAssign(seen.mul(exp(max(q.y, float(0)).mul(-0.9))).mul(stride));
        t.addAssign(stride);
      });
      const toward = max(dot(d, sun), float(0)) as any;
      const phase = pow(toward, float(8))
        .mul(1.6)
        .add(pow(toward, float(2)).mul(0.25))
        .add(0.05) as any;
      return world.sun
        .mul(world.power)
        .mul(light)
        .mul(phase)
        .mul(0.05)
        .mul(float(1).sub(world.metal.mul(0.5)));
    })() as any;
    return m;
  }, [desert, steps]);
  useDispose(geometry, material);
  const shell = useRef<THREE.Mesh>(null);
  useFrame(({ camera }) => shell.current?.position.copy(camera.position));
  return <mesh ref={shell} geometry={geometry} material={material} renderOrder={4} frustumCulled={false} />;
}

// Ripples on the water, each a train of waves running its own way about the wind's, the finer ones slower: how long,
// at what angle from the wind, how steep and how fast.
const RIPPLES = [
  [0.11, 0, 0.075, 0.09],
  [0.073, 0.5, 0.07, 0.075],
  [0.047, -0.6, 0.065, 0.06],
  [0.031, 0.25, 0.06, 0.05],
  [0.019, -0.35, 0.055, 0.04],
  [0.012, 0.9, 0.05, 0.032],
  [0.0075, -0.8, 0.045, 0.026]
];
// The slope the ripples give the water at a point, from those long enough to see from here, and how much slope those
// too fine to see would have given, for the highlight to spread by. Gusts sweep rougher patches across the water.
function waterSlope(p: any, distance: any): any {
  const wind = vec2(...WIND) as any;
  const gust = smoothstep(-0.35, 0.55, mx_noise_float(vec3(p.mul(0.9).sub(wind.mul(time.mul(0.25))), time.mul(0.07))))
    .mul(0.9)
    .add(0.3) as any;
  const warp = mx_noise_float(vec3(p.mul(6), time.mul(0.3)))
    .mul(1.6)
    .add(mx_noise_float(vec3(p.mul(17), time.mul(0.5))).mul(0.9)) as any;
  let slope: any = vec2(0, 0);
  let missed: any = float(0);
  for (const [long, angle, steep, speed] of RIPPLES) {
    const way = vec2(WIND[0] * Math.cos(angle) - WIND[1] * Math.sin(angle), WIND[0] * Math.sin(angle) + WIND[1] * Math.cos(angle)) as any;
    const k = (Math.PI * 2) / long;
    const phase = dot(p, way)
      .mul(k)
      .sub(time.mul(speed * k))
      .add(warp) as any;
    const seen = smoothstep(3, 8, float(long).div(distance.mul(world.pixel))) as any;
    slope = slope.add(way.mul(phase.cos().mul(steep).mul(seen)));
    missed = missed.add(float(1).sub(seen).mul(steep));
  }
  return vec3(slope.mul(gust), missed.mul(gust));
}

// The water over the sand, one vertex to a column, sunk out of sight where a column is dry. Clear water lets the sand
// show through it, tinted by the depth the light passes, with the sky in it at a glance and the sun glittering off its
// ripples; liquid metal is all mirror.
export function Water({ desert }: { desert: Desert }) {
  const { N, CELL } = desert;
  const geometry = useMemo(() => new THREE.PlaneGeometry(PATCH - CELL, PATCH - CELL, N - 1, N - 1).rotateX(-Math.PI / 2), [N, CELL]);
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      fog: false
    });
    const surfaceAt = (k: any) => {
      const c = desert.cells.element(k) as any;
      return c.x.add(c.y);
    };
    {
      const c = column(desert, vertexIndex).cell;
      m.positionNode = vec3(positionLocal.x, c.y.greaterThan(0.0002).select(c.x.add(c.y), c.x.sub(0.01)), positionLocal.z) as any;
    }
    const normal = (() => {
      const id = int(vertexIndex) as any;
      const i = id.mod(N) as any;
      const j = id.div(N) as any;
      const at = (a: any, b: any) =>
        (max as any)((min as any)(b, int(N - 1)), int(0))
          .mul(N)
          .add((max as any)((min as any)(a, int(N - 1)), int(0)));
      const own = surfaceAt(id) as any;
      const side = (a: any, b: any) => {
        const k = at(a, b);
        return desert.cells.element(k).y.greaterThan(0.0002).select(surfaceAt(k), own);
      };
      return normalize(vec3(side(i.sub(1), j).sub(side(i.add(1), j)), CELL * 2, side(i, j.sub(1)).sub(side(i, j.add(1)))));
    })();
    const n0 = varying(normal) as any;
    const depth = varying(column(desert, vertexIndex).cell.y) as any;
    const lit = varying(column(desert, vertexIndex).light.x) as any;
    m.colorNode = Fn(() => {
      const p = positionWorld.xz as any;
      const distance = length(cameraPosition.sub(positionWorld)) as any;
      const calm = smoothstep(0.0008, 0.008, depth) as any;
      // The surface: ripples, rougher in the gusts' patches, calmer in the shallows; what is too fine to see makes the
      // sun's highlight broader instead.
      const ripples = waterSlope(p, distance) as any;
      const n = normalize(n0.add(vec3(ripples.x, 0, ripples.y).mul(calm))) as any;
      const eye = normalize(cameraPosition.sub(positionWorld)) as any;
      const facing = max(dot(n, eye), float(0)) as any;
      const fresnel = pow(float(1).sub(facing), float(5)).mul(0.98).add(0.02) as any;
      // What it mirrors: stepping along the bounced ray, a palm standing over the water, the grass on the bank, or the
      // bank or dune it meets, lit as it is; or, if it meets none, the sky, with the far dunes low round its edge.
      const bounce = reflect(eye.negate(), n) as any;
      const sky = mirrored(bounce, lit).toVar();
      const found = float(0).toVar();
      const t = float(0.006).toVar();
      const sun = world.sun.mul(world.power) as any;
      const air = mix(world.horizon, world.zenith, 0.5) as any;
      Loop(24, () => {
        // Done once the ray has met something.
        If(found.greaterThan(0.5), () => {
          Break();
        });
        const q = positionWorld.add(bounce.mul(t)) as any;
        If(found.equal(0), () => {
          const inside = max(abs(q.x), abs(q.z)).lessThan(PATCH / 2 - CELL) as any;
          const k = desert.columnOf(q.xz) as any;
          const ground = inside.select(desert.cells.element(k).x, homeNode(q.xz)) as any;
          const palm = desert.palmsOver(q.xz) as any;
          If(q.y.greaterThan(palm.x).and(q.y.lessThan(palm.y)), () => {
            const leaf = q.y.greaterThan(palm.z) as any;
            const albedo = leaf.select(world.frond, world.trunk) as any;
            sky.assign(albedo.mul(sun.mul(leaf.select(float(0.3), float(0.5).mul(desert.palmShade(q.xz)))).add(air.mul(0.45))));
            found.assign(1);
          })
            .ElseIf(q.y.lessThan(ground), () => {
              const far = litSand(sandAlbedo(q.xz, ground), vec3(0, 1, 0), desert.palmShade(q.xz)) as any;
              sky.assign(inside.select(desert.tone.element(k).xyz, far));
              found.assign(1);
            })
            .ElseIf(inside.and(q.y.lessThan(ground.add(0.08))), () => {
              // The grass on the bank, as high as the green has grown it.
              const green = desert.life.element(k).y as any;
              const grass = green.mul(mix(float(0.02), float(0.06), world.oasis)) as any;
              If(q.y.lessThan(ground.add(grass)).and(green.greaterThan(0.3)), () => {
                const blade = mix(world.grass, world.grassTip, q.y.sub(ground).div(grass)) as any;
                sky.assign(blade.mul(sun.mul(desert.light.element(k).x).mul(0.45).add(air.mul(0.5))));
                found.assign(1);
              });
            });
        });
        t.mulAssign(1.3);
      });
      // The sand under the water, seen a little displaced through its rippling surface, its light dying with the depth
      // it passes through, red first, and the water's own colour gathering in its place.
      const under = p.sub(n.xz.mul(depth).mul(2.5)) as any;
      // Caustics: the ripples gather the sun into a moving net of bright lines on the bed, strongest a little way down,
      // gone where the net is finer than a pixel or the water too deep for the sun to reach.
      const net = (shift: number, speed: number) => pow(float(1).sub(abs(mx_noise_float(vec3(under.mul(34).add(shift), time.mul(speed))))), float(7));
      const caustic = net(0, 0.55)
        .add(net(4.3, -0.42))
        .mul(smoothstep(0.0006, 0.004, depth))
        .mul(exp(depth.mul(-25)))
        .mul(smoothstep(2, 6, float(1 / 34).div(distance.mul(world.pixel)))) as any;
      const bed = sandBetween(desert, under, desert.tone).xyz.mul(caustic.mul(lit).mul(1.6).add(1)) as any;
      const path = depth.div(max(facing, float(0.2))) as any;
      const through = exp((vec3(1) as any).sub(world.water).add(0.04).mul(path).mul(world.absorb).negate()) as any;
      const scatter = (world.water as any).mul(sun.mul(lit).mul(0.14).add(air.mul(0.38))) as any;
      // The sun off the surface: a highlight as sharp as the ripples left out of the normal allow, bright in the Fresnel
      // of the angle; none where something stands between it and the sky.
      const rough = float(0.035).add(ripples.z.mul(0.9)) as any;
      const half = normalize(world.toSun.add(eye)) as any;
      const nh = max(dot(n, half), float(1e-3)) as any;
      const a2 = rough.mul(rough) as any;
      const spread = exp(nh.mul(nh).sub(1).div(a2.mul(nh).mul(nh)))
        .div(a2.mul(nh.mul(nh).mul(nh).mul(nh)).mul(Math.PI))
        .min(60) as any;
      const sheen = pow(float(1).sub(max(dot(half, eye), float(0))), float(5))
        .mul(0.98)
        .add(0.02) as any;
      const glitter = sun
        .mul(spread)
        .mul(sheen)
        .mul(max(dot(n, world.toSun), float(0)))
        .div(max(facing, float(0.1)).mul(4))
        .mul(lit)
        .mul(found.oneMinus()) as any;
      const clear = mix(bed.mul(through).add(scatter.mul(vec3(1).sub(through))), sky, fresnel.mul(calm)).add(glitter.mul(smoothstep(0.0005, 0.004, depth))) as any;
      // Where the water thins to nothing at its edge, a lacy line of froth that comes and goes.
      const lace = smoothstep(0.1, 0.45, mx_noise_float(vec3(p.mul(60), time.mul(0.8)))) as any;
      const froth = smoothstep(0.0024, 0.0006, depth)
        .mul(smoothstep(0.0002, 0.0007, depth))
        .mul(lace)
        .mul(0.55)
        .mul(world.metal.oneMinus()) as any;
      const foam = mix(world.sand, vec3(1), 0.75).mul(sun.mul(lit).mul(0.6).add(air.mul(0.6))) as any;
      const metal = sky.mul(world.water).mul(0.9).add(glitter) as any;
      return mix(mix(clear, foam, froth), metal, world.metal);
    })() as any;
    m.opacityNode = smoothstep(0.0002, 0.003, depth) as any;
    return m;
  }, [desert, N, CELL]);
  useDispose(geometry, material);
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={1} />;
}

// The spray: grains thrown up by the hand that turn into drops as they fly, and sand the wind lifts off the crests.
export function Spray({ desert }: { desert: Desert }) {
  const { sprite, material } = useMemo(() => {
    const m = new THREE.SpriteNodeMaterial({
      alphaTest: 0.5,
      depthWrite: true,
      fog: false
    });
    m.positionNode = desert.sprayAt.element(instanceIndex).xyz as any;
    {
      const p = desert.sprayAt.element(instanceIndex) as any;
      const turning = desert.sprayVelocity.element(instanceIndex).w as any;
      m.scaleNode = p.w.greaterThan(0).select(mix(float(0.0045), float(0.007), turning.mul(smoothstep(0.85, 0.4, p.w))).mul(hash(float(instanceIndex)).mul(0.6).add(0.7)), float(0)) as any;
    }
    const colour = (() => {
      const p = desert.sprayAt.element(instanceIndex) as any;
      const turning = desert.sprayVelocity.element(instanceIndex).w as any;
      const water = turning.mul(smoothstep(0.85, 0.4, p.w)) as any;
      const sun = world.sun.mul(world.power) as any;
      const sand = litSand(mix(world.sandDark, world.sand, hash(float(instanceIndex))), vec3(0, 1, 0), float(1)) as any;
      const drop = world.water.mul(sun.mul(0.25).add(0.4)).add(skyColour(vec3(0, 1, 0)).mul(0.25)) as any;
      return mix(sand, drop, water);
    })();
    const q = uv().sub(0.5).mul(2) as any;
    m.colorNode = varying(colour) as any;
    m.opacityNode = smoothstep(1, 0.8, dot(q, q)) as any;
    const sprite = new THREE.Sprite(m);
    sprite.count = desert.sprays;
    sprite.frustumCulled = false;
    return { sprite, material: m };
  }, [desert]);
  useDispose(material);
  return <primitive object={sprite} />;
}
