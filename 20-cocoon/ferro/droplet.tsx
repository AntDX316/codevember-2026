"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  acos,
  cameraPosition,
  clamp,
  cross,
  dot,
  exp,
  float,
  Fn,
  fract,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  sqrt,
  transformNormalToView,
  uniform,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { sound } from "../../shared/engine/sound";
import { usePointerRay } from "../kit";
import { Ferro, FOOT, RIPPLES, RX, RY, TAPER } from "./field";
import { nearestSpike, SPACING } from "./lattice";
import type { Studio } from "./studio";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// How far apart, on the unit sphere, the three samples that give each pixel its normal are.
const EPS = 0.0016;
// How tall a spike stands at full field, in widths of its own foot.
const SPIKE_HEIGHT = 3;
const SEGMENTS = { high: [640, 320], medium: [448, 224], low: [288, 144] } as const;
// The most spikes each tier's mesh can draw with a sharp tip.
const MOST = { high: 1500, medium: 1200, low: 800 } as const;

// Spikes erupting crackle like static, louder the faster they rise.
function crackled(strength: number, pan: number) {
  sound.play("sizzle", { gain: 0.12 + strength * 0.75, pitch: 0.8 + Math.random() * 0.5, pan: pan * 0.6 });
  if (strength > 0.3) sound.play("tick", { gain: 0.25 + strength * 0.5, pitch: 0.7 + Math.random() * 0.9, pan: pan * 0.6 });
}

