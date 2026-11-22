"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  cameraPosition,
  clamp,
  cross,
  dot,
  exp,
  float,
  fract,
  instancedArray,
  instanceIndex,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  screenCoordinate,
  screenUV,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  texture3D,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import type { QualityTier } from "../../shared/engine/types";
import { BLUE_SIZE, blueNoise, BOUNDS, ECHO_REACH, LOBES, nebula, REACH, smokeNoise } from "./cloud";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The palette: a warm white front, and echoes in deep teal and violet. The smoke itself is near black, seen at rest only
// by a cold rim of light from somewhere behind it.
const WARM = vec3(1, 0.86, 0.68);
const TEAL = vec3(0.18, 0.78, 0.82);
const VIOLET = vec3(0.52, 0.36, 1);
const RIM = vec3(0.42, 0.52, 0.7);
const KEY = new THREE.Vector3(-0.45, 0.5, -0.74).normalize();
// Units of extinction per unit of smoke per world unit: thick enough that a slice through it reads as a surface.
const SIGMA = 3.2;
const STEPS: Record<QualityTier, number> = { low: 4, medium: 4, high: 4 };
// The share of the screen's pixels the cloud is marched at, each way.
const SCALE: Record<QualityTier, number> = { low: 0.4, medium: 0.46, high: 0.5 };

// The colour a shell gives off: warm for the hand's own pulse, teal to violet for an echo.
const tintOf = (shell: any) => mix(WARM, mix(TEAL, VIOLET, shell.w), shell.z) as any;

// How brightly shell `i` lights a point at distance `dl` from where it started, and how wide its front is there.
function shellLight(origin: any, shell: any, dl: any, width: number, tail: number) {
  const age = nebula.time.sub(origin.w) as any;
  const radius = age.mul(shell.y) as any;
  const x = dl.sub(radius) as any;
  const echo = shell.z as any;
  const w = mix(float(width), float(width * 1.7), echo) as any;
  const front = exp(x.div(w).pow2().negate()) as any;
  // A little light lingers behind the front, as the smoke it has passed keeps scattering it.
  const behind = select(x.lessThan(0), exp(x.mul(7)).mul(tail), float(0)) as any;
  const reach = mix(float(REACH), float(ECHO_REACH), echo) as any;
  const life = exp(age.mul(mix(float(0.5), float(1.25), echo)).negate())
    .mul(smoothstep(0, 0.04, age))
    .mul(float(1).sub(smoothstep(reach.mul(0.7), reach, radius))) as any;
  // The tap itself: a brief flare where the pulse leaves.
  const flare = exp(dl.mul(dl).mul(-90))
    .mul(exp(age.mul(-9)))
    .mul(float(1).sub(echo))
    .mul(3) as any;
  return front.add(behind).mul(life).div(radius.mul(0.55).add(1)).add(flare).mul(shell.x) as any;
}

