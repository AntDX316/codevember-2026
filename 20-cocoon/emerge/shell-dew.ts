import * as THREE from "three/webgpu";
import { Fn, cameraPosition, dot, max, mix, normalWorld, normalize, positionLocal, positionWorld, pow, reflect, smoothstep, uniform, vec3, vec4 } from "three/tsl";
import { sky } from "../../14-tension/backdrop";
import { skyAt } from "./sky";
import { dewPoints, pieceAt, pupaPoint, shapeOf } from "./shell-shape";
import type { Species } from "./species";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Dew beaded on the chrysalis, as on Tension's web at dawn: each bead a small lens sat on the cuticle, showing the
// shell under it and the garden turned over, its rim mirroring the sky, burning where it lines up with the sun. Beads
// belong to the piece they sit on, so they ride the lid when it opens and fall with the shell. Always drawn, shrunk to
// nothing by `amount` when the look is dry, so choosing the look builds nothing.
export function makeDew(tint: any) {
  const amount = uniform(0);
  const geometry = new THREE.IcosahedronGeometry(1, 3);
  const material = new THREE.MeshBasicNodeMaterial();
  material.positionNode = positionLocal.mul(amount) as any;
  material.colorNode = Fn(() => {
    const N = normalize(normalWorld) as any;
    const I = normalize(positionWorld.sub(cameraPosition)) as any;
    const L = sky.toLight as any;
    const bent = normalize(I.sub(N.mul(1.2))) as any;
    const facing = max(dot(I.negate(), N), 0) as any;
    // Through the bead: mostly the shell it sits on, magnified and brightened, and some of the garden beyond.
    const under = (tint as any).mul(sky.light.mul(sky.power).mul(0.3).add(sky.horizon.mul(0.6))) as any;
    const seen = mix((skyAt(bent) as any).mul(0.9), under.mul(1.2), 0.75) as any;
    const mirrored = skyAt(reflect(I, N)) as any;
    const fresnel = pow(facing.oneMinus(), 4) as any;
    let rgb: any = mix(seen, mirrored, fresnel.mul(0.7).add(0.04));
    // The dark ring inside its rim that makes a drop read as a drop.
    rgb = rgb.mul(smoothstep(0.08, 0.5, facing).mul(0.8).add(0.2));
    const focus = pow(max(dot(bent, L), 0), 400).mul(1.6) as any;
    const glance = pow(max(dot(reflect(I, N), L), 0), 500).mul(8) as any;
    // The sky in front, as a small soft window on each bead.
    const window = pow(max(dot(reflect(I, N), normalize(vec3(1.5, 2, 6))), 0), 140).mul(2.2) as any;
    rgb = rgb.add(sky.light.mul(sky.power).mul(focus.add(glance))).add(sky.horizon.mul(window));
    return vec4(rgb.add(vec3(1, 1, 1).mul(sky.flash.mul(0.5))), 1);
  })() as any;

  // Beads for one chrysalis, on its pieces.
  const bead = (sp: Species, pivots: THREE.Group[], fine: number) => {
    const sh = shapeOf(sp);
    const points = dewPoints(sp, Math.round(110 * fine));
    // One hanging from the very tip.
    points.push([0.992, Math.PI / 2, -0.02 * (sp.pupa / 0.6) ** 0.5]);
    const lists: THREE.Matrix4[][] = [[], [], [], []];
    const P = new THREE.Vector3();
    const n = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const z = new THREE.Vector3(0, 0, 1);
    for (const [t, u, r0] of points) {
      const hanging = r0 < 0;
      const r = Math.abs(r0);
      pupaPoint(sp, t, u, P, n);
      const piece = pieceAt(sh, t, u);
      if (hanging) {
        // Drawn out by its own weight.
        P.y -= r * 0.75;
        q.identity();
        s.set(r * 0.82, r * 1.15, r * 0.82);
      } else {
        // Sat on the surface, flattened against it; the big ones sag.
        q.setFromUnitVectors(z, n);
        P.addScaledVector(n, r * 0.22);
        P.y -= r * 0.12;
        s.set(r, r, r * 0.72);
      }
      P.sub(pivots[piece].position);
      lists[piece].push(new THREE.Matrix4().compose(P, q, s));
    }
    lists.forEach((list, piece) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      list.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      pivots[piece].add(mesh);
    });
  };
  return { amount, geometry, material, bead };
}
