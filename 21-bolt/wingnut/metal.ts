import * as THREE from "three/webgpu";
import { abs, color, float, length, mix, mx_noise_float, normalLocal, positionLocal, smoothstep, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The finishes. Each is real metal (metalness 1, its colour the reflectance) with the marks of how it was made worked
// into the roughness from the part's own coordinates: fine rings from the lathe round a turned axis, fainter streaks
// across, and a few soft smudges where it has been handled. `axis` is the part's turning axis: x for the bolt, z for a
// nut.

type Finish = { colour: string; rough: number; marks: number; smudge: number; flats?: number; iridescence?: number; clearcoat?: number; metalness?: number };

export const FINISHES = {
  // Bright turned steel, for the bolt.
  steel: { colour: "#c9ccd0", rough: 0.24, marks: 0.16, smudge: 0.1 },
  // Polished brass, for the wing nut.
  brass: { colour: "#ecc684", rough: 0.21, marks: 0.1, smudge: 0.09 },
  // Turned aluminium, for the T-handle's barrel.
  aluminium: { colour: "#d8d5cf", rough: 0.32, marks: 0.14, smudge: 0.06 },
  // Chrome, for its bar.
  chrome: { colour: "#e8eaec", rough: 0.07, marks: 0.03, smudge: 0.04, flats: 0 },
  // Zinc plate with its faint rainbow, for the hex nut.
  zinc: { colour: "#cfd3d8", rough: 0.26, marks: 0.16, smudge: 0.09, iridescence: 0.4 }
} satisfies Record<string, Finish>;

export function metal(finish: Finish, axis: "x" | "z") {
  const m = new THREE.MeshPhysicalNodeMaterial({ metalness: finish.metalness ?? 1, roughness: finish.rough, color: new THREE.Color(finish.colour) });
  if (finish.iridescence) {
    m.iridescence = finish.iridescence;
    m.iridescenceIOR = 1.6;
    Object.assign(m, { iridescenceThicknessMinimum: 260, iridescenceThicknessMaximum: 520 });
  }
  if (finish.clearcoat) {
    m.clearcoat = finish.clearcoat;
    m.clearcoatRoughness = 0.25;
  }
  const p = positionLocal as any;
  const along = (axis === "x" ? p.x : p.z) as any;
  const a = (axis === "x" ? p.y : p.x) as any;
  const b = (axis === "x" ? p.z : p.y) as any;
  const radius = length(vec3(a, b, 0)) as any;
  // Round the axis by the direction (cos, sin) rather than an angle, which would jump at ±π and draw a seam.
  const round = vec3(a, b, 0).div(radius.max(1e-4)) as any;
  // Lathe rings: fine bands along the axis on turned faces, and out across the radius on flat ones.
  const rings = mx_noise_float(vec3(along.mul(230).add(radius.mul(260)), round.x.mul(1.2), round.y.mul(1.2))) as any;
  const streak = mx_noise_float(vec3(along.mul(9), a.mul(110), b.mul(110))) as any;
  // Faces square to the axis (a bolt's end, the washer face, a nut's faces) are cut or pressed, not polished: duller.
  const flat = smoothstep(0.85, 0.98, abs(axis === "x" ? (normalLocal as any).x : (normalLocal as any).z)) as any;
  const smudge = smoothstep(0.15, 0.65, mx_noise_float(p.mul(2.2).add(vec3(3.1, 0, 7.7)))) as any;
  m.roughnessNode = float(finish.rough)
    .add(rings.mul(finish.marks * 0.5))
    .add(streak.mul(finish.marks * 0.3))
    .add(smudge.mul(finish.smudge))
    .add(flat.mul(finish.flats ?? 0.22))
    .clamp(0.03, 0.8) as any;
  // Handled metal is a touch duller where the smudges are.
  m.colorNode = mix(color(finish.colour), color(finish.colour).mul(0.86), smudge.mul(0.5)) as any;
  return m;
}
