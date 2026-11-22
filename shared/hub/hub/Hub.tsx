"use client";

import { useFrame, useThree, type RootState } from "@react-three/fiber";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { suspend } from "suspend-react";
import * as THREE from "three/webgpu";
import type { Node } from "three/webgpu";
import { days, daySlug, promptDayFor } from "@/shared/days";
import { dayLoaders } from "@/shared/registry";
import { useDispose } from "@/shared/engine/dispose";
import { damp } from "@/shared/engine/walk";
import { scenePhase } from "@/shared/engine/quality";
import { sound } from "@/shared/engine/sound";
import { REPO } from "@/shared/ui/github";
import { ARRIVE_COVER, DAY_MUSIC, HUB_MUSIC } from "../posters";
import { arrived } from "../returning";
import { coverPicture, loadPosters } from "./pictures";
import { layoutPage, type CardLayout, type Fonts, type PageLayout, type Rect } from "./layout";
import { BG, cardMaterial, floorMaterial, motes, portalLight, RING, ringCentre, ringStart, skyMaterial, textMaterial, veilMaterial, worldAmount, type CardUniforms } from "./materials";
import { hubState, placeTip, recall, remember, resetView, setMoving, setTipDay } from "./state";
import { blurbTexture, cardTexture, markTexture, texelRect, TITLE_PAD, titleTexture } from "./text";

// The page lies on the floor at a centimetre to the CSS pixel, and the camera looks straight down at it from the height at
// which one CSS pixel on the floor is one CSS pixel on screen. Scrolling carries the camera along the page.
export const PX = 0.01;
export const PAGE_FOV = 36;
const WALK_FOV = 64;
const EYE = 1.65;
// Seconds from page to world, and how much of that the last card waits before it moves.
const MORPH = 2.8;
const STAGGER = 0.35;
// The portals stand in a ring, one for each day, facing in.
const PORTAL = { w: 2.2, h: 2.75, raise: 0.15 };
// Singled out, under the pointer or pressed, a portal comes out of the ring toward its middle by this much, then grows this
// many times over, over POP seconds in all; its neighbours, one, two and three places away, close in behind it by these
// distances, so that it stands in front of them.
const PULL = 2;
const GROW = 2;
const POP = 0.75;
const FILL = [0, 0.42, 0.18, 0.06];
// How far along its pop a portal has come out, and how far it has grown: out first, then up in size, with an overlap.
const outOf = (pop: number) => ease(clamp01(pop / 0.55));
const growOf = (pop: number) => ease(clamp01((pop - 0.3) / 0.7));
// Room kept above the tooltip's point, in CSS pixels, for the card that hangs up from it.
const TIP_ROOM = 190;
const WALK = 3.2;
const RUN = 7;
const LOOK = 0.0042;
const STRIDE = 0.78;
// How close to a portal its music comes through, and how far away it gives way to the hub's again.
const HEAR = 4.5;
const LOSE = 7;
const HUB = "/";
// Seconds held up against a portal on arriving back from its day, while the day's last frame fades away, and how far
// back from it the step back ends, which is also how close a portal opens by itself.
const ARRIVE_HOLD = 0.8;
const STEP_BACK = 3.4;

export const FLAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const FLIP = new THREE.Matrix4().makeScale(1, -1, 1);
const UP = new THREE.Vector3(0, 1, 0);

export async function loadFonts(): Promise<Fonts> {
  const style = getComputedStyle(document.documentElement);
  const display = style.getPropertyValue("--font-display").trim() || "Arial, sans-serif";
  const body = style.getPropertyValue("--font-body").trim() || "Arial, sans-serif";
  // A font that will not load (blocked, or the connection dropped) is drawn in the fallback rather than ending the visit.
  await Promise.all([document.fonts.load(`800 100px ${display}`, "Codevember"), document.fonts.load(`400 13px ${body}`, "One word")]).catch(() => {});
  return { display, body };
}

export type Item = {
  mesh: THREE.Mesh;
  // The picture of its words the GPU draws from, for the page as HTML to show (spaces/mirror.ts).
  art: THREE.Texture;
  // Where it sits on the page, in CSS pixels.
  rect: Rect;
  // When it rises into view as the page opens, in seconds, and how far it rises, in CSS pixels.
  intro: number;
  rise: number;
  // How long it waits, as a part of the move, before leaving the page for the world.
  delay: number;
  // Its opacity on the page, and the uniform that sets it.
  base: number;
  opacity: { value: number };
  hover: { lift: number; zoom: number; open: number; wanted: boolean; pop: number; aside: number };
  card?: { layout: CardLayout; uniforms: CardUniforms; mirror: THREE.Mesh; tint: THREE.Color; picture: THREE.Texture | null };
  title?: boolean;
  href?: string;
  external?: boolean;
};

