"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { forwardRef, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  abs,
  atan,
  attribute,
  color,
  cos,
  cross,
  dot,
  exp,
  faceDirection,
  float,
  fract,
  frontFacing,
  int,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  normalGeometry,
  normalize,
  positionGeometry,
  positionView,
  refract,
  screenCoordinate,
  select,
  sign,
  sin,
  smoothstep,
  transformNormalToView,
  uniformArray,
  varying,
  vec2,
  vec3
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import type { QualityTier } from "../../shared/engine/types";
import { MAX_TAPS, type Live } from "./live";
import { buildShell, radiusNode, SHOULDER } from "./shape";

// The jewel itself: a shell of glossy skin, gold dots round its crown, and inside it the sleeper, a dark shape seen
// through jade-coloured flesh by its own pulsing light. Taps ripple the skin and grow gold cracks out from where they
// land along the lines it will break on; when it breaks, each piece folds back or falls, all worked out in the shader
// from how long ago it broke.

// v turned by angle about the unit axis k.
const turn = (v: any, k: any, angle: any) => {
  const c = cos(angle) as any;
  const s = sin(angle) as any;
  return v.mul(c).add(cross(k, v).mul(s)).add(k.mul(dot(k, v)).mul(float(1).sub(c))) as any;
};

const hash1 = (x: any) => fract(sin(x.mul(12.9898)).mul(43758.547)) as any;

// Raised gold beyond the ring: pairs low down, on the wing cases and near the crown.
const SPOTS: [number, number, number][] = [
  [0.38, -0.55, 0.026],
  [-0.38, -0.55, 0.026],
  [0.95, -0.1, 0.022],
  [-0.95, -0.1, 0.022],
  [0.5, 0.62, 0.019],
  [-0.5, 0.62, 0.019],
  [0, -0.32, 0.015]
];

// A height for bumping the surface, turned into a normal by how it changes across the screen.
function bumped(height: any, normal: any) {
  const sx = positionView.dFdx() as any;
  const sy = positionView.dFdy() as any;
  const r1 = cross(sy, normal) as any;
  const r2 = cross(normal, sx) as any;
  const det = dot(sx, r1).mul(faceDirection) as any;
  const grad = sign(det).mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2))) as any;
  return normalize(abs(det).mul(normal).sub(grad)) as any;
}

// The sleeper, as a distance: a segmented abdomen, a thorax and head, and the folded wing cases over its front.
function sleeper(q: any, beat: any) {
  const ellipsoid = (centre: [number, number, number], r: [number, number, number], swell: any = float(1)) => {
    const radii = vec3(...r).mul(swell) as any;
    return length(q.sub(vec3(...centre)).div(radii)).sub(1).mul(Math.min(...r)) as any;
  };
  const swell = float(1).add(beat.mul(0.035)) as any;
  const segments = sin(q.y.mul(31)).mul(0.012).mul(smoothstep(0.2, 0.0, q.y)) as any;
  const abdomen = ellipsoid([0, -0.15, -0.05], [0.21, 0.52, 0.19], swell).add(segments) as any;
  const thorax = ellipsoid([0, 0.3, -0.03], [0.19, 0.24, 0.17]) as any;
  const cases = ellipsoid([0, 0.08, 0.08], [0.25, 0.42, 0.1]) as any;
  const blend = (a: any, b: any, k: number) => {
    const h = max(float(k).sub(abs(a.sub(b))), float(0)).div(k) as any;
    return min(a, b).sub(h.mul(h).mul(k * 0.25)) as any;
  };
  return blend(blend(abdomen, thorax, 0.12), cases, 0.08) as any;
}

