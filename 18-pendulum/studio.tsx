"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { atan, color, float, floor, fract, max, mix, mx_noise_float, positionLocal, sin, smoothstep, step, vec2, vec3 } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { useDispose } from "../shared/engine/dispose";
import { lehmer } from "../shared/engine/random";
import { CANVAS } from "./pendulum";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What the studio is made of: its size, the paints and the open cans of them round the canvas, the paint spilt over
// its floor over the years, and the finished paintings that lean on its walls. The room itself is in studios.tsx.

export const ROOM = { width: 9, depth: 9, height: 3.4 };
// Where the open cans stand, round the canvas, and the colours they hold.
export const PAINTS = [
  { value: "bone", label: "Bone", colour: "#efe8da" },
  { value: "crimson", label: "Crimson", colour: "#b3122a" },
  { value: "marigold", label: "Marigold", colour: "#f2a516" },
  { value: "cobalt", label: "Cobalt", colour: "#1f4fd1" },
  { value: "mint", label: "Mint", colour: "#41c9a0" },
  { value: "flamingo", label: "Flamingo", colour: "#ff4f8a" }
] as const;
export type PaintName = (typeof PAINTS)[number]["value"];
// Round the canvas, clear of the circle its corners sweep on the turntable (half its diagonal, about a metre out).
export const CAN_SPOTS = PAINTS.map((_, k) => {
  const a = -0.5 + (k / (PAINTS.length - 1)) * 2.2;
  const out = (CANVAS * Math.SQRT2) / 2 + 0.3;
  return new THREE.Vector3(Math.sin(a) * out, 0, Math.cos(a) * out);
});

// Muted by years underfoot: dirt and wear have taken the edge off every colour, and most of it is white, grey and black.
const MUTED = ["#d9d2c3", "#cfc8b8", "#8a1a26", "#c08a2a", "#2a4594", "#3d9a7e", "#c24a74", "#1c1c1c", "#2a2a2a", "#5c5a56", "#9a948a"];

