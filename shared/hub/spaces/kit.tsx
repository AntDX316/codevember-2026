"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { suspend } from "suspend-react";
import * as THREE from "three/webgpu";
import type { Node } from "three/webgpu";
import { Fn, attribute, cameraPosition, color, dot, equirectDirection, equirectUV, float, max, mix, mx_fractal_noise_float, normalize, positionGeometry, positionWorld, pow, sin, smoothstep, texture, time, uniform, uv, vec3, vec4 } from "three/tsl";
import { days, daySlug, promptDayFor, type CodevemberDay } from "@/shared/days";
import { dayLoaders } from "@/shared/registry";
import { cameraTaken, orbitPoint } from "@/shared/engine/controls";
import { useDispose } from "@/shared/engine/dispose";
import { focusDistance, postBypass } from "@/shared/engine/Post";
import { scenePhase } from "@/shared/engine/quality";
import { sound } from "@/shared/engine/sound";
import type { Look } from "@/shared/engine/types";
import { HUB_MUSIC } from "../posters";
import { arrived, returnState } from "../returning";
import { loadPosters } from "../hub/pictures";
import { hubState, placeTip, setTipDay } from "../hub/state";
import { transition } from "./transitions";
import { hubSound } from "../sounds";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Where the hub is between the page and the 3D calendar, shared by the page that unfolds into it (unfold.tsx) and the
// calendar: `amount` from 0 on the page to 1 in the world, `inWorld` once there and handed over, and for each day, how far
// its card has landed as its tile (indexed by day number). `lastView` is where a day was entered from, to come back to it.
export const unfold = {
  amount: 0,
  inWorld: false,
  landed: new Float32Array(32),
  lastView: "2d" as "2d" | "3d",
  // In place, how far the plate under the month has come out behind the cards, and how far the title and the buttons have
  // stood out of the page, 0 to 1. On the page they lie flat in it.
  plate: 0,
  solid: 0,
  // The same, for shaders: the sides of what stands out of the page are the page's own white while it lies flat in it, so
  // that no edge of them shows there.
  solidness: uniform(0),
  // How far the title and the buttons have gone over from their flat pictures, the page's own, to their solid selves, 0 to 1:
  // over the first moments of the move, so that neither takes the other's place at a stroke.
  standing: 0,
  standingness: uniform(0),
  // Whether the camera is flying into a day, or back out of one: the eye's drift stays off till it lands, then eases in.
  flying: false,
  // Where the eye was when a day was entered from the calendar, to pull back out to on the way back from it.
  left: null as null | { day: number; position: THREE.Vector3; quaternion: THREE.Quaternion; target: THREE.Vector3; fov: number }
};

// What every space shares: the month's days with their posters, a gradient sky with soft lights far off in it, pointing at
// a day (a tooltip, a ping, the lens pulled to it) and going into one, and coming back out of one.

export type SpaceDay = {
  day: CodevemberDay;
  number: number;
  slug: string;
  open: boolean;
  today: boolean;
  // Null for a day not yet out, or one whose poster failed to load.
  poster: THREE.Texture | null;
  // The poster's colour, made a little richer; a quiet grey for a day without one.
  tint: THREE.Color;
};

// All thirty days, the ones not yet out included, for spaces that show the whole month.
export function useSpaceDays(): SpaceDay[] {
  const posters = suspend(loadPosters, ["cv-hub-posters"]);
  return useMemo(() => {
    const today = promptDayFor(new Date());
    return days.map((day) => {
      const slug = daySlug(day);
      const found = posters.get(slug);
      return { day, number: day.day, slug, open: day.live, today: day.day === today, poster: found?.poster ?? null, tint: found?.tint.clone() ?? new THREE.Color("#3a3d46") };
    });
  }, [posters]);
}

// The look every space starts from: deep, soft, glowing. A space can override any of it.
export const SPACE_LOOK: Partial<Look> = {
  background: "#05060a",
  exposure: 1,
  bloom: 0.55,
  bloomThreshold: 0.72,
  ao: 0.35,
  aoRadius: 0.4,
  gi: 0,
  haze: 0,
  vignette: 0.42,
  grain: 0.028
};

