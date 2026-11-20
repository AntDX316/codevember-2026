"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, abs, attribute, cameraPosition, dot, exp, float, max, mix, mod, normalView, normalize, positionGeometry, positionLocal, positionViewDirection, positionWorld, pow, saturate, sin, smoothstep, step, time, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import type { Spool } from "./spool";
import { KEY, type StrandUniforms } from "./strands";

// The pupa at the heart of it: a ringed, tapering body lit from inside like a coal, brightest where it faces the eye
// and deepening to ember red at its edges and in the creases between its rings.
export function Pupa({ u }: { u: StrandUniforms }) {
  const { geometry, material } = useMemo(() => {
    const geometry = new THREE.SphereGeometry(1, 64, 48);
    const material = new THREE.MeshBasicNodeMaterial();
    const p = positionGeometry as any;
    // Rings down its length, pinched in at each crease, and a tail that narrows to a point below.
    const band = abs(sin(p.y.mul(9.5))) as any;
    const crease = pow(float(1).sub(band), 8) as any;
    const taper = float(1).sub(float(1).sub(smoothstep(-1, 0.1, p.y)).mul(0.45)).add(smoothstep(0.2, 1, p.y).mul(0.05)) as any;
    const across = taper.mul(float(1).sub(crease.mul(0.07))) as any;
    material.positionNode = vec3(p.x.mul(across).mul(0.27), p.y.mul(0.6), p.z.mul(across).mul(0.27)) as any;
    material.colorNode = Fn(() => {
      const facing = saturate(dot(normalView, positionViewDirection)) as any;
      const ember = vec3(0.45, 0.11, 0.02) as any;
      const hot = vec3(1.0, 0.64, 0.3) as any;
      const body = mix(ember, hot, pow(facing, 1.6)) as any;
      // Slow currents of heat moving under the skin.
      const stir = sin(positionLocal.y.mul(11).sub(time.mul(0.9)).add(sin(positionLocal.x.mul(23).add(time.mul(0.4))).mul(1.4)))
        .mul(0.12)
        .add(0.94) as any;
      const strength = u.glow.mul(u.beat).mul(facing.mul(0.75).add(0.2)).mul(stir).mul(float(1).sub(crease.mul(0.65))).add(0.03) as any;
      return vec4(body.mul(strength), 1);
    })() as any;
    return { geometry, material };
  }, [u]);
  useDispose(geometry, material);
  return <mesh geometry={geometry} material={material} raycast={() => null} />;
}

// Dust adrift in the studio air, of mixed sizes: lit where it drifts through the key light's beam, and opening into
// soft discs the further it is from the plane in focus, as a lens shows it, never wider than about two degrees.
// Every mote moves on the GPU from where it started, wrapping round a box that reaches back past the camera.
const BOX = { min: [-4, -2.6, -3.5], size: [8, 5.2, 9.5] };

