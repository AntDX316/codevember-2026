"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  Fn,
  fract,
  hash,
  length,
  max,
  mix,
  mod,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sqrt,
  uniform,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { BRIGHTNESS, KINDS, PULSING, SHADES, SQUEEZE, type Bloom, type Instances } from "./bloom";
import { clock, giantLight, glowAt, light, paletteAt, pixel, REFLECTED, VEINS, veinStyle } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The way the eye looks, set each frame, to turn the threads' strips toward it.
export const eyeForward = uniform(new THREE.Vector3(0, 0, -1));

// One mushroom, built as numbers rather than a shape: each vertex knows which part it is (0 stem, 1 top of the cap,
// 2 gills under it), how far along or out it is, and how far round. The shader makes the shape from those, the
// mushroom's own size and lean, and how far it has grown.
function mushroomGeometry(fine: boolean) {
  const part: number[] = [];
  const at: number[] = [];
  const index: number[] = [];
  const grid = (kind: number, rows: number, sides: number, from: number) => {
    const first = part.length;
    for (let r = 0; r <= rows; r++)
      for (let s = 0; s <= sides; s++) {
        part.push(kind);
        at.push(from + ((1 - from) * r) / rows, (s / sides) * Math.PI * 2);
      }
    for (let r = 0; r < rows; r++)
      for (let s = 0; s < sides; s++) {
        const a = first + r * (sides + 1) + s;
        const b = a + sides + 1;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
  };
  grid(0, fine ? 16 : 7, fine ? 14 : 8, 0);
  grid(1, fine ? 12 : 6, fine ? 40 : 16, 0);
  grid(2, fine ? 8 : 4, fine ? 48 : 16, 0.08);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(part.length * 3), 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute("aAlong", new THREE.Float32BufferAttribute(at, 2));
  g.setIndex(index);
  return g;
}

// What one mushroom is at this moment, worked out from scratch each time it is asked for, so no node is shared
// between the shape and what the colour reads.
function mushroom() {
  const part = attribute("aPart", "float") as any;
  const along = attribute("aAlong", "vec2") as any;
  const foot = attribute("aFoot", "vec4") as any;
  const shape = attribute("aShape", "vec4") as any;
  const born = attribute("aBirth", "vec4") as any;
  const age = clock.sub(born.x).div(born.y) as any;
  const grown = clamp(age, 0, 1) as any;
  // Growing like a spring let go: the stem shoots up past its height and settles, then the cap, a closed bud till
  // then, pops open, flaring wider than it will stay, and settles too.
  const spring = (x: any) => float(1).sub(pow(float(0.0009), x).mul(cos(x.mul(11)).add(sin(x.mul(11)).mul(0.6)))) as any;
  const stemT = clamp(age.div(0.6), 0, 4) as any;
  const capT = clamp(age.sub(0.42).div(0.45), 0, 4) as any;
  const stemUp = age.greaterThan(0).select(spring(stemT), float(0)) as any;
  const open = age.greaterThan(0.42).select(spring(capT), float(0)) as any;
  const bud = smoothstep(0, 0.5, grown) as any;
  // Pushed about by a passing hand: a lean that springs back, from the processor.
  const wobble0 = attribute("aWobble", "vec2") as any;
  // Shooting spores: it scrunches down, its cap bulging, with a shiver; then springs up past its height and settles as
  // the spores go.
  const since = clock.sub(attribute("aSqueeze", "float")) as any;
  const gather = smoothstep(0, SQUEEZE, since).mul(since.lessThan(SQUEEZE).select(float(1), float(0))) as any;
  const after = since.sub(SQUEEZE).max(0) as any;
  const rebound = since.greaterThanEqual(SQUEEZE).select(exp(after.mul(-7)).mul(cos(after.mul(24))), float(0)) as any;
  const squash = gather
    .mul(gather)
    .add(rebound)
    .mul(since.lessThan(2).select(float(1), float(0))) as any;
  const shiver = vec2(sin(since.mul(47)), cos(since.mul(39))).mul(gather.mul(0.05)) as any;
  const wobble = wobble0.add(shiver) as any;
  // Its kind, colour and brightness, packed in one number (see bloom.ts).
  const kind = mod(shape.w, KINDS) as any;
  const hue = floor(mod(shape.w, SHADES).div(KINDS)) as any;
  const level = floor(shape.w.div(SHADES)) as any;
  const steady = mod(level, PULSING) as any;
  const base = BRIGHTNESS.slice(0, -1).reduceRight((rest: any, value, k) => steady.lessThan(k + 0.5).select(float(value), rest), float(BRIGHTNESS[BRIGHTNESS.length - 1])) as any;
  // Glowing in waves: brightening and going almost dark again, the wave rolling across the cluster from one side.
  const wave = pow(
    sin(clock.mul(0.9).add(born.z).sub(foot.x.add(foot.z).mul(9)))
      .mul(0.5)
      .add(0.5),
    float(2.5)
  ) as any;
  // Within any cluster, some glow brighter and some dimmer than the rest.
  const own = born.z.mul(0.61803).fract() as any;
  const mine = own.lessThan(0.35).select(float(0.25), own.lessThan(0.75).select(float(0.85), float(1.7))) as any;
  // Touched, any of them lights up, fading as it stops rocking.
  const stirred = clamp(length(wobble0).mul(14), 0, 1) as any;
  const shine = max(base.mul(mine).mul(level.greaterThanEqual(PULSING - 0.5).select(wave.mul(1.4).add(0.04), float(1))), stirred.mul(1.4)) as any;
  const byKind = (v: number[]) => v.slice(0, -1).reduceRight((rest: any, value, k) => kind.lessThan(k + 0.5).select(float(value), rest), float(v[v.length - 1])) as any;
  const bell = kind.lessThan(0.5).or(kind.greaterThan(2.5).and(kind.lessThan(4.5))) as any;
  // A pin at first, then the stem lifting the cap and the cap opening out from a closed bud.
  const L = shape.x.mul(mix(float(0.1), float(1), stemUp)).mul(float(1).sub(squash.mul(0.22))) as any;
  const capR = shape.y.mul(mix(float(0.35), float(1), bud)).mul(float(1).add(squash.mul(0.14))) as any;
  const away = vec3(cos(foot.w.add(born.w)), 0, sin(foot.w.add(born.w))) as any;
  const lean = shape.z as any;
  // The stem, bending outward as it rises.
  const t = along.x as any;
  const angle = along.y as any;
  const ring = vec3(cos(angle), 0, sin(angle)) as any;
  const spine = (k: any) =>
    foot.xyz
      .add(away.mul(lean.mul(L).mul(k.mul(k))))
      .add(vec3(wobble.x, 0, wobble.y).mul(L.mul(k.mul(k))))
      .add(vec3(0, L.mul(k), 0)) as any;
  const stemR = capR.mul(byKind([0.13, 0.17, 0.085, 0.16, 0.14, 0.15])).mul(pow(float(1).sub(t), float(4)).mul(0.45).add(1)) as any;
  // The cap, tilted the way the stem leans, a bell or a wide cap with a dip in its middle.
  const axis = normalize(
    vec3(0, 1, 0)
      .add(away.mul(lean.mul(1.4)))
      .add(vec3(wobble.x, 0, wobble.y).mul(2))
  ) as any;
  const H = capR.mul(mix(float(1.25), byKind([0.85, 0.32, 0.3, 1.0, 1.9, 0.3]), open)).mul(float(1).sub(squash.mul(0.25))) as any;
  const R = capR.mul(mix(float(0.6), float(1), open)) as any;
  const r = t as any;
  const flat = ring.sub(axis.mul(dot(ring, axis))) as any;
  const radial = normalize(flat.add(vec3(1e-5, 0, 0))) as any;
  // The stout kind's cap dips in its middle; the parasol's rises in a knob.
  const dip = H.mul(byKind([0, 0.7, -0.45, 0, 0, 1.6])).mul(open) as any;
  const topY = H.mul(-0.15)
    .add(H.mul(1.15).mul(float(1).sub(pow(r, float(2.2)))))
    .sub(dip.mul(pow(float(1).sub(r), float(3)))) as any;
  const underY = H.mul(-0.15).add(H.mul(0.45).mul(pow(float(1).sub(r), float(1.2)))) as any;
  const origin = spine(float(1)).sub(axis.mul(H.mul(0.35))) as any;
  const isTop = part.greaterThan(0.5).and(part.lessThan(1.5)) as any;
  const capPoint = origin.add(radial.mul(r.mul(R))).add(axis.mul(isTop.select(topY, underY))) as any;
  const stemPoint = spine(t).add(ring.mul(stemR)) as any;
  const position = part.lessThan(0.5).select(stemPoint, capPoint) as any;
  // Normals from the slopes of the same curves.
  const topSlope = H.mul(1.15)
    .mul(pow(r, float(1.2)).mul(-2.2))
    .add(dip.mul(pow(float(1).sub(r), float(2)).mul(3)))
    .div(R) as any;
  const underSlope = H.mul(-0.54)
    .mul(pow(float(1).sub(r).add(1e-3), float(0.2)))
    .div(R) as any;
  const capNormal = isTop.select(normalize(radial.mul(topSlope.negate()).add(axis)), normalize(radial.mul(underSlope).sub(axis))) as any;
  const normal = part.lessThan(0.5).select(ring, capNormal) as any;
  // A flash of light as the cap first opens fully, fading over a second or two.
  const flash = smoothstep(0.6, 1, capT).mul(pow(float(0.3), max(capT.sub(1), 0))) as any;
  return { position, normal, grown, part, t, angle, bell, kind, hue, shine, seed: born.z, foot, flash };
}

// The mushrooms: every one in one draw, shaped and grown by the clock, glowing from their gills and through their
// caps, lit faintly by the moon and by each other.
// `mirrored`: drawn again in the puddles. The giants are; the hundreds of small ones would cost too much drawn twice.
export function Mushrooms({ bloom, fine, bright = 1, mirrored = false }: { bloom: Instances; fine: boolean; bright?: number; mirrored?: boolean }) {
  const { mesh, material, geometry, attrs } = useMemo(() => {
    const geometry = mushroomGeometry(fine);
    const attrs = {
      foot: new THREE.InstancedBufferAttribute(bloom.foot, 4),
      shape: new THREE.InstancedBufferAttribute(bloom.shape, 4),
      birth: new THREE.InstancedBufferAttribute(bloom.birth, 4)
    };
    geometry.setAttribute("aFoot", attrs.foot);
    geometry.setAttribute("aShape", attrs.shape);
    geometry.setAttribute("aBirth", attrs.birth);
    const wobble = new THREE.InstancedBufferAttribute(bloom.wobble ?? new Float32Array((bloom.foot.length / 4) * 2), 2);
    geometry.setAttribute("aWobble", wobble);
    const squeeze = new THREE.InstancedBufferAttribute(bloom.squeeze ?? new Float32Array(bloom.foot.length / 4).fill(-1000), 1);
    geometry.setAttribute("aSqueeze", squeeze);
    geometry.instanceCount = 0;
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
    material.positionNode = mushroom().position;
    const normal = varying(mushroom().normal) as any;
    // Packed four to a varying: the fragment stage takes only sixteen.
    const where = varying(vec4(mushroom().grown, mushroom().part, mushroom().t, mushroom().angle)) as any;
    const grown = where.x as any;
    const part = where.y as any;
    const t = where.z as any;
    const angle = where.w as any;
    const tags = varying(vec4(mushroom().bell.select(float(1), float(0)), mushroom().kind, mushroom().hue, mushroom().shine)) as any;
    const bell = tags.x as any;
    const kind = tags.y as any;
    const hue = tags.z as any;
    const shine = tags.w as any;
    const more = varying(vec3(mushroom().seed, length(mushroom().foot.xz), mushroom().flash)) as any;
    const seed = more.x as any;
    const footFar = more.y as any;
    const flash = more.z as any;
    material.colorNode = Fn(() => {
      const n = normalize(normal) as any;
      const V = normalize(cameraPosition.sub(positionWorld)) as any;
      const isStem = part.lessThan(0.5) as any;
      const isTop = part.greaterThan(0.5).and(part.lessThan(1.5)) as any;
      const byKind = (v: number[]) => v.slice(0, -1).reduceRight((rest: any, value, k) => kind.lessThan(k + 0.5).select(float(value), rest), float(v[v.length - 1])) as any;
      const glowTint = paletteAt(hue) as any;
      const capTintLight = mix(glowTint, vec3(1, 1, 1), 0.45) as any;
      // Pale flesh, a little browner in the stouter kind; darker at the foot of the stem, where it comes out of the
      // litter.
      const foot = isStem.select(smoothstep(0, 0.15, t).mul(0.75).add(0.25), float(1)) as any;
      // Some stems plain, some rough: streaked lengthwise, banded in snakeskin scales, or with a ring left by the veil just
      // under the cap.
      const rough = seed.mul(0.7531).fract() as any;
      const streaks = mx_noise_float(vec3(angle.mul(5), t.mul(40), seed))
        .mul(0.5)
        .add(0.5) as any;
      const scales = smoothstep(
        0.55,
        0.75,
        t
          .mul(16)
          .add(sin(angle.mul(3).add(seed)).mul(0.6))
          .fract()
      ).mul(smoothstep(0.85, 0.2, t)) as any;
      const ring = smoothstep(0.06, 0, abs(t.sub(0.82))) as any;
      const stemTexture = mix(float(1), streaks.mul(0.5).add(0.6), rough.greaterThan(0.35).select(float(1), float(0)))
        .mul(float(1).sub(scales.mul(rough.greaterThan(0.65).select(float(0.45), float(0)))))
        .add(ring.mul(rough.lessThan(0.3).select(float(0.6), float(0)))) as any;
      const albedo = mix(vec3(0.62, 0.5, 0.36), vec3(0.6, 0.58, 0.5), bell)
        .mul(foot)
        .mul(isStem.select(stemTexture, float(1))) as any;
      const moonlit = albedo
        .mul(light.moon)
        .mul(max(dot(n, light.toMoon), 0))
        .mul(light.moonPower)
        .mul(0.35) as any;
      const neighbours = albedo.mul(glowAt(positionWorld).add(giantLight().mul(0.15))).mul(0.4) as any;
      // How strongly it glows: dim as a pin, full once open; each breathing on its own, and a slow wave across the
      // whole floor.
      const ripe = pow(smoothstep(0.2, 1, grown), float(1.5)) as any;
      const breath = sin(clock.mul(1.7).add(seed.mul(6)))
        .mul(0.15)
        .add(0.85)
        .mul(
          sin(clock.mul(0.6).sub(footFar.mul(5)))
            .mul(0.12)
            .add(0.88)
        ) as any;
      // Gills brightest, in fine ridges; through the cap, brighter toward the thin rim than the darker middle; the
      // stem faint, brightening toward the cap.
      const ridges = pow(abs(cos(angle.mul(byKind([13, 22, 30, 9, 18, 26])))), float(3)) as any;
      const gills = glowTint
        .mul(ridges.mul(1.5).add(0.9))
        .mul(smoothstep(0.05, 0.35, t))
        .mul(2.2) as any;
      const rim = pow(float(1).sub(abs(dot(n, V))), float(2)) as any;
      // Through the cap: dark at the middle, translucent toward the thin rim, in fine radial striations.
      const striae = cos(angle.mul(byKind([26, 40, 48, 14, 34, 44])))
        .mul(0.5)
        .add(0.5)
        .mul(smoothstep(0.3, 0.9, t)) as any;
      const thin = smoothstep(0.25, 1, t) as any;
      // Fine fibrils running out to the rim, and a scatter of tiny specks, so the cap is skin and not plastic.
      const fibrils = sin(angle.mul(byKind([90, 120, 140, 50, 110, 130])).add(sin(angle.mul(7).add(seed)).mul(2)))
        .mul(0.5)
        .add(0.5)
        .mul(0.12)
        .add(0.94) as any;
      const specks = smoothstep(
        0.82,
        0.9,
        sin(angle.mul(53).add(seed))
          .mul(sin(t.mul(37).add(seed.mul(3))))
          .mul(0.5)
          .add(0.5)
      ).mul(0.25) as any;
      const through = capTintLight
        .mul(thin.mul(0.55).add(0.06).add(striae.mul(0.25)).add(rim.mul(0.6)))
        .mul(byKind([1.15, 0.22, 1.05, 1.3, 1.1, 0.8]))
        .mul(fibrils)
        .mul(float(1).sub(specks)) as any;
      // The stouter kind's cap is warm and mostly dark on top, its light all underneath.
      const capTint = mix(vec3(0.45, 0.22, 0.08), vec3(0.32, 0.3, 0.24), bell) as any;
      const half = normalize(light.toMoon.add(V)) as any;
      const sheen = pow(max(dot(n, half), 0), float(40))
        .mul(light.moonPower)
        .mul(0.5) as any;
      const topLit = capTint
        .mul(
          glowAt(positionWorld)
            .mul(0.6)
            .add(light.moon.mul(max(dot(n, light.toMoon), 0).mul(light.moonPower).mul(0.5)))
        )
        .add(light.moon.mul(sheen)) as any;
      // The stem: fibrous lengthwise, glowing faintly, brightest just under the cap.
      const fibres = sin(angle.mul(14).add(sin(t.mul(9).add(seed)).mul(0.6)))
        .mul(0.12)
        .add(0.88) as any;
      const stem = mix(glowTint, capTintLight, 0.6)
        .mul(pow(t, float(2)).mul(0.22).add(0.025))
        .mul(fibres)
        .mul(stemTexture) as any;
      const glow = isStem.select(stem, isTop.select(through, gills)).mul(ripe).mul(breath).mul(bright).mul(shine).mul(flash.mul(1.3).add(1)) as any;
      const lit = isTop.select(topLit, moonlit.add(neighbours)) as any;
      // Dew from the rain on the tops of the caps: clear beads, each holding a point of the moon and a little of the cap's
      // own light, near to only.
      const cells = vec2(angle.mul(byKind([2.2, 3.2, 3.6, 1.6, 2.6, 3.4])), t.mul(byKind([5, 6, 7, 3, 6, 6]))) as any;
      const cell = floor(cells) as any;
      const pick = hash(cell.x.mul(13.7).add(cell.y.mul(71.3)).add(seed)) as any;
      const spot = fract(cells).sub(0.5) as any;
      const bead = smoothstep(0.32, 0.18, length(spot))
        .mul(pick.greaterThan(0.62).select(float(1), float(0)))
        .mul(isTop.select(float(1), float(0)))
        .mul(smoothstep(0.15, 0.4, t))
        .mul(ripe) as any;
      const core = smoothstep(0.12, 0.0, length(spot.sub(vec2(-0.08, 0.1)))) as any;
      const close = smoothstep(1.2, 0.25, length(cameraPosition.sub(positionWorld))) as any;
      const dew = capTintLight
        .mul(0.25)
        .add(light.moon.mul(core.mul(2.2)))
        .mul(bead)
        .mul(close) as any;
      return vec4(lit.add(glow).add(dew), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    if (mirrored) mesh.layers.enable(REFLECTED);
    mesh.frustumCulled = false;
    return { mesh, material, geometry, attrs: { ...attrs, wobble, squeeze } };
  }, [bloom, fine, mirrored]);
  useFrame(() => {
    if (bloom.mushroomsDirty) {
      bloom.mushroomsDirty = false;
      attrs.foot.needsUpdate = attrs.shape.needsUpdate = attrs.birth.needsUpdate = true;
    }
    if (bloom.wobbling) attrs.wobble.needsUpdate = true;
    if (bloom.squeezeDirty) {
      bloom.squeezeDirty = false;
      attrs.squeeze.needsUpdate = true;
    }
    geometry.instanceCount = bloom.mushrooms;
  });
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// The light of each bloom hanging in the damp air round it: a soft halo over every cluster, as bright as its
// mushrooms are grown.
export function Halos({ bloom }: { bloom: Bloom }) {
  const { mesh, material, geometry, at } = useMemo(() => {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const at = new THREE.InstancedBufferAttribute(new Float32Array(bloom.maxClusters * 4), 4);
    geometry.setAttribute("aHalo", at);
    geometry.instanceCount = 0;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const halo = attribute("aHalo", "vec4") as any;
    const centre = halo.xyz as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const up = cross(toEye, right) as any;
    const size = float(0.11) as any;
    material.positionNode = centre.add(right.mul(attribute("position", "vec3").x.mul(size))).add(up.mul(attribute("position", "vec3").y.mul(size))) as any;
    material.colorNode = Fn(() => {
      const r = attribute("position", "vec3").xy.length() as any;
      const soft = pow(smoothstep(1, 0, r), float(2.2)) as any;
      return vec4(light.glow.mul(soft).mul(halo.w).mul(0.06), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.enable(REFLECTED);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return { mesh, material, geometry, at };
  }, [bloom]);
  useFrame(() => {
    const now = clock.value as number;
    const a = at.array as Float32Array;
    bloom.clusters.forEach((c, k) => {
      let lit = 0;
      for (const i of c.slots) lit += Math.min(1, Math.max(0, (now - bloom.birth[i * 4]) / bloom.birth[i * 4 + 1])) ** 2;
      a.set([c.x, c.y + (c.kind === 0 ? 0.035 : 0.04), c.z, Math.min(1.6, lit / 5) * BRIGHTNESS[c.shade % PULSING] * (0.85 + 0.15 * Math.sin(now * 1.3 + c.x * 7))], k * 4);
    });
    at.needsUpdate = true;
    geometry.instanceCount = bloom.clusters.length;
  });
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// The giants' light hanging in the damp air round their caps: big soft haloes, so the woods glow round them and
// whatever walks between shows black against it.
export function GiantHalos({ giants, strength }: { giants: { x: number; z: number; stem: number; cap: number; hue: number }[]; strength: number }) {
  const { mesh, material, geometry } = useMemo(() => {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const data: number[] = [];
    for (const g of giants) data.push(g.x, g.stem * 0.9, g.z, g.cap * 2.8, g.hue, 0, 0, 0);
    const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(data), 8);
    geometry.setAttribute("aAt", new THREE.InterleavedBufferAttribute(buffer, 4, 0));
    geometry.setAttribute("aHue", new THREE.InterleavedBufferAttribute(buffer, 4, 4));
    geometry.instanceCount = giants.length;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const at = attribute("aAt", "vec4") as any;
    const hue = attribute("aHue", "vec4") as any;
    const toEye = normalize(cameraPosition.sub(at.xyz)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const up = cross(toEye, right) as any;
    const corner = attribute("position", "vec3") as any;
    material.positionNode = at.xyz.add(right.mul(corner.x.mul(at.w))).add(up.mul(corner.y.mul(at.w))) as any;
    material.colorNode = Fn(() => {
      const r = corner.xy.length() as any;
      const soft = pow(smoothstep(1, 0, r), float(2.4)) as any;
      return vec4(paletteAt(hue.x).mul(soft).mul(strength), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.enable(REFLECTED);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return { mesh, material, geometry };
  }, [giants, strength]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// A dark patch on the litter round the foot of each mushroom, where it shades and crowds the ground it grows from,
// so it stands in the floor rather than on it.
export function Footprints({ bloom }: { bloom: Bloom }) {
  const { mesh, material, geometry } = useMemo(() => {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], 3));
    geometry.setIndex([0, 2, 1, 0, 3, 2]);
    geometry.setAttribute("aFoot", new THREE.InstancedBufferAttribute(bloom.foot, 4));
    geometry.setAttribute("aShape", new THREE.InstancedBufferAttribute(bloom.shape, 4));
    geometry.setAttribute("aBirth", new THREE.InstancedBufferAttribute(bloom.birth, 4));
    geometry.instanceCount = 0;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    const foot = attribute("aFoot", "vec4") as any;
    const shape = attribute("aShape", "vec4") as any;
    const born = attribute("aBirth", "vec4") as any;
    const grown = clamp(clock.sub(born.x).div(born.y), 0, 1) as any;
    const reach = max(shape.y.mul(0.9), float(0.004)).mul(smoothstep(0, 0.6, grown)) as any;
    material.positionNode = foot.xyz.add(vec3((positionGeometry as any).x.mul(reach), 0.006, (positionGeometry as any).z.mul(reach))) as any;
    material.colorNode = vec4(0, 0, 0, 1) as any;
    material.opacityNode = pow(smoothstep(1, 0, positionGeometry.xz.length()), float(1.6))
      .mul(0.6)
      .mul(grown) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return { mesh, material, geometry };
  }, [bloom]);
  useFrame(() => {
    if (bloom.mushroomsDirty) for (const name of ["aFoot", "aShape", "aBirth"]) (geometry.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
    geometry.instanceCount = bloom.mushrooms;
  });
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// The mycelium: fine glowing threads through the litter, drawn as strips turned to the eye, reaching out from each
// cluster at the pace a living thread would, its growing tips brightest, pulses of light running out along them.
// A number for each vein look, picked by the panel's choice in the shader.
const byVein = (v: number[]) => v.slice(0, -1).reduceRight((rest: any, value, k) => veinStyle.lessThan(k + 0.5).select(float(value), rest), float(v[v.length - 1])) as any;

export function Threads({ bloom }: { bloom: Bloom }) {
  const { mesh, material, geometry, attrs } = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const attrs = {
      at: new THREE.BufferAttribute(bloom.threadAt, 3),
      dir: new THREE.BufferAttribute(bloom.threadDir, 3),
      info: new THREE.BufferAttribute(bloom.threadInfo, 4),
      index: new THREE.BufferAttribute(bloom.threadIndex, 1)
    };
    geometry.setAttribute("position", attrs.at);
    geometry.setAttribute("aDir", attrs.dir);
    geometry.setAttribute("aInfo", attrs.info);
    geometry.setIndex(attrs.index);
    geometry.setDrawRange(0, 0);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    const reach = () => {
      const info = attribute("aInfo", "vec4") as any;
      // How far past this point the thread has grown, in metres, at a few centimetres a second.
      return clock
        .sub(info.y)
        .mul(byVein(VEINS.map((v) => v.speed)))
        .sub(info.x) as any;
    };
    material.positionNode = Fn(() => {
      const info = attribute("aInfo", "vec4") as any;
      const dir = attribute("aDir", "vec3") as any;
      const side = normalize(cross(dir, eyeForward).add(vec3(0, 1e-4, 0))) as any;
      const shown = smoothstep(0, 0.015, reach()) as any;
      // Never narrower than about a pixel; finer than that, it dims instead.
      const at = attribute("position", "vec3") as any;
      const least = length(cameraPosition.sub(at)).mul(pixel).mul(0.45) as any;
      const half = max(abs(info.z).mul(byVein(VEINS.map((v) => v.drawn))), least).mul(info.z.sign()) as any;
      return at.add(side.mul(half.mul(shown)));
    })() as any;
    material.colorNode = Fn(() => {
      const info = attribute("aInfo", "vec4") as any;
      const arc = varying(info.x) as any;
      const seed = varying(info.w) as any;
      const ahead = varying(reach()) as any;
      const shown = smoothstep(0, 0.015, ahead) as any;
      const tip = smoothstep(0.05, 0, ahead).mul(shown) as any;
      // Breathing: slow, soft swells of light rolling out along every thread from the cluster it grew from, the whole
      // web drawing breath together and the swells running on through the forks; now and then a brighter bead.
      const breath = sin(clock.mul(0.55)).mul(0.35).add(0.65) as any;
      const swell = pow(
        sin(arc.mul(9).sub(clock.mul(1.1)))
          .mul(0.5)
          .add(0.5),
        float(2.5)
      ).mul(breath) as any;
      const pulse = pow(
        sin(arc.mul(16).sub(clock.mul(2.4)).add(seed))
          .mul(0.5)
          .add(0.5),
        float(14)
      ) as any;
      const slow = sin(arc.mul(3).sub(clock.mul(0.8)))
        .mul(0.3)
        .add(0.7) as any;
      const strand = seed.greaterThan(999).select(float(1.4), float(1)) as any;
      const at = attribute("position", "vec3") as any;
      const fine = clamp(abs(info.z).div(length(cameraPosition.sub(at)).mul(pixel).mul(0.45)), 0, 1) as any;
      // Faint along their length, a bead of light running out along each now and then, the growing tips brightest.
      const sparkle = pow(
        sin(arc.mul(90).add(seed.mul(7)).add(clock.mul(0.7)))
          .mul(0.5)
          .add(0.5),
        float(30)
      ).mul(0.6) as any;
      // Rounded across, as a thread is: brightest down its middle.
      const across = varying(info.z.sign()) as any;
      const round = sqrt(max(float(1).sub(across.mul(across)), 0))
        .mul(0.7)
        .add(0.3) as any;
      // Each look its own: glowing threads breathing; roots lit along their edges, warmer; a fine web glinting; a soft
      // wide glow under the litter; dim threads with bright pulses racing out along them.
      const edges = pow(abs(across), float(1.5)).mul(0.9).add(0.1) as any;
      const haze = exp(across.mul(across).mul(-2.5)) as any;
      const race = pow(
        sin(arc.mul(5).sub(clock.mul(5)).add(seed.mul(0.37)))
          .mul(0.5)
          .add(0.5),
        float(24)
      ).mul(3) as any;
      const looks = [
        // Thick and soft-edged, glowing through the litter rather than drawn on it.
        slow
          .mul(0.12)
          .add(swell.mul(0.75))
          .add(pulse.mul(0.6))
          .add(tip.mul(1.5))
          .add(sparkle)
          .mul(mix(round, haze, 0.6))
          .mul(0.8),
        float(0.25).add(swell.mul(0.35)).add(tip).mul(edges),
        float(0.15).add(sparkle.mul(1.5)).add(pulse.mul(0.4)).add(tip).mul(round),
        float(0.18).add(swell.mul(0.4)).add(tip.mul(0.5)).mul(haze),
        float(0.05).add(race).add(tip).mul(round)
      ];
      const amount = looks.slice(0, -1).reduceRight((rest: any, value: any, k) => veinStyle.lessThan(k + 0.5).select(value, rest), looks[looks.length - 1]) as any;
      const colour = veinStyle.equal(1).select(mix(light.thread, light.cap, 0.45), light.thread) as any;
      return vec4(colour.mul(amount).mul(shown).mul(strand).mul(varying(fine)), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.enable(REFLECTED);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return { mesh, material, geometry, attrs };
  }, [bloom]);
  useFrame(() => {
    if (bloom.threadsDirty) {
      bloom.threadsDirty = false;
      attrs.at.needsUpdate = attrs.dir.needsUpdate = attrs.info.needsUpdate = attrs.index.needsUpdate = true;
    }
    geometry.setDrawRange(0, bloom.indices);
  });
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}
