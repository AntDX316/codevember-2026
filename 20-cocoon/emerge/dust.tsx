"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, abs, attribute, cameraFar, cameraNear, cameraPosition, clamp, color, cos, cross, dot, exp, float, length, max, min, mix, mod, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, pow, screenUV, sin, smoothstep, time, uniform, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import type { QualityTier } from "../../shared/engine/types";
import { sky } from "../../14-tension/backdrop";
import { mulberry32 } from "../../14-tension/web";
import { live } from "./live";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Flakes of dried cuticle shaken loose as the case splits: thin angular shards of clear film, thrown off along the
// seams, slowed at once by the air, then drifting down turning over and over, glinting each time they face the light.
// In the chrysalis' own space; `since` is the time since the crack.
export const dustSince = uniform(100);

export function makeDust(seams: THREE.Vector3[], count = 90) {
  {
    const random = mulberry32(17);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const start: number[] = [];
    const vel: number[] = [];
    for (let i = 0; i < count; i++) {
      const p = seams[Math.floor(random() * seams.length)];
      start.push(p.x, p.y, p.z, 0.0012 + random() ** 3 * 0.0055);
      const out = new THREE.Vector3(p.x, 0, p.z).normalize().multiplyScalar(0.08 + random() * 0.18);
      vel.push(out.x + (random() - 0.5) * 0.06, 0.04 + random() * 0.1, out.z + (random() - 0.5) * 0.06, random() * 0.25);
    }
    geometry.setAttribute("aStart", new THREE.InstancedBufferAttribute(new Float32Array(start), 4));
    geometry.setAttribute("aVel", new THREE.InstancedBufferAttribute(new Float32Array(vel), 4));
    geometry.instanceCount = count;
    const material = new THREE.MeshBasicNodeMaterial();
    material.alphaTest = 0.5;
    const s = attribute("aStart", "vec4") as any;
    const v = attribute("aVel", "vec4") as any;
    const t = max(dustSince.sub(v.w), 0) as any;
    // Thrown out, slowed by the air, falling.
    const drag = float(1).sub(t.mul(-2.2).exp()).div(2.2) as any;
    const centre = s.xyz.add(v.xyz.mul(drag)).add(vec3(0, -0.35, 0).mul(t.mul(t))) as any;
    const toEye = normalize(live.eye.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const up = cross(toEye, right) as any;
    const size = s.w.mul(smoothstep(3.4, 2.2, t)).mul(dustSince.lessThan(0.001).select(0, 1)) as any;
    // Each turns in its own plane at its own rate, and tumbles: seen edge on it all but vanishes.
    const spin = v.w.mul(40).add(t.mul(v.w.mul(9).add(2.5))) as any;
    const flip = cos(t.mul(v.w.mul(22).add(5)).add(s.w.mul(900))) as any;
    const px = positionGeometry.x.mul(cos(spin)).sub(positionGeometry.y.mul(sin(spin))) as any;
    const py = positionGeometry.x.mul(sin(spin)).add(positionGeometry.y.mul(cos(spin))).mul(abs(flip).mul(0.92).add(0.08)) as any;
    // Drifting sideways as it turns.
    const drift = right.mul(sin(t.mul(3).add(v.w.mul(50))).mul(0.012).mul(t.min(1))) as any;
    material.positionNode = centre.add(drift).add(right.mul(px.mul(size))).add(up.mul(py.mul(size))) as any;
    // A shard, not a disc: an uneven quadrilateral.
    const shard = abs(positionGeometry.x).mul(v.w.mul(2).add(0.9)).add(abs(positionGeometry.y.add(positionGeometry.x.mul(0.4)))) as any;
    material.opacityNode = smoothstep(1, 0.9, shard) as any;
    const glint = smoothstep(0.75, 1, abs(flip)).mul(1.6) as any;
    material.colorNode = (color("#d9cfb4") as any).mul(sky.light.mul(sky.power).mul(glint.mul(0.3).add(0.14)).add(0.1)) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return { mesh, material };
  }
}

// The air of the garden: dust in a sunbeam. A few soft motes drifting slowly through the light, each a disc of blur
// as a macro lens draws anything off its plane of focus: small and nearly sharp only at the chrysalis' distance,
// swelling into wide, faint, translucent discs nearer the lens and farther off, its light spread thinner the wider it
// is drawn. They only show where they catch the light: glowing warm toward the sun, all but gone away from it. Never
// white, never a hard point. And a few long faint shafts slanting down from the light. One mesh for every weather: it
// takes its colour and direction from the sky's uniforms, so a change of weather builds nothing.
const AIR = { min: [-3.4, -2.6, -4.5], size: [6.8, 5.6, 9] };
const moteFocus = uniform(3);

export function makeMotes(tier: QualityTier, amount = 1) {
  const count = Math.round((tier === "low" ? 90 : tier === "medium" ? 150 : 220) * amount);
  {
    const random = mulberry32(41);
    const quad = () => {
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      return geometry;
    };
    const geometry = quad();
    const start: number[] = [];
    const drift: number[] = [];
    for (let i = 0; i < count; i++) {
      start.push(AIR.min[0] + random() * AIR.size[0], AIR.min[1] + random() * AIR.size[1], AIR.min[2] + random() * AIR.size[2], random() * 100);
      // Mostly fine, a few larger; each with its own brightness.
      drift.push((random() - 0.5) * 0.05, (random() - 0.6) * 0.035, (random() - 0.5) * 0.04, 0.4 + random() ** 3 * 1.6);
    }
    geometry.setAttribute("aStart", new THREE.InstancedBufferAttribute(new Float32Array(start), 4));
    geometry.setAttribute("aDrift", new THREE.InstancedBufferAttribute(new Float32Array(drift), 4));
    geometry.instanceCount = count;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const s = attribute("aStart", "vec4") as any;
    const v = attribute("aDrift", "vec4") as any;
    const seed = s.w as any;
    const wander = vec3(sin(time.mul(0.13).add(seed)).mul(0.22), sin(time.mul(0.11).add(seed.mul(1.3))).mul(0.16), sin(time.mul(0.09).add(seed.mul(2.1))).mul(0.2)) as any;
    const lo = vec3(...AIR.min) as any;
    const centre = mod(s.xyz.add(v.xyz.mul(time)).add(wander).sub(lo), vec3(...AIR.size)).add(lo) as any;
    const away = centre.sub(cameraPosition) as any;
    const far = max(length(away), 0.05) as any;
    const toEye = away.div(far).negate() as any;
    // Off the plane of focus by this much, as a fraction of its distance: the disc it blurs to.
    const blur = abs(far.sub(moteFocus)).div(moteFocus) as any;
    const sharp = v.w.mul(0.0035) as any;
    // No wider than two degrees across, however near the lens.
    const radius = min(sharp.add(blur.mul(0.045).mul(far.max(0.6))), far.mul(0.0175)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius))).add(upward.mul(positionGeometry.y.mul(radius))) as any;
    const moteColour = (behind: any) => Fn(() => {
      const r = positionGeometry.xy.length() as any;
      // In focus a soft glow; out of it an even disc with a soft edge.
      const wide = smoothstep(0.0, 0.25, blur) as any;
      const shape = mix(exp(r.mul(r).mul(-4)), smoothstep(1, 0.72, r), wide).mul(smoothstep(1, 0.9, r)) as any;
      // The same light over a wider disc is fainter.
      const spread = sharp.div(radius).pow(1.35).mul(wide.mul(2.2).add(1)) as any;
      const toward = max(dot(toEye.negate(), sky.toLight), 0) as any;
      const lit = pow(toward, 3).mul(1.8).add(0.07).mul(sky.power) as any;
      const twinkle = sin(time.mul(0.5).add(seed.mul(7))).mul(0.2).add(0.8) as any;
      // Fading out before it would pass through the lens.
      const near = smoothstep(0.15, 0.6, far) as any;
      const warm = mix(sky.light, color("#ffb968"), 0.45) as any;
      const glow = clamp(shape.mul(spread).mul(lit).mul(twinkle).mul(near).mul(v.w).mul(0.85), 0, 0.45) as any;
      return vec4(warm.mul(glow).add(vec3(1, 1, 1).mul(sky.flash.mul(glow).mul(0.5))).mul(behind), 1);
    })() as any;
    material.colorNode = moteColour(float(1));
    // Light in the air has no surface: drawn in the scene pass it would also write the normals and motion that pass
    // keeps, and ambient occlusion and the temporal filter would draw every quad as a hard-edged block. So it goes in
    // the overlay pass (the day must ask for `passes.overlay`), hidden behind solid things by the scene's depth.
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.layers.set(OVERLAY_LAYER);

    // Shafts: long thin sheets of light hanging in the air along the way the light falls, turned to face the eye.
    const beams = quad();
    const at: number[] = [];
    const shafts = tier === "low" ? 4 : 7;
    for (let i = 0; i < shafts; i++) at.push((random() - 0.5) * 5, 0.2 + random() * 1.2, -2.6 + random() * 2.2, 0.25 + random() * 0.55);
    beams.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(at), 4));
    beams.instanceCount = shafts;
    const beamMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const b = attribute("aAt", "vec4") as any;
    const along = normalize(sky.toLight) as any;
    const sway = sin(time.mul(0.07).add(b.w.mul(40))).mul(0.25) as any;
    const mid = b.xyz.add(vec3(sway, 0, 0)) as any;
    const across = normalize(cross(along, normalize(cameraPosition.sub(mid)))) as any;
    beamMaterial.positionNode = mid.add(along.mul(positionGeometry.y.mul(3.4))).add(across.mul(positionGeometry.x.mul(b.w))) as any;
    const beamColour = (behind: any) => Fn(() => {
      const edge = smoothstep(1, 0.0, abs(positionGeometry.x)).pow(1.6) as any;
      const ends = smoothstep(-1, -0.2, positionGeometry.y).mul(smoothstep(1, 0.3, positionGeometry.y)) as any;
      const toward = max(dot(normalize(mid.sub(cameraPosition)), sky.toLight), 0) as any;
      const breath = sin(time.mul(0.11).add(b.w.mul(90))).mul(0.3).add(0.7) as any;
      const warm = mix(sky.light, color("#ffb968"), 0.35) as any;
      return vec4(warm.mul(edge.mul(ends).mul(breath).mul(pow(toward, 2).mul(0.11).add(0.014)).mul(sky.power)).mul(behind), 1);
    })() as any;
    beamMaterial.colorNode = beamColour(float(1));
    // Given the scene's depth: nothing of the air shows through what is in front of it.
    const link = (depth: any) => {
      const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
      const clear = smoothstep(-0.04, 0.04, positionView.z.sub(sceneZ)) as any;
      material.colorNode = moteColour(clear);
      beamMaterial.colorNode = beamColour(clear);
      discMaterial.colorNode = discColour(clear);
      discMaterial.needsUpdate = true;
      material.needsUpdate = true;
      beamMaterial.needsUpdate = true;
    };
    const beamMesh = new THREE.Mesh(beams, beamMaterial);
    beamMesh.layers.set(OVERLAY_LAYER);
    beamMesh.frustumCulled = false;
    beamMesh.renderOrder = 2;
    // Far behind, where the garden catches the light: wide, dim, warm discs of blur in the leaves' own colours, a few
    // of them, in place of bright bokeh. Translucent, slow to brighten and fade, never white.
    const discs = quad();
    const where: number[] = [];
    const tone: number[] = [];
    const far2 = tier === "low" ? 22 : 40;
    for (let i = 0; i < far2; i++) {
      where.push((random() - 0.5) * 24, (random() - 0.4) * 12, -6 - random() * 15, 0.5 + random() * 0.5);
      tone.push(random(), random() * 100, 0.35 + random() * 0.65, random());
    }
    discs.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(where), 4));
    discs.setAttribute("aTone", new THREE.InstancedBufferAttribute(new Float32Array(tone), 4));
    discs.instanceCount = far2;
    const discMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const d = attribute("aAt", "vec4") as any;
    const tn = attribute("aTone", "vec4") as any;
    // Toward the light, mostly: carried there by its direction.
    const spot = d.xyz.add(vec3(sky.toLight.x, sky.toLight.y, 0).mul(tn.w.mul(5))) as any;
    const discEye = normalize(cameraPosition.sub(spot)) as any;
    const discRight = normalize(cross(vec3(0, 1, 0), discEye)) as any;
    const discUp = cross(discEye, discRight) as any;
    const discR = length(spot.sub(cameraPosition)).mul(0.0175).mul(d.w) as any;
    discMaterial.positionNode = spot.add(discRight.mul(positionGeometry.x.mul(discR))).add(discUp.mul(positionGeometry.y.mul(discR))) as any;
    const discColour = (behind: any) => Fn(() => {
      const r = positionGeometry.xy.length() as any;
      const shape = smoothstep(1, 0.8, r) as any;
      const leaf = mix(mix(sky.blots[1], sky.blots[2], tn.x), mix(sky.light, color("#ffb968"), 0.5), tn.x.mul(tn.x).mul(0.6).add(0.15)) as any;
      const toward = max(dot(normalize(spot.sub(cameraPosition)), sky.toLight), 0) as any;
      const slow = sin(time.mul(0.23).add(tn.y)).mul(0.3).add(0.7) as any;
      const glow = clamp(shape.mul(tn.z).mul(slow).mul(pow(toward, 2).mul(0.5).add(0.1)).mul(sky.power).mul(0.16), 0, 0.3) as any;
      return vec4(leaf.mul(glow).mul(behind), 1);
    })() as any;
    discMaterial.colorNode = discColour(float(1));
    const discMesh = new THREE.Mesh(discs, discMaterial);
    discMesh.frustumCulled = false;
    discMesh.renderOrder = 1;
    discMesh.layers.set(OVERLAY_LAYER);
    const group = new THREE.Group();
    group.add(discMesh, mesh, beamMesh);
    // The lens is focused on the chrysalis.
    const subject = new THREE.Vector3(0, 0.4, 0);
    const update = (camera: THREE.Camera) => {
      moteFocus.value = Math.max(0.3, camera.position.distanceTo(subject));
    };
    return { group, geometry, material, beams, beamMaterial, discs, discMaterial, update, link };
  }
}

// In place of Tension's <Air> (and its hard white specks) in this scene.
export function Motes({ tier, amount = 1 }: { tier: QualityTier; amount?: number }) {
  const made = useMemo(() => makeMotes(tier, amount), [tier, amount]);
  useDispose(made.geometry, made.material, made.beams, made.beamMaterial, made.discs, made.discMaterial);
  useEffect(() => overlayLink.listen(made.link), [made]);
  useFrame(({ camera }) => made.update(camera));
  return <primitive object={made.group} />;
}
