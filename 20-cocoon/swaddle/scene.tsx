"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { color, dot, float, normalView, positionViewDirection, pow, uniform, uv } from "three/tsl";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSettingAction, useSettingRef, useSetting } from "../../shared/engine/settings";
import { sound } from "../../shared/engine/sound";
import { useDispose } from "../../shared/engine/dispose";
import { KeyLight, StudioEnvironment, StudioFloor } from "../../shared/engine/studio";
import { Backdrop, focus } from "../kit";
import { Cloth, FLOOR_Y, PHYSICS } from "./cloth";
import { createFabric, createFabricUniforms, type FabricName } from "./fabric";
import { KEY, Motes } from "./motes";

export const ROOM = { top: "#0e0d0f", horizon: "#0b0a0a", bottom: "#090808" };

export const COLOURS: Record<string, string> = {
  ivory: "#e2d8c8",
  blush: "#c9988c",
  sage: "#8c9c88",
  dusk: "#4f5d78",
  oxblood: "#6a2229",
  saffron: "#c08a3a",
  ink: "#24262c"
};

// Each fabric's voice: satin hisses high, velvet is a low hush, chiffon a whisper.
const VOICE: Record<FabricName, number> = { satin: 1.25, velvet: 0.7, linen: 1, chiffon: 1.45 };

// Where the unwrap carries the sheet's two top corners: up and out behind the body, so it hangs there like a curtain.
const CORNERS = [new THREE.Vector3(-1.4, 1.72, -1.15), new THREE.Vector3(1.4, 1.72, -1.15)];

const FABRICS: FabricName[] = ["satin", "velvet", "linen", "chiffon"];

