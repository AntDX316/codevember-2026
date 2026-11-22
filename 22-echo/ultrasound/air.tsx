"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { abs, atan, attribute, cameraPosition, color, cross, dot, exp, float, fract, length, max, min, mix, normalize, positionGeometry, positionWorld, pow, sin, smoothstep, step, time, uv, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { bell, tint, view } from "./fans";
import { APEX, FAR, fanFrame, fanFrameNode, HALF, NEAR } from "./scan";
import { SHELL_CENTRE } from "./shell";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The dark water the shell hangs in: near black, with a faint glow of the tint high behind it on the left, darkening
// below, so the frame falls off into shadow on every side.
export function Backdrop() {
  const { material, geometry } = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const d = normalize(positionWorld.sub(cameraPosition)) as any;
    const glowDir = normalize(vec3(-0.45, 0.35, -1)) as any;
    const glow = pow(max(dot(d, glowDir), float(1e-6)), float(5)) as any;
    const wide = pow(max(dot(d, normalize(vec3(0, -0.1, -1))), float(1e-6)), float(2)) as any;
    const below = smoothstep(0.05, -0.6, d.y) as any;
    const lit = tint(float(0.12)).mul(glow.mul(0.05).add(wide.mul(0.01))) as any;
    m.colorNode = vec4(color("#000000").add(lit).mul(float(1).sub(below.mul(0.6))), 1) as any;
    return { material: m, geometry: new THREE.SphereGeometry(40, 48, 24) };
  }, []);
  useDispose(material, geometry);
  return <mesh geometry={geometry} material={material} renderOrder={-1} frustumCulled={false} raycast={() => null} />;
}

// Specks hanging in the water, in mixed sizes, with big soft discs drifting past the lens. Each glints as the pulse
// sweeps over it inside the fan, the way dust shows in a lidar's beam; the rest stay a dim haze of points.
export function Motes({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(4271);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const s = attribute("aSeed", "vec4") as any;
    const t = time as any;
    const size = vec3(6.5, 4.6, 6.5) as any;
    const drift = vec3(t.mul(0.004), t.mul(0.011), t.mul(-0.003)).mul(s.w.add(0.5)) as any;
    const lens = step(s.w, 0.12) as any;
    const big = step(0.12, s.w).mul(step(s.w, 0.3)) as any;
    const raw = fract(s.xyz.add(drift.div(size)))
      .sub(0.5)
      .mul(size)
      .add(vec3(SHELL_CENTRE.x, SHELL_CENTRE.y + 0.3, SHELL_CENTRE.z)) as any;
    const swirl = vec3(sin(raw.y.mul(1.3).add(t.mul(0.11))), sin(raw.z.mul(1.1).add(t.mul(0.09))).mul(0.5), sin(raw.x.mul(1.2).sub(t.mul(0.1)))).mul(0.08) as any;
    const room = raw.add(swirl) as any;
    const nearPlace = cameraPosition.add(
      fract(s.xyz.add(drift.div(2.2)).sub(cameraPosition.div(2.2)))
        .sub(0.5)
        .mul(2.2)
    ) as any;
    const centre = mix(room, nearPlace, lens) as any;

    // Lit by the live fan: near its plane, inside the sector, and most as the pulse front passes.
    const frame = fanFrameNode(view.tilt, view.yaw);
    const rel = centre.sub(vec3(APEX.x, APEX.y, APEX.z)) as any;
    const range = length(rel) as any;
    const off = dot(rel, frame.normal) as any;
    const angle = atan(dot(rel, frame.across), dot(rel, frame.down)) as any;
    const inside = smoothstep(HALF + 0.05, HALF - 0.08, abs(angle))
      .mul(smoothstep(NEAR, NEAR + 0.2, range))
      .mul(smoothstep(FAR + 0.1, FAR - 0.3, range)) as any;
    const sheet = bell(off.div(0.07)) as any;
    const ahead = range.sub(view.front) as any;
    const since = fract(view.front.sub(range).div(view.trip)).mul(view.trip) as any;
    const pulse = bell(ahead.div(0.06)).mul(6).add(exp(since.mul(-2.5)).mul(1.4)) as any;
    const beam = inside.mul(sheet).mul(pulse.add(0.25)) as any;

    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const up = cross(toEye, right) as any;
    const away = cameraPosition.sub(centre).length() as any;
    const grain = mix(float(1), s.x.mul(2.4).add(1.5), big) as any;
    const sharp = max(float(0.0022), away.mul(0.0009)).mul(grain).mul(s.y.mul(0.8).add(0.6)) as any;
    // Out of focus with distance from the shell: the lens is focused on it.
    const focus = length(vec3(SHELL_CENTRE.x, SHELL_CENTRE.y, SHELL_CENTRE.z).sub(cameraPosition)) as any;
    const blur = min(away.sub(focus).abs().div(away).mul(0.045), away.mul(0.03)) as any;
    const radius = sharp.add(blur) as any;
    const spread = sharp.div(radius).pow(2).max(0.03) as any;
    const soft = smoothstep(0.004, 0.03, blur) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
    const r = uv().sub(0.5).length() as any;
    const point = float(1).sub(smoothstep(0.06, 0.5, r)) as any;
    const disc = float(1).sub(smoothstep(0.3, 0.5, r)) as any;
    const shape = mix(point, disc, soft).mul(spread) as any;
    const twinkle = sin(t.mul(s.y.mul(1.7).add(0.5)).add(s.z.mul(40)))
      .mul(0.3)
      .add(0.7) as any;
    // A cool side light from the upper left gives the haze its faint base, the beam the rest.
    const side = smoothstep(2.5, -2, centre.x).mul(smoothstep(-2, 2.2, centre.y)).mul(0.06).add(0.008) as any;
    const base = mix(side, side.mul(0.8).add(0.015), lens) as any;
    const lit = beam.mul(mix(float(1), float(0.25), lens)).add(base.mul(twinkle)) as any;
    material.colorNode = vec4(tint(lit.mul(shape).mul(1.4)).add(vec3(0.5, 0.52, 0.55).mul(base.mul(shape).mul(0.25))), 1) as any;

    const mesh = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, material, mesh };
  }, [count]);
  useDispose(parts.quad, parts.material);
  return <primitive object={parts.mesh} />;
}