// A sky in four colours, top to bottom, with a glow toward `toLight` and big soft blots of the `blots` colours drifting in
// it, as out-of-focus light far away.
export type Palette = {
  top: string;
  horizon: string;
  bottom: string;
  glow: string;
  toLight: [number, number, number];
  blots: [string, string, string, string];
  bokeh: string[];
  // How quickly the sky goes from the horizon to the top and bottom: more, for a gradient that shows in a narrow view.
  spread?: number;
};

// The sky's colour, in linear light, looking along `d` (normalised). Also for the page's words, mixed over the sky behind
// them as the browser mixes its text over a page.
const paintSky = (palette: Palette, clock: Node<"float">) => {
  const toLight = uniform(new THREE.Vector3(...palette.toLight).normalize());
  const [top, horizon, bottom, glow] = [palette.top, palette.horizon, palette.bottom, palette.glow].map((c) => color(c));
  const blots = palette.blots.map((c) => color(c));
  const sky = Fn(([d]: [any]) => {
    const y = d.y.mul(palette.spread ?? 1) as any;
    const up = smoothstep(-0.1, 0.9, y) as any;
    const down = smoothstep(0.1, -0.8, y) as any;
    let rgb: any = mix(mix(horizon, top, up), bottom, down);
    const toward = max(dot(d, toLight), 0) as any;
    rgb = rgb.add(glow.mul(pow(toward, 6).mul(0.45).add(pow(toward, 40).mul(0.5))));
    const drift = (clock as any).mul(0.012) as any;
    const n1 = mx_fractal_noise_float(d.mul(1.6).add(vec3(drift, 0, drift.mul(0.6))), 3, 2, 0.5) as any;
    const n2 = mx_fractal_noise_float(d.mul(2.4).add(vec3(5.2, drift, 1.7)), 3, 2, 0.5) as any;
    const tint = mix(mix(blots[0], blots[1], smoothstep(-0.25, 0.3, n2)), mix(blots[2], blots[3], smoothstep(-0.2, 0.35, n2)), smoothstep(0.4, -0.4, d.y)) as any;
    return mix(rgb, tint, smoothstep(0.02, 0.45, n1).mul(0.55)) as any;
  });
  return (d: Node<"vec3">) => sky(d) as unknown as Node<"vec3">;
};

// The sky is smooth, its clouds wide and soft and drifting a little a second, so working it out afresh for every pixel of
// the screen, every frame, and again under every word on the page that is mixed over it, cost far more than it shows: on
// a phone, most of a frame. It is painted instead, each frame, into a small picture all the way round (512 by 256, about
// a twentieth of a phone's screen), and the sky and the words read it from there. Its colours are kept in full, and
// between its pixels it is blended, finer than any of its detail. On the flat page, where its drift is too slow to see, it
// is left as last painted, and its clouds take up again from there when the page moves.
const SKY_PAINT = { width: 512, height: 256 };
type SkyPaint = { picture: THREE.Texture; paint: (gl: THREE.WebGPURenderer) => void };
const skyPaints = new Map<Palette, SkyPaint>();
function skyPaint(palette: Palette) {
  let made = skyPaints.get(palette);
  if (made) return made;
  const target = new THREE.RenderTarget(SKY_PAINT.width, SKY_PAINT.height, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
  // All the way round, so the seam behind is blended across like anywhere else.
  target.texture.wrapS = THREE.RepeatWrapping;
  // Its own clock, which stops while it is not painted.
  const clock = uniform(0);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = vec4(paintSky(palette, clock as unknown as Node<"float">)(equirectDirection(uv())), 1) as any;
  material.toneMapped = false;
  const quad = new THREE.QuadMesh(material);
  let paintedAt = -1;
  let paintedWhen = -1;
  made = {
    picture: target.texture,
    // Once a frame, however many ask; on the flat page, only the first time.
    paint: (gl) => {
      const frame = (gl.info as unknown as { frame: number }).frame;
      if (frame === paintedAt || (postBypass.current && paintedAt >= 0)) return;
      const when = performance.now() / 1000;
      if (paintedWhen >= 0) clock.value += Math.min(when - paintedWhen, 0.1);
      paintedAt = frame;
      paintedWhen = when;
      const before = gl.getRenderTarget();
      gl.setRenderTarget(target);
      quad.render(gl);
      gl.setRenderTarget(before);
    }
  };
  skyPaints.set(palette, made);
  return made;
}

// The sky's colour seen in direction `d`, read from its painting (above), which the space's Sky keeps up to date.
export const skyColour = (palette: Palette) => {
  const { picture } = skyPaint(palette);
  return (d: Node<"vec3">) => texture(picture, equirectUV(d)).rgb as unknown as Node<"vec3">;
};

// The sky alone, for the canvas to hold behind the page while the page is HTML (mirror.ts).
export const SKY_LAYER = 20;
// How long the day's loader takes to come up, with a little to spare (codevember.css, .cv-loader).
const LOADER_UP = 400;

export function Sky({ palette, radius = 300 }: { palette: Palette; radius?: number }) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const { mesh, material } = useMemo(() => {
    // Drawn first and leaving no depth, so that the passes take it for empty sky: the lens keeps it sharp (sharpSky), rather
    // than blurring into it a soft copy of whatever stands in front of it.
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    material.colorNode = vec4(skyColour(palette)(normalize(positionWorld.sub(cameraPosition))), 1) as any;
    material.fog = false;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    mesh.layers.enable(SKY_LAYER);
    return { mesh, material };
  }, [palette, radius]);
  useDispose(mesh.geometry, material);
  // Always round the eye, so it is never flown out of.
  useFrame(() => {
    // Painted fresh before anything reads it, the words on the page too, whether or not the sky itself is drawn.
    skyPaint(palette).paint(gl);
    mesh.position.copy(camera.position);
    // Under the page's own ground on the page, where nothing of it shows, when the page lies flat. (Warming up draws hidden
    // things anyway.) In place, the page stands in front of it.
    mesh.visible = unfold.amount > 0 || transition().kind === "page";
  });
  return <primitive object={mesh} />;
}