type Mode = "wrapped" | "unwrapping" | "open" | "rewrapping";

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function Swaddle() {
  const { tier } = useQuality();
  // The grid is set by the tier the visit starts on, so a later step down does not rebuild the cloth mid-pull.
  const startTier = useRef(tier).current;
  const fabric = useSetting<FabricName>("swaddleFabric");
  const colourKey = useSetting<string>("swaddleColour");
  const breathing = useSettingRef<boolean>("swaddleBreathing");

  const cloth = useMemo(() => {
    const [cols, rows, substeps] = startTier === "high" ? [96, 54, 4] : startTier === "medium" ? [80, 45, 4] : [56, 32, 3];
    const c = new Cloth(cols, rows);
    c.substeps = substeps;
    // A couple of seconds settled before it is first seen, so it never arrives taut and smooth.
    c.setFabric(PHYSICS.satin);
    for (let f = 0; f < 60; f++) c.step(1 / 60);
    return c;
  }, [startTier]);

  const geometry = useMemo(() => {
    const { cols, rows, count } = cloth;
    const g = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    position.setUsage(THREE.DynamicDrawUsage);
    const normal = new THREE.BufferAttribute(cloth.normal, 3);
    normal.setUsage(THREE.DynamicDrawUsage);
    const uvs = new Float32Array(count * 2);
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        uvs[(j * cols + i) * 2] = i / (cols - 1);
        uvs[(j * cols + i) * 2 + 1] = j / (rows - 1);
      }
    const index: number[] = [];
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        // Wound so the outside of the wrap is the front face, whichever way the grid's normals came out.
        if (cloth.flip > 0) index.push(a, b, c, b, d, c);
        else index.push(a, c, b, b, c, d);
      }
    g.setIndex(index);
    g.setAttribute("position", position);
    g.setAttribute("normal", normal);
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    return g;
  }, [cloth]);
  useDispose(geometry);

  const uniforms = useMemo(() => createFabricUniforms(), []);
  // Every fabric's two faces made at mount and compiled behind the loader, so changing fabric is a swap, not a stall.
  const library = useMemo(
    () =>
      Object.fromEntries(FABRICS.map((name) => [name, { outside: createFabric(name, uniforms, false), inside: createFabric(name, uniforms, true) }])) as unknown as Record<
        FabricName,
        { outside: THREE.Material; inside: THREE.Material }
      >,
    [uniforms]
  );
  useDispose(...FABRICS.flatMap((name) => [library[name].outside, library[name].inside]));
  const materials = library[fabric] ?? library.satin;
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const group = new THREE.Group();
    FABRICS.forEach((name) => {
      group.add(new THREE.Mesh(geometry, library[name].outside));
      group.add(new THREE.Mesh(geometry, library[name].inside));
    });
    gl.compileAsync?.(group, camera, scene).catch(() => {});
  }, [gl, camera, scene, geometry, library]);
  const sheer = fabric === "chiffon";

  // A new fabric moves as itself from the next step: weight, drape, grip and how much it gathers.
  useEffect(() => {
    cloth.setFabric(PHYSICS[fabric] ?? PHYSICS.satin);
  }, [cloth, fabric]);
  useEffect(() => {
    uniforms.colour.value.set(COLOURS[colourKey] ?? COLOURS.ivory);
  }, [uniforms, colourKey]);

  // The body's own warm light: a soft glowing heart, and a small lamp that lights the inside of the cloth (reaching no
  // further, so it does not shine through the cloth onto the floor).
  const heart = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const face = pow(dot(normalView, positionViewDirection).clamp(0, 1), 2.2) as any;
    m.colorNode = color("#ffb46b").mul(uniforms.glowLevel).mul(face).mul(3.2) as any;
    return m;
  }, [uniforms]);
  useDispose(heart);
  const lamp = useRef<THREE.PointLight>(null);

  // A soft dark pool on the floor under the body, darker the closer the cloth hangs to it.
  const pool = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const r = uv().sub(0.5).length().mul(2) as any;
    const strength = uniform(0.55) as any;
    m.colorNode = color("#000000");
    m.opacityNode = pow(float(1).sub(r).clamp(0, 1), 2.2).mul(strength) as any;
    return { material: m, strength };
  }, []);
  useDispose(pool.material);

  // The state of the wrap, and the clocks it runs on.
  const state = useMemo(
    () => ({
      mode: "wrapped" as Mode,
      t: 0,
      // Seconds since the cloth was last let go, for the cinch that follows.
      sinceRelease: 99,
      breath: 0,
      breathAmount: 0,
      clock: 0,
      pinFrom: [new THREE.Vector3(), new THREE.Vector3()],
      // Each pinned particle's corner and where it sits from that corner, held as it was taken.
      pinCorner: [] as number[],
      pinOffset: [] as number[],
      folded: false,
      lastDrag: new THREE.Vector3(),
      dragSpeed: 0,
      grabbed: -1
    }),
    []
  );

  useEffect(() => {
    focus.blur = 0.7;
  }, []);

  useSettingAction("swaddleWrap", () => {
    if (state.mode === "wrapped" || state.mode === "rewrapping") {
      state.mode = "unwrapping";
      state.t = 0;
      // Each corner is taken up by a small patch, as a hand would hold it, not a single thread that would stretch.
      const top = cloth.rows - 1;
      state.pinCorner.length = state.pinOffset.length = 0;
      cloth.pins = [];
      [0, cloth.cols - 1].forEach((column, n) => {
        const corner = cloth.index(column, top);
        state.pinFrom[n].fromArray(cloth.pos, corner * 3);
        for (let j = 0; j < 4; j++)
          for (let i = 0; i < 6; i++) {
            const index = cloth.index(column + (n === 0 ? i : -i), top - j);
            state.pinCorner.push(n);
            state.pinOffset.push(cloth.pos[index * 3] - state.pinFrom[n].x, cloth.pos[index * 3 + 1] - state.pinFrom[n].y, cloth.pos[index * 3 + 2] - state.pinFrom[n].z);
            cloth.pins.push({ index, x: cloth.pos[index * 3], y: cloth.pos[index * 3 + 1], z: cloth.pos[index * 3 + 2] });
          }
      });
      sound.play("whoosh", { gain: 0.35, pitch: 0.8 });
      sound.play("peel", { variant: "silk", gain: 0.35 });
    } else {
      state.mode = "rewrapping";
      state.t = 0;
      state.folded = false;
      cloth.pins = [];
      sound.play("whoosh", { gain: 0.3, pitch: 1.1 });
    }
  });

  const hit = useMemo(() => new THREE.Vector3(), []);
  useGrabbable({
    pick: (ray) => {
      const index = cloth.pick(ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, 0.075);
      if (index < 0) return null;
      state.grabbed = index;
      hit.fromArray(cloth.pos, index * 3);
      return { distance: ray.origin.distanceTo(hit), point: hit.clone() };
    },
    grab: (point) => {
      if (state.grabbed < 0) return;
      cloth.grab(state.grabbed, 0.17);
      state.lastDrag.copy(point);
      state.dragSpeed = 0;
      dismissPrompt();
      sound.play("brush", { gain: 0.35, pitch: VOICE[fabric] });
    },
    drag: (point) => {
      // Held within reach of the body and above the floor, so the cloth cannot be dragged away across the room.
      const reach = 2.4;
      if (point.length() > reach) point.setLength(reach);
      point.y = Math.max(point.y, FLOOR_Y + 0.05);
      state.dragSpeed += point.distanceTo(state.lastDrag);
      state.lastDrag.copy(point);
      cloth.heldTarget[0] = point.x;
      cloth.heldTarget[1] = point.y;
      cloth.heldTarget[2] = point.z;
    },
    release: () => {
      if (!cloth.holding) return;
      // How far the pinch was from where it belongs sets how big a fold it falls back with.
      const k = state.grabbed * 3;
      const off = Math.hypot(cloth.pos[k], cloth.pos[k + 1], cloth.pos[k + 2]);
      cloth.release();
      state.grabbed = -1;
      state.sinceRelease = 0;
      sound.play("fold", { gain: 0.25 + Math.min(0.45, Math.max(0, off - 0.7) * 0.4), pitch: VOICE[fabric] * 0.9, size: 0.4 });
    }
  });

  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 30);
    state.clock += delta;
    state.t += delta;
    state.sinceRelease += delta;

    // Breathing: a slow rise and a slower fall, about one every five seconds, eased in and out when switched.
    state.breathAmount += ((breathing.current ? 1 : 0) - state.breathAmount) * (1 - Math.exp(-delta * 1.5));
    const phase = (state.clock / 5.2) * Math.PI * 2;
    const wave = Math.sin(phase) * 0.7 + Math.sin(phase * 2 - 1.2) * 0.15;
    state.breath = wave * state.breathAmount;
    cloth.breath = 1 + state.breath * 0.03;

    // How firmly the cloth is drawn to the body: steady while wrapped, eased off under the hand, a firmer cinch for a
    // couple of seconds after it is let go, none while unwrapped, and a swoop back on the rewrap. Set per step, so it is
    // scaled to however many steps the tier runs a frame.
    const perStep = 4 / cloth.substeps;
    let normal = 0;
    let across = 0;
    if (state.mode === "wrapped") {
      const cinch = Math.exp(-state.sinceRelease / 1.4);
      normal = 0.02 + 0.012 * cinch;
      across = 0.006 + 0.008 * cinch;
      if (cloth.holding) {
        normal *= 0.35;
        across *= 0.15;
      }
      cloth.solid = 1;
    } else if (state.mode === "unwrapping" || state.mode === "open") {
      // The corners rise in an arc to where they hang, while the body lets the cloth pass through it, then firms again
      // once the cloth has fallen clear, so the curtain can be pushed against it.
      const e = smooth(0, 1.7, state.t);
      cloth.pins.forEach((pin, p) => {
        const n = state.pinCorner[p];
        const to = CORNERS[n];
        const from = state.pinFrom[n];
        const sway = state.mode === "open" ? Math.sin(state.clock * 0.7 + n * 2) * 0.03 : 0;
        pin.x = THREE.MathUtils.lerp(from.x, to.x, e) + sway + state.pinOffset[p * 3];
        pin.y = THREE.MathUtils.lerp(from.y, to.y, e) + Math.sin(Math.PI * e) * 0.5 + state.pinOffset[p * 3 + 1];
        pin.z = THREE.MathUtils.lerp(from.z, to.z, e) + sway * 0.5 + state.pinOffset[p * 3 + 2];
      });
      cloth.solid = state.t < 2.4 ? 1 - smooth(0, 0.35, state.t) : smooth(2.4, 3.6, state.t);
      if (state.mode === "unwrapping" && state.t > 1.7) state.mode = "open";
    } else {
      const k = smooth(0, 1.4, state.t);
      normal = 0.016 * k;
      across = 0.012 * k;
      cloth.solid = smooth(1.1, 2, state.t);
      if (!state.folded && state.t > 1.1) {
        state.folded = true;
        sound.play("fold", { gain: 0.5, pitch: VOICE[fabric] * 0.85, size: 0.6 });
      }
      if (state.t > 2.4) {
        state.mode = "wrapped";
        state.sinceRelease = 0;
      }
    }
    // Hung from two corners, the sheet's weight runs down its whole length, and one pass a step lets it stretch: two
    // hold it, where the tier can spare them.
    cloth.iterations = state.mode !== "wrapped" && startTier !== "low" ? 2 : 1;
    cloth.pullNormal = normal * perStep;
    cloth.pullAcross = across * perStep;

    cloth.step(delta);

    const position = geometry.attributes.position as THREE.BufferAttribute;
    (position.array as Float32Array).set(cloth.pos);
    position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;

    // The light inside swells a little on each breath in.
    uniforms.glowLevel.value = 1 + state.breath * 0.18;
    if (lamp.current) lamp.current.intensity = 7 * (1 + state.breath * 0.18);

    // The cloth's sound follows how fast it moves; dragging it brushes under the hand.
    const voice = VOICE[fabric] ?? 1;
    if (cloth.speed > 0.22) sound.play("rustle", { gain: Math.min(0.45, (cloth.speed - 0.18) * 0.35), pitch: voice * (0.9 + Math.min(0.3, cloth.speed * 0.05)), gap: 0.16 });
    if (cloth.holding) {
      const speed = state.dragSpeed / delta;
      if (speed > 0.6) sound.play("brush", { gain: Math.min(0.4, speed * 0.08), pitch: voice, gap: 0.12 });
    }
    state.dragSpeed = 0;

    // The lens holds the near face of the cloth sharp, from wherever the eye has gone.
    focus.point.copy(camera.position).setY(camera.position.y * 0.5).normalize().multiplyScalar(0.72);
  });

  return (
    <>
      <mesh geometry={geometry} material={materials.outside} castShadow receiveShadow frustumCulled={false} renderOrder={sheer ? 3 : 0} />
      <mesh geometry={geometry} material={materials.inside} frustumCulled={false} renderOrder={sheer ? 2 : 0} raycast={() => null} />
      <mesh material={heart} renderOrder={1} raycast={() => null} scale={[0.34, 0.5, 0.34]}>
        <sphereGeometry args={[1, 32, 20]} />
      </mesh>
      <pointLight ref={lamp} color="#ffb36a" intensity={7} distance={1.3} decay={2} position={[0, 0.05, 0]} />
      <mesh material={pool.material} rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y + 0.003, 0]} raycast={() => null}>
        <planeGeometry args={[3.2, 3.2]} />
      </mesh>
    </>
  );
}