// The probe: a small dark transducer head at the top of the fan, its row of elements along the underside glowing as
// each pulse leaves. Turns with the pose.
export function Probe() {
  const group = useRef<THREE.Group>(null);
  const parts = useMemo(() => {
    const body = new THREE.CapsuleGeometry(0.055, 0.3, 8, 24);
    // Lying along the fan's width.
    body.rotateZ(Math.PI / 2);
    body.scale(1, 0.9, 0.62);
    const shell = new THREE.MeshStandardNodeMaterial({ color: "#14161a", roughness: 0.32, metalness: 0.55 });
    const face = new THREE.BoxGeometry(0.34, 0.012, 0.028);
    face.translate(0, -0.047, 0);
    const emitter = new THREE.MeshBasicNodeMaterial();
    const flash = exp(view.front.mul(-9)).mul(2.2).add(0.35) as any;
    emitter.colorNode = vec4(tint(flash.mul(1.3)), 1) as any;
    return { body, shell, face, emitter };
  }, []);
  useDispose(parts.body, parts.shell, parts.face, parts.emitter);
  const scratch = useMemo(() => ({ down: new THREE.Vector3(), across: new THREE.Vector3(), normal: new THREE.Vector3(), m: new THREE.Matrix4() }), []);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    fanFrame(view.tilt.value, view.yaw.value, scratch.down, scratch.across, scratch.normal);
    // Local x along the fan's width, y up out of it (against the beam), z out of its plane.
    scratch.down.negate();
    scratch.m.makeBasis(scratch.across, scratch.down, scratch.normal);
    g.quaternion.setFromRotationMatrix(scratch.m);
    g.position.copy(APEX);
  });

  return (
    <group ref={group}>
      <mesh geometry={parts.body} material={parts.shell} />
      <mesh geometry={parts.face} material={parts.emitter} />
    </group>
  );
}