// Paint spilled over the floor over the years, drawn once into a texture: pools, splats with their spray, long drips
// and the loops of old pendulum paintings that ran off their canvases.
// colours: the palette to spill; by default muted by years underfoot.
export function spills(size: number, seed: number, colours = MUTED) {
  const random = lehmer(seed);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, size, size);
  const pick = () => colours[Math.floor(random() * colours.length)];
  // Splats, with spray round them.
  for (let n = 0; n < 420; n++) {
    const x = random() * size;
    const y = random() * size;
    const r = (2 + random() ** 3 * 40) * (size / 2048);
    g.fillStyle = pick();
    g.globalAlpha = 0.35 + random() * 0.5;
    g.beginPath();
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const rr = r * (0.75 + random() * 0.5);
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.fill();
    for (let k = 0; k < 14; k++) {
      const a = random() * Math.PI * 2;
      const d = r * (1.2 + random() * 3);
      g.beginPath();
      g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.08 * (0.4 + random()), 0, Math.PI * 2);
      g.fill();
    }
  }
  // Drips and flicks: thin lines thickening and thinning.
  for (let n = 0; n < 160; n++) {
    g.strokeStyle = pick();
    g.globalAlpha = 0.35 + random() * 0.45;
    g.lineCap = "round";
    let x = random() * size;
    let y = random() * size;
    let a = random() * Math.PI * 2;
    const steps = 10 + Math.floor(random() * 50);
    for (let k = 0; k < steps; k++) {
      g.lineWidth = (0.6 + random() * 3.5) * (size / 2048);
      g.beginPath();
      g.moveTo(x, y);
      a += (random() - 0.5) * 0.5;
      x += Math.cos(a) * 9 * (size / 2048);
      y += Math.sin(a) * 9 * (size / 2048);
      g.lineTo(x, y);
      g.stroke();
    }
  }
  // Loops from old pendulum paintings that ran off the edge of their canvases.
  for (let n = 0; n < 7; n++) {
    g.strokeStyle = pick();
    g.globalAlpha = 0.85;
    g.lineWidth = 2.2 * (size / 2048);
    const cx = random() * size;
    const cy = random() * size;
    const ax = (0.04 + random() * 0.08) * size;
    const ay = ax * (0.4 + random() * 0.6);
    const turn = (random() - 0.5) * 0.02;
    g.beginPath();
    for (let k = 0; k < 2200; k++) {
      const t = k * 0.06;
      const fade = Math.exp(-t * 0.012);
      const r = t * turn;
      const px = Math.cos(t) * ax * fade;
      const py = Math.sin(t * 1.003) * ay * fade;
      g.lineTo(cx + px * Math.cos(r) - py * Math.sin(r), cy + px * Math.sin(r) + py * Math.cos(r));
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// A finished pendulum painting, for the stack against the wall: a damped spherical swing's path traced over a dark or
// pale ground in one to three colours.
export function painting(size: number, seed: number) {
  const random = lehmer(seed);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const dark = random() < 0.65;
  g.fillStyle = dark ? "#121212" : "#e8e3d8";
  g.fillRect(0, 0, size, size);
  const colours = ["#efe8da", "#b3122a", "#f2a516", "#1f4fd1", "#41c9a0", "#ff4f8a", "#e8e04a"];
  const layers = 1 + Math.floor(random() * 3);
  for (let l = 0; l < layers; l++) {
    g.strokeStyle = colours[Math.floor(random() * colours.length)];
    g.lineWidth = size / 400;
    g.globalAlpha = 0.9;
    const ax = (0.25 + random() * 0.2) * size;
    const ay = ax * (0.3 + random() * 0.7);
    const turn = 0.002 + random() * 0.01;
    const ox = size / 2 + (random() - 0.5) * size * 0.1;
    const oy = size / 2 + (random() - 0.5) * size * 0.1;
    g.beginPath();
    for (let k = 0; k < 5000; k++) {
      const t = k * 0.05;
      const fade = Math.exp(-t * 0.006);
      const r = t * turn;
      const px = Math.cos(t) * ax * fade;
      const py = Math.sin(t) * ay * fade;
      g.lineTo(ox + px * Math.cos(r) - py * Math.sin(r), oy + px * Math.sin(r) + py * Math.cos(r));
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// The open cans of paint round the canvas, one of each colour: a tin with a printed band, paint run down from the rim in
// drips of every length with rounded ends, flecks of it on the sides, a wall inside coated in it so nothing is seen
// through the rim from above, and drops of it on the floor round each.
export function Cans() {
  const parts = useMemo(() => {
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const tin = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.9 });
    tin.colorNode = color("#a7a49d") as any;
    materials.push(tin);
    const R = 0.09;
    const H = 0.2;
    const LEVEL = 0.185;
    const body = new THREE.CylinderGeometry(R, R, H, 48, 1, true).translate(0, H / 2, 0);
    const inner = new THREE.CylinderGeometry(R - 0.0025, R - 0.0025, H - LEVEL + 0.002, 48, 1, true).translate(0, (H + LEVEL) / 2 - 0.001, 0);
    const top = new THREE.CircleGeometry(R - 0.0025, 40).rotateX(-Math.PI / 2).translate(0, LEVEL, 0);
    const rim = new THREE.TorusGeometry(R, 0.004, 6, 40).rotateX(Math.PI / 2).translate(0, H, 0);
    geometries.push(body, inner, top, rim);
    // Lanes round the can, each with its own drip (or none), as wide and as long as a hash of the lane says.
    const LANES = 11;
    const laneWidth = (Math.PI * 2 * R) / LANES;
    const hash = (n: any, a: number, b: number) => fract(sin(n.mul(a).add(b)).mul(43758.5453)) as any;
    PAINTS.forEach((p, k) => {
      const random = lehmer(311 + k * 17);
      const y = positionLocal.y as any;
      const around = atan(positionLocal.x, positionLocal.z).div(Math.PI * 2).add(0.5).mul(LANES).add(random()) as any;
      const lane = floor(around) as any;
      const across = fract(around).sub(0.5).abs().mul(laneWidth) as any;
      const length = hash(lane, 12.9898, k * 7.1).pow(1.6).mul(0.16).add(0.006) as any;
      const width = hash(lane, 78.233, k * 3.3).mul(0.0055).add(0.0022) as any;
      const fromTop = float(H).sub(y) as any;
      // A capsule from the rim down to its length, a little fuller at its end, where the paint gathers.
      const d = vec2(across, max(fromTop.sub(length), 0)).length() as any;
      const r = width.mul(smoothstep(0, length, fromTop).mul(0.35).add(1)) as any;
      const drip = float(1).sub(smoothstep(r.sub(0.0006), r.add(0.0006), d)) as any;
      // A coat round the top where it ran over the rim, its lower edge wavering; and flecks lower down.
      const lip = float(1).sub(smoothstep(0.008, 0.01, fromTop.sub(mx_noise_float(vec3(around.mul(3), 0, k)).mul(0.004)))) as any;
      const fleck = smoothstep(0.66, 0.7, mx_noise_float(positionLocal.mul(85).add(k * 3.1))).mul(step(fromTop, 0.17)) as any;
      const coat = drip.max(lip).max(fleck) as any;
      const band = smoothstep(0.035, 0.04, y).mul(float(1).sub(smoothstep(0.16, 0.165, y))) as any;
      const label = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.5, metalness: 0.2 });
      // The printed label: cream paper with a stripe of the colour inside, so the drips show running over it.
      const stripe = smoothstep(0.085, 0.088, y).mul(float(1).sub(smoothstep(0.112, 0.115, y))) as any;
      const printed = mix(color("#e6e0d2"), color(p.colour).mul(0.85), stripe) as any;
      label.colorNode = mix(mix(color("#a7a49d"), printed, band), color(p.colour), coat) as any;
      label.metalnessNode = mix(mix(float(0.9), float(0.05), band), float(0), coat) as any;
      label.roughnessNode = mix(float(0.4), float(0.12), coat) as any;
      label.clearcoatNode = coat.mul(0.9) as any;
      const paint = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03 });
      paint.colorNode = color(p.colour) as any;
      // Inside, the wall above the paint is coated in it, streaked where it has run back down.
      const wall = new THREE.MeshStandardNodeMaterial({ roughness: 0.2, side: THREE.BackSide });
      const streak = mx_noise_float(vec3(around.mul(2), y.mul(60), k)).mul(0.5).add(0.5) as any;
      wall.colorNode = mix(color(p.colour).mul(0.55), color(p.colour), streak) as any;
      materials.push(label, paint, wall);
      // Drops on the floor round it: a few big ones near its foot and a scatter of small ones further out.
      const drops: THREE.BufferGeometry[] = [];
      for (let n = 0; n < 16; n++) {
        const a = random() * Math.PI * 2;
        const out = R + 0.01 + random() ** 1.5 * 0.3;
        const size = 0.003 + random() ** 3 * 0.022 * (1.2 - out / 0.4);
        drops.push(new THREE.CircleGeometry(size, 16).scale(1, 1 + random() * 0.4, 1).rotateX(-Math.PI / 2).translate(Math.cos(a) * out, 0.003 + n * 0.00005, Math.sin(a) * out));
      }
      const dropGeometry = mergeGeometries(drops)!;
      drops.forEach((g) => g.dispose());
      geometries.push(dropGeometry);
      const can = new THREE.Group();
      const shell = new THREE.Mesh(body, label);
      shell.castShadow = shell.receiveShadow = true;
      const lid = new THREE.Mesh(rim, tin);
      lid.castShadow = true;
      can.add(shell, new THREE.Mesh(inner, wall), new THREE.Mesh(top, paint), lid, new THREE.Mesh(dropGeometry, paint));
      can.position.copy(CAN_SPOTS[k]);
      can.rotation.y = k * 1.7;
      group.add(can);
    });
    return { group, geometries, materials };
  }, []);
  useDispose(...parts.geometries, ...parts.materials);
  return <primitive object={parts.group} />;
}
