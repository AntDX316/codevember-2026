"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  exp,
  mx_noise_float,
  cameraPosition,
  clamp,
  color,
  cos,
  cross,
  dot,
  float,
  length,
  max,
  mix,
  mod,
  normalize,
  positionGeometry,
  pow,
  sin,
  smoothstep,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import type { QualityTier } from "../shared/engine/types";
import type { Bloom } from "./bloom";
import { clock, light, pixel, sporeCloud } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

const quad = () => {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
};
// A square turned to the eye, of this radius, never under about a pixel and a half.
const facing = (centre: any, radius: any) => {
  const toEye = normalize(cameraPosition.sub(centre)) as any;
  const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
  const up = cross(toEye, right) as any;
  const r = max(radius, length(cameraPosition.sub(centre)).mul(pixel).mul(1.5)) as any;
  return centre.add(right.mul(positionGeometry.x.mul(r))).add(up.mul(positionGeometry.y.mul(r)));
};

// Spores: each rises from where it was let go, drifts in a slow wavering arc, and comes down where it is to land,
// glowing the colour of the caps. Those that will grow are brighter and stay lit a moment on the ground; the rest fade
// as they go. All of it worked out from the clock and where each began and ends.
export function Spores({ bloom }: { bloom: Bloom }) {
  const { mesh, material, geometry, attrs } = useMemo(() => {
    const geometry = quad();
    const attrs = {
      from: new THREE.InstancedBufferAttribute(bloom.sporeFrom, 4),
      to: new THREE.InstancedBufferAttribute(bloom.sporeTo, 4),
      info: new THREE.InstancedBufferAttribute(bloom.sporeInfo, 4)
    };
    geometry.setAttribute("aFrom", attrs.from);
    geometry.setAttribute("aTo", attrs.to);
    geometry.setAttribute("aInfo", attrs.info);
    geometry.instanceCount = bloom.maxSpores;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const state = () => {
      const from = attribute("aFrom", "vec4") as any;
      const to = attribute("aTo", "vec4") as any;
      const info = attribute("aInfo", "vec4") as any;
      // Seeding spores (1) fly to where they will grow; a cluster's own drifts (2) always go as a light sparkle; only the
      // spores let go by hand take the chosen cloud.
      const seeding = info.w.greaterThan(0.5).and(info.w.lessThan(1.5)) as any;
      const drift = info.w.greaterThan(1.5) as any;
      // A cluster's own drifts take the swirl too, when it is chosen; the heavier clouds are kept for spores let go by hand.
      const is = (n: number) => sporeCloud.equal(n).and(n === 3 ? info.w.lessThan(0.5).or(drift) : info.w.lessThan(0.5)) as any;
      // The bigger clouds hang in the air longer before they are gone.
      const linger = is(4).select(float(2.6), is(5).select(float(2), is(6).select(float(2.2), is(0).or(is(2)).select(float(1.4), float(1))))) as any;
      const t = clock.sub(from.w).div(to.w.mul(linger)) as any;
      const s = clamp(t, 0, 1) as any;
      // A second number of each spore's own, for which part of a cloud it makes.
      const role = sin(info.x.mul(12.9898)).mul(43758.5).fract() as any;
      // Sparkle: up together in a column that slows as it climbs, widening as it goes; then each drifts down to where it
      // lands. Spores that will grow always go this way, so they come down where they are to.
      const climb = float(1).sub(pow(float(1).sub(smoothstep(0, 0.6, s)), float(2.2))) as any;
      const spread = pow(smoothstep(0.05, 1, s), float(1.6)) as any;
      const across = to.xz.sub(from.xz).mul(spread) as any;
      const down = smoothstep(0.5, 1, s) as any;
      const billow = vec3(sin(clock.mul(1.3).add(info.x)).add(sin(clock.mul(0.7).add(info.x.mul(2.1))).mul(0.6)), 0, cos(clock.mul(1.1).add(info.x.mul(1.7))))
        .mul(0.018)
        .mul(spread.add(0.05)) as any;
      const lean = vec3(0.05, 0, 0.02).mul(s).mul(float(1).sub(down)) as any;
      const sparkle = vec3(from.x.add(across.x), mix(from.y.add(info.z.mul(climb)), to.y, down.mul(down)), from.z.add(across.y))
        .add(billow)
        .add(lean) as any;
      // Plume: a column of smoke, rising and slowing, rolling over and spreading out into a cloud as it thins away.
      const rise = float(1).sub(pow(float(1).sub(s), float(2))) as any;
      const roll = vec3(sin(clock.mul(0.9).add(info.x).add(s.mul(5))), 0, cos(clock.mul(0.8).add(info.x.mul(1.3)).add(s.mul(4)))).mul(s.mul(0.045)) as any;
      const plume = vec3(from.x, from.y.add(info.z.mul(2.4).mul(rise)), from.z)
        .add(
          vec3(across.x, 0, across.y)
            .mul(0.55)
            .mul(pow(s, float(1.4)))
        )
        .add(roll)
        .add(vec3(0.04, 0, 0.015).mul(s)) as any;
      // Mist: let go low, it rolls out wide over the litter and hangs there, thinning.
      const mist = vec3(from.x, from.y.add(info.z.mul(0.35).mul(rise)), from.z)
        .add(
          vec3(across.x, 0, across.y)
            .mul(1.5)
            .mul(pow(s, float(0.7)))
        )
        .add(roll.mul(0.6)) as any;
      // Swirl: carried up round and round in a little whirlwind that opens as it climbs.
      // Shot out fast the moment they leave the cap, then turning slower as they climb and the whirl opens.
      const shot = float(1).sub(pow(float(1).sub(s), float(3))) as any;
      const turn = info.x.add(shot.mul(11)) as any;
      const swirl = vec3(from.x, from.y.add(info.z.mul(2.1).mul(shot)), from.z).add(vec3(cos(turn), 0, sin(turn)).mul(float(0.006).add(shot.mul(0.07)))) as any;
      // Mushroom cloud: a third of it a stem of smoke shooting up; the rest climbs with it and then rolls out into a
      // ring-shaped cap at its top, turning over on itself as it widens, and slowly thins away.
      const top = info.z.mul(2.6) as any;
      const shoot = float(1).sub(pow(float(1).sub(smoothstep(0, 0.35, s)), float(3))) as any;
      const around = info.x.mul(6.283) as any;
      const tumble = role.mul(6.283).add(s.mul(7)) as any;
      const ring = smoothstep(0.15, 0.7, s).mul(0.14) as any;
      const tube = smoothstep(0.1, 0.6, s).mul(0.06) as any;
      const reach = ring.add(cos(tumble).mul(tube)) as any;
      const capPart = (vec3 as any)(cos(around).mul(reach), top.mul(shoot).add(sin(tumble).mul(tube)).add(s.mul(0.03)), sin(around).mul(reach)) as any;
      const stemPart = (vec3 as any)(cos(around).mul(s.mul(0.02)), top.mul(shoot).mul(role.mul(4)), sin(around).mul(s.mul(0.02))) as any;
      const mushroomCloud = from.xyz.add(role.lessThan(0.25).select(stemPart, capPart)).add(roll.mul(0.4)) as any;
      // Puffball: burst out all round into a soft ball that hangs and drifts up a little as it fades.
      const way = normalize(vec3(sin(info.x.mul(3.1)), cos(info.x.mul(1.7)).abs().mul(0.8).add(0.2), sin(info.x.mul(5.3).add(1)))) as any;
      const burst = float(1).sub(pow(float(1).sub(s), float(4))) as any;
      const puffball = from.xyz
        .add(way.mul(burst.mul(0.13).mul(role.mul(0.6).add(0.4))))
        .add(vec3(0, s.mul(0.06), 0))
        .add(roll.mul(0.3)) as any;
      // Smoke ring: a ring that rises, widening, its smoke rolling round inside it.
      const ringReach = float(0.02).add(s.mul(0.09)) as any;
      const roll2 = role.mul(6.283).add(s.mul(10)) as any;
      const smokeRing = from.xyz.add(
        (vec3 as any)(cos(around).mul(ringReach.add(cos(roll2).mul(0.018))), info.z.mul(2.4).mul(rise).add(sin(roll2).mul(0.018)), sin(around).mul(ringReach.add(cos(roll2).mul(0.018))))
      ) as any;
      const centre = is(0).select(plume, is(2).select(mist, is(3).select(swirl, is(4).select(mushroomCloud, is(5).select(puffball, is(6).select(smokeRing, sparkle)))))) as any;
      // A cloud is a few big soft puffs of smoke, swelling as they go, with the rest of its spores as specks of light
      // carried along inside it.
      const cloudy = is(0).or(is(2)).or(is(4)).or(is(5)).or(is(6)) as any;
      // Which spores are smoke is chosen apart from which part of the cloud each makes, so every part has its smoke.
      const smoky = cloudy.and(role.mul(7.13).fract().lessThan(0.4)) as any;
      const swell = is(2).select(float(0.06), is(6).select(float(0.025), float(0.045))) as any;
      const radius = smoky.select(float(0.012).add(s.mul(swell)).mul(role.mul(1.5).add(0.7)), info.y.mul(0.0011).mul(is(3).select(float(1.5), float(1)))) as any;
      const thin = smoky.select(float(0.16).mul(pow(float(1).sub(s), float(0.6))), float(1)) as any;
      // In from nothing, out again: seeding spores linger lit on the ground, the rest fade on the air.
      const alive = smoothstep(0, 0.012, t).mul(seeding.select(smoothstep(1.5, 1.0, t), smoothstep(1.0, 0.55, t))) as any;
      return { centre, info, alive, seeding, drift, t, radius, thin, smoky };
    };
    material.positionNode = Fn(() => {
      const { centre, alive, radius } = state();
      return facing(centre, radius.mul(alive.greaterThan(0.001).select(float(1), float(0))));
    })() as any;
    material.colorNode = Fn(() => {
      const { info, alive, seeding, thin, smoky } = state();
      const r = positionGeometry.xy.length() as any;
      // Smoke is soft right out to its edge and wispy, its wisps turning over slowly; a spark has a bright core.
      const wisps = mx_noise_float((vec3 as any)(positionGeometry.xy.mul(1.6).add(info.x), clock.mul(0.35).add(info.x)))
        .mul(0.55)
        .add(0.6)
        .clamp(0, 1) as any;
      const soft = smoky
        .select(
          exp(r.mul(r).mul(-3.2))
            .mul(smoothstep(1, 0.75, r))
            .mul(wisps),
          smoothstep(1, 0, r).pow(1.6)
        )
        .mul(thin) as any;
      const twinkle = sin(clock.mul(6).add(info.x.mul(9)))
        .mul(0.25)
        .add(0.75) as any;
      const tint = mix(light.cap, light.glow, 0.5) as any;
      return vec4(
        tint
          .mul(soft)
          .mul(alive)
          .mul(twinkle)
          .mul(seeding.select(float(3.2), float(1.8))),
        1
      );
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    return { mesh, material, geometry, attrs };
  }, [bloom]);
  useFrame(() => {
    if (bloom.sporesDirty) {
      bloom.sporesDirty = false;
      attrs.from.needsUpdate = attrs.to.needsUpdate = attrs.info.needsUpdate = true;
    }
  });
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// What drifts above the floor besides spores: a few fireflies wandering and blinking, and fine dust that shows only
// where it catches the moon.
const BOX = { min: [-1.6, 0.02, -1.4], size: [3.2, 0.7, 2.8] };
export function Air({ tier }: { tier: QualityTier }) {
  const flies = tier === "low" ? 10 : 22;
  const motes = tier === "low" ? 120 : tier === "medium" ? 260 : 380;
  const { mesh, material, geometry } = useMemo(() => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const geometry = quad();
    const count = flies + motes;
    const start: number[] = [];
    const drift: number[] = [];
    for (let i = 0; i < count; i++) {
      start.push(BOX.min[0] + random() * BOX.size[0], BOX.min[1] + random() * BOX.size[1], BOX.min[2] + random() * BOX.size[2], random() * 100);
      drift.push((random() - 0.5) * 0.02, (random() - 0.5) * 0.008, (random() - 0.5) * 0.02, i < flies ? 1 : 0);
    }
    geometry.setAttribute("aStart", new THREE.InstancedBufferAttribute(new Float32Array(start), 4));
    geometry.setAttribute("aDrift", new THREE.InstancedBufferAttribute(new Float32Array(drift), 4));
    geometry.instanceCount = count;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const where = () => {
      const s = attribute("aStart", "vec4") as any;
      const v = attribute("aDrift", "vec4") as any;
      const fly = v.w.greaterThan(0.5) as any;
      const wander = vec3(sin(clock.mul(0.31).add(s.w)), sin(clock.mul(0.23).add(s.w.mul(1.7))).mul(0.4), sin(clock.mul(0.19).add(s.w.mul(2.3)))).mul(fly.select(float(0.25), float(0.05))) as any;
      const moved = s.xyz.add(v.xyz.mul(clock)).add(wander) as any;
      const min = vec3(...BOX.min) as any;
      const span = vec3(...BOX.size) as any;
      return { centre: mod(moved.sub(min), span).add(min), fly, seed: s.w };
    };
    material.positionNode = Fn(() => {
      const { centre, fly } = where();
      return facing(centre, fly.select(float(0.0028), float(0.0007)));
    })() as any;
    material.colorNode = Fn(() => {
      const { centre, fly, seed } = where();
      const r = positionGeometry.xy.length() as any;
      const soft = smoothstep(1, 0, r).pow(1.8) as any;
      // Fireflies blink in slow flashes; dust shows toward the moon, against the dark.
      const blink = pow(
        sin(clock.mul(1.1).add(seed.mul(3)))
          .mul(0.5)
          .add(0.5),
        float(6)
      ).mul(4) as any;
      const toEye = normalize(cameraPosition.sub(centre)) as any;
      const backlit = pow(max(dot(toEye.negate(), light.toMoon), 0), float(3))
        .mul(light.moonPower)
        .mul(0.9)
        .add(0.04) as any;
      return vec4(fly.select(color("#e9ff8a").mul(blink), light.moon.mul(backlit)).mul(soft), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    return { mesh, material, geometry };
  }, [flies, motes]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}
