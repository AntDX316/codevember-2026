"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { sound } from "../../shared/engine/sound";
import type { QualityTier } from "../../shared/engine/types";
import { Backdrop, focus, usePointerRay, type Variant } from "../kit";
import { eggGeometry, liftShell, sowStrands } from "./egg";
import { FurField } from "./field";
import { Motes } from "./motes";
import { FIBRES, furUniforms, skinMaterial, strandMaterial } from "./shade";

// A cocoon grown over with soft fibres, a hundred and thirty thousand of them on the high tier, each its own tapered
// strand. Which way they lie is kept in a small picture over the egg, so a stroke of the hand stays where it was made,
// and the sheen turns over wherever the nap does.

const BASE_LENGTH = 0.16;
const SHELL_AROUND = 48;
const SHELL_ROWS = 32;
// How far above the skin the hand meets the fur, as a share of a strand's length.
const SHELL_LIFT = 0.42;

const TIERS: Record<QualityTier, { count: number; segments: number }> = {
  low: { count: 36000, segments: 3 },
  medium: { count: 80000, segments: 4 },
  high: { count: 130000, segments: 4 }
};

// Dust in the air about it, and how much of it each tier can afford.
const MOTES: Record<QualityTier, number> = { low: 160, medium: 320, high: 520 };

// The lights, as seen from the camera: a key from the left and a little above, a faint fill low on the right, and a
// rim behind on the right that edges the shadowed side.
const KEY_VIEW = new THREE.Vector3(-0.85, 0.5, 0.32).normalize();
const FILL_VIEW = new THREE.Vector3(0.8, -0.25, 0.4).normalize();
const RIM_VIEW = new THREE.Vector3(0.7, 0.35, -0.75).normalize();

