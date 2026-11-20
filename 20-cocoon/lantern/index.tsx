"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { lehmer } from "../../shared/engine/random";
import { useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { sound, useBed, useEvery } from "../../shared/engine/sound";
import { StudioEnvironment } from "../../shared/engine/studio";
import { Backdrop, focus, usePointerRay, type Variant } from "../kit";
import { buildLayout, EMBER, HALF_HEIGHT } from "./layout";
import { createLight, createMaps, dustMaterial, emberMaterial, floorMaterial, haloMaterial, paperMaterial, shaftMaterial, veinMaterial } from "./materials";
import { paintWashi } from "./washi";

const FLOOR = -1.75;
// The floor melts into the room at its horizon, so both are one colour there.
const BACKGROUND = "#0b0908";

// Each paper's colour by the light through it (and how much it lets through), and by light falling on it.
const PAPERS: Record<string, { transmit: string; gain: number; reflect: string }> = {
  rice: { transmit: "#fff0d2", gain: 1, reflect: "#e9e1d0" },
  amber: { transmit: "#ffb24a", gain: 1.05, reflect: "#d29445" },
  indigo: { transmit: "#5b7dff", gain: 2.3, reflect: "#2d3d7a" },
  red: { transmit: "#ff4b2b", gain: 1.35, reflect: "#a52a22" }
};

// The ember's colour from a sleepy red coal to a bright candle, in linear light.
const COOL_FLAME = new THREE.Color(1, 0.26, 0.05);
const HOT_FLAME = new THREE.Color(1, 0.72, 0.44);

// How a panel swings: lively opening, with an overshoot that settles like stiff paper; closing firmer, so it does not
// swing deep inside past its frame.
const OPEN_SPRING = { k: 85, c: 8.5 };
const CLOSE_SPRING = { k: 140, c: 18 };
// A hovered panel lifts just ajar, showing a sliver of light.
const AJAR = 0.05;

function Lantern() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const mapWidth = startTier === "high" ? 512 : startTier === "medium" ? 384 : 256;
  const radial = tier === "low" ? 6 : 8;

  // The cell count is rebuilt a moment after the slider stops, not at every step of it.
  const requested = useSetting<number>("lanternCells");
  const [count, setCount] = useState(requested);
  useEffect(() => {
    const timer = window.setTimeout(() => setCount(Math.round(THREE.MathUtils.clamp(requested, 30, 200))), 250);
    return () => window.clearTimeout(timer);
  }, [requested]);

  const layout = useMemo(() => buildLayout(count, mapWidth, radial), [count, mapWidth, radial]);
  const light = useMemo(() => createLight(), []);
  const washi = useMemo(() => paintWashi(startTier === "low" ? 512 : 1024), [startTier]);
  const maps = useMemo(() => createMaps(layout.map), [mapWidth]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new layout pours its light map into the same texture, so nothing that reads it has to compile again.
  useEffect(() => {
    (maps.exits.image.data as Uint8Array).set(layout.map.data);
    maps.exits.needsUpdate = true;
  }, [maps, layout]);

  const materials = useMemo(
    () => ({
      paper: paperMaterial(light, washi),
      vein: veinMaterial(light),
      ember: emberMaterial(light),
      halo: haloMaterial(light),
      shaft: shaftMaterial(light, maps, FLOOR),
      floor: floorMaterial(light, maps, BACKGROUND),
      dust: dustMaterial(light, maps, FLOOR)
    }),
    [light, washi, maps]
  );
  useDispose(...Object.values(materials), washi, maps.exits, maps.open);

  const parts = useMemo(() => {
    const knotGeometry = new THREE.IcosahedronGeometry(1, 1);
    const knots = new THREE.InstancedMesh(knotGeometry, materials.vein, layout.knots.length);
    const m = new THREE.Matrix4();
    layout.knots.forEach((p, i) => knots.setMatrixAt(i, m.makeScale(layout.knotRadius, layout.knotRadius * 0.8, layout.knotRadius).setPosition(p)));
    knots.instanceMatrix.needsUpdate = true;
    return { knotGeometry, knots };
  }, [layout, materials.vein]);
  useDispose(layout.paper, layout.veins, layout.shafts, parts.knotGeometry);

  const fixed = useMemo(() => {
    // A lumpy coal, its bumps a smooth function of place so the shared corners of the faces move together.
    const ember = new THREE.IcosahedronGeometry(0.075, 3);
    const pos = ember.getAttribute("position") as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = v.clone().normalize();
      const bump = 1 + 0.2 * Math.sin(n.x * 5.1 + 1) * Math.sin(n.y * 4.3 + 2) * Math.sin(n.z * 6.2) + 0.08 * Math.sin(n.x * 13 + n.y * 11);
      v.multiplyScalar(bump);
      v.y *= 0.85;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    ember.computeVertexNormals();
    const cord = new THREE.CylinderGeometry(0.0055, 0.0055, 8 - HALF_HEIGHT, 6);
    const cap = new THREE.CylinderGeometry(0.03, 0.07, 0.07, 16);
    const floor = new THREE.CircleGeometry(40, 96);
    const quad = new THREE.PlaneGeometry(1, 1);
    const dustCount = startTier === "high" ? 3000 : startTier === "medium" ? 1800 : 900;
    const seeds = new Float32Array(dustCount * 4);
    const random = lehmer(3301);
    for (let i = 0; i < seeds.length; i++) seeds[i] = random();
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    return { ember, cord, cap, floor, quad, dustCount };
  }, [startTier]);
  useDispose(fixed.ember, fixed.cord, fixed.cap, fixed.floor, fixed.quad);

  const dust = useMemo(() => {
    const mesh = new THREE.InstancedMesh(fixed.quad, materials.dust, fixed.dustCount);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < fixed.dustCount; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    return mesh;
  }, [fixed, materials.dust]);

  const halo = useMemo(() => {
    const sprite = new THREE.Sprite(materials.halo);
    sprite.scale.setScalar(0.85);
    sprite.position.copy(EMBER);
    return sprite;
  }, [materials.halo]);

  // ---- Settings
  const paper = useSetting<string>("lanternPaper");
  useEffect(() => {
    const p = PAPERS[paper] ?? PAPERS.rice;
    light.transmit.value.set(p.transmit).multiplyScalar(p.gain);
    light.reflect.value.set(p.reflect);
  }, [paper, light]);
  const flame = useSettingRef<number>("lanternFlame");

  // ---- Every panel's swing: where it is (0 shut, 1 open), how fast, where it is heading, and anything queued for it.
  const swing = useMemo(() => {
    const n = layout.cells.length;
    return {
      x: new Float32Array(n),
      v: new Float32Array(n),
      target: new Uint8Array(n),
      shown: new Float32Array(n).fill(-1),
      due: new Float32Array(n).fill(-1),
      dueTarget: new Uint8Array(n),
      hover: -1,
      held: false,
      mode: 1,
      last: -1,
      announced: false,
      clock: 0,
      pressed: null as ReturnType<typeof layout.pick>
    };
  }, [layout]);

  const camera = useThree((state) => state.camera);
  const pointer = usePointerRay();
  const scratch = useMemo(() => ({ q: new THREE.Quaternion(), p: new THREE.Vector3(), n: new THREE.Vector3(), screen: new THREE.Vector3() }), []);

  const panOf = (cell: number) => THREE.MathUtils.clamp(scratch.screen.copy(layout.cells[cell].centre).project(camera).x, -1, 1);

  const setCell = (cell: number, open: number, quiet = false) => {
    if (swing.target[cell] === open) return;
    swing.target[cell] = open;
    swing.due[cell] = -1;
    if (!quiet) sound.play("fold", { gain: open ? 0.55 : 0.4, pitch: open ? 1.05 + Math.random() * 0.25 : 0.78 + Math.random() * 0.15, pan: panOf(cell), size: 0.3 });
  };

  useGrabbable({
    // The rig asks for a pick at the press just before it grabs, so the press's own cell is kept from it.
    pick: (ray) => (swing.pressed = layout.pick(ray)),
    grab: () => {
      dismissPrompt();
      const hit = swing.pressed;
      if (!hit) return;
      // A press on a shut cell opens it and every cell the drag then crosses; on an open one, closes them.
      swing.mode = swing.target[hit.cell] ? 0 : 1;
      swing.held = true;
      swing.last = hit.cell;
      setCell(hit.cell, swing.mode);
    },
    drag: () => {},
    release: () => {
      swing.held = false;
      swing.last = -1;
    }
  });

  const cascade = (open: number) => {
    let any = false;
    layout.cells.forEach((cell, i) => {
      if (swing.target[i] === open) return;
      any = true;
      // Opening runs from the crown down, as a flower opens; closing from the base up.
      const delay = open ? (1 - cell.height) * 0.75 : (1 + cell.height) * 0.5;
      swing.due[i] = swing.clock + delay + Math.random() * 0.08;
      swing.dueTarget[i] = open;
    });
    if (any) sound.play("whoosh", { gain: 0.25, pitch: open ? 1.3 : 0.9 });
  };
  useSettingAction("lanternBloom", () => cascade(1));
  useSettingAction("lanternClose", () => cascade(0));

  // ---- Sound: a low hum like air moving over the flame, and now and then the ember spits.
  const bed = useBed("hum", 0.08);
  useEvery(0.7, 2.8, () => sound.play("sizzle", { gain: 0.12 + Math.random() * 0.18, pitch: 0.3 + Math.random() * 0.25, size: 0.1 }));

  useEffect(() => {
    focus.point.set(0, -0.1, 0);
    focus.blur = 0.8;
  }, []);

  const flicker = useRef({ dip: 0 });
  const emberRef = useRef<THREE.Mesh>(null);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 1 / 30);
    const t = state.clock.elapsedTime;
    swing.clock += dt;

    // ---- The flame: its colour and strength from the setting, flickering on a few unrelated rhythms and now and then
    // guttering for a moment.
    const f = flame.current;
    light.flame.value.copy(COOL_FLAME).lerp(HOT_FLAME, f);
    const fl = flicker.current;
    if (Math.random() < dt * 0.25) fl.dip = 0.25 + Math.random() * 0.2;
    fl.dip *= Math.exp(-dt * 6);
    const wave = 0.07 * Math.sin(t * 7.3 + Math.sin(t * 2.1) * 2) + 0.05 * Math.sin(t * 13.7 + 1.3) + 0.03 * Math.sin(t * 23.1);
    light.power.value = (0.9 + 1.7 * f) * (1 + wave - fl.dip);
    light.ember.value.set(EMBER.x + 0.006 * Math.sin(t * 1.7), EMBER.y + 0.004 * Math.sin(t * 2.3), EMBER.z + 0.006 * Math.sin(t * 1.3 + 1));
    bed.current?.level(0.04 + 0.08 * f, 0.5);

    // ---- The pointer: what it is over, and while held, every cell it crosses.
    let over = -1;
    if (pointer.active) {
      const hit = layout.pick(pointer.ray);
      if (hit) over = hit.cell;
    }
    if (swing.held && over >= 0 && over !== swing.last) {
      swing.last = over;
      setCell(over, swing.mode);
    }
    swing.hover = swing.held ? -1 : over;
    light.hover.value = swing.hover;
    light.lift.value = THREE.MathUtils.damp(light.lift.value, swing.hover >= 0 ? 1 : 0, 8, dt);

    // ---- The panels.
    const positions = layout.paper.getAttribute("position") as THREE.BufferAttribute;
    const normals = layout.paper.getAttribute("normal") as THREE.BufferAttribute;
    const pa = positions.array as Float32Array;
    const na = normals.array as Float32Array;
    let moved = false;
    let openChanged = false;
    let allOpen = true;
    for (let i = 0; i < layout.cells.length; i++) {
      const cell = layout.cells[i];
      if (swing.due[i] >= 0 && swing.clock >= swing.due[i]) {
        swing.target[i] = swing.dueTarget[i];
        swing.due[i] = -1;
        sound.play("fold", { gain: 0.2, pitch: swing.target[i] ? 1.1 + Math.random() * 0.3 : 0.8 + Math.random() * 0.2, pan: panOf(i), gap: 0.045 });
      }
      if (!swing.target[i] || swing.x[i] < 0.85) allOpen = false;

      const goal = swing.target[i] ? 1 : i === swing.hover ? AJAR : 0;
      const spring = goal > 0.5 ? OPEN_SPRING : CLOSE_SPRING;
      // Two half steps keep the stiff closing spring steady at a low frame rate.
      for (let k = 0; k < 2; k++) {
        const h = dt / 2;
        swing.v[i] += (spring.k * (goal - swing.x[i]) - spring.c * swing.v[i]) * h;
        swing.x[i] += swing.v[i] * h;
      }
      // A panel slapping shut meets its frame and bounces off it a little.
      if (swing.x[i] < -0.015) {
        if (swing.v[i] < -1.2) sound.play("click", { gain: Math.min(0.25, -swing.v[i] * 0.03), pitch: 0.55 + Math.random() * 0.2, pan: panOf(i), gap: 0.03 });
        swing.x[i] = -0.015;
        swing.v[i] = -swing.v[i] * 0.2;
      }
      if (Math.abs(swing.v[i]) < 1e-4 && Math.abs(goal - swing.x[i]) < 1e-4) {
        swing.x[i] = goal;
        swing.v[i] = 0;
      }
      if (swing.x[i] === swing.shown[i]) continue;
      swing.shown[i] = swing.x[i];
      moved = true;

      // Turn the panel's resting vertices about its hinge.
      scratch.q.setFromAxisAngle(cell.axis, swing.x[i] * cell.reach);
      const rp = layout.restPositions;
      const rn = layout.restNormals;
      for (let j = cell.start; j < cell.start + cell.count; j++) {
        const o = j * 3;
        scratch.p.set(rp[o] - cell.pivot.x, rp[o + 1] - cell.pivot.y, rp[o + 2] - cell.pivot.z).applyQuaternion(scratch.q).add(cell.pivot);
        pa[o] = scratch.p.x;
        pa[o + 1] = scratch.p.y;
        pa[o + 2] = scratch.p.z;
        scratch.n.set(rn[o], rn[o + 1], rn[o + 2]).applyQuaternion(scratch.q);
        na[o] = scratch.n.x;
        na[o + 1] = scratch.n.y;
        na[o + 2] = scratch.n.z;
      }
      // How much light gets past: most of it once the panel has swung a little way clear.
      const clear = Math.round(THREE.MathUtils.smoothstep(swing.x[i], 0.02, 0.5) * 255);
      if (maps.openData[i * 4] !== clear) {
        maps.openData[i * 4] = clear;
        openChanged = true;
      }
    }
    if (moved) {
      positions.needsUpdate = true;
      normals.needsUpdate = true;
    }
    if (openChanged) maps.open.needsUpdate = true;

    // The whole lantern open at once earns a little fanfare.
    if (allOpen && !swing.announced) {
      swing.announced = true;
      sound.play("fanfare", { gain: 0.3, pitch: 1 });
      sound.play("chime", { gain: 0.25, pitch: 1.5 });
    } else if (!allOpen && swing.announced && swing.target.some((x) => !x)) {
      swing.announced = false;
    }

    // The coal breathes.
    emberRef.current?.scale.setScalar(1 + 0.04 * Math.sin(t * 2.2) + 0.02 * Math.sin(t * 5.3));
    emberRef.current?.rotation.set(0, t * 0.15, 0);
  });

  return (
    <>
      <Backdrop top="#08080e" horizon={BACKGROUND} bottom="#060504" />
      <StudioEnvironment
        ambient="#040405"
        intensity={0.35}
        boxes={[
          // A cool night sky overhead, and the lantern's own warm pool bouncing up off the floor.
          { position: [0, 8, 0], scale: [6, 0.2, 6], color: "#7f93c4", intensity: 0.5 },
          { position: [-6, 3, -4], scale: [0.2, 3, 3], color: "#8ea2d0", intensity: 0.5 },
          { position: [0, -1.8, 0], scale: [3, 0.2, 3], color: "#ff9a4a", intensity: 0.6 }
        ]}
      />
      <directionalLight position={[-4, 6, -3]} intensity={0.45} color="#9fb2e0" />

      <mesh geometry={layout.paper} material={materials.paper} frustumCulled={false} />
      <mesh geometry={layout.veins} material={materials.vein} />
      <primitive object={parts.knots} />
      <mesh geometry={fixed.cord} material={materials.vein} position={[0, (8 + HALF_HEIGHT) / 2, 0]} />
      <mesh geometry={fixed.cap} material={materials.vein} position={[0, HALF_HEIGHT - 0.008, 0]} />

      <mesh ref={emberRef} geometry={fixed.ember} material={materials.ember} position={EMBER.toArray()} />
      <primitive object={halo} />

      <mesh geometry={layout.shafts} material={materials.shaft} frustumCulled={false} renderOrder={2} />
      <primitive object={dust} />
      <mesh geometry={fixed.floor} material={materials.floor} rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR, 0]} />
    </>
  );
}