// `sized`: each card's poster drawn at the card's own pixels (coverPicture), rather than the poster itself, cropped and scaled
// by the GPU.
export function buildPage(layout: PageLayout, fonts: Fonts, posters: Map<string, { poster: THREE.Texture; tint: THREE.Color }>, geometry: THREE.PlaneGeometry, marks = true, over?: (d: Node<"vec3">) => Node<"vec3">, sized = false) {
  const items: Item[] = [];
  const disposables: { dispose: () => void }[] = [];
  const group = new THREE.Group();
  const reflections = new THREE.Group();
  const today = promptDayFor(new Date());
  const hover = () => ({ lift: 0, zoom: 0, open: 0, wanted: false, pop: 0, aside: 0 });

  const addText = (texture: THREE.Texture, rect: Rect, extra: Partial<Item> & { intro: number; rise: number; base: number }) => {
    const { material, opacity } = textMaterial(texture, over);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2;
    group.add(mesh);
    disposables.push(texture, material);
    const item: Item = { mesh, art: texture, rect: texelRect(texture, rect), delay: 0, opacity, hover: hover(), ...extra };
    items.push(item);
    return item;
  };

  // The header rises in turn, 0.1 s apart after 0.05 s; then the cards, 0.028 s apart after 0.3 s. As the Gallery.
  if (marks) {
    addText(markTexture("Adam Chernick", layout.home.w, fonts), layout.home, { intro: 0.05, rise: 14, base: 0.62, href: "/" });
    addText(markTexture("Github", layout.github.w, fonts, true), layout.github, { intro: 0.05, rise: 14, base: 0.62, href: REPO, external: true });
  }
  const { title } = layout;
  const titleRect = { x: title.x - title.size * TITLE_PAD.x, y: title.y - title.size * TITLE_PAD.y, w: title.w + title.size * TITLE_PAD.x * 2, h: title.h + title.size * TITLE_PAD.y * 2 };
  addText(titleTexture(layout, fonts), titleRect, { intro: 0.15, rise: 34, base: 1, title: true });
  addText(blurbTexture(layout, fonts), { ...layout.blurb, h: layout.blurb.h + 4 }, { intro: 0.25, rise: 14, base: 0.62 });

  layout.cards.forEach((card, index) => {
    const words = cardTexture(card, fonts, card.day.day === today);
    const found = card.poster ? posters.get(card.slug) : undefined;
    const tint = found?.tint ?? new THREE.Color("#3a3d46");
    const picture = found && sized ? coverPicture(found.poster.image as HTMLImageElement, card.w, card.h) : null;
    if (picture) disposables.push(picture);
    const { material, uniforms } = cardMaterial(words, picture ?? found?.poster ?? null, card.open, card.day.day === today, tint);
    uniforms.size.value.set(card.w, card.h);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1;
    group.add(mesh);
    // Its reflection in the floor: the same card, turned upside down under it.
    const mirror = new THREE.Mesh(geometry, material);
    mirror.matrixAutoUpdate = false;
    mirror.renderOrder = -3;
    mirror.frustumCulled = false;
    reflections.add(mirror);
    disposables.push(words, material);
    items.push({
      mesh,
      art: words,
      rect: card,
      intro: 0.3 + index * 0.028,
      rise: 14,
      delay: (index / days.length) * STAGGER,
      base: 1,
      opacity: uniforms.opacity,
      hover: hover(),
      card: { layout: card, uniforms, mirror, tint, picture },
      href: card.open ? `${HUB}${card.slug}/` : undefined
    });
  });

  return { group, reflections, items, disposables };
}

// The ring the page becomes, laid out round `anchor`, the point on the page that was in the middle of the screen: its
// middle a little ahead, `focus` straight ahead across it, and the walker starting between the middle and the near side.
// Laid out once for each anchor; nothing in it is changed after.
function ringAt(anchor: number, focus: number) {
  const centre = new THREE.Vector3(0, 0, anchor - 1 - RING.radius * 0.3);
  const step = (Math.PI * 2) / RING.count;
  const start = -(focus - 1) * step;
  const portals = Array.from({ length: RING.count }, (_, index) => {
    const angle = start + index * step;
    const out = new THREE.Vector3(Math.sin(angle), 0, -Math.cos(angle));
    return {
      position: centre.clone().addScaledVector(out, RING.radius).setY(PORTAL.h / 2 + PORTAL.raise),
      // Facing in, towards the middle.
      normal: out.clone().negate(),
      tangent: new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)),
      quaternion: new THREE.Quaternion().setFromAxisAngle(UP, -angle)
    };
  });
  const portal = (day: number) => portals[day - 1];
  return { anchor, centre, start, portal, standing: centre.clone().add(new THREE.Vector3(0, EYE, RING.radius * 0.3)) };
}
type Ring = ReturnType<typeof ringAt>;

// Where a portal stands now: come out toward the ring's middle and grown as far as it is singled out, closed in behind a
// neighbour that is, and stood on the floor whatever its size. Returns its scale.
function placed(ring: Ring, day: number, hover: Item["hover"], out: THREE.Vector3) {
  const portal = ring.portal(day);
  const grow = 1 + growOf(hover.pop) * (GROW - 1);
  out
    .copy(portal.position)
    .addScaledVector(portal.normal, outOf(hover.pop) * PULL)
    .addScaledVector(portal.tangent, hover.aside)
    .setY((PORTAL.h * grow) / 2 + PORTAL.raise);
  return grow;
}

// The yaw that looks along `direction`, for a walker facing -z at a yaw of 0.
const yawAlong = (direction: THREE.Vector3) => Math.atan2(-direction.x, -direction.z);

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const approach = (from: number, to: number, time: number, delta: number) => to + (from - to) * Math.exp(-delta / time);
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

// A day's code starts downloading as soon as it is likely to be wanted: under the pointer, or when walking up to it.
function prefetch(fetched: Set<string>, slug: string) {
  if (fetched.has(slug)) return;
  fetched.add(slug);
  dayLoaders[slug]?.().catch(() => fetched.delete(slug));
}