export function Smoke({ tier }: { tier: QualityTier }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const dome = useRef<THREE.Mesh>(null);
  const steps = STEPS[tier];

  const pass = useMemo(() => {
    const make = () => new THREE.RenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
    const target = make();
    const history = [make(), make()];
    const view = {
      inverseView: uniform(new THREE.Matrix4()),
      inverseProjection: uniform(new THREE.Matrix4()),
      previous: uniform(new THREE.Matrix4()),
      eye: uniform(new THREE.Vector3()),
      blend: uniform(1),
      texel: uniform(new THREE.Vector2(0.5, 0.5))
    };
    return { target, history, view, size: new THREE.Vector2(), count: 0 };
  }, []);

  const material = useMemo(() => {
    const { view } = pass;
    const n = nebula as any;
    const noise = smokeNoise();
    const blue = texture(blueNoise());
    const tap = (q: any) => texture3D(noise, q, 0) as any;

    // The lobes' sum at a point: the smoke's body before the noise wears it.
    const lobes = (p: any) => {
      const sum = float(0).toVar() as any;
      Loop(LOBES, ({ i }: any) => {
        const l = n.lobes.element(i) as any;
        const d = p.sub(l.xyz) as any;
        sum.addAssign(exp(dot(d, d).div(l.w.mul(l.w)).negate()));
      });
      return sum;
    };

    // The smoke at a point. Each of the hand's pulses shoves it outward a little as it passes, so the smoke is read
    // from further in.
    const smoke = (p: any) => {
      const at = p.toVar() as any;
      Loop(n.pushes, ({ i }: any) => {
        const o = n.origins.element(i) as any;
        const s = n.shells.element(i) as any;
        const age = n.time.sub(o.w) as any;
        const d = p.sub(o.xyz) as any;
        const dl = length(d).add(0.0001) as any;
        const passed = age.mul(s.y).sub(dl) as any;
        const push = smoothstep(-0.05, 0.45, passed).mul(exp(age.mul(-0.75))).mul(s.x).mul(0.085).div(dl.mul(0.8).add(1)) as any;
        at.subAssign(d.div(dl).mul(push));
      });
      const body = lobes(at).toVar() as any;
      const dense = float(0).toVar() as any;
      If(body.greaterThan(0.1), () => {
        const q = at.mul(0.5).add(n.drift).toVar() as any;
        const big = tap(q) as any;
        // The fine billows read through a warp taken from the large ones, so they curl round them.
        const fine = tap(q.mul(3.1).add(vec3(big.b, big.a, big.r).sub(0.5).mul(0.9)).sub(n.drift.mul(2.5))) as any;
        const shape = body
          .add(big.g.sub(0.5).mul(0.95))
          .add(big.r.sub(0.5).mul(0.4))
          .sub(float(1).sub(fine.g).mul(0.42)) as any;
        dense.assign(smoothstep(0.38, 1.05, shape));
      });
      return dense;
    };

    // A coarse take on the same, for light finding its way in: no push, no fine wear.
    const coarse = (p: any) => {
      const big = tap(p.mul(0.5).add(n.drift)) as any;
      return smoothstep(0.3, 1.05, lobes(p).add(big.g.sub(0.5).mul(0.95))) as any;
    };

    const hg = (g: number, c: any) => float(1 - g * g).div(pow(float(1 + g * g).sub(c.mul(2 * g)), 1.5)).mul(1 / (4 * Math.PI)) as any;
    const key = vec3(KEY.x, KEY.y, KEY.z);

    const m = new THREE.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false, blending: THREE.NoBlending });
    m.colorNode = Fn(() => {
      const ndc = vec2(uv().x, float(1).sub(uv().y)).mul(2).sub(1) as any;
      const far = view.inverseProjection.mul(vec4(ndc.x, ndc.y, 1, 1)) as any;
      const rd = normalize(view.inverseView.mul(vec4(far.xyz.div(far.w), 0)).xyz).toVar() as any;
      const ro = view.eye as any;
      const b = dot(ro, rd) as any;
      const c = dot(ro, ro).sub(BOUNDS * BOUNDS) as any;
      const h = b.mul(b).sub(c) as any;
      const light = vec3(0).toVar() as any;
      const through = float(1).toVar() as any;
      If(h.greaterThan(0), () => {
        const root = sqrt(h) as any;
        const enter = max(b.negate().sub(root), float(0)) as any;
        const leave = b.negate().add(root) as any;
        const dt = leave.sub(enter).div(steps).toVar() as any;
        const jitter = fract((blue.sample(screenCoordinate.xy.div(BLUE_SIZE)) as any).r.add(n.frame.mul(0.618034))) as any;
        const t = enter.add(dt.mul(jitter)).toVar() as any;
        const phase = hg(0.78, dot(key, rd)).mul(0.9).add(hg(0, dot(key, rd)).mul(0.1)).toVar() as any;
        Loop(steps, () => {
          If(through.lessThan(0.01), () => {
            Break();
          });
          const p = ro.add(rd.mul(t)).toVar() as any;
          const dense = smoke(p).mul(n.density).toVar() as any;
          If(dense.greaterThan(0.002), () => {
            // The rim: a cold light from behind, scattered forward through the edges and dimmed by what lies toward it.
            const toKey = coarse(p.add(key.mul(0.3))).mul(0.5) as any;
            const rim = RIM.mul(exp(toKey.mul(SIGMA * -1.6))).mul(phase).mul(0.3) as any;
            // Every shell of sound passing through here, and which way its light comes from, on the whole.
            const glow = vec3(0).toVar() as any;
            const from = vec3(0).toVar() as any;
            Loop(n.top, ({ i }: any) => {
              const o = n.origins.element(i) as any;
              const s = n.shells.element(i) as any;
              const d = o.xyz.sub(p) as any;
              const dl = length(d).add(0.0001) as any;
              const strength = shellLight(o, s, dl, 0.04, 0.05) as any;
              glow.addAssign(tintOf(s).mul(strength));
              from.addAssign(d.div(dl).mul(strength));
            });
            const lit = rim.add(vec3(0.004, 0.005, 0.008)).toVar() as any;
            If(glow.x.add(glow.y).add(glow.z).greaterThan(0.002), () => {
              // Self-shadowing: the smoke between here and where the light comes from dims it.
              const dir = from.div(length(from).add(0.0001)) as any;
              const od = coarse(p.add(dir.mul(0.18))).mul(0.3) as any;
              lit.addAssign(glow.mul(exp(od.mul(SIGMA * -0.9)).mul(0.85).add(0.15)).mul(0.9));
            });
            const sigma = dense.mul(SIGMA) as any;
            const fade = exp(sigma.mul(dt).negate()) as any;
            light.addAssign(lit.mul(through).mul(float(1).sub(fade)));
            through.mulAssign(fade);
          });
          t.addAssign(dt);
        });
      });
      return vec4(light, float(1).sub(through));
    })();
    const quad = new THREE.QuadMesh(m);

    // The history: last frame's result where this pixel's ray met the cloud then, held within this frame's neighbours, so
    // a front shows at once and only the grain is averaged away.
    const resolve = new THREE.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false, blending: THREE.NoBlending });
    const raw = texture(pass.target.texture);
    const past = texture(pass.history[0].texture);
    resolve.colorNode = Fn(() => {
      const at = uv();
      const now = raw.sample(at).toVar() as any;
      const low = now.toVar() as any;
      const high = now.toVar() as any;
      for (const [x, y] of [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1]
      ]) {
        const s = raw.sample(at.add(vec2(x, y).mul(view.texel)));
        low.assign(min(low, s));
        high.assign(max(high, s));
      }
      const ndc = vec2(at.x, float(1).sub(at.y)).mul(2).sub(1) as any;
      const far = view.inverseProjection.mul(vec4(ndc.x, ndc.y, 1, 1)) as any;
      const d = normalize(view.inverseView.mul(vec4(far.xyz.div(far.w), 0)).xyz) as any;
      const reach = max(dot(view.eye, d).negate(), float(0.5)) as any;
      const clip = view.previous.mul(vec4(view.eye.add(d.mul(reach)), 1)) as any;
      const ahead = clip.xy.div(clip.w).mul(0.5).add(0.5) as any;
      const back = vec2(ahead.x, float(1).sub(ahead.y)) as any;
      const inside = back.x.greaterThan(0).and(back.x.lessThan(1)).and(back.y.greaterThan(0)).and(back.y.lessThan(1)).and(clip.w.greaterThan(0));
      const held = clamp(past.sample(back), low, high);
      return mix(held, now, select(inside, view.blend, float(1)));
    })();
    const resolveQuad = new THREE.QuadMesh(resolve);

    // The dome round the eye lays the cloud over the dark, premultiplied, at full size.
    const domeMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, transparent: true, fog: false });
    domeMaterial.blending = THREE.CustomBlending;
    domeMaterial.blendSrc = THREE.OneFactor;
    domeMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
    domeMaterial.blendSrcAlpha = THREE.OneFactor;
    domeMaterial.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    const cloudTexture = texture(pass.history[1].texture, screenUV);
    domeMaterial.colorNode = (cloudTexture as any).rgb;
    domeMaterial.opacityNode = (cloudTexture as any).a;
    return { m, quad, resolve, resolveQuad, past, domeMaterial, cloudTexture };
  }, [pass, steps]);

  useDispose(material.m, material.resolve, material.domeMaterial, pass.target, ...pass.history);
  cloudOver.texture = material.cloudTexture;

  useFrame(() => {
    dome.current?.position.copy(camera.position);
    gl.getDrawingBufferSize(pass.size);
    let w = Math.max(2, Math.floor(pass.size.x * SCALE[tier]));
    let h = Math.max(2, Math.floor(pass.size.y * SCALE[tier]));
    // Never more than about two thirds of a million pixels marched, whatever the screen.
    const over = Math.sqrt((w * h) / 640_000);
    if (over > 1) {
      w = Math.floor(w / over);
      h = Math.floor(h / over);
    }
    const resized = pass.target.width !== w || pass.target.height !== h;
    if (resized) [pass.target, ...pass.history].forEach((t) => t.setSize(w, h));
    camera.updateMatrixWorld();
    const { view } = pass;
    view.inverseView.value.copy(camera.matrixWorld);
    view.inverseProjection.value.copy(camera.projectionMatrixInverse);
    view.eye.value.copy(camera.position);
    view.texel.value.set(1 / w, 1 / h);
    view.blend.value = resized || pass.count === 0 ? 1 : 0.22;
    const read = pass.history[pass.count % 2];
    const write = pass.history[(pass.count + 1) % 2];
    material.past.value = read.texture;
    material.cloudTexture.value = write.texture;
    const before = gl.getRenderTarget();
    gl.setRenderTarget(pass.target);
    material.quad.render(gl);
    gl.setRenderTarget(write);
    material.resolveQuad.render(gl);
    gl.setRenderTarget(before);
    view.previous.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    pass.count++;
  }, 0.75);

  return (
    <mesh ref={dome} material={material.domeMaterial} renderOrder={-10} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[50, 32, 16]} />
    </mesh>
  );
}