const lantern: Variant = {
  Scene: Lantern,
  settings: {
    lanternPaper: {
      type: "choice",
      label: "Paper",
      value: "rice",
      options: [
        { value: "rice", label: "Rice", swatch: ["#f3e7cf"] },
        { value: "amber", label: "Amber", swatch: ["#e8a043"] },
        { value: "indigo", label: "Indigo", swatch: ["#34478f"] },
        { value: "red", label: "Red", swatch: ["#c8352a"] }
      ]
    },
    lanternCells: { type: "range", label: "Cells", min: 40, max: 180, step: 10, value: 90, reset: 90 },
    lanternFlame: { type: "range", label: "Flame", min: 0, max: 1, step: 0.01, value: 0.55, reset: 0.55 },
    lanternBloom: { type: "action", label: "Bloom" },
    lanternClose: { type: "action", label: "Close" }
  },
  view: { position: [0, 0.55, 6.4], target: [0, -0.25, 0], fov: 36 },
  look: { background: BACKGROUND, exposure: 1, bloom: 0.6, bloomThreshold: 0.75, ao: 0.35, aoRadius: 0.3, vignette: 0.45, grain: 0.022 },
  hint: "Click a paper cell to fold it open, or drag across several. Bloom opens the whole lantern.",
  notes:
    "A paper lantern grown as a cocoon: Voronoi cells of washi on an egg, framed in dark veins and lit from within by a flickering ember. Fold cells open and the ember's light spills out across the floor and through the dust.",
  overview: [
    {
      title: "The lantern",
      points: [
        "Seeds relaxed on a sphere give a spherical Voronoi diagram (the dual of their convex hull), pressed into an egg; each cell is its own curved paper panel, each edge a bowed vein that swells into its joints.",
        "The paper is lit by the ember in its shader: light from behind comes through tinted by the dye, dimmed by every fibre of a canvas-painted washi sheet and brightest looking straight at the flame.",
        "Each panel hangs on its lowest edge and swings on a spring with a little overshoot; the cascade opens from the crown down."
      ]
    },
    {
      title: "The light out",
      points: [
        "A map of every direction out of the ember records which cell it leaves through and how clear of the veins it is; with each cell's openness it lights the floor, so open cells throw shafts framed by vein shadows.",
        "Beams are each cell's outline carried out from the ember, drawn soft-edged and additive, and the dust glints where it drifts through them."
      ]
    }
  ]
};

export default lantern;