export function Droplet({ studio }: { studio: Studio }) {
  const { tier } = useQuality();
  const field = useSettingRef<number>("ferroField");
  const density = useSettingRef<number>("ferroDensity");
  const pointer = usePointerRay();
  const camera = useThree((state) => state.camera);

  const ferro = useMemo(() => new Ferro({ sizzle: crackled }), []);

  const u = useMemo(
    () => ({
      time: uniform(0),
      count: uniform(600),
      level: uniform(0),
      reach: uniform(-0.45),
      lean: uniform(0.1),
      t1: uniform(new THREE.Vector3(1, 0, 0)),
      t2: uniform(new THREE.Vector3(0, 1, 0)),
      axis: uniform(new THREE.Vector3(0, 0, 1)),
      anchorDir: uniform(new THREE.Vector3(0, 0, 1)),
      anchor: uniform(new THREE.Vector3(0, 0, RX)),
      tip: uniform(new THREE.Vector3(0, 0, RX)),
      pullDir: uniform(new THREE.Vector3(0, 0, 1)),
      pulled: uniform(0),
      wobble: uniform(0),
      wobbleAxis: uniform(new THREE.Vector3(0, 1, 0)),
      // Separate uniforms rather than a uniform array, which the pixel stage of a shared function could not see.
      ripples: ferro.ripples.map((r) => uniform(r.clone()))
    }),
    [ferro]
  ) as Record<string, any>;

  const [wide, high] = SEGMENTS[tier];
  const geometry = useMemo(() => new THREE.SphereGeometry(1, wide, high), [wide, high]);

  const material = useMemo(() => {
    // The whole surface as one function of direction: an egg, jiggling and rippling, carrying a lattice of spikes and
    // stretched out into a tendril. The vertices use it once, and every pixel three times more for an exact normal.
    const surface = Fn(([s]: any[]) => {
      const rx = float(RX).mul(float(1).sub(s.y.mul(TAPER))) as any;
      const egg = normalize(vec3(s.x.div(rx), s.y.div(RY), s.z.div(rx))).toVar() as any;
      const facing = dot(s, u.axis).toVar() as any;
      const crown = smoothstep(u.reach, float(1), facing) as any;
      // A slow breath, a squash along the last pull, the whole crown lifting a little, and ripples running round.
      const c = dot(s, u.wobbleAxis) as any;
      const swell = sin(u.time.mul(0.8)).mul(0.006).add(u.wobble.mul(c.mul(c).mul(1.5).sub(0.5))).add(crown.mul(crown).mul(u.level).mul(0.035)).toVar() as any;
      for (let i = 0; i < RIPPLES; i++) {
        const ripple = u.ripples[i] as any;
        const amount = sqrt(dot(ripple.xyz, ripple.xyz)) as any;
        const from = ripple.xyz.div(max(amount, float(1e-5))) as any;
        const age = u.time.sub(ripple.w) as any;
        const behind = acos(clamp(dot(s, from), -1, 1)).sub(age.mul(1.5)) as any;
        swell.addAssign(amount.mul(sin(behind.mul(16))).mul(exp(behind.mul(behind).mul(-24))).mul(exp(age.mul(-1.1))).mul(smoothstep(0, 0.08, age)));
      }
      const base = vec3(s.x.mul(rx), s.y.mul(RY), s.z.mul(rx)).add(egg.mul(swell)) as any;

      // The spike in this cell of the lattice, sharp at the tip and flaring at the foot, its height set by how strongly
      // the field reaches it, with a little life of its own.
      const local = vec3(dot(s, u.t1), dot(s, u.t2), facing) as any;
      const nearest = nearestSpike(local, u.count).toVar() as any;
      const spot = nearest.xyz as any;
      const foot = float(SPACING * 1.05).div(sqrt(u.count)) as any;
      const out = max(float(1).sub(local.sub(spot).length().div(foot)), float(0)) as any;
      const profile = out.mul(out).mul(sqrt(out)) as any;
      // Dave Hoskins' hash, which stays the same in the vertex and pixel stages, unlike sin of a large number.
      const seed = fract(nearest.w.mul(0.1031)).toVar() as any;
      seed.mulAssign(seed.add(33.33));
      const luck = fract(seed.mul(seed.add(seed))) as any;
      const reached = smoothstep(u.reach, float(1), spot.z) as any;
      const strength = u.level.mul(reached).mul(sqrt(reached)).mul(luck.mul(0.5).add(0.72)).mul(sin(u.time.mul(1.9).add(luck.mul(6.283))).mul(0.14).add(1)) as any;
      const height = strength.mul(foot).mul(RX * SPIKE_HEIGHT).mul(profile) as any;
      // The tendril: everything near its foot is drawn towards its tip, the foot most of all.
      const drawn = exp(dot(s, u.anchorDir).sub(1).div(FOOT)).mul(u.pulled) as any;
      const drawnOut = clamp(abs(drawn).mul(1.5), 0, 1) as any;
      const reachOut = u.tip.sub(u.anchor).mul(drawn) as any;
      // Each spike leans towards the field as a whole, more so near the pointer, but stands straight out of a tendril's
      // sides, which face away from its length, rather than lying along it.
      const centre = u.t1.mul(spot.x).add(u.t2.mul(spot.y)).add(u.axis.mul(spot.z)) as any;
      const lean = u.axis.sub(centre.mul(spot.z)).mul(u.lean).mul(float(1).sub(drawnOut)) as any;
      const sideways = egg.sub(u.pullDir.mul(dot(egg, u.pullDir))).add(u.pullDir.mul(0.4)) as any;
      const along = normalize(mix(egg, sideways, drawnOut) as any) as any;
      // A tendril's sides are stretched cells, whose spikes would smear into fins; they stay lower.
      const point = base.add(reachOut).add(along.add(lean).mul(height).mul(float(1).sub(drawnOut.mul(0.45)))) as any;
      return vec4(point, float(1).sub(profile).mul(clamp(strength, 0, 1.5)));
      // Inline, not a layout function: three r187 reuses a layout function's code from the first shader built in the
      // next one (the depth pass, say) with its uniforms in the first build's order, and they came out mistyped.
    }) as any;

    const m = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
    m.positionNode = surface(normalize(positionGeometry)).xyz;

    // Per pixel: the surface again, and either side of here, for a normal as sharp as the maths rather than the mesh.
    const s = normalize(varying(normalize(positionGeometry))).toVar("ferroDir") as any;
    const side = abs(s.y).greaterThan(0.99).select(vec3(1, 0, 0), vec3(0, 1, 0)) as any;
    const t1 = normalize(cross(side, s)).toVar("ferroT1") as any;
    const t2 = cross(s, t1).toVar("ferroT2") as any;
    const here = surface(s).toVar("ferroHere") as any;
    const across = surface(normalize(s.add(t1.mul(EPS)))).xyz.sub(here.xyz) as any;
    const upward = surface(normalize(s.add(t2.mul(EPS)))).xyz.sub(here.xyz) as any;
    const normal = normalize(cross(across, upward).mul(1 / (EPS * EPS)).add(s.mul(1e-4))).toVar("ferroNormal") as any;

    const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
    const towards = dot(normal, toEye).toVar() as any;
    const facing = clamp(towards, 0, 1) as any;
    const mirrored = reflect(toEye.negate(), normal) as any;
    const edge = pow(float(1).sub(facing), float(5)) as any;
    // Black, glossy, the reflectance of oil: faint face on, a full mirror at a glance.
    const fresnel = edge.mul(0.945).add(0.055) as any;
    // A reflection aimed back into the egg would only see more black fluid; the tendril is out in the open, so it is spared.
    const rx = float(RX).mul(float(1).sub(s.y.mul(TAPER))) as any;
    const egg = normalize(vec3(s.x.div(rx), s.y.div(RY), s.z.div(rx))) as any;
    const pulledHere = min(exp(dot(s, u.anchorDir).sub(1).div(FOOT)).mul(abs(u.pulled)), float(1)) as any;
    const open = mix(smoothstep(-0.35, 0.25, dot(mirrored, egg)), float(1), pulledHere).mul(0.75).add(0.25) as any;
    // Down between the spikes, each reflection sees mostly its neighbours.
    const between = float(1).div(here.w.mul(1.2).add(1)) as any;
    // Where the mesh and the exact normal disagree at the outline, the normal can face away; those pixels would only sparkle.
    const outline = smoothstep(-0.2, 0.03, towards) as any;
    const tint = mix(studio.tint, vec3(1), edge) as any;
    const reflected = studio.room(mirrored, 1).mul(fresnel.mul(2)).mul(open).mul(between).mul(outline).mul(tint) as any;
    // What little light gets into the fluid comes back a deep oily brown.
    const body = vec3(0.004, 0.0028, 0.002).mul(facing.mul(0.6).add(0.4)) as any;

    m.colorNode = vec3(0) as any;
    m.emissiveNode = min(reflected.add(body), vec3(24)) as any;
    m.normalNode = transformNormalToView(normal) as any;
    return m;
  }, [u, studio]);

  useDispose(material, geometry);

  useSettingAction("ferroSlam", () => {
    ferro.slamDown();
    dismissPrompt();
    const pan = ferro.fieldDir.x * 0.6;
    sound.play("thud", { gain: 0.85, pitch: 0.55, size: 0.7, pan });
    for (const [i, delay] of [0, 150].entries()) window.setTimeout(() => sound.play("sizzle", { gain: 0.9 - i * 0.18, pitch: 0.7 + Math.random() * 0.6, pan }), delay);
  });

  useGrabbable({
    pick(ray) {
      const distance = ferro.pick(ray);
      return distance === null ? null : { distance, point: ray.at(distance, new THREE.Vector3()) };
    },
    grab(point) {
      ferro.grab(point);
      dismissPrompt();
      sound.play("peel", { variant: "suction", gain: 0.45, pitch: 0.8, pan: point.x / 3 });
    },
    drag(point) {
      ferro.drag(point);
    },
    release() {
      const stretch = ferro.release();
      sound.play("plop", { gain: 0.35 + Math.min(stretch, 1.4) * 0.45, pitch: 0.95 - Math.min(stretch, 1.4) * 0.25, pan: ferro.tip.x / 3 });
      if (stretch > 0.4) window.setTimeout(() => sound.play("drip", { gain: 0.3, pitch: 0.7, pan: ferro.anchor.x / 3 }), 140);
    }
  });

  useFrame((_, delta) => {
    ferro.point(pointer.active ? pointer.ray : null);
    ferro.update(delta, field.current, density.current, MOST[tier], Math.atan2(camera.position.z, camera.position.x));
    u.time.value = ferro.time;
    u.count.value = ferro.count;
    u.level.value = ferro.level;
    u.reach.value = ferro.reach;
    u.lean.value = ferro.lean;
    u.t1.value.copy(ferro.t1);
    u.t2.value.copy(ferro.t2);
    u.axis.value.copy(ferro.axis);
    u.anchorDir.value.copy(ferro.anchorDir);
    u.anchor.value.copy(ferro.anchor);
    u.tip.value.copy(ferro.tip);
    const pull = u.pullDir.value as THREE.Vector3;
    pull.subVectors(ferro.tip, ferro.anchor);
    if (pull.lengthSq() > 1e-6) pull.normalize();
    else pull.set(0, 0, 0);
    u.pulled.value = ferro.pulled;
    u.wobble.value = ferro.wobble;
    u.wobbleAxis.value.copy(ferro.wobbleAxis);
    ferro.ripples.forEach((ripple, i) => (u.ripples[i].value as THREE.Vector4).copy(ripple));
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} raycast={() => null} />;
}