// Lights hung through the space at real depths, so that the lens blurs the ones it is not focused on into soft discs and
// they slide past each other as the eye moves: what makes the space feel deep.
export function Lights({ palette, count = 260, inner = 6, outer = 70, size = [0.03, 0.22], seed = 7 }: { palette: Palette; count?: number; inner?: number; outer?: number; size?: [number, number]; seed?: number }) {
  const { mesh, material } = useMemo(() => {
    const random = mulberry32(seed);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const at: number[] = [];
    const tint: number[] = [];
    for (let i = 0; i < count; i++) {
      // Evenly through a shell, a little flattened.
      const u = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const r = inner + (outer - inner) * Math.cbrt(random());
      const s = Math.sqrt(1 - u * u);
      at.push(Math.cos(a) * s * r, u * r * 0.55, Math.sin(a) * s * r, size[0] + (size[1] - size[0]) * random() ** 2);
      tint.push(Math.floor(random() * palette.bokeh.length), random() * 100, 0.35 + random() * 0.65, 0);
    }
    geometry.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(at), 4));
    geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(new Float32Array(tint), 4));
    geometry.instanceCount = count;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const placed = attribute("aAt", "vec4") as any;
    const t = attribute("aTint", "vec4") as any;
    const bob = vec3(sin(time.mul(0.21).add(t.y)), sin(time.mul(0.17).add(t.y.mul(1.7))), sin(time.mul(0.19).add(t.y.mul(0.6)))).mul(0.35) as any;
    const centre = placed.xyz.add(bob) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(vec3(toEye.z, 0, toEye.x.negate())) as any;
    const upward = normalize(toEye.cross(right).negate()) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(placed.w))).add(upward.mul(positionGeometry.y.mul(placed.w))) as any;
    const colours = palette.bokeh.map((c) => color(c));
    const pick = (k: any) => colours.reduce((acc: any, c: any, i: number) => (i === 0 ? c : mix(acc, c, k.greaterThanEqual(i).select(1, 0))), colours[0]);
    material.colorNode = Fn(() => {
      const r = positionGeometry.xy.length() as any;
      const disc = smoothstep(1, 0.2, r) as any;
      const core = smoothstep(0.45, 0, r) as any;
      const twinkle = sin(time.mul(0.9).add(t.y)).mul(0.3).add(0.7) as any;
      return vec4(pick(t.x).mul(disc.mul(0.5).add(core.mul(1.4))).mul(t.z.mul(twinkle)), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return { mesh, material };
  }, [palette, count, inner, outer, size, seed]);
  useDispose(mesh.geometry, material);
  return <primitive object={mesh} />;
}

