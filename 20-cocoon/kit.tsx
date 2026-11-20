"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, type ComponentType } from "react";
import * as THREE from "three/webgpu";
import { color, mix, normalize, positionWorld, pow, smoothstep } from "three/tsl";
import { focusBlur, focusDistance } from "../shared/engine/Post";
import type { DayDefinition, Look, OverviewSection, SettingsSchema } from "../shared/engine/types";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What each version brings: index.tsx makes it a whole day.
export type View = { position: [number, number, number]; target: [number, number, number]; fov?: number };

export type Variant = {
  Scene: ComponentType;
  settings: SettingsSchema;
  // Where the eye starts.
  view: View;
  // The shared render stack, tuned for this version: applied on top of the day's look while it is out.
  look: Partial<Look>;
  // One line on what to do, shown under the version's name.
  hint?: string;
  // Shown in the middle of the screen until the version calls dismissPrompt.
  prompt?: { title: string; detail?: string; high?: boolean; low?: boolean };
  notes?: string;
  overview?: OverviewSection[];
  // Drawn over the canvas in screen space, inside the HUD: cards and captions that belong to the version.
  Overlay?: ComponentType;
  // The settings that get their own pills down the right of a phone.
  phonePills?: string[];
  // Where the eye starts on a phone held upright, if drawing back from the desktop view is not right for it.
  phoneView?: View;
  // Extra post passes this version needs, laid over the day's.
  passes?: DayDefinition["passes"];
  // The lowest tier Auto may settle on, for a version the lower tiers do not help.
  autoFloor?: DayDefinition["autoFloor"];
  // The most pixels per CSS pixel it draws at, for a version too heavy for a retina screen's full density.
  maxDpr?: DayDefinition["maxDpr"];
};

// The lens follows whatever the version says matters, by default the middle of the cocoon.
export const focus = { point: new THREE.Vector3(0, 0, 0), blur: 1 };

export function Focus() {
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    focusDistance.value = Math.max(0.3, camera.position.distanceTo(focus.point));
    focusBlur.value = focus.blur;
  });
  return null;
}

// The room every version floats in: a great sphere shaded from floor to sky, with no edges to find.
export function Backdrop({ top, horizon, bottom, radius = 60 }: { top: string; horizon: string; bottom: string; radius?: number }) {
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const up = (normalize(positionWorld) as any).y;
    m.colorNode = mix(mix(color(horizon), color(top), pow(smoothstep(-0.05, 0.9, up), 0.8)), color(bottom), smoothstep(0.05, -0.6, up));
    return m;
  }, [top, horizon, bottom]);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh material={material} renderOrder={-1} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[radius, 48, 24]} />
    </mesh>
  );
}

// The pointer as a ray into the scene every frame, whether or not anything is held: for things that answer a passing
// hand, such as fur stroked or a swarm parted. `active` is false while the pointer is off the canvas; `touch` says the
// last thing heard from was a finger, which has no hover; `moved` is when it last moved (performance.now()).
export function usePointerRay() {
  const camera = useThree((state) => state.camera);
  const dom = useThree((state) => state.gl.domElement);
  const state = useMemo(() => ({ ray: new THREE.Ray(), ndc: new THREE.Vector2(), active: false, down: false, touch: false, moved: 0, raycaster: new THREE.Raycaster() }), []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      state.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      state.active = true;
      state.touch = event.pointerType !== "mouse";
      state.moved = performance.now();
    };
    const leave = () => (state.active = false);
    const down = (event: PointerEvent) => {
      move(event);
      state.down = true;
    };
    const up = () => (state.down = false);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    dom.addEventListener("pointerleave", leave);
    return () => {
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      dom.removeEventListener("pointerleave", leave);
    };
  }, [dom, state]);

  useFrame(() => {
    state.raycaster.setFromCamera(state.ndc, camera);
    state.ray.copy(state.raycaster.ray);
  });
  return state;
}