export function makeShellMaterial(live: Live, seeds: THREE.Vector3[], steps: number) {
  const seedArray = uniformArray(seeds, "vec3") as any;
  const p = positionGeometry as any;
  const shard = attribute("aShard", "vec4") as any;
  const hinge = attribute("aHinge", "vec4") as any;

  // Each tap's ripple, a ring running out from where it landed and dying away.
  const rippleAt = (q: any) => {
    let sum: any = float(0);
    for (let k = 0; k < MAX_TAPS; k++) {
      const tap = live.taps.element(k) as any;
      const age = live.now.sub(tap.w).max(0) as any;
      const d = length(q.sub(tap.xyz)) as any;
      const front = age.mul(0.8) as any;
      const wave = sin(d.sub(front).mul(46)).mul(exp(age.mul(-1.7))).mul(exp(d.mul(-2.2))).mul(smoothstep(-0.02, 0.05, front.sub(d))) as any;
      sum = sum.add(wave);
    }
    return sum as any;
  };

  // The shell's motion. Pieces that fall drift out, tumble and drop, shrinking away; pieces that peel fold back about
  // their top edge with a little overshoot; the crown stays.
  const t = live.shardT as any;
  const centre = shard.xyz as any;
  const kind = hinge.w as any;
  const r = hash1(shard.w.add(1)) as any;
  const out = normalize(vec3(centre.x, centre.y.mul(0.25), centre.z).add(vec3(0.0011, 0, 0.0007))) as any;
  const fallTime = t.sub(r.mul(0.35)).clamp(0, 2.6) as any;
  const fallAxis = normalize(vec3(out.z.negate(), 0, out.x).add(vec3(r.sub(0.5).mul(0.6), 0.35, float(0.5).sub(r).mul(0.5)))) as any;
  const fallAngle = fallTime.mul(r.mul(2.4).add(1.4)) as any;
  const fallMove = out.mul(fallTime.mul(r.mul(0.35).add(0.45))).add(vec3(0, fallTime.mul(fallTime).mul(-1.9), 0)) as any;
  const fallScale = float(1).sub(smoothstep(1.5, 2.5, fallTime)) as any;
  const peelTime = t.sub(r.mul(0.18)).max(0) as any;
  const flat = normalize(vec3(centre.x, 0, centre.z).add(vec3(0.0011, 0, 0.0007))) as any;
  const peelAxis = normalize(vec3(flat.z.negate(), 0, flat.x)).negate() as any;
  const peelAngle = float(1).sub(exp(peelTime.mul(-3.4)).mul(cos(peelTime.mul(6)))).mul(r.mul(0.5).add(1.55)) as any;
  const falls = kind.greaterThan(1.5) as any;
  const peels = kind.greaterThan(0.5).and(kind.lessThan(1.5)) as any;
  const pivot = select(falls, centre, hinge.xyz) as any;
  const axis = select(falls, fallAxis, peelAxis) as any;
  const angle = select(falls, fallAngle, select(peels, peelAngle, float(0))) as any;
  const move = select(falls, fallMove, select(peels, flat.mul(smoothstep(0, 0.6, peelTime).mul(0.03)), vec3(0, 0, 0))) as any;
  const scale = select(falls, fallScale, float(1)) as any;

  const lift = rippleAt(p).mul(0.0035).add(live.beat.mul(0.0022).mul(live.intact)) as any;
  const rest = p.add(normalGeometry.mul(lift)) as any;
  const moved = turn(rest.sub(pivot), axis, angle).mul(scale).add(pivot).add(move) as any;
  const turnedNormal = turn(normalGeometry, axis, angle) as any;

  const material = new THREE.MeshPhysicalNodeMaterial({
    side: THREE.DoubleSide,
    roughness: 0.45,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.2,
    iridescence: 0.15,
    iridescenceIOR: 1.6,
    // A faint waxy bloom over the skin, as a real chrysalis has.
    sheen: 0.25,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color("#8fa597")
  });
  material.positionNode = moved;
  material.castShadowPositionNode = moved;

  {
    // Patterns ride on the skin where it was made, so they go with the pieces.
    const phi = atan(p.x, p.z) as any;
    const across = radiusNode(p.y) as any;

    // Gold: a ring of beads round the shoulder across the front, a fine gold line above it with a black one over that,
    // and a scatter of single beads.
    const pitch = (Math.PI * 2) / 19;
    const k = phi.div(pitch).round() as any;
    const at = k.mul(pitch) as any;
    const size = float(0.016).add(hash1(k.add(3)).mul(0.012)) as any;
    const ringBead = smoothstep(size, size.mul(0.7), length(vec2(phi.sub(at).mul(across), p.y.sub(SHOULDER)))).mul(step01(float(2.35).sub(abs(at)))) as any;
    let beads: any = ringBead;
    for (const [a, y, s] of SPOTS) {
      beads = max(beads, smoothstep(s, s * 0.7, length(vec2(phi.sub(a).mul(across), p.y.sub(y)))));
    }
    const lineY = float(SHOULDER + 0.046).add(sin(phi.mul(9)).mul(0.005)) as any;
    const front = smoothstep(2.45, 2.2, abs(phi)) as any;
    const goldLine = smoothstep(0.0042, 0.0018, abs(p.y.sub(lineY))).mul(front) as any;
    const blackLine = smoothstep(0.0035, 0.0012, abs(p.y.sub(lineY.add(0.014)))).mul(front) as any;
    const gold = max(beads, goldLine) as any;

    // The folded wing cases under the skin: a faint raised edge down each side of the front from the shoulder, and
    // across below them.
    const below = float(SHOULDER).sub(p.y).div(0.95).clamp(0, 1) as any;
    const caseSide = abs(phi).sub(float(1.15).sub(below.mul(below).mul(0.5))).mul(across) as any;
    const caseFoot = p.y.sub(phi.mul(phi).mul(0.1).sub(0.5)) as any;
    const caseEdge = max(
      smoothstep(0.007, 0.0015, abs(caseSide)).mul(smoothstep(-0.52, -0.44, p.y)).mul(smoothstep(SHOULDER, SHOULDER - 0.06, p.y)),
      smoothstep(0.007, 0.0015, abs(caseFoot)).mul(smoothstep(1.12, 1.0, abs(phi)))
    ) as any;
    const onCase = smoothstep(0.01, -0.01, caseSide).mul(smoothstep(-0.01, 0.01, caseFoot)).mul(smoothstep(SHOULDER, SHOULDER - 0.03, p.y)) as any;

    // Cracks: the true edges between pieces, as the distance to the nearest of the planes halfway to each other seed,
    // shown only where a tap's spreading reach has got to.
    const wobble = mx_noise_float(p.mul(7)) as any;

    let reach: any = float(0);
    let burning: any = float(0);
    let star: any = float(0);
    for (let n = 0; n < MAX_TAPS; n++) {
      const tap = live.taps.element(n) as any;
      const on = step01(tap.w.add(100)) as any;
      const age = live.now.sub(tap.w).max(0) as any;
      const d = length(p.sub(tap.xyz)).add(wobble.mul(0.06)) as any;
      const furthest = 0.3 + n * 0.11;
      const R = float(furthest).mul(float(1).sub(exp(age.mul(-3)))) as any;
      reach = max(reach, smoothstep(R, R.sub(0.08), d).mul(on));
      burning = max(burning, smoothstep(0.07, 0, abs(d.sub(R))).mul(exp(age.mul(-1.4))).mul(on));
      // A little star of short cracks right where it landed.
      const up = vec3(0, 1, 0);
      const outward = normalize(vec3(tap.x, 0, tap.z).add(vec3(0.0013, 0, 0.0009))) as any;
      const side = vec3(outward.z.negate(), 0, outward.x) as any;
      const v = p.sub(tap.xyz) as any;
      const dist = length(v) as any;
      const a = atan(dot(v, up), dot(v, side)) as any;
      const spokes = 7;
      const cell = fract(a.div((Math.PI * 2) / spokes).add(n * 0.37)).sub(0.5).abs() as any;
      const off = cell.mul((Math.PI * 2) / spokes).mul(dist) as any;
      const span = min(R.mul(0.6), float(0.2)) as any;
      star = max(star, smoothstep(0.0042, 0.0012, off).mul(smoothstep(span, span.mul(0.4), dist)).mul(on));
    }
    const shown = min(reach.add(live.flare), float(1)).mul(live.heal) as any;
    const nearest = Fn(() => {
      const own = int(shard.w) as any;
      const mine = seedArray.element(own) as any;
      const best = float(1000).toVar();
      const toMine = dot(p.sub(mine), p.sub(mine)) as any;
      // Only worth finding where a crack is showing.
      If(live.cracked.greaterThan(0.5), () => {
        Loop({ start: 0, end: seeds.length, type: "int", name: "s" } as any, ({ s }: any) => {
          const other = seedArray.element(s) as any;
          const apart = max(length(other.sub(mine)), float(1e-4)) as any;
          const toOther = dot(p.sub(other), p.sub(other)) as any;
          const edge = toOther.sub(toMine).div(apart.mul(2)) as any;
          best.assign(min(best, select(s.equal(own), float(1000), edge)));
        });
      });
      return best;
    })() as any;
    const seamDistance = abs(nearest) as any;
    const width = float(0.0055).add(wobble.mul(0.0025)) as any;
    const line = float(1).sub(smoothstep(width.mul(0.35), width, seamDistance)) as any;
    const halo = exp(seamDistance.mul(-70)) as any;
    const crack = max(line.mul(shown), star.mul(live.heal)) as any;

    // The glow inside, marched through the flesh from where the eye enters it. Light comes from round the sleeper and
    // from its heart; the flesh soaks it up by colour as it goes and the sleeper blocks it, so it shows as a shadow
    // with a glowing edge.
    const glowInside = Fn(() => {
      const view = normalize(p.sub(live.camPod)) as any;
      const bent = refract(view, normalGeometry, 0.72) as any;
      const dir = normalize(bent.add(view.mul(1e-3))) as any;
      const jitter = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))))) as any;
      const ds = 1.05 / steps;
      // Read once out here: a uniform read only inside the loop was left unbound and kept its first value.
      const absorb = vec3(live.absorb).toVar();
      const through = vec3(1, 1, 1).toVar();
      const light = vec3(0, 0, 0).toVar();
      const heart = vec3(0, 0.05, -0.2) as any;
      // Nothing to see once it has opened, so the march is skipped.
      If(live.intact.greaterThan(0.002), () => {
      Loop({ start: 0, end: steps, type: "int", name: "m" } as any, ({ m }: any) => {
        const q = p.add(dir.mul(float(m).add(jitter).mul(ds))) as any;
        const inside = smoothstep(-0.004, 0.025, radiusNode(q.y).sub(length(q.xz))) as any;
        const body = sleeper(q, live.beat) as any;
        const solid = smoothstep(0.05, -0.05, body) as any;
        const near = exp(max(body, float(0)).mul(-7.5)) as any;
        const pulse = exp(length(q.sub(heart)).mul(-5.5)).mul(live.beat) as any;
        // Only a little light is given off on the near side; most comes through from behind the sleeper.
        const emit = float(0.24).add(near.mul(live.beat.mul(0.45).add(0.25))).add(pulse.mul(0.8)).mul(inside).mul(float(1).sub(solid)) as any;
        light.addAssign(through.mul(emit).mul(ds));
        through.mulAssign(exp(absorb.add(solid.mul(7)).mul(inside).mul(-ds)));
      });
      });
      // Light from the far side, through whatever flesh and shadow lay in the way: the sleeper shows dark against it,
      // the thin edges bright.
      light.addAssign(through.mul(live.beat.mul(0.25).add(0.5)));
      return light.mul(live.glow).mul(live.strength) as any;
    });

    const mottle = mx_noise_float(p.mul(vec3(5, 2.2, 5))).mul(0.5).add(0.5) as any;
    let albedo: any = mix(live.skin, live.mottle, mottle);
    albedo = mix(albedo, live.mottle.mul(1.6), caseEdge.mul(0.6));
    albedo = mix(albedo, color("#020202"), blackLine);
    albedo = mix(albedo, live.gold, gold);
    // Gold has little to mirror in the dark, so it is helped with a little light of its own.
    const goldLight = live.gold.mul(gold).mul(0.22) as any;

    // After it opens the pieces still glow faintly, as thin flesh would; their inside is dark and wet.
    const thin = live.glow.mul(live.strength).mul(0.05) as any;
    const looked = glowInside() as any;
    const skinLight = mix(thin, looked, live.intact).mul(float(1).sub(gold)).mul(float(1).sub(blackLine)) as any;
    const seamLight = live.seam
      .mul(line.mul(shown).mul(float(2.2).add(burning.mul(4)).add(live.beat.mul(1.2)).add(live.flare.mul(6))).add(halo.mul(shown).mul(0.3)).add(star.mul(live.heal).mul(3.5)))
      .mul(frontFacing.select(float(1), float(0.6))) as any;
    const inner = live.glow.mul(live.strength).mul(0.04) as any;

    const height = gold.mul(0.0024).add(caseEdge.mul(0.0016)).add(onCase.mul(0.0012)).sub(crack.mul(0.0018)).add(rippleAt(p).mul(0.004)).add(mx_noise_float(p.mul(38)).mul(0.00035)).sub(blackLine.mul(0.0006)) as any;
    const geometric = normalize(varying(transformNormalToView(turnedNormal))).mul(faceDirection) as any;

    material.colorNode = frontFacing.select(albedo, live.mottle.mul(0.6)) as any;
    material.emissiveNode = frontFacing.select(skinLight.add(goldLight), inner).add(seamLight) as any;
    material.metalnessNode = gold.mul(frontFacing.select(float(1), float(0))) as any;
    material.roughnessNode = mix(float(0.42), float(0.16), gold).add(crack.mul(0.4)) as any;
    material.clearcoatNode = float(0.4).sub(gold.mul(0.4)).sub(crack).max(0) as any;
    const normal = bumped(height, geometric) as any;
    material.normalNode = normal;
    material.clearcoatNormalNode = normal;
  }
  return material;
}

// 1 where x is above 0.
function step01(x: any) {
  return x.greaterThan(0).select(float(1), float(0)) as any;
}

export const Shell = forwardRef<THREE.Mesh, { live: Live; tier: QualityTier }>(function Shell({ live, tier }, ref) {
  const rows = tier === "low" ? 110 : tier === "medium" ? 140 : 170;
  const around = tier === "low" ? 96 : tier === "medium" ? 120 : 144;
  const steps = tier === "low" ? 7 : tier === "medium" ? 10 : 14;
  const { geometry, seeds } = useMemo(() => buildShell(rows, around), [rows, around]);
  const material = useMemo(() => makeShellMaterial(live, seeds, steps), [live, seeds, steps]);
  useDispose(geometry, material);
  return <mesh ref={ref} geometry={geometry} material={material} receiveShadow frustumCulled={false} />;
});