// The eye never quite still in the world: it drifts on slow, uneven swells, and turns a little round the point it looks at
// to follow the pointer, as a head would toward whatever is looked at. Laid over the rig's camera after the rig has moved
// it, and taken off again before the rig next reads it, so the rig never sees it. Held while dragging, and eased away while
// anything else has the camera.
export function CameraDrift({ float = 0.09, turn = [0.2, 0.08], seed = 3 }: { float?: number; turn?: [number, number]; seed?: number }) {
  const camera = useThree((state) => state.camera);
  const dom = useThree((state) => state.gl.domElement);
  const s = useMemo(() => {
    const random = mulberry32(seed);
    // Per axis, three swells at unrelated speeds, so the drift never repeats in any way the eye could catch.
    const swells = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ speed: 0.07 + random() * 0.22, phase: random() * Math.PI * 2 })));
    return {
      swells,
      pointer: new THREE.Vector2(),
      sway: new THREE.Vector2(),
      held: false,
      weight: 0,
      laid: false,
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      offset: new THREE.Vector3(),
      centre: new THREE.Vector3(),
      spherical: new THREE.Spherical()
    };
  }, [seed]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse") s.pointer.set((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
    };
    const onDown = () => (s.held = true);
    const onUp = () => (s.held = false);
    window.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dom, s]);

  // Off, before anything else moves the camera. Unless something has just taken the camera, or the way back to the page has
  // begun: then it is left where it was seen, for that to carry on from, rather than jumping.
  const free = () => unfold.inWorld && !cameraTaken.current && !unfold.flying && hubState().view === "3d";
  useFrame(() => {
    if (!s.laid) return;
    s.laid = false;
    if (!free()) return;
    camera.position.copy(s.position);
    camera.quaternion.copy(s.quaternion);
  }, -1);

  // On, once the rig has placed the camera.
  useFrame(({ clock }, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 30);
    const on = free();
    // Eased in each time the camera is handed back, from nothing.
    s.weight = on ? s.weight + (1 - s.weight) * (1 - Math.exp(-delta * 1.2)) : 0;
    if (!s.held) s.sway.lerp(s.pointer, 1 - Math.exp(-delta * 2.2));
    if (s.weight < 0.001 || !on) return;

    s.position.copy(camera.position);
    s.quaternion.copy(camera.quaternion);
    s.laid = true;
    const centre = orbitPoint.current ?? s.centre.set(0, 0, 0);
    // The turn round the middle: right on the screen swings the eye to the right, down tips it to look down on the month.
    s.spherical.setFromVector3(s.offset.subVectors(camera.position, centre));
    s.spherical.theta += s.sway.x * turn[0] * s.weight;
    s.spherical.phi = THREE.MathUtils.clamp(s.spherical.phi - s.sway.y * turn[1] * s.weight, 0.05, Math.PI - 0.05);
    camera.position.setFromSpherical(s.spherical).add(centre);
    const t = clock.elapsedTime;
    const swell = (axis: number) => s.swells[axis].reduce((sum, w, i) => sum + Math.sin(t * w.speed * Math.PI * 2 + w.phase) / (i + 1), 0) / 1.83;
    camera.position.x += swell(0) * float * s.weight;
    camera.position.y += swell(1) * float * 0.7 * s.weight;
    camera.position.z += swell(2) * float * 0.5 * s.weight;
    camera.lookAt(centre);
    camera.updateMatrixWorld();
  }, 0.5);

  return null;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A day in a space: the things that stand for it (any mesh under them can be pointed at), and where its tooltip hangs and
// its middle is, in the world, for the lens to focus on and the camera to fly into.
export type Pickable = { day: SpaceDay; object: THREE.Object3D };

export type Pointing = {
  // The day under the pointer (or last tapped, on a touch screen), and since when, in seconds.
  hovered: SpaceDay | null;
  since: number;
  // Going into a day: the camera flies at it, then the day loads.
  entering: { day: SpaceDay; at: number; from: THREE.Vector3; turn: THREE.Quaternion; gone: boolean; dark: boolean; darkAt: number } | null;
  // Back from a day entered from here: the eye starts square on to its window, close, and pulls back out to where it was.
  leaving: { day: SpaceDay; at: number; left: NonNullable<(typeof unfold)["left"]> } | null;
  // Set for one frame when the visitor has just pressed a day, so a space can answer it.
  pressed: SpaceDay | null;
};