// One strand: a ribbon from root (y = 0) to tip (y = 1), from x = -1 to 1 across, bent and turned in the shader.
function strandGeometry(segments: number, sown: ReturnType<typeof sowStrands>) {
  const position: number[] = [];
  const index: number[] = [];
  for (let s = 0; s <= segments; s++) position.push(-1, s / segments, 0, 1, s / segments, 0);
  for (let s = 0; s < segments; s++) {
    const a = s * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.setAttribute("aRoot", new THREE.InstancedBufferAttribute(sown.root, 4));
  geometry.setAttribute("aFacing", new THREE.InstancedBufferAttribute(sown.facing, 4));
  geometry.setAttribute("aPlace", new THREE.InstancedBufferAttribute(sown.place, 4));
  geometry.instanceCount = sown.made;
  return geometry;
}

const linear = (hex: string) => new THREE.Color(hex);
const PALETTES = Object.fromEntries(
  Object.entries(FIBRES).map(([name, f]) => [name, { root: linear(f.root), body: linear(f.body), tip: linear(f.tip), shine: linear(f.shine), gloss: f.gloss }])
);

function Scene() {
  const { tier } = useQuality();
  const camera = useThree((state) => state.camera);
  const fibre = useSettingRef<string>("furFibre");
  const length = useSettingRef<number>("furLength");
  const pointer = usePointerRay();

  const field = useMemo(() => new FurField(), []);
  const uniforms = useMemo(() => {
    const u = furUniforms();
    const start = PALETTES[fibre.current] ?? PALETTES.mohair;
    u.root.value.copy(start.root);
    u.body.value.copy(start.body);
    u.tip.value.copy(start.tip);
    u.shine.value.copy(start.shine);
    u.gloss.value = start.gloss;
    u.length.value = BASE_LENGTH * length.current;
    return u;
  }, [fibre, length]);

  const strands = useMemo(() => {
    const { count, segments } = TIERS[tier];
    const sown = sowStrands(count);
    const geometry = strandGeometry(segments, sown);
    // Fewer strands are made wider, so the coat stays as full on every tier.
    const material = strandMaterial(uniforms, field.leanTexture, field.wobbleTexture, 0.0014 * Math.sqrt(TIERS.high.count / count));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    // Drawn after the skin, so strands on the far side are hidden before they are shaded.
    mesh.renderOrder = 1;
    mesh.raycast = () => {};
    return mesh;
  }, [tier, uniforms, field]);

  const skin = useMemo(() => {
    const mesh = new THREE.Mesh(eggGeometry(160, 110), skinMaterial(uniforms, field.leanTexture));
    mesh.raycast = () => {};
    return mesh;
  }, [uniforms, field]);

  // The egg the hand is tested against: unseen, at about the height of the fur's tips.
  const shell = useMemo(() => {
    const geometry = eggGeometry(SHELL_AROUND, SHELL_ROWS, BASE_LENGTH * SHELL_LIFT);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld();
    return { mesh, lift: BASE_LENGTH * SHELL_LIFT, raycaster: new THREE.Raycaster(), hits: [] as THREE.Intersection[] };
  }, []);

  useDispose(strands.geometry, strands.material as THREE.Material, skin.geometry, skin.material as THREE.Material, shell.mesh.geometry, shell.mesh.material as THREE.Material, field);

  const state = useMemo(
    () => ({
      held: false,
      last: new THREE.Vector3(),
      hasLast: false,
      hit: new THREE.Vector3(),
      ndc: new THREE.Vector2(),
      combSound: 0
    }),
    []
  );

  const cast = (ray: THREE.Ray) => {
    shell.raycaster.ray.copy(ray);
    shell.hits.length = 0;
    shell.mesh.raycast(shell.raycaster, shell.hits);
    if (!shell.hits.length) return null;
    let best = shell.hits[0];
    for (const hit of shell.hits) if (hit.distance < best.distance) best = hit;
    return best;
  };

  // Pressing on the fur holds the pointer there, so dragging brushes rather than turning the camera.
  useGrabbable({
    pick: (ray) => {
      const hit = cast(ray);
      return hit ? { distance: hit.distance, point: hit.point } : null;
    },
    grab: () => {
      state.held = true;
      state.hasLast = false;
      dismissPrompt();
      sound.play("brush", { gain: 0.35, pitch: 1.1, size: 0.3 });
    },
    drag: () => {},
    release: () => {
      state.held = false;
      state.hasLast = false;
    }
  });

  useSettingAction("furComb", () => {
    field.combAll();
    sound.play("whoosh", { gain: 0.35, pitch: 0.7 });
  });

  useFrame(({ clock }, rawDelta) => {
    const dt = Math.min(rawDelta, 1 / 20);
    const ease = (rate: number) => 1 - Math.exp(-dt * rate);

    // The fibre and its length, eased in.
    const palette = PALETTES[fibre.current] ?? PALETTES.mohair;
    const k = ease(4);
    uniforms.root.value.lerp(palette.root, k);
    uniforms.body.value.lerp(palette.body, k);
    uniforms.tip.value.lerp(palette.tip, k);
    uniforms.shine.value.lerp(palette.shine, k);
    uniforms.gloss.value += (palette.gloss - uniforms.gloss.value) * k;
    uniforms.length.value += (BASE_LENGTH * length.current - uniforms.length.value) * ease(5);
    const lift = uniforms.length.value * SHELL_LIFT;
    if (Math.abs(lift - shell.lift) > 0.003) {
      shell.lift = lift;
      liftShell(shell.mesh.geometry, SHELL_AROUND, SHELL_ROWS, lift);
    }
    // A slow breath, about one every seven seconds.
    uniforms.breath.value = Math.sin(clock.elapsedTime * 0.9);

    uniforms.key.value.copy(KEY_VIEW).applyQuaternion(camera.quaternion);
    uniforms.fill.value.copy(FILL_VIEW).applyQuaternion(camera.quaternion);
    uniforms.rim.value.copy(RIM_VIEW).applyQuaternion(camera.quaternion);

    // The hand. Held, it lays the fur down where it goes; passing over without a press, it only ruffles the tips. A
    // press that is turning the camera does neither.
    const moved = !state.ndc.equals(pointer.ndc);
    state.ndc.copy(pointer.ndc);
    const hit = pointer.active ? cast(pointer.ray) : null;
    const touching = !!hit && (state.held || !pointer.down);
    if (hit && touching) {
      state.hit.copy(hit.point);
      const firm = state.held ? 1 : moved ? 0.3 : 0;
      if (state.hasLast && firm > 0) {
        const step = state.last.distanceTo(state.hit);
        if (step < 0.5) {
          field.stroke(state.last, state.hit, state.held ? 0.2 : 0.14, firm, dt);
          const speed = step / Math.max(dt, 1 / 240);
          if (speed > 0.15) {
            sound.play("brush", {
              gain: Math.min(1.1, (speed - 0.1) * 0.45) * (state.held ? 1 : 0.45),
              pitch: 0.75 + Math.min(speed, 3) * 0.1 + Math.random() * 0.06,
              pan: Math.max(-0.8, Math.min(0.8, pointer.ndc.x * 0.7)),
              size: 0.3 + Math.min(speed, 3) * 0.1,
              gap: 0.085
            });
          }
        }
      }
      state.last.copy(state.hit);
      state.hasLast = true;
      uniforms.hand.value.lerp(state.hit, uniforms.press.value < 0.02 ? 1 : ease(30));
    } else {
      state.hasLast = false;
    }
    uniforms.press.value += ((touching ? (state.held ? 1 : 0.45) : 0) - uniforms.press.value) * ease(state.held ? 12 : 6);

    // The comb's teeth, heard as they go.
    if (field.combing) {
      state.combSound -= dt;
      if (state.combSound <= 0) {
        state.combSound = 0.11;
        sound.play("brush", { gain: 0.55, pitch: 0.8 + Math.random() * 0.15, size: 0.4 });
      }
    }
    field.update(dt);

    // The lens rests on the near side of the cocoon, wherever it is seen from.
    focus.point.copy(camera.position).normalize().multiplyScalar(0.7);
    focus.blur = 0.7;
  });

  return (
    <>
      <Backdrop top="#120f0d" horizon="#0a0807" bottom="#030303" />
      <primitive object={skin} />
      <primitive object={strands} />
      <Motes count={MOTES[tier]} keyLight={uniforms.key} />
    </>
  );
}

const fur: Variant = {
  Scene,
  settings: {
    furFibre: {
      type: "choice",
      label: "Fibre",
      options: [
        { value: "mohair", label: "Mohair cream", short: "Mohair", swatch: [FIBRES.mohair.tip, FIBRES.mohair.body, FIBRES.mohair.root] },
        { value: "sable", label: "Sable brown", short: "Sable", swatch: [FIBRES.sable.tip, FIBRES.sable.body, FIBRES.sable.root] },
        { value: "silver", label: "Silver fox", short: "Silver", swatch: [FIBRES.silver.body, FIBRES.silver.tip, FIBRES.silver.root] },
        { value: "coral", label: "Dyed coral", short: "Coral", swatch: [FIBRES.coral.tip, FIBRES.coral.body, FIBRES.coral.root] }
      ],
      value: "mohair"
    },
    furLength: { type: "range", label: "Length", min: 0.5, max: 1.8, step: 0.05, value: 1, reset: 1 },
    furComb: { type: "action", label: "Comb smooth" }
  },
  view: { position: [0.6, 0.45, 5.3], target: [0, 0, 0], fov: 36 },
  look: { background: "#070605", exposure: 1, bloom: 0.18, bloomThreshold: 1.0, ao: 0.3, aoRadius: 0.15, vignette: 0.45, grain: 0.02 },
  hint: "Press and drag across the fur to brush it; the strokes stay. Hover to ruffle the tips. Drag the dark around it to turn.",
  notes:
    "A cocoon in fur: up to a hundred and thirty thousand tapered strands, each bent toward the way the nap lies in a small picture over the egg. Brushing rewrites that picture, so the marks stay and the sheen turns over where the nap does.",
  overview: [
    {
      title: "Fur",
      points: [
        "Every strand is a ribbon of a few segments, turned to the eye and curved from its root toward the nap, with springs, a breeze and the hand bending its tip.",
        "Lit as hair rather than as a surface: two highlights along the fibres, a white one and a coloured one, darkening toward the roots, and a rim light glowing through the tips.",
        "Which way the fur lies is a world direction per texel over the egg; brushing against the grain passes it through zero, so the strands stand on end mid-stroke."
      ]
    }
  ]
};

export default fur;
