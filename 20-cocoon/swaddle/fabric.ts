/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { color, dot, float, length, mix, mx_noise_float, normalView, positionViewDirection, positionWorld, pow, smoothstep, uniform, uv, vec2, vec3 } from "three/tsl";

export type FabricName = "satin" | "velvet" | "linen" | "chiffon";

// What every fabric's material reads each frame: the chosen colour, and the warm light inside the body.
export function createFabricUniforms() {
  return {
    colour: uniform(new THREE.Color("#efe6d6")) as any,
    glow: uniform(new THREE.Color("#ffb46b")) as any,
    // How bright the light inside is, breathing with the body.
    glowLevel: uniform(1) as any
  };
}
export type FabricUniforms = ReturnType<typeof createFabricUniforms>;

// How much of the light inside comes through each cloth, seen from outside: none through velvet's pile, a little through
// satin, more through the open weave of linen, and a lot through chiffon.
const THROUGH: Record<FabricName, number> = { satin: 0.1, velvet: 0.03, linen: 0.16, chiffon: 0.6 };

// One face of the cloth: the outside (FrontSide) or the inside (BackSide), which the light in the body falls on.
export function createFabric(name: FabricName, u: FabricUniforms, inside: boolean) {
  const m = new THREE.MeshPhysicalNodeMaterial({ side: inside ? THREE.BackSide : THREE.FrontSide });
  const base = u.colour as any;
  // The cloth's own coordinates in metres: across the weave round the body, and down it.
  const cloth = uv().mul(vec2(4.9, 2.4)) as any;
  // Light from the body's middle through the cloth, fading as cloth is pulled away from it.
  const near = smoothstep(1.35, 0.6, length(positionWorld.sub(vec3(0, 0.05, 0)))) as any;
  const facing = dot(normalView, positionViewDirection).abs().clamp(0, 1) as any;

  if (name === "satin") {
    // A long, stretched highlight along the threads that wind round the body, and a soft pearly sheen at the edges.
    m.colorNode = base.mul(inside ? 0.8 : 1);
    m.roughness = 0.26;
    m.anisotropy = 0.8;
    // Turned to run down the cloth, so the long highlight follows each fold rather than crossing it.
    m.anisotropyRotation = Math.PI / 2;
    m.sheen = 0.35;
    m.sheenRoughness = 0.35;
    m.sheenNode = mix(base, color("#ffffff"), 0.55) as any;
    m.specularIntensity = 1;
  } else if (name === "velvet") {
    // Pile: deep in the folds where it is seen end on, bright at the rims where it lies over, all from the sheen lobe.
    // A faint crushed variation in the pile keeps a large panel from looking printed.
    const crush = mx_noise_float(vec3(cloth.mul(5), 0)).mul(0.5).add(0.5) as any;
    m.colorNode = base.mul(mix(float(0.42), float(0.55), crush)).mul(inside ? 0.8 : 1);
    m.roughness = 0.85;
    m.sheen = 1;
    m.sheenNode = mix(base, color("#ffffff"), 0.3).mul(1.15) as any;
    m.sheenRoughnessNode = mix(float(0.32), float(0.48), crush) as any;
    m.specularIntensity = 0.25;
  } else if (name === "linen") {
    // Slubbed yarn: streaks along the weft, thicker and thinner, and a dry, soft lustre.
    const slub = mx_noise_float(vec3(cloth.x.mul(3), cloth.y.mul(70), 0)).mul(0.5).add(0.5) as any;
    const fleck = mx_noise_float(vec3(cloth.mul(28), 1.7)).mul(0.5).add(0.5) as any;
    m.colorNode = base.mul(slub.mul(0.12).add(0.88)).mul(fleck.mul(0.06).add(0.97)).mul(inside ? 0.85 : 1);
    m.roughness = 0.88;
    m.sheen = 0.45;
    m.sheenRoughness = 0.75;
    m.sheenNode = mix(base, color("#ffffff"), 0.25) as any;
    m.specularIntensity = 0.4;
  } else {
    // Sheer: thin enough to see the body's light and the layer behind through it, darker where it is seen edge on and
    // the light crosses more cloth.
    m.colorNode = base;
    m.roughness = 0.55;
    m.sheen = 0.8;
    m.sheenRoughness = 0.4;
    m.sheenNode = mix(base, color("#ffffff"), 0.45) as any;
    m.specularIntensity = 0.5;
    m.transparent = true;
    m.depthWrite = true;
    m.opacityNode = mix(float(0.78), float(0.36), pow(facing, 0.6)) as any;
  }

  // The warm light inside, coming through: from outside, most where the cloth faces you (thinnest to the eye); from the
  // inside face, the light falls on it directly, and the inner point light adds to that.
  const through = THROUGH[name];
  const glow = (u.glow as any).mul(u.glowLevel).mul(near);
  m.emissiveNode = inside ? glow.mul(through * 0.8 + 0.25).mul(base.mul(0.6).add(0.4)) : glow.mul(base.mul(0.5).add(0.5)).mul(facing.mul(0.6).add(0.4)).mul(through);
  if (!inside) m.shadowSide = THREE.DoubleSide;
  return m;
}
