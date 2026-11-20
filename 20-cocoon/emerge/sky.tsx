"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, asin, atan, cos, float, normalize, positionWorld, sin, texture, uv, vec2, vec3 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { environment, sky } from "../../14-tension/backdrop";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The garden's sky and leaves, as Tension draws them (its `environment`: two three-octave noises for every pixel that
// asks), drawn ONCE into a small picture of every direction, and looked up from there by everything in this scene that
// shows the sky: the dome behind, and every drop, shell, eye and wing that mirrors or bends it. The picture is drawn
// again only while the weather is changing. Tension's own file is not touched.
//
//   skyAt(direction)            the sky in a direction, as environment(direction) gives it (lightning included).
//   skyAt(direction, blur)      the same, softened: blur 0 sharp, 1 the widest blur (for rough reflections).
//   <SkyDome />                 the dome behind everything, in place of Tension's <Backdrop />.
//   useSkyBake()                keeps the picture up to date; call it once in the scene (usePupa already does).

const WIDTH = 1024;
const HEIGHT = 512;
const target = new THREE.RenderTarget(WIDTH, HEIGHT, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true });
target.texture.minFilter = THREE.LinearMipmapLinearFilter;
target.texture.magFilter = THREE.LinearFilter;
target.texture.wrapS = THREE.RepeatWrapping;
target.texture.wrapT = THREE.ClampToEdgeWrapping;
const baked = texture(target.texture) as any;
const LEVELS = Math.log2(HEIGHT) - 2;

// Across the picture: round the horizon from left to right, from straight down at the bottom to straight up at the top.
const toPicture = (direction: any) => {
  const d = normalize(direction) as any;
  return vec2(atan(d.z, d.x).div(Math.PI * 2).add(0.5), asin(d.y.clamp(-1, 1)).div(Math.PI).add(0.5)) as any;
};

export const skyAt = (direction: any, blur: any = 0) =>
  (baked.sample(toPicture(direction)) as any)
    .level(typeof blur === "number" ? float(blur * LEVELS) : (blur as any).mul(LEVELS))
    .rgb.add(vec3(1, 1, 1).mul(sky.flash.mul(0.8))) as any;

// What draws the picture.
let quad: THREE.QuadMesh | null = null;
let drawn = "";
const state = () =>
  [sky.zenith.value, sky.horizon.value, sky.light.value, ...sky.blots.map((b) => b.value)].map((c) => `${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)}`).join(";") +
  `;${sky.power.value.toFixed(4)};${sky.toLight.value.x.toFixed(4)},${sky.toLight.value.y.toFixed(4)},${sky.toLight.value.z.toFixed(4)}`;

export function bakeSky(renderer: THREE.WebGPURenderer, force = false) {
  const now = state();
  if (!force && now === drawn) return false;
  if (!quad) {
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = Fn(() => {
      const around = uv().x.sub(0.5).mul(Math.PI * 2) as any;
      const up = uv().y.sub(0.5).mul(Math.PI) as any;
      return environment(vec3(cos(up).mul(cos(around)), sin(up), cos(up).mul(sin(around))));
    })() as any;
    quad = new THREE.QuadMesh(material);
  }
  // Without the lightning: that is added where the picture is read, so a flash need not redraw it.
  const flash = sky.flash.value;
  sky.flash.value = 0;
  const before = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  quad.render(renderer);
  renderer.setRenderTarget(before);
  sky.flash.value = flash;
  drawn = now;
  return true;
}

export function useSkyBake() {
  const renderer = useThree((three) => three.gl) as unknown as THREE.WebGPURenderer;
  useFrame(() => {
    bakeSky(renderer);
  });
}

// The dome behind everything.
export function SkyDome() {
  const { mesh, material } = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: true });
    material.colorNode = skyAt(normalize(positionWorld)) as any;
    material.fog = false;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(40, 48, 24), material);
    mesh.frustumCulled = false;
    return { mesh, material };
  }, []);
  useDispose(mesh.geometry, material);
  return <primitive object={mesh} />;
}

// In development: `__sky.bake(renderer)` redraws the picture; `__sky.dome(scene)` puts the picture on Tension's dome in
// place of its own sky (and gives back a way to undo it), to compare the two.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production")
  (globalThis as Record<string, unknown>).__sky = {
    target,
    bake: (renderer: THREE.WebGPURenderer) => bakeSky(renderer, true),
    dome(scene: THREE.Object3D) {
      let found: THREE.Mesh | null = null;
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && (mesh.geometry as THREE.SphereGeometry).parameters?.radius === 40) found = mesh;
      });
      const dome = found as THREE.Mesh | null;
      if (!dome) return null;
      const before = dome.material;
      const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: true });
      material.colorNode = skyAt(normalize(positionWorld)) as any;
      material.fog = false;
      dome.material = material;
      return () => {
        dome.material = before;
      };
    }
  };