// Whether to keep the moves short and still: the swing between page and world, the dive and the step back.
const stillness = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function HubScene() {
  const fonts = suspend(loadFonts, ["cv-hub-fonts"]);
  const posters = suspend(loadPosters, ["cv-hub-posters"]);
  const size = useThree((state) => state.size);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const renderer = useThree((state) => state.gl);
  const dom = renderer.domElement as HTMLCanvasElement;
  // The canvas size now, which the page's layout, made for its width alone, can be behind.
  const get = useThree((state) => state.get);
  const router = useRouter();

  // Straight ahead in the ring: two days before the latest, so that the newest stand just to the right.
  const focus = useMemo(() => Math.max(1, Math.max(...days.filter((day) => day.live).map((day) => day.day)) - 2), []);

  // Laid out again a moment after the window stops changing width, as a page reflows. Its height only sets how much of the
  // page is in view, which is read from the canvas as it is (a phone's address bar comes and goes without a new layout).
  const [layout, setLayout] = useState(() => layoutPage(size.width, size.height, fonts));
  useEffect(() => {
    if (layout.width === size.width) return;
    const timer = window.setTimeout(() => setLayout(layoutPage(size.width, size.height, fonts)), 150);
    return () => window.clearTimeout(timer);
  }, [size.width, size.height, fonts, layout.width]);

  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const page = useMemo(() => buildPage(layout, fonts, posters, geometry), [layout, fonts, posters, geometry]);
  const world = useMemo(() => {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), floorMaterial());
    floor.quaternion.copy(FLAT);
    floor.renderOrder = -1;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(150, 48, 24), skyMaterial());
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    const dust = motes(700);
    const { material, amount } = veilMaterial();
    const veil = new THREE.Mesh(geometry, material);
    veil.renderOrder = 10;
    veil.frustumCulled = false;
    return { floor, sky, dust, veil, veilAmount: amount };
  }, [geometry]);
  useDispose(geometry, world.floor.geometry, world.floor.material as THREE.Material, world.sky.geometry, world.sky.material as THREE.Material, world.dust.geometry, world.dust.material as THREE.Material, world.veil.material as THREE.Material);
  useDispose(...page.disposables);

  const run = useRef({
    morph: 0,
    scroll: 0,
    target: 0,
    // Flung scrolling on a touch screen, in CSS pixels a second.
    fling: 0,
    anchor: 0,
    ring: null as Ring | null,
    // Read once, as the hub comes up.
    still: false,
    restored: false,
    introAt: -1,
    walker: { position: new THREE.Vector3(), velocity: new THREE.Vector3(), yaw: 0, pitch: -0.12, stride: 0 },
    keys: new Set<string>(),
    // Walking by itself to a portal that was pressed, and through it.
    auto: null as null | { slug: string; day: number },
    leaving: null as null | { at: number; slug: string; dive: boolean; gone: boolean },
    // The portal being dived into.
    into: null as null | { position: THREE.Vector3; normal: THREE.Vector3 },
    // Back from a day by its calendar button: standing up against its portal and stepping back from it.
    // Its distance from the portal and the step's speed ride on x, for the shared spring.
    arrival: null as null | { day: number; at: number; start: number; distance: THREE.Vector3; velocity: THREE.Vector3; signalled: boolean },
    pointer: { down: null as null | { x: number; y: number; scroll: number }, moved: 0, touch: false, lastY: 0, lastAt: 0 },
    hovered: null as Item | null,
    fetched: new Set<string>(),
    cursor: "",
    sound: { beds: null as null | { level: (value: number) => void; stop: () => void }[], music: null as null | { url: string; stop: () => void }, near: null as string | null, bedLevel: -1 }
  });
  const items = useRef(page.items);
  items.current = page.items;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Sets off for a day: through a portal (a dive) or from the page (a fade). Set by the input effect.
  const leaveRef = useRef<(slug: string, dive: boolean) => void>(() => {});

  // Coming back from a day puts the visitor where they left: down the page, or in the world. By the calendar button, up
  // against the portal they went through, about to step back from it.
  useEffect(() => {
    const r = run.current;
    // Once only: in development React runs this twice, and the second would find the memory already spent.
    if (r.restored) return;
    r.restored = true;
    r.still = stillness();
    const memory = recall();
    r.introAt = performance.now() / 1000;
    document.documentElement.classList.remove("cv-hub-leaving");
    if (!memory) {
      // The toggle's last choice outlives the hub; a fresh visit starts on the page.
      resetView("2d");
      return;
    }
    r.scroll = r.target = memory.scroll;
    r.introAt = -100;
    if (memory.view === "3d") {
      const { width, height } = get().size;
      r.anchor = memory.anchor ?? (memory.scroll + height / 2) * PX;
      r.morph = 1;
      const ring = ringAt(r.anchor, focus);
      const day = memory.from ? days.find((item) => daySlug(item) === memory.from) : undefined;
      if (day) {
        const portal = ring.portal(day.day);
        // Arriving, close enough that the portal's picture covers the screen edge to edge, its frame just out of view.
        // Kept still, it arrives where it would have stepped back to.
        const tan = Math.tan(THREE.MathUtils.degToRad(WALK_FOV / 2));
        const covering = Math.min(PORTAL.w / 2 / (tan * (width / height)), PORTAL.h / 2 / tan) * ARRIVE_COVER;
        const distance = memory.arriving && !r.still ? covering : STEP_BACK;
        r.walker.position.copy(portal.position).addScaledVector(portal.normal, distance).setY(EYE);
        r.walker.yaw = yawAlong(portal.normal.clone().negate());
        r.walker.pitch = memory.arriving ? 0 : Math.atan2(portal.position.y - EYE, distance);
        if (memory.arriving)
          r.arrival = { day: day.day, at: performance.now() / 1000, start: distance, distance: new THREE.Vector3(distance, 0, 0), velocity: new THREE.Vector3(), signalled: false };
      } else r.walker.position.copy(ring.standing);
    }
    resetView(memory.view);
    remember({ ...memory, from: undefined, arriving: undefined });
  }, [focus, get]);

  // No tone mapping while the hub is up: the page's colours go out as they are. Put back for the days.
  useEffect(() => {
    const before = scene.background;
    const toneMapping = renderer.toneMapping;
    scene.background = BG;
    renderer.toneMapping = THREE.NoToneMapping;
    const sounds = run.current.sound;
    return () => {
      scene.background = before;
      renderer.toneMapping = toneMapping;
      camera.fov = PAGE_FOV;
      camera.updateProjectionMatrix();
      dom.style.cursor = "";
      setMoving(false);
      setTipDay(null);
      worldAmount.value = 0;
      sounds.beds?.forEach((bed) => bed.stop());
      sounds.beds = null;
      sounds.music?.stop();
      sounds.music = null;
      sounds.bedLevel = -1;
    };
  }, [scene, camera, dom, renderer]);

  // Input. On the page: wheel, keys, and dragging on a touch screen scroll it; a press on a card or a mark follows it. In the
  // world: WASD or the arrows walk (Shift runs), dragging looks round, and a press on a portal walks into it.
  useEffect(() => {
    const r = run.current;
    const ndc = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const viewHeight = () => get().size.height;
    const maxScroll = () => Math.max(0, layoutRef.current.page - viewHeight());
    const onPage = () => r.morph === 0 && !hubState().moving && !r.leaving;
    const inWorld = () => r.morph === 1 && !hubState().moving && !r.leaving && !r.arrival;

    const pick = (event: PointerEvent) => {
      const bounds = dom.getBoundingClientRect();
      ndc.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const live = items.current.filter((item) => item.href && (onPage() || (inWorld() && item.card)));
      const hit = raycaster.intersectObjects(
        live.map((item) => item.mesh),
        false
      )[0];
      return hit ? live.find((item) => item.mesh === hit.object) ?? null : null;
    };

    const leave = (slug: string, dive: boolean) => {
      if (r.leaving) return;
      r.leaving = { at: performance.now() / 1000, slug, dive, gone: false };
      remember({ view: dive ? "3d" : "2d", scroll: r.target, from: slug, anchor: dive ? r.anchor : undefined });
      if (dive) {
        sound.play("whoosh", { gain: 0.9, pitch: 0.7 });
        sound.play("chime", { gain: 0.35, pitch: 0.8 });
      }
    };
    leaveRef.current = leave;

    const follow = (item: Item, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button?: number }) => {
      if (!item.href) return;
      if (item.external || event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) {
        window.open(item.href, "_blank", "noopener");
        return;
      }
      if (item.href === "/") {
        router.push("/");
        return;
      }
      if (item.card) leave(item.card.layout.slug, false);
    };

    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.(".cv-hub-hud")) return;
      // A pinch or Ctrl and the wheel is the browser's zoom, which the page lays itself out again for.
      if (event.ctrlKey) return;
      event.preventDefault();
      if (!onPage()) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewHeight() : 1;
      r.fling = 0;
      r.target = Math.min(maxScroll(), Math.max(0, r.target + event.deltaY * unit));
    };

    const onDown = (event: PointerEvent) => {
      r.pointer.down = { x: event.clientX, y: event.clientY, scroll: r.target };
      r.pointer.moved = 0;
      r.pointer.touch = event.pointerType !== "mouse";
      r.pointer.lastY = event.clientY;
      r.pointer.lastAt = performance.now();
      r.fling = 0;
      dom.setPointerCapture(event.pointerId);
    };

    const onMove = (event: PointerEvent) => {
      const down = r.pointer.down;
      if (down) {
        r.pointer.moved = Math.max(r.pointer.moved, Math.hypot(event.clientX - down.x, event.clientY - down.y));
        if (onPage() && r.pointer.touch) {
          const now = performance.now();
          const velocity = (-(event.clientY - r.pointer.lastY) / Math.max(1, now - r.pointer.lastAt)) * 1000;
          r.fling = r.fling * 0.6 + velocity * 0.4;
          r.pointer.lastY = event.clientY;
          r.pointer.lastAt = now;
          r.target = r.scroll = Math.min(maxScroll(), Math.max(0, down.scroll - (event.clientY - down.y)));
        }
        if (inWorld() && r.pointer.moved > 3) {
          const w = r.walker;
          w.yaw -= event.movementX * LOOK;
          w.pitch = Math.max(-1.2, Math.min(1.2, w.pitch - event.movementY * LOOK));
          r.auto = null;
        }
      }
      if (!r.pointer.touch || !down) {
        const hovered = pick(event);
        if (hovered !== r.hovered && hovered?.card && r.morph === 1) {
          // A soft ping as a portal is singled out, higher for later days.
          sound.play("ping", { gain: 0.16, pitch: 0.55 + hovered.card.layout.day.day / 60, gap: 0.08 });
        }
        r.hovered = hovered;
        if (hovered?.card) prefetch(r.fetched, hovered.card.layout.slug);
      }
    };

    const onUp = (event: PointerEvent) => {
      const down = r.pointer.down;
      r.pointer.down = null;
      if (dom.hasPointerCapture(event.pointerId)) dom.releasePointerCapture(event.pointerId);
      if (!down) return;
      if (r.pointer.moved > 6) {
        if (!(onPage() && r.pointer.touch && performance.now() - r.pointer.lastAt < 80)) r.fling = 0;
        return;
      }
      r.fling = 0;
      const item = pick(event);
      if (!item) return;
      if (onPage()) follow(item, event);
      else if (inWorld() && item.card) {
        // Off to that portal and through it, and no other: inside the ring, the straight way there crosses none.
        r.auto = { slug: item.card.layout.slug, day: item.card.layout.day.day };
        sound.play("click", { gain: 0.3 });
      }
    };

    const onLeave = () => {
      r.hovered = null;
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
      if (onPage()) {
        const height = viewHeight();
        const moves: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: height * 0.875, PageUp: -height * 0.875, " ": (event.shiftKey ? -1 : 1) * height * 0.875 };
        let next = r.target;
        if (event.key in moves) next += moves[event.key];
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = maxScroll();
        else return;
        if (target?.tagName === "BUTTON" && event.key === " ") return;
        event.preventDefault();
        r.fling = 0;
        r.target = Math.min(maxScroll(), Math.max(0, next));
        return;
      }
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"].includes(event.code)) {
        if (event.code.startsWith("Arrow")) event.preventDefault();
        r.keys.add(event.code);
        if (!event.code.startsWith("Shift")) r.auto = null;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => r.keys.delete(event.code);
    const onBlur = () => r.keys.clear();

    window.addEventListener("wheel", onWheel, { passive: false });
    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    dom.addEventListener("pointerleave", onLeave);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("wheel", onWheel);
      dom.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dom.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [camera, dom, router, get]);

  // In development, where each portal is on screen, for driving the hub from a test.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const handle = {
      screen: (day: number) => {
        const item = items.current.find((entry) => entry.card?.layout.day.day === day);
        if (!item) return null;
        const point = item.mesh.getWorldPosition(new THREE.Vector3()).project(camera);
        const { width, height } = get().size;
        return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height, ahead: point.z < 1 };
      },
      path: () => window.location.pathname
    };
    (window as unknown as { cvHub?: typeof handle }).cvHub = handle;
    return () => {
      delete (window as unknown as { cvHub?: typeof handle }).cvHub;
    };
  }, [camera, get]);

  const scratch = useMemo(
    () => ({
      pagePosition: new THREE.Vector3(),
      walkQuaternion: new THREE.Quaternion(),
      euler: new THREE.Euler(0, 0, 0, "YXZ"),
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      wish: new THREE.Vector3(),
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      local: new THREE.Vector3(),
      rel: new THREE.Vector3(),
      inverse: new THREE.Quaternion(),
      quaternion: new THREE.Quaternion(),
      colour: new THREE.Color(),
      stepBack: new THREE.Vector3(STEP_BACK, 0, 0),
      tip: new THREE.Vector3(),
      stand: new THREE.Vector3()
    }),
    []
  );

  useFrame(({ gl, size: view }: RootState, rawDelta: number) => {
    const r = run.current;
    const s = scratch;
    const delta = Math.min(rawDelta, 1 / 20);
    const now = performance.now() / 1000;
    // Placed across the page's own width, the one it was laid out for; seen through the canvas as it is.
    const { width } = layoutRef.current;
    const { height } = view;
    const maxScroll = Math.max(0, layoutRef.current.page - height);

    // The page: scrolling eases a touch, as a browser's does, and a fling runs on and slows.
    if (r.fling !== 0 && !r.pointer.down) {
      r.target = Math.min(maxScroll, Math.max(0, r.target + r.fling * delta));
      r.fling *= Math.exp(-delta / 0.33);
      if (Math.abs(r.fling) < 5 || r.target === 0 || r.target === maxScroll) r.fling = 0;
      r.scroll = r.target;
    }
    r.target = Math.min(maxScroll, r.target);
    r.scroll = approach(r.scroll, r.target, 0.07, delta);
    if (Math.abs(r.scroll - r.target) < 0.05) r.scroll = r.target;

    // Between page and world, at the pace the toggle asks for.
    const want = hubState().view === "3d" ? 1 : 0;
    if (r.morph !== want && !r.leaving) {
      if (r.morph === 1 - want) {
        // Setting out either way: whatever was under way in the world is dropped.
        r.auto = null;
        r.arrival = null;
        r.into = null;
        r.keys.clear();
      }
      if (r.morph === 0) {
        // Setting out from the page: the ring is laid out round what was in the middle of the screen.
        r.anchor = (r.scroll + height / 2) * PX;
        r.walker.position.copy(ringAt(r.anchor, focus).standing);
        r.walker.yaw = 0;
        r.walker.pitch = -0.12;
        r.walker.velocity.set(0, 0, 0);
        sound.play("whoosh", { gain: 0.6, pitch: 0.55 });
      }
      setMoving(true);
      const pace = r.still ? 0.5 : MORPH;
      r.morph = want > r.morph ? Math.min(1, r.morph + delta / pace) : Math.max(0, r.morph - delta / pace);
      if (r.morph === want) setMoving(false);
    }
    const amount = ease(r.morph);
    worldAmount.value = amount;
    if (r.ring?.anchor !== r.anchor) r.ring = ringAt(r.anchor, focus);
    const ring = r.ring;
    ringCentre.value.copy(ring.centre);
    ringStart.value = ring.start;

    // Walking, once in the world.
    const w = r.walker;
    const walkable = r.morph === 1 && !hubState().moving;
    if (walkable) {
      s.forward.set(-Math.sin(w.yaw), 0, -Math.cos(w.yaw));
      s.right.set(Math.cos(w.yaw), 0, -Math.sin(w.yaw));
      s.wish.set(0, 0, 0);
      const k = r.keys;
      const ahead = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
      const side = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
      s.wish.addScaledVector(s.forward, ahead).addScaledVector(s.right, side);
      if (s.wish.lengthSq() > 0) s.wish.normalize().multiplyScalar(k.has("ShiftLeft") || k.has("ShiftRight") ? RUN : WALK);

      if (r.arrival) {
        // Stepping back from the portal on a damped spring, its picture sinking back behind the frame as the eye leaves it.
        const a = r.arrival;
        const portal = ring.portal(a.day);
        const start = a.start;
        damp(a.distance, s.stepBack, a.velocity, 1, delta);
        if (!a.signalled && scenePhase.current === "live") {
          a.signalled = true;
          a.at = now;
          arrived();
          sound.play("whoosh", { gain: 0.5, pitch: 1.1 });
        }
        // Held up against the picture while the day's last frame fades into it, then stepping back.
        if (!a.signalled || now - a.at < ARRIVE_HOLD) {
          a.velocity.set(0, 0, 0);
          a.distance.set(start, 0, 0);
        }
        const back = start < STEP_BACK ? clamp01((a.distance.x - start) / (STEP_BACK - start)) : 1;
        w.position.copy(portal.position).addScaledVector(portal.normal, a.distance.x);
        w.position.y = THREE.MathUtils.lerp(portal.position.y, EYE, back);
        w.pitch = 0;
        w.velocity.set(0, 0, 0);
        if (a.signalled && now - a.at >= ARRIVE_HOLD && (Math.abs(a.distance.x - STEP_BACK) < 0.01 || s.wish.lengthSq() > 0)) r.arrival = null;
        s.to.copy(w.position);
      } else if (r.leaving?.dive && r.into) {
        // Up to the picture until it fills the view, square on to it.
        s.wish.copy(r.into.position).addScaledVector(r.into.normal, 0.12).sub(w.position).setY(0);
        const speed = Math.min(2.4, s.wish.length() * 6);
        if (s.wish.lengthSq() > 0) s.wish.normalize().multiplyScalar(speed);
        w.yaw += wrap(yawAlong(s.rel.copy(r.into.normal).negate()) - w.yaw) * (1 - Math.exp(-delta / 0.18));
        w.pitch = approach(w.pitch, Math.atan2(r.into.position.y - EYE, 1) * 0.5, 0.18, delta);
      } else if (r.auto) {
        const auto = items.current.find((item) => item.card?.layout.day.day === r.auto?.day);
        if (auto) placed(ring, r.auto.day, auto.hover, s.stand);
        else s.stand.copy(ring.portal(r.auto.day).position);
        s.wish.copy(s.stand).sub(w.position).setY(0);
        w.yaw += wrap(yawAlong(s.wish) - w.yaw) * (1 - Math.exp(-delta / 0.25));
        w.pitch = approach(w.pitch, -0.04, 0.4, delta);
        s.wish.normalize().multiplyScalar(WALK * 1.15);
      }

      if (!r.arrival) {
        w.velocity.lerp(s.wish, 1 - Math.exp(-delta / 0.14));
        s.from.copy(w.position);
        s.to.copy(w.position).addScaledVector(w.velocity, delta);

        // The ring holds the walker in. An open portal takes them in from just short of its face; while walking to one
        // that was pressed, only that one does.
        s.rel.subVectors(s.to, ring.centre).setY(0);
        const reach = RING.radius - 0.3;
        if (!r.leaving) {
          for (const item of items.current) {
            if (!item.card) continue;
            const { layout: card } = item.card;
            const portal = ring.portal(card.day.day);
            const grow = placed(ring, card.day.day, item.hover, s.stand);
            s.local.subVectors(s.to, s.stand).setY(0);
            const facing = s.local.dot(portal.normal);
            const across = Math.abs(s.local.dot(portal.tangent));
            if (card.open && facing < 7 && across < 5) prefetch(r.fetched, card.slug);
            const wanted = !r.auto || r.auto.slug === card.slug;
            if (card.open && wanted && across < (PORTAL.w * grow) / 2 - 0.15 && facing < 0.75 && s.wish.dot(portal.normal) < 0) {
              r.into = { position: s.stand.clone(), normal: portal.normal };
              r.auto = null;
              leaveRef.current(card.slug, true);
              break;
            }
          }
        }
        if (s.rel.length() > reach && !r.leaving) s.rel.setLength(reach);
        if (!r.leaving) s.to.set(ring.centre.x + s.rel.x, EYE, ring.centre.z + s.rel.z);
        // Footsteps on the stone, a stride apart.
        w.stride += Math.hypot(s.to.x - w.position.x, s.to.z - w.position.z);
        if (w.stride > STRIDE) {
          w.stride = 0;
          sound.play("step", { variant: "stone", gain: 1.7, pitch: 0.92 + Math.random() * 0.12 });
        }
        w.position.copy(s.to);
        w.position.y = EYE;
      }
    }

    // The camera: straight down over the page, or at eye height in the world, and on the way between, swung from one to
    // the other.
    const lift = height / 2 / Math.tan(THREE.MathUtils.degToRad(PAGE_FOV / 2));
    s.pagePosition.set(0, lift * PX, (r.scroll + height / 2) * PX);
    s.euler.set(w.pitch, w.yaw, 0, "YXZ");
    s.walkQuaternion.setFromEuler(s.euler);
    camera.position.lerpVectors(s.pagePosition, w.position, amount);
    // A rise on the way, so the swing passes over the page rather than through it.
    if (!r.still) camera.position.y += Math.sin(amount * Math.PI) * 2.5;
    camera.quaternion.slerpQuaternions(FLAT, s.walkQuaternion, amount);
    const fov = THREE.MathUtils.lerp(PAGE_FOV, WALK_FOV, amount);
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    world.floor.position.set(camera.position.x, 0, camera.position.z);
    world.sky.position.copy(camera.position);
    world.sky.visible = amount > 0.001;
    world.dust.visible = amount > 0.001;

    // Each thing on the page: rising into view as the page opens, lifting under the pointer, and on the way to the world,
    // leaving the page in turn for its place in the ring.
    let cursor = "";
    const light = portalLight.image.data as Float32Array;
    // The portal most singled out, which the others ease aside for.
    let popDay = 0;
    let popped = 0;
    for (const item of items.current) {
      if (item.card && item.hover.pop > popped) {
        popped = item.hover.pop;
        popDay = item.card.layout.day.day;
      }
    }
    for (const item of items.current) {
      const { mesh, rect } = item;
      const since = now - r.introAt - item.intro;
      const big = item.rise > 20;
      const entered = 1 - Math.pow(1 - clamp01(since / (big ? 0.8 : 0.55)), 3);
      const hovered = r.hovered === item && (r.morph === 0 || r.morph === 1) && !r.leaving;
      if (hovered) cursor = "pointer";
      item.hover.lift = approach(item.hover.lift, hovered ? 1 : 0, 0.12, delta);
      item.hover.zoom = approach(item.hover.zoom, hovered ? 1 : 0, 0.3, delta);

      const own = smooth(clamp01((r.morph - item.delay) / (1 - STAGGER)));
      // Flat on the page, in metres.
      const pageY = rect.y + rect.h / 2 + (1 - entered) * item.rise - (item.card ? 7 * item.hover.lift : 0);
      s.from.set((rect.x + rect.w / 2 - width / 2) * PX, 0.002, pageY * PX);
      const flatW = rect.w * PX;
      const flatH = rect.h * PX;
      let alpha = item.base + (1 - item.base) * (item.card ? 0 : item.hover.lift);
      alpha *= entered;

      if (item.card) {
        const { layout: card, uniforms: u, mirror, tint } = item.card;
        const portal = ring.portal(card.day.day);
        const diving = r.leaving?.dive && r.leaving.slug === card.slug;
        // Out of the ring and twice the size while under the pointer, pressed, or being walked into.
        const singled = card.open && r.morph === 1 && !hubState().moving && !r.arrival && (hovered || r.auto?.slug === card.slug || !!diving);
        // At an even pace, so that the eased steps within it play out the same way coming and going.
        item.hover.pop = clamp01(item.hover.pop + ((singled ? 1 : -1) * delta) / POP);
        const apart = card.day.day - popDay;
        item.hover.aside = popDay && apart !== 0 && Math.abs(apart) < FILL.length ? -Math.sign(apart) * FILL[Math.abs(apart)] * outOf(popped) : 0;
        const grow = placed(ring, card.day.day, item.hover, s.stand);
        mesh.position.lerpVectors(s.from, s.stand, own);
        if (!r.still) mesh.position.y += Math.sin(own * Math.PI) * 1.4;
        mesh.quaternion.slerpQuaternions(FLAT, portal.quaternion, own);
        mesh.scale.set(THREE.MathUtils.lerp(flatW, PORTAL.w * grow, own), THREE.MathUtils.lerp(flatH, PORTAL.h * grow, own), 1);
        mesh.updateMatrix();
        mirror.matrix.multiplyMatrices(FLIP, mesh.matrix);
        mirror.visible = amount > 0.02;

        // A portal opens under the pointer, when walked up to, and while being dived into or stepped back from.
        s.local.subVectors(w.position, portal.position).setY(0);
        const near = r.morph === 1 && s.local.dot(portal.normal) > 0 && s.local.dot(portal.normal) < STEP_BACK && Math.abs(s.local.dot(portal.tangent)) < 1.6;
        const back = r.arrival?.day === card.day.day;
        const wanted = card.open && r.morph === 1 && (hovered || near || !!diving || back || r.auto?.slug === card.slug);
        if (wanted && !item.hover.wanted) sound.play("whoosh", { gain: 0.22, pitch: 1.4 + card.day.day / 40, gap: 0.15 });
        item.hover.wanted = wanted;
        item.hover.open = back ? 1 : approach(item.hover.open, wanted ? 1 : 0, wanted ? 0.28 : 0.45, delta);
        u.open.value = item.hover.open;
        u.depth.value = back ? (r.arrival?.signalled ? smooth(clamp01((now - (r.arrival?.at ?? now) - ARRIVE_HOLD) / 1.4)) : 0) : approach(u.depth.value, 1, 0.3, delta);
        u.lift.value = item.hover.lift;
        u.zoom.value = item.hover.zoom;
        u.metres.value.set(mesh.scale.x, mesh.scale.y);
        s.inverse.copy(mesh.quaternion).invert();
        u.eye.value.copy(s.rel.subVectors(camera.position, mesh.position).applyQuaternion(s.inverse));

        // Its light on the floor: its colour, dim at rest, bright as it opens. Closed days give hardly any.
        const at = (card.day.day - 1) * 4;
        s.colour.copy(tint);
        const glow = card.open ? 0.35 + item.hover.open * 0.9 : 0.05;
        light[at] = s.colour.r;
        light[at + 1] = s.colour.g;
        light[at + 2] = s.colour.b;
        light[at + 3] = glow;
      } else if (item.title) {
        // The title is laid into the floor in the middle of the ring.
        const wide = 7.5;
        mesh.position.lerpVectors(s.from, s.to.copy(ring.centre).setY(0.004), own);
        if (!r.still) mesh.position.y += Math.sin(own * Math.PI) * 3;
        mesh.quaternion.copy(FLAT);
        mesh.scale.set(THREE.MathUtils.lerp(flatW, wide, own), THREE.MathUtils.lerp(flatH, (wide * rect.h) / rect.w, own), 1);
      } else {
        // The marks and the line under the title have no place in the world: they fade as it begins.
        mesh.position.copy(s.from);
        mesh.quaternion.copy(FLAT);
        mesh.scale.set(flatW, flatH, 1);
        alpha *= 1 - smooth(clamp01(r.morph / 0.2));
      }
      // Laid in the floor, the title is an inlay, not a sign.
      if (item.title) alpha *= 1 - amount * 0.55;
      item.opacity.value = alpha;
      mesh.visible = alpha > 0.001;
    }
    portalLight.needsUpdate = true;

    // Over the portal under the pointer, a word on its day, pinned just above its frame.
    const tipped = r.hovered?.card && r.morph === 1 && !hubState().moving && !r.leaving && !r.arrival && !r.auto ? r.hovered : null;
    if (tipped?.card) {
      const grow = placed(ring, tipped.card.layout.day.day, tipped.hover, s.tip);
      s.tip.y += (PORTAL.h * grow) / 2 + 0.12;
      s.tip.project(camera);
      // Kept on screen: a grown portal close by can reach past the top, and the card hangs up from this point.
      if (s.tip.z < 1) placeTip(((s.tip.x + 1) / 2) * view.width, Math.max(TIP_ROOM, ((1 - s.tip.y) / 2) * height));
    }
    setTipDay(tipped?.card && s.tip.z < 1 ? tipped.card.layout.day.day : null);
    if (!cursor && r.morph === 1 && !hubState().moving && !r.leaving && !r.arrival) cursor = r.pointer.down && r.pointer.moved > 3 ? "grabbing" : "grab";
    if (cursor !== r.cursor) {
      r.cursor = cursor;
      dom.style.cursor = cursor;
    }

    // Sound, in the world only: a low drone and a shimmer under everything, the hub's music, and close to an open portal,
    // its own day's music coming through it instead.
    const a = r.sound;
    if (amount > 0.001 && !a.beds) a.beds = [sound.bed("drone", 0), sound.bed("shimmer", 0)];
    if (a.beds && (Math.abs(a.bedLevel - amount) > 0.02 || (amount === 0 && a.bedLevel !== 0))) {
      a.bedLevel = amount;
      a.beds[0].level(0.16 * amount);
      a.beds[1].level(0.07 * amount);
    }
    let near: string | null = null;
    if (r.morph === 1) {
      let best = Infinity;
      for (const item of items.current) {
        if (!item.card?.layout.open || !DAY_MUSIC[item.card.layout.slug]) continue;
        const distance = Math.hypot(w.position.x - item.mesh.position.x, w.position.z - item.mesh.position.z);
        const keep = item.card.layout.slug === a.near ? LOSE : HEAR;
        if (distance < keep && distance < best) {
          best = distance;
          near = item.card.layout.slug;
        }
      }
    }
    a.near = near;
    const music = amount > 0.6 && !r.leaving ? (near ? DAY_MUSIC[near] : HUB_MUSIC) : null;
    if ((a.music?.url ?? null) !== music) {
      a.music?.stop();
      a.music = music ? { url: music, stop: sound.music(music, near ? 0.3 : 0.2) } : null;
    }

    // Leaving for a day: from the page, a quick fade; through a portal, up to its picture as the dark closes in.
    if (r.leaving) {
      const t = now - r.leaving.at;
      const dive = r.leaving.dive && !r.still;
      const length = dive ? 0.9 : 0.22;
      const hold = dive ? 0.4 : 0;
      world.veilAmount.value = smooth(clamp01((t - hold) / (length - hold)));
      if (t >= length && !r.leaving.gone) {
        r.leaving.gone = true;
        router.push(`${HUB}${r.leaving.slug}/`);
      }
    } else world.veilAmount.value = 0;
    world.veil.visible = world.veilAmount.value > 0;
    if (world.veil.visible) {
      camera.getWorldDirection(s.forward);
      world.veil.position.copy(camera.position).addScaledVector(s.forward, 0.2);
      world.veil.quaternion.copy(camera.quaternion);
      world.veil.scale.setScalar(2);
    }

    if (scenePhase.current !== "hold") gl.render(scene, camera);
  }, 1);

  return (
    <>
      <primitive object={world.sky} />
      <primitive object={page.reflections} />
      <primitive object={world.floor} />
      <primitive object={world.dust} />
      <primitive object={page.group} />
      <primitive object={world.veil} />
    </>
  );
}