// The cloud as last drawn, for what is laid over it to hide behind.
const cloudOver: { texture: any } = { texture: null };

// The lens: a pixel's size at a distance of one, and where it is focused, set each frame by the scene.
export const lens = { pixel: uniform(0.001), focus: uniform(6) };

// Fine motes hanging round the cloud, dim until a shell passes through them, when they catch its colour: so each pulse
// and echo shows as a sphere of sparks through the air as well as a slice through the smoke.
export function Motes({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(2211);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const seed = instancedArray(seeds, "vec4") as any;
    const quad = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(quad, material);
    mesh.count = count;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { seed, quad, material, mesh };
  }, [count]);
  useDispose(parts.quad, parts.material);

  useMemo(() => {
    const n = nebula as any;
    // Each mote in a wide shell round the cloud, drifting slowly up and round; a few near the lens, big and soft.
    const place = () => {
      const s = parts.seed.element(instanceIndex) as any;
      const t = n.time as any;
      const lensNear = step01(s.w, 0.06) as any;
      const theta = s.x.mul(6.2832).add(t.mul(s.w.mul(0.02).add(0.008))) as any;
      const y = s.y.mul(2).sub(1) as any;
      const ring = sqrt(float(1).sub(y.mul(y))) as any;
      const radius = pow(s.z, 0.6).mul(2.9).add(1.05) as any;
      const rise = fract(s.w.mul(7.3).add(t.mul(0.004))).sub(0.5).mul(0.6) as any;
      const far = vec3(ring.mul(sin(theta.add(1.5708))), y.mul(0.8).add(rise), ring.mul(sin(theta))).mul(radius) as any;
      const near = cameraPosition.add(s.xyz.add(vec3(t.mul(0.004), t.mul(0.003), 0)).sub(cameraPosition.div(2.2)).fract().sub(0.5).mul(2.2)) as any;
      return { s, centre: mix(far, near, lensNear) as any, lensNear };
    };
    const a = place();
    const toEye = normalize(cameraPosition.sub(a.centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    const away = length(cameraPosition.sub(a.centre)) as any;
    const sharp = max(float(0.0018), away.mul(lens.pixel).mul(1.4)).mul(a.s.y.mul(1.2).add(0.6)) as any;
    const blur = min(abs(away.sub(lens.focus)).div(away).mul(0.035), away.mul(0.028)) as any;
    const radius = sharp.add(blur) as any;
    parts.material.positionNode = a.centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(upward.mul(positionGeometry.y.mul(radius.mul(2)))) as any;

    const b = place();
    const awayB = length(cameraPosition.sub(b.centre)) as any;
    const sharpB = max(float(0.0018), awayB.mul(lens.pixel).mul(1.4)).mul(b.s.y.mul(1.2).add(0.6)) as any;
    const blurB = min(abs(awayB.sub(lens.focus)).div(awayB).mul(0.035), awayB.mul(0.028)) as any;
    const spreadOut = pow(sharpB.div(sharpB.add(blurB)), 2).max(0.03) as any;
    const caught = vec3(0).toVar() as any;
    Loop(n.top, ({ i }: any) => {
      const o = n.origins.element(i) as any;
      const s = n.shells.element(i) as any;
      const dl = length(b.centre.sub(o.xyz)) as any;
      caught.addAssign(tintOf(s).mul(shellLight(o, s, dl, 0.1, 0.05)));
    });
    const twinkle = sin(n.time.mul(b.s.y.mul(1.9).add(0.5)).add(b.s.z.mul(40))).mul(0.3).add(0.7) as any;
    const ambient = vec3(0.55, 0.62, 0.8).mul(0.05).mul(b.s.x.mul(0.8).add(0.2)) as any;
    const amount = mix(float(1), float(0.16), b.lensNear) as any;
    const colour = varying(caught.mul(1.6).add(ambient).mul(twinkle).mul(amount).mul(spreadOut)) as any;
    // Hidden by the smoke where the mote lies beyond the cloud's middle.
    const beyond = varying(smoothstep(-0.3, 0.3, awayB.sub(length(cameraPosition)))) as any;
    const r = uv().sub(0.5).length() as any;
    const soft = varying(smoothstep(0.004, 0.03, blurB)) as any;
    const shape = mix(float(1).sub(smoothstep(0.08, 0.5, r)), float(1).sub(smoothstep(0.36, 0.5, r)), soft) as any;
    const cover = cloudOver.texture ? (cloudOver.texture as any).a : float(0);
    parts.material.colorNode = vec4(colour.mul(shape).mul(float(1).sub(cover.mul(beyond).mul(0.92))), 1) as any;
    parts.material.needsUpdate = true;
  }, [parts]);

  return <primitive object={parts.mesh} />;
}

// 1 where a is below edge, else 0.
const step01 = (a: any, edge: number) => float(1).sub(smoothstep(edge - 0.0001, edge, a));