// A dark studio: one broad soft light from the left, like a tall window, and the rest falling away into deep shadow,
// with a faint warm rim behind for the cloth's edge and a long strip for satin to run its highlight along.
export function Studio() {
  return (
    <>
      <Backdrop top={ROOM.top} horizon={ROOM.horizon} bottom={ROOM.bottom} />
      <StudioEnvironment
        ambient="#040405"
        intensity={0.75}
        boxes={[
          { position: [-7, 2.2, 2], scale: [0.2, 6, 4], color: "#fff1e2", intensity: 3.2 },
          { position: [-4, 6, -2], scale: [3, 0.2, 3], color: "#f4f0ff", intensity: 1.1 },
          { position: [5, 1.2, -6], scale: [1, 4, 0.2], color: "#ffcf9e", intensity: 1.3 },
          { position: [0, 1, 8], scale: [3, 2, 0.2], color: "#ffffff", intensity: 0.12 }
        ]}
      />
      <KeyLight position={KEY.position.toArray()} target={KEY.target.toArray()} color="#ffefdc" intensity={240} angle={0.36} penumbra={0.9} />
      <StudioFloor y={FLOOR_Y} background={ROOM.horizon} color="#24201d" roughness={0.7} radius={12} />
      <Motes />
    </>
  );
}
