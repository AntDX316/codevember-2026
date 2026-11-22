// The screen as a window into the water, for Head Tracking. The eye is moved with the viewer's head, and the view is
// sheared (an off-axis frustum) so a pane of glass at the orbit point stays fixed on screen: what lies nearer swings
// against the head, what lies beyond slides with it, as through a real window. Moving in widens the view.
//
// Applied just before the frame is drawn and taken off just after, so the orbit, the hover and the day's own frame loop
// never see it, and nothing else is changed. The shear is added after three works out the projection (and after the
// temporal filter's jitter), by wrapping this camera's updateProjectionMatrix while Kelp is mounted.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, type RefObject } from "react";
import * as THREE from "three/webgpu";
import { orbitPoint } from "../shared/engine/controls";
import type { Head } from "./head";
import { SURFACE } from "./water";

// The glass is at the orbit point, at least this near and at most this far.
const NEAR_PANE = 2;
const FAR_PANE = 8;
// How far the eye may move from where it was, as a share of the distance to the glass: across, and in or out (less, so
// leaning in never carries the eye into the kelp).
const REACH = 0.4;
const REACH_IN = 0.2;
// Leaning in or out moves the eye at this share of the geometry's own, past a small still zone (metres of head travel):
// distance is read from the few pixels between the eyes, so it is the noisiest axis, and a wobble in it pumps the view.
const LEAN = 0.5;
const LEAN_STILL = 0.02;
// How quickly the eye follows the head (seconds), and eases home when the face is lost: a critically damped spring, so
// the tracker's 30 steps a second blend into one glide with no overshoot.
const FOLLOW = 0.16;
const HOME = 0.7;

// One axis of a critically damped spring toward target over about `time` seconds (the closed form, steady at any dt).
function glide(at: { x: number; v: number }, target: number, time: number, dt: number) {
  const omega = 2 / time;
  const w = omega * dt;
  const decay = 1 / (1 + w + 0.48 * w * w + 0.235 * w * w * w);
  const change = at.x - target;
  const pull = (at.v + omega * change) * dt;
  at.v = (at.v - omega * pull) * decay;
  at.x = target + (change + pull) * decay;
}

export function usePeer(head: RefObject<Head | null>) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const s = useMemo(
    () => ({
      x: 0,
      y: 0,
      z: 0,
      glide: [
        { x: 0, v: 0 },
        { x: 0, v: 0 },
        { x: 0, v: 0 }
      ],
      moved: new THREE.Vector3(),
      shear: { on: false, x: 0, y: 0, zoom: 1 },
      axis: new THREE.Vector3()
    }),
    []
  );
  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __kelpPeer: s });

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera & { updateProjectionMatrix: () => void };
    const own = Object.prototype.hasOwnProperty.call(cam, "updateProjectionMatrix");
    const base = cam.updateProjectionMatrix;
    const shear = s.shear;
    cam.updateProjectionMatrix = function () {
      base.call(this);
      if (!shear.on) return;
      const e = this.projectionMatrix.elements;
      // Elements 8 and 9 are (right + left) / (right - left) and the same for top and bottom: the frustum's shift.
      e[8] -= e[0] * shear.x;
      e[9] -= e[5] * shear.y;
      e[0] *= shear.zoom;
      e[5] *= shear.zoom;
      this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    };
    return () => {
      if (own) cam.updateProjectionMatrix = base;
      else delete (cam as { updateProjectionMatrix?: unknown }).updateProjectionMatrix;
      cam.updateProjectionMatrix();
    };
  }, [camera, s]);

  // On: after every system has placed the eye (the orbit, the hover, the day), before the frame is drawn (priority 1).
  useFrame((_, raw) => {
    const dt = Math.min(raw, 0.1);
    const h = head.current;
    const seen = !!h?.seen;
    const pane = THREE.MathUtils.clamp(camera.position.distanceTo(orbitPoint.current ?? s.axis.set(0, 0, 0)), NEAR_PANE, FAR_PANE);
    // A head's metres to the scene's: the viewer's own distance from the screen maps to the glass's from the eye.
    const metres = seen && h ? pane / Math.max(0.25, h.stats.distance - h.offset.z) : 0;
    const limit = pane * REACH;
    const want =
      seen && h
        ? [
            THREE.MathUtils.clamp(h.offset.x * metres, -limit, limit),
            THREE.MathUtils.clamp(h.offset.y * metres, -limit, limit),
            THREE.MathUtils.clamp(Math.sign(h.offset.z) * Math.max(0, Math.abs(h.offset.z) - LEAN_STILL) * metres * LEAN, -pane * REACH_IN, pane * REACH_IN)
          ]
        : [0, 0, 0];
    for (let i = 0; i < 3; i++) glide(s.glide[i], want[i], seen ? FOLLOW : HOME, dt);
    s.x = s.glide[0].x;
    s.y = s.glide[1].x;
    s.z = s.glide[2].x;
    if (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z) < 1e-4) return;

    // Along the eye's own right, up and back.
    s.moved.set(0, 0, 0);
    s.moved.add(s.axis.set(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(s.x));
    s.moved.add(s.axis.set(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(s.y));
    s.moved.add(s.axis.set(0, 0, 1).applyQuaternion(camera.quaternion).multiplyScalar(s.z));
    // Never out of the water or into the floor.
    const y = camera.position.y + s.moved.y;
    s.moved.y = THREE.MathUtils.clamp(y, 0.35, SURFACE - 0.4) - camera.position.y;
    camera.position.add(s.moved);
    camera.updateMatrixWorld();
    s.shear.on = true;
    s.shear.x = s.x / pane;
    s.shear.y = s.y / pane;
    s.shear.zoom = (pane + s.z) / pane;
    camera.updateProjectionMatrix();
    // Dev only: where the orbit point lands on screen as drawn, which the shear should hold still.
    if (process.env.NODE_ENV !== "production" && orbitPoint.current) Object.assign(s, { pinned: orbitPoint.current.clone().project(camera).toArray() });
  }, 0.9);

  // Off: once the frame is drawn.
  useFrame(() => {
    if (!s.shear.on) return;
    s.shear.on = false;
    camera.position.sub(s.moved);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  }, 1.5);
}