export function Motes({ count, u }: { count: number; u: StrandUniforms }) {
  const { mesh, material } = useMemo(() => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const start: number[] = [];
    const drift: number[] = [];
    for (let i = 0; i < count; i++) {
      start.push(BOX.min[0] + random() * BOX.size[0], BOX.min[1] + random() * BOX.size[1], BOX.min[2] + random() * BOX.size[2], random() * 100);
      // Mostly fine specks, a few larger flecks.
      drift.push((random() - 0.5) * 0.05, (random() - 0.35) * 0.04, (random() - 0.5) * 0.05, 0.4 + Math.pow(random(), 3) * 1.6);
    }
    geometry.setAttribute("aStart", new THREE.InstancedBufferAttribute(new Float32Array(start), 4));
    geometry.setAttribute("aDrift", new THREE.InstancedBufferAttribute(new Float32Array(drift), 4));
    geometry.instanceCount = count;

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const s = attribute("aStart", "vec4") as any;
    const v = attribute("aDrift", "vec4") as any;
    const wander = vec3(sin(time.mul(0.2).add(s.w)).mul(0.15), sin(time.mul(0.17).add(s.w.mul(1.3))).mul(0.12), sin(time.mul(0.13).add(s.w.mul(2.1))).mul(0.1)) as any;
    const min = vec3(...(BOX.min as [number, number, number])) as any;
    const span = vec3(...(BOX.size as [number, number, number])) as any;
    const centre = mod(s.xyz.add(v.xyz.mul(time)).add(wander).sub(min), span).add(min) as any;
    const toEye = normalize(cameraPosition.sub(centre).add(vec3(0, 1e-5, 0))) as any;
    const right = normalize(vec3(toEye.z, 0, toEye.x.negate()).add(vec3(1e-5, 0, 0))) as any;
    const up = vec3(right.y.mul(toEye.z).sub(right.z.mul(toEye.y)), right.z.mul(toEye.x).sub(right.x.mul(toEye.z)), right.x.mul(toEye.y).sub(right.y.mul(toEye.x))) as any;
    const sharp = v.w.mul(0.007) as any;
    const far = cameraPosition.sub(centre).length() as any;
    const blur = sharp.add(far.sub(u.focusDistance).abs().mul(0.006)).min(far.mul(0.0175)).max(sharp.mul(0.5)) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(blur))).add(up.mul(positionGeometry.y.mul(blur))) as any;
    const opened = varying(saturate(blur.div(sharp).sub(1).div(3))) as any;
    const spread = varying(sharp.div(blur).pow(2).max(0.06)) as any;
    material.colorNode = Fn(() => {
      const q = positionGeometry.xy.length() as any;
      // A soft speck in focus, a flat disc with a faint brighter rim out of it.
      const speck = exp(q.mul(q).mul(-5)) as any;
      const disc = float(1)
        .sub(smoothstep(0.82, 1, q))
        .mul(smoothstep(0.55, 0.95, q).mul(0.35).add(0.75)) as any;
      const shape = mix(speck, disc, opened) as any;
      // Lit inside the key light's beam across the cocoon, brighter still looking up it toward the light.
      const key = vec3(KEY.x, KEY.y, KEY.z) as any;
      const p = positionWorld as any;
      const offAxis = p.sub(key.mul(dot(p, key))).length() as any;
      const inBeam = float(1).sub(smoothstep(0.7, 2.0, offAxis)).mul(step(-0.6, dot(p, key))) as any;
      const towardLight = pow(max(dot(toEye.negate(), key), 0), 3) as any;
      const near = float(1).div(p.dot(p).mul(1.5).add(1)) as any;
      const twinkle = sin(time.mul(0.7).add(s.w.mul(5))).mul(0.25).add(0.75) as any;
      const lit = vec3(1.0, 0.88, 0.7)
        .mul(inBeam.mul(towardLight.mul(1.6).add(0.6)).add(0.1))
        .add(vec3(1.0, 0.6, 0.25).mul(near).mul(u.glow).mul(0.15)) as any;
      return vec4(lit.mul(shape).mul(spread).mul(twinkle).mul(2.2), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.raycast = () => null;
    return { mesh, material };
  }, [count, u]);
  useDispose(mesh.geometry, material);
  return <primitive object={mesh} />;
}

// A bead of light at the very tip of the loose end, breathing, to say it can be taken hold of.
export function Bead({ u, spool }: { u: StrandUniforms; spool: Spool }) {
  const camera = useThree((state) => state.camera);
  const { mesh, material } = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    material.colorNode = Fn(() => {
      const q = positionGeometry.xy.length() as any;
      const core = exp(q.mul(q).mul(-60)) as any;
      const halo = exp(q.mul(q).mul(-9)).mul(0.25) as any;
      const breathe = sin(time.mul(2.4)).mul(0.3).add(0.8).mul(u.tailHover.mul(0.8).add(1)) as any;
      return vec4(mix(u.silk, vec3(1, 0.9, 0.7), 0.6).mul(core.add(halo)).mul(breathe).mul(0.9), 1);
    })() as any;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.raycast = () => null;
    mesh.scale.setScalar(0.06);
    return { mesh, material };
  }, [u]);
  useDispose(mesh.geometry, material);
  useFrame(() => {
    const k = (spool.tailCount - 1) * 3;
    mesh.position.set(spool.tail[k], spool.tail[k + 1], spool.tail[k + 2]);
    mesh.quaternion.copy(camera.quaternion);
  });
  return <primitive object={mesh} />;
}
