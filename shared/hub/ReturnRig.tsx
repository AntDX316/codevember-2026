"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { cameraTaken, orbitPoint } from "@/shared/engine/controls";
import { worldShifted } from "@/shared/engine/extents";
import { useSettingsStore } from "@/shared/engine/settings";
import { unwind } from "@/shared/engine/unwind";
import { sound } from "@/shared/engine/sound";
import type { DayDefinition } from "@/shared/engine/types";
import { damp, walking } from "@/shared/engine/walk";
import { recall, remember } from "./hub/state";
import { arrivalFov, KEEP_ON_RETURN, POSTER_SETTINGS, posterWiden } from "./posters";
import { cancelReturn, finishReturn, holdFrame, returnState, setReturnReady } from "./returning";

// Where a day's poster was taken from: its starting view (the phone's own on a narrow screen), zoomed out by `widen`.
function posterView(camera: DayDefinition["camera"], widen: number) {
  const narrow = window.matchMedia("(max-width: 720px)").matches;
  const view = narrow && camera.phone ? camera.phone : camera;
  const fov = view.fov ?? camera.fov ?? 36;
  const wide = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * widen));
  return { position: new THREE.Vector3(...view.position), target: new THREE.Vector3(...view.target), fov: wide };
}

// The way back from a day to the hub. Asked for by the calendar button, it puts the day back as its poster shows it, eases
// the camera to where the poster was taken from, holds a moment, and hands its last frame over to be faded into the hub.
// An endless world is periodic, so there it eases to whichever copy of that view is nearest.
export function ReturnRig({ slug, definition }: { slug: string; definition: DayDefinition }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl);
  const store = useSettingsStore();
  const router = useRouter();
  const run = useRef({ stage: "idle" as "idle" | "settle" | "move" | "hold" | "capture" | "done", at: 0, until: 0 });
  const springs = useMemo(
    () => ({
      position: new THREE.Vector3(),
      target: new THREE.Vector3(),
      positionVelocity: new THREE.Vector3(),
      targetVelocity: new THREE.Vector3(),
      direction: new THREE.Vector3(),
      // The fov rides on x, so it shares the spring.
      fov: new THREE.Vector3(),
      fovGoal: new THREE.Vector3(),
      fovVelocity: new THREE.Vector3(),
      goal: null as ReturnType<typeof posterView> | null
    }),
    []
  );

  useEffect(() => {
    setReturnReady(true);
    return () => setReturnReady(false);
  }, []);

  // An endless world carries everything back by whole periods now and then; the move is carried with it.
  useEffect(() => {
    const listener = (shift: THREE.Vector3) => {
      springs.position.add(shift);
      springs.target.add(shift);
      springs.goal?.position.add(shift);
      springs.goal?.target.add(shift);
    };
    worldShifted.add(listener);
    return () => {
      worldShifted.delete(listener);
    };
  }, [springs]);

  // Gone before the move was done, by leaving the day some other way: the day's HUD back, and the camera to its controls.
  useEffect(
    () => () => {
      const { stage } = run.current;
      if (stage === "idle" || stage === "settle") cancelReturn();
      else {
        cameraTaken.current = false;
        if (stage !== "capture" && stage !== "done") cancelReturn();
      }
    },
    []
  );

  useFrame((_, rawDelta) => {
    const r = run.current;
    const s = springs;
    const delta = Math.min(rawDelta, 1 / 20);
    const now = performance.now() / 1000;

    if (r.stage === "idle") {
      if (returnState().phase !== "settling") return;
      r.stage = "settle";
      r.at = now;
      document.documentElement.classList.add("cv-hub-leaving");
      const wanted = POSTER_SETTINGS[slug] ?? {};
      // A day that can put itself back in view does, while the camera moves, and the frame waits for it. One that
      // cannot is reset at once.
      const unwinding = unwind();
      r.until = now + (unwinding ?? 0);
      if (unwinding === null && !KEEP_ON_RETURN.has(slug)) store.trigger("reset");
      for (const [key, setting] of Object.entries(store.schema)) {
        if (setting.type === "action") continue;
        const value = key in wanted ? wanted[key] : setting.value;
        if (store.get(key) !== value) store.set(key, value);
      }
      sound.play("whoosh", { gain: 0.45, pitch: 0.8 });
      // The day's music dies away through the move back, instead of stopping short as the day goes.
      sound.fadeMusic(2.4);
    }

    if (r.stage === "settle") {
      // Walking hands the camera back by rising; wait for that, or it would take the camera back from under the move.
      const free = !walking.on && walking.amount < 0.02 && !cameraTaken.current;
      if (!free && now - r.at < 3.5) return;
      r.stage = "move";
      r.at = now;
      cameraTaken.current = true;
      s.position.copy(camera.position);
      camera.getWorldDirection(s.direction);
      const point = orbitPoint.current;
      const reach = point ? point.distanceTo(camera.position) : 0;
      if (point && reach > 0.05 && reach < 200) s.target.copy(point);
      else s.target.copy(camera.position).addScaledVector(s.direction, 8);
      s.positionVelocity.set(0, 0, 0);
      s.targetVelocity.set(0, 0, 0);
      s.fov.set(camera.fov, 0, 0);
      s.fovVelocity.set(0, 0, 0);
      const goal = posterView(definition.camera, posterWiden(slug));
      const period = definition.extents?.endless?.period;
      if (period) {
        const shift = new THREE.Vector3(Math.round((s.position.x - goal.position.x) / period) * period, 0, Math.round((s.position.z - goal.position.z) / period) * period);
        goal.position.add(shift);
        goal.target.add(shift);
      }
      // Coming back, framed as much of the poster as the hub will show on this screen; posing for one, as it is taken.
      if (!returnState().posing) goal.fov = arrivalFov(goal.fov, camera.aspect);
      s.goal = goal;
      s.fovGoal.set(goal.fov, 0, 0);
    }

    if ((r.stage === "move" || r.stage === "hold") && s.goal) {
      const goal = s.goal;
      damp(s.position, goal.position, s.positionVelocity, 0.6, delta);
      damp(s.target, goal.target, s.targetVelocity, 0.6, delta);
      damp(s.fov, s.fovGoal, s.fovVelocity, 0.6, delta);

      camera.position.copy(s.position);
      camera.lookAt(s.target);
      camera.fov = s.fov.x;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      orbitPoint.current?.copy(s.target);

      const there = s.position.distanceTo(goal.position) < 0.03 && s.target.distanceTo(goal.target) < 0.05 && Math.abs(s.fov.x - goal.fov) < 0.05;
      if (r.stage === "move" && (there || now - r.at > 3)) {
        r.stage = "hold";
        r.at = now;
      } else if (r.stage === "hold" && now - r.at > 0.35 && now >= r.until && !returnState().posing) r.stage = "capture";
    }
  }, 0.75);

  // After the frame is drawn, while it is still on the canvas: kept as a picture to fade from, and off to the hub.
  useFrame(() => {
    const r = run.current;
    if (r.stage !== "capture") return;
    r.stage = "done";
    const go = () => {
      const memory = recall();
      remember({ view: "3d", scroll: memory?.scroll ?? 0, anchor: memory?.anchor, from: slug, arriving: true });
      router.push("/");
    };
    // Copied now, in the frame it was drawn in: a WebGPU canvas is only readable until the frame is shown.
    const source = gl.domElement as HTMLCanvasElement;
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    const ctx = copy.getContext("2d");
    // A canvas with no size (a window minimised at this frame) cannot be copied: go back without the held frame.
    try {
      if (!ctx) throw new Error("No 2D context");
      ctx.drawImage(source, 0, 0);
      holdFrame(copy);
    } catch {
      finishReturn();
    }
    go();
  }, 3);

  return null;
}
