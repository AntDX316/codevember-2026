import * as THREE from "three/webgpu";

// The hidden form: a torus knot, a single tube wound P times round its axis and Q times through its hole. Its centre
// line is sampled once so the processor can find, for any beacon, the point of the surface its sound meets first.
export const KNOT = { radius: 0.85, tube: 0.13, p: 3, q: 4 };
const LINE = 900;

function onCurve(u: number, out: THREE.Vector3) {
  const { radius, p, q } = KNOT;
  const cs = Math.cos((q / p) * u);
  return out.set(radius * (2 + cs) * 0.5 * Math.cos(u), radius * (2 + cs) * 0.5 * Math.sin(u), radius * Math.sin((q / p) * u) * 0.5);
}

export function createForm(fine: boolean) {
  const geometry = new THREE.TorusKnotGeometry(KNOT.radius, KNOT.tube, fine ? 720 : 400, fine ? 64 : 32, KNOT.p, KNOT.q);
  const line = new Float32Array(LINE * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < LINE; i++) onCurve((i / LINE) * Math.PI * 2 * KNOT.p, v).toArray(line, i * 3);
  return { geometry, line };
}

// The nearest point of the surface to `from` (both in the form's own frame), its outward normal, and how far that is.
// Inside the tube the distance is negative.
export function nearestOnForm(line: Float32Array, from: THREE.Vector3, point: THREE.Vector3, normal: THREE.Vector3) {
  let best = Infinity;
  let k = 0;
  for (let i = 0; i < line.length; i += 3) {
    const dx = from.x - line[i];
    const dy = from.y - line[i + 1];
    const dz = from.z - line[i + 2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) {
      best = d;
      k = i;
    }
  }
  normal.set(from.x - line[k], from.y - line[k + 1], from.z - line[k + 2]);
  const far = normal.length();
  if (far < 1e-6) normal.set(0, 0, 1);
  else normal.divideScalar(far);
  point.set(line[k], line[k + 1], line[k + 2]).addScaledVector(normal, KNOT.tube);
  return far - KNOT.tube;
}
