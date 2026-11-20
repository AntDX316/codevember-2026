"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { cameraPosition, color, dot, exp, float, length, max, mix, normalize, output, positionWorld, pow, reflector, smoothstep, uniform, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { END_RADIUS, RING_TUBE, WAIST_RADIUS, type Loom } from "./sim";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

export const FLOOR_Y = -1.62;
export const BACKGROUND = "#07070a";

// The three rings, polished brass, each with a bead where every string is tied on. The beads ride in the ring's own
// frame, so turning the ring turns them with it for nothing.
export function Rings({ loom, beads, hover }: { loom: Loom; beads: boolean; hover: { ring: number; glow: number[] } }) {
  const groups = useRef<(THREE.Group | null)[]>([]);

  const { brass, beadMaterial, torus, bead, glows } = useMemo(() => {
    const glows = [uniform(0), uniform(0), uniform(0)];
    const brass = glows.map((glow) => {
      const m = new THREE.MeshPhysicalNodeMaterial({ color: "#c79a52", metalness: 1, roughness: 0.17, clearcoat: 0.35, clearcoatRoughness: 0.08 });
      // A warm breath of light while the hand is over it, so it reads as something to take hold of.
      m.emissiveNode = color("#ffb75e").mul(glow.mul(0.12)) as any;
      return m;
    });
    const beadMaterial = new THREE.MeshPhysicalNodeMaterial({ color: "#dcb46e", metalness: 1, roughness: 0.24 });
    const torus = [END_RADIUS, WAIST_RADIUS, END_RADIUS].map((r, i) => new THREE.TorusGeometry(r, RING_TUBE[i], 20, 160).rotateX(Math.PI / 2));
    const bead = new THREE.SphereGeometry(1, 10, 8);
    return { brass, beadMaterial, torus, bead, glows };
  }, []);
  useDispose(...brass, beadMaterial, ...torus, bead);

  const pins = useMemo(() => {
    if (!beads) return [];
    return [0, 1, 2].map((ring) => {
      const mesh = new THREE.InstancedMesh(bead, beadMaterial, loom.count);
      const m = new THREE.Matrix4();
      const r = loom.radius(ring);
      // As big as the ring will take without the beads running into one another.
      const size = Math.min(RING_TUBE[ring] * 0.55, ((Math.PI * 2 * r) / loom.count) * 0.4);
      for (let i = 0; i < loom.count; i++) {
        const a = (i / loom.count) * Math.PI * 2;
        // Set on the inner face of the ring, where the string leaves it.
        m.makeScale(size, size, size).setPosition((r - RING_TUBE[ring] * 0.55) * Math.cos(a), 0, (r - RING_TUBE[ring] * 0.55) * Math.sin(a));
        mesh.setMatrixAt(i, m);
      }
      mesh.castShadow = false;
      mesh.raycast = () => null;
      return mesh;
    });
  }, [beads, bead, beadMaterial, loom]);
  useDispose(...pins);

  useFrame((_, delta) => {
    loom.rings.forEach((ring, i) => {
      const g = groups.current[i];
      if (g) {
        // Three turns a point at +x toward -z for a positive y rotation; the loom measures angles toward +z.
        g.rotation.y = -ring.angle;
        g.position.y = loom.height(i);
      }
      const want = hover.ring === i || ring.held ? (ring.held ? 1.6 : 1) : 0;
      hover.glow[i] += (want - hover.glow[i]) * (1 - Math.exp(-delta * 10));
      glows[i].value = hover.glow[i];
    });
  });

  return (
    <>
      {[0, 1, 2].map((i) => (
        <group key={i} ref={(g) => void (groups.current[i] = g)}>
          <mesh geometry={torus[i]} material={brass[i]} castShadow receiveShadow raycast={() => null} />
          {pins[i] ? <primitive object={pins[i]} /> : null}
        </group>
      ))}
    </>
  );
}

// A floor of black lacquer: the strings and rings mirrored in it, a little soft, strongest at a slant; a faint pool of
// their light on it beneath; and fading into the dark all round so the set has no edge.
export function Floor({ tint, energy, mirrorScale }: { tint: THREE.Color; energy: { value: number }; mirrorScale: number }) {
  const { mesh, material, mirror, pool, poolColour } = useMemo(() => {
    const pool = uniform(0);
    const poolColour = uniform(new THREE.Color());
    const material = new THREE.MeshStandardNodeMaterial({ color: "#060609", roughness: 0.3, metalness: 0 });
    const mirror = reflector({ resolutionScale: mirrorScale, generateMipmaps: true, bounces: false }) as any;
    mirror.target.rotateX(-Math.PI / 2);
    mirror.target.position.y = FLOOR_Y;
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const slant = pow(float(1).sub(max(dot(V, vec3(0, 1, 0)), 0)), 3).mul(0.55).add(0.22) as any;
    const d = length(positionWorld.xz) as any;
    const near = smoothstep(7.5, 2.5, d) as any;
    const seen = mirror.level(1.4).rgb.mul(slant).mul(near) as any;
    const glow = poolColour.mul(exp(d.mul(d).mul(-0.9))).mul(pool) as any;
    material.emissiveNode = seen.add(glow) as any;
    // Fading the lit result, not opacity, keeps the floor in the depth and shadow passes.
    material.outputNode = mix(output, vec4(color(BACKGROUND), 1), smoothstep(5, 13, d)) as any;
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(40, 96).rotateX(-Math.PI / 2), material);
    mesh.position.y = FLOOR_Y;
    mesh.receiveShadow = true;
    mesh.raycast = () => null;
    return { mesh, material, mirror, pool, poolColour };
  }, [mirrorScale]);
  useDispose(material, mesh.geometry, mirror);

  useFrame(() => {
    poolColour.value.copy(tint);
    pool.value = 0.025 + Math.min(0.3, energy.value * 0.0025);
  });

  return (
    <>
      <primitive object={mesh} />
      <primitive object={mirror.target} />
    </>
  );
}