type SpaceOptions = {
  targets: () => Pickable[];
  // Where the tooltip's point is, just above the day: written into `out`.
  anchor: (day: SpaceDay, out: THREE.Vector3) => void;
  // The day's middle: written into `out`. Its radius, roughly, is returned, for flying into it.
  centre: (day: SpaceDay, out: THREE.Vector3) => number;
  // The eye square on to the day, close enough that it fills the view at `nearness` 1, nearer below that: written into
  // `position` and `quaternion`, for flying into the day and back out of it.
  close: (day: SpaceDay, camera: THREE.PerspectiveCamera, nearness: number, position: THREE.Vector3, quaternion: THREE.Quaternion) => void;
  // How long the flight into a day takes, in seconds.
  flight?: number;
};

// Room kept above the tooltip's point, in CSS pixels, for the card that hangs up from it.
const TIP_ROOM = 190;
// Eased in and out with no jolt at either end: still, and not yet speeding up, at the start; the same at the finish.
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
// How long the way back out of a day's window takes, in seconds.
const RETURN_FLIGHT = 3.8;
// How long the screen takes to go black on the way into a day, in seconds: as .cv-space-leaving's in hub.css.
const DARK = 0.8;

// Pointing at days and going into them, the lens kept on whatever is looked at, the hub's music, and the way back in from a
// day. Returns what is pointed at, for the space to answer with its own hover states.
export function useSpace({ targets, anchor, centre, close, flight = 2.15 }: SpaceOptions) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const dom = useThree((state) => state.gl.domElement) as HTMLCanvasElement;
  const get = useThree((state) => state.get);
  const router = useRouter();
  const pointing = useRef<Pointing>({ hovered: null, since: 0, entering: null, leaving: null, pressed: null });
  const options = useRef({ targets, anchor, centre, close, flight });
  options.current = { targets, anchor, centre, close, flight };

  // Back from a day that was entered from the calendar: out of its window, to where the eye was.
  useEffect(() => {
    const left = unfold.left;
    unfold.left = null;
    if (!left || returnState().phase !== "crossing" || unfold.lastView !== "3d") return;
    const day = options.current.targets().find((target) => target.day.number === left.day)?.day;
    if (!day) return;
    pointing.current.leaving = { day, at: -1, left };
    cameraTaken.current = true;
  }, []);

  useEffect(() => {
    const p = pointing.current;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const fetched = new Set<string>();
    let down: { x: number; y: number } | null = null;
    let moved = 0;

    const pick = (event: PointerEvent) => {
      // On the page, or on the way between, the page does its own pointing.
      if (!unfold.inWorld) return null;
      const bounds = dom.getBoundingClientRect();
      ndc.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const list = options.current.targets();
      const hit = raycaster.intersectObjects(
        list.map((target) => target.object),
        true
      )[0];
      if (!hit) return null;
      for (let object: THREE.Object3D | null = hit.object; object; object = object.parent) {
        const found = list.find((target) => target.object === object);
        if (found) return found.day;
      }
      return null;
    };
    const point = (day: SpaceDay | null) => {
      if (day === p.hovered) return;
      p.hovered = day;
      p.since = performance.now() / 1000;
      if (day) {
        hubSound("hover", { pitch: 0.75 + day.number / 50 });
        if (day.open && !fetched.has(day.slug)) {
          fetched.add(day.slug);
          dayLoaders[day.slug]?.().catch(() => fetched.delete(day.slug));
        }
      }
    };
    const enter = (day: SpaceDay) => {
      if (p.entering || p.leaving || !day.open) return;
      // From exactly where the eye is, turning and moving at once, both eased in and out.
      const target = orbitPoint.current?.clone() ?? camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(12));
      unfold.left = { day: day.number, position: camera.position.clone(), quaternion: camera.quaternion.clone(), target, fov: camera.fov };
      p.entering = { day, at: performance.now() / 1000, from: camera.position.clone(), turn: camera.quaternion.clone(), gone: false, dark: false, darkAt: 0 };
      unfold.lastView = "3d";
      cameraTaken.current = true;
      sound.play("whoosh", { gain: 0.8, pitch: 0.7 });
      sound.play("chime", { gain: 0.3, pitch: 0.8 + day.number / 60 });
    };

    const onDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY };
      moved = 0;
    };
    const onMove = (event: PointerEvent) => {
      if (down) moved = Math.max(moved, Math.hypot(event.clientX - down.x, event.clientY - down.y));
      if (event.pointerType === "mouse" && !p.entering && !p.leaving) point(down && moved > 3 ? p.hovered : pick(event));
    };
    const onUp = (event: PointerEvent) => {
      if (!down) return;
      down = null;
      if (moved > 6 || p.entering || p.leaving) return;
      const day = pick(event);
      // On a touch screen the first tap points, as hovering would, and the second goes in.
      if (event.pointerType !== "mouse" && day !== p.hovered) {
        point(day);
        if (day) p.pressed = day;
        return;
      }
      if (!day) return;
      p.pressed = day;
      if (day.open) enter(day);
      else sound.play("click", { gain: 0.2, pitch: 0.6 });
    };
    // A finger leaves the screen each time it lifts, and that is not looking away: what it tapped stays pointed at.
    const onLeave = (event: PointerEvent) => {
      if (event.pointerType === "mouse") point(null);
    };

    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    dom.addEventListener("pointerleave", onLeave);
    return () => {
      dom.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointerleave", onLeave);
    };
  }, [camera, dom]);

  // In the world, the hub's music and a low drone under it; on the page, quiet, as a page is.
  const music = useRef<null | { stop: () => void; drone: { stop: () => void } }>(null);
  useEffect(
    () => () => {
      music.current?.stop();
      music.current?.drone.stop();
      music.current = null;
    },
    []
  );

  useEffect(
    () => () => {
      setTipDay(null);
      dom.style.cursor = "";
      cameraTaken.current = false;
      unfold.flying = false;
      // Into a day, the dark stays until the day's loader has come up over it (codevember.css: 0.28 s), or the calendar's last
      // frame would show through the loader as it fades in.
      const root = document.documentElement;
      if (root.classList.contains("cv-space-leaving")) window.setTimeout(() => root.classList.remove("cv-space-leaving"), LOADER_UP);
    },
    [dom]
  );

  // In development, where each day is on screen, for driving a space from a test, as the calendar's.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const handle = {
      screen: (number: number) => {
        const day = options.current.targets().find((target) => target.day.number === number)?.day;
        if (!day) return null;
        const point = new THREE.Vector3();
        options.current.centre(day, point);
        point.project(camera);
        const { width, height } = get().size;
        return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height, ahead: point.z < 1 };
      },
      path: () => window.location.pathname,
      // The renderer and the scene, for switching parts of it off from a test to time what they cost.
      three: () => get(),
      // The point the camera turns round, for following the camera from a test.
      orbit: () => orbitPoint.current?.toArray() ?? null,
      // What the last frame drew, and every object on show, by name or type, for finding what costs a frame.
      drawn: () => {
        const { gl, scene } = get();
        const shown: Record<string, number> = {};
        scene.traverseVisible((object) => {
          if (!(object as THREE.Mesh).isMesh && !(object as THREE.Points).isPoints) return;
          const mesh = object as THREE.InstancedMesh;
          const geometry = mesh.geometry as THREE.BufferGeometry & { parameters?: { width?: number; height?: number } };
          const size = geometry.parameters?.width ? `${Math.round(geometry.parameters.width)}x${Math.round(geometry.parameters.height ?? 0)}` : `${geometry.index?.count ?? geometry.attributes.position?.count}v`;
          const key = object.name || `${geometry.type} ${size}${mesh.isInstancedMesh ? ` x${mesh.count}` : ""} r${object.renderOrder}`;
          shown[key] = (shown[key] ?? 0) + 1;
        });
        return { render: { ...(gl.info as unknown as { render: object }).render }, shown };
      }
    };
    (window as unknown as { cvHub?: typeof handle }).cvHub = handle;
    return () => {
      delete (window as unknown as { cvHub?: typeof handle }).cvHub;
    };
  }, [camera, get]);

  const scratch = useMemo(() => ({ tip: new THREE.Vector3(), middle: new THREE.Vector3(), to: new THREE.Vector3(), turn: new THREE.Quaternion(), cursor: "" }), []);
  useFrame(() => {
    const p = pointing.current;
    const s = scratch;
    const now = performance.now() / 1000;
    const { width, height } = get().size;

    // Back from a day: its last frame fades once this is up.
    if (returnState().phase === "crossing" && scenePhase.current === "live") arrived();

    const loud = unfold.amount > 0.6;
    if (loud && !music.current) music.current = { stop: sound.music(HUB_MUSIC, 0.2), drone: sound.bed("drone", 0.12) };
    else if (!loud && music.current) {
      music.current.stop();
      music.current.drone.stop();
      music.current = null;
    }

    // Out of a day's window: held square on to it, close, until the scene is up and the day's last frame starts to fade
    // into it, then drawn back to where the eye was when it went in, and the camera handed back to the visitor there.
    // The eye's drift (CameraDrift) is held off from the moment a flight begins until the frame after it lands.
    unfold.flying = !!(p.entering || p.leaving);
    const l = p.leaving;
    if (l) {
      cameraTaken.current = true;
      options.current.close(l.day, camera, 0.9, s.to, s.turn);
      if (l.at < 0) {
        if (scenePhase.current === "live") l.at = now + 0.25;
        camera.position.copy(s.to);
        camera.quaternion.copy(s.turn);
      } else {
        const t = THREE.MathUtils.clamp((now - l.at) / RETURN_FLIGHT, 0, 1);
        const k = smoother(t);
        camera.position.lerpVectors(s.to, l.left.position, k);
        camera.quaternion.slerpQuaternions(s.turn, l.left.quaternion, smoother(Math.min(1, t * 1.15)));
        if (t >= 1) {
          p.leaving = null;
          orbitPoint.current?.copy(l.left.target);
          cameraTaken.current = false;
        }
      }
      camera.updateMatrixWorld();
    }

    // The page keeps the lens, the pointer and the cursor until the world is handed over.
    if (!unfold.inWorld) {
      if (p.hovered) p.hovered = null;
      setTipDay(null);
      s.cursor = "";
      return;
    }

    // The lens on whatever is pointed at, or else on what the eye turns round.
    const focusOn = p.entering?.day ?? p.leaving?.day ?? p.hovered;
    let wanted = orbitPoint.current ? camera.position.distanceTo(orbitPoint.current) : 12;
    if (focusOn) {
      options.current.centre(focusOn, s.middle);
      wanted = camera.position.distanceTo(s.middle);
    }
    focusDistance.value += (wanted - focusDistance.value) * 0.12;

    // Over the day pointed at, a word on it.
    let tipped = 0;
    if (p.hovered && !p.entering && !p.leaving) {
      options.current.anchor(p.hovered, s.tip);
      s.tip.project(camera);
      if (s.tip.z < 1) {
        tipped = p.hovered.number;
        placeTip(((s.tip.x + 1) / 2) * width, Math.max(TIP_ROOM, ((1 - s.tip.y) / 2) * height));
      }
    }
    setTipDay(tipped || null);

    const cursor = p.entering || p.leaving ? "" : p.hovered ? (p.hovered.open ? "pointer" : "not-allowed") : "grab";
    if (cursor !== s.cursor) {
      s.cursor = cursor;
      dom.style.cursor = cursor;
    }

    // Flying into a day, then off to it.
    const e = p.entering;
    if (e) {
      // Into the day's window from wherever the eye was: the turn a little ahead of the move, so it faces the day before
      // it arrives, and both starting and stopping gently. Toward the end, the screen darkens as the day loads.
      const t = Math.min(1, (now - e.at) / options.current.flight);
      options.current.close(e.day, camera, 0.45, s.to, s.turn);
      camera.position.lerpVectors(e.from, s.to, smoother(t));
      camera.quaternion.slerpQuaternions(e.turn, s.turn, smoother(Math.min(1, t * 1.3)));
      camera.updateMatrixWorld();
      // Into black well before the day is asked for, and all the way there before it comes: the day's loader then comes up
      // out of the same black, as if out of the window. The calendar's music dies away with the light.
      if (t > 0.5 && !e.dark) {
        e.dark = true;
        e.darkAt = now;
        document.documentElement.classList.add("cv-space-leaving");
        sound.fadeMusic(1.2);
      }
      if (t >= 1 && e.dark && now - e.darkAt >= DARK && !e.gone) {
        e.gone = true;
        router.push(`/${e.day.slug}/`);
      }
    }
  }, 0.9);

  // A press lasts one frame, read by the space in its own frame, which runs before this one.
  useFrame(() => {
    pointing.current.pressed = null;
  }, 0.95);

  return pointing;
}
