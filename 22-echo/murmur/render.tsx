"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, cameraPosition, cross, dot, float, hash, instanceIndex, length, max, min, mix, normalize, positionGeometry, positionWorld, pow, sin, smoothstep, uniform, uv, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER } from "../../shared/engine/Post";
import { FRONTS, REACH, SPEED, type Flock } from "./flock";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Every bird in one draw: a thin streak laid along its velocity and turned square to the view, a wingbeat flickering its
// width. Ink over the sky, with the light a startled bird catches added on top (premultiplied), so a passing front glints
// through the cloud without any sorting. Never under about two thirds of a pixel wide: fainter instead.
export function Birds({ flock }: { flock: Flock }) {
  const parts = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    const { pos, vel, u } = flock;
    // Built afresh for each use: a node shared between the position and a varying breaks the draw.
    const streak = () => {
      const p = pos.element(instanceIndex) as any;
      const v = vel.element(instanceIndex) as any;
      const seed = hash(instanceIndex) as any;
      const speed = length(v.xyz) as any;
      const axis = v.xyz.div(speed.add(1e-4)) as any;
      // Forward crossed with the axis, not the other way, or the quad faces away from the eye and is culled.
      const side = normalize(cross(u.forward, axis).add(cross(vec3(0, 1, 0.001), u.forward).mul(0.002))) as any;
      const px = u.pixel.mul(length(u.eye.sub(p.xyz))) as any;
      // A wingbeat, each bird its own rate.
      const beat = abs(sin(u.now.mul(seed.mul(5).add(13)).add(seed.mul(40)))) as any;
      const width = float(0.011).mul(seed.mul(0.6).add(0.7)).mul(beat.mul(0.6).add(0.4)) as any;
      const reach = float(0.03).mul(speed.mul(0.22).add(0.5)).mul(v.w.mul(0.8).add(1)) as any;
      const wide = max(width, px.mul(0.7)) as any;
      const long = max(reach, px.mul(1.6)) as any;
      return { p, axis, side, width, reach, wide, long };
    };
    const at = streak();
    material.positionNode = at.p.xyz.add(at.axis.mul(positionGeometry.y.mul(at.long))).add(at.side.mul(positionGeometry.x.mul(at.wide))) as any;
    const fade = streak();
    const thin = varying(fade.width.div(fade.wide).mul(fade.reach.div(fade.long).pow(0.5))) as any;
    const glow = varying(pos.element(instanceIndex).w) as any;
    const across = abs(uv().x.sub(0.5)).mul(2) as any;
    const alongTail = uv().y as any;
    const shape = float(1).sub(smoothstep(0.45, 1, across)).mul(smoothstep(0, 0.55, alongTail)).mul(float(1).sub(smoothstep(0.88, 1, alongTail))) as any;
    const alpha = shape.mul(thin).mul(0.9) as any;
    // The light a turning bird catches burns brightest on its edges.
    const rim = mix(float(0.55), float(1), across) as any;
    const light = (u.glint as any).mul(glow.mul(glow.add(0.25)).mul(rim).mul(shape).mul(2.4).mul(thin.mul(0.6).add(0.4))) as any;
    material.colorNode = vec4((u.ink as any).mul(alpha).add(light), alpha) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.count = flock.count;
    mesh.frustumCulled = false;
    return { geometry, material, mesh };
  }, [flock]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// The dusk: dark overhead, a band of afterglow round the horizon, warmest low where the sun has gone down behind the flock.
export const skyColours = {
  zenith: uniform(new THREE.Color()),
  band: uniform(new THREE.Color()),
  sun: uniform(new THREE.Color()),
  below: uniform(new THREE.Color())
};

export function Sky() {
  const { material, geometry } = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const d = normalize(positionWorld.sub(cameraPosition)) as any;
    const sunDir = normalize(vec3(-0.36, -0.12, -1)) as any;
    const toward = max(dot(d, sunDir), float(0)) as any;
    const y = d.y as any;
    const up = smoothstep(-0.05, 0.75, y) as any;
    const base = mix(skyColours.band, skyColours.zenith, pow(up, float(0.7))) as any;
    const under = smoothstep(0.0, -0.5, y) as any;
    const low = mix(base, skyColours.below, under) as any;
    // The afterglow: a wide warm lobe and a tighter, brighter one, both lying flat along the horizon.
    const flat = float(1).sub(smoothstep(0, 0.55, abs(y.add(0.04)))) as any;
    const glow = pow(toward, float(5)).mul(0.28).add(pow(toward, float(30)).mul(0.55)).mul(flat.mul(0.75).add(0.25)) as any;
    m.colorNode = vec4(low.add(skyColours.sun.mul(glow)), 1) as any;
    return { material: m, geometry: new THREE.SphereGeometry(60, 64, 32) };
  }, []);
  useDispose(material, geometry);
  return <mesh geometry={geometry} material={material} renderOrder={-1} frustumCulled={false} raycast={() => null} />;
}

// Each chirp's wavefront as a faint shell in the air, brightest where it is seen edge-on, added over the frame; one draw for
// every front, its sphere grown from the source as it travels.
export function Shells({ flock }: { flock: Flock }) {
  const parts = useMemo(() => {
    const geometry = new THREE.SphereGeometry(1, 64, 32);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false });
    const { u } = flock;
    // Picking a front by index from separate uniforms: a chain of mixes over the few there are.
    let src: any = u.fronts[0];
    let power: any = u.power[0];
    for (let k = 1; k < FRONTS; k++) {
      const is = float(instanceIndex).sub(k).abs().lessThan(0.5) as any;
      src = is.select(u.fronts[k], src);
      power = is.select(u.power[k], power);
    }
    const age = max(u.now.sub(src.w), 0) as any;
    const radius = age.mul(SPEED).add(0.001) as any;
    material.positionNode = positionGeometry.mul(radius).add(src.xyz) as any;
    const n = varying(normalize(positionGeometry)) as any;
    const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
    const edge = pow(float(1).sub(abs(dot(n, toEye))), float(7)) as any;
    const fade = float(1).sub(smoothstep(0, REACH, radius)).mul(smoothstep(0, 0.6, radius)) as any;
    const strength = min(power, 1).pow(2).mul(fade).mul(fade) as any;
    material.colorNode = vec4((u.glint as any).mul(edge.mul(strength).mul(0.16)), 1) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.count = FRONTS;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { geometry, material, mesh };
  }, [flock]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}
