"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { suspend } from "suspend-react";
import * as THREE from "three/webgpu";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { abs, color, dot, float, mix, normalView, positionLocal, positionViewDirection, pow, sign, sRGBTransferEOTF, texture, uniform, vec3, vec4 } from "three/tsl";
import { useDispose } from "@/shared/engine/dispose";
import { scenePhase } from "@/shared/engine/quality";
import { sound } from "@/shared/engine/sound";
import { LINKEDIN_URL, REPO, X_URL } from "@/shared/ui/social";
import { loadFonts } from "../hub/Hub";
import { ACTIONS, goFonts, goLabel, RAISE, type PageLayout } from "../hub/layout";
import { hubState, requestView } from "../hub/state";
import { whole } from "../hub/text";
import { hubSound } from "../sounds";
import { unfold } from "./kit";
import { hover as showHover, inked, pageSheet, place, shown } from "./mirror";
import { onSheet, PAGE_Z, sheetOf } from "./unfold";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The page's buttons as solid things, standing on it just above the cards' top right corner: the way between the page and the
// calendar, a white pill, and to its left where else Adam is, a white disc each with the mark standing out of it. On the page they
// lie flat in it, pressed to almost no depth; as the page becomes the calendar they stand out of it and turn with it, being
// part of it. Pointed at, one grows a little on a spring, coming up off the page and glowing at its rim once it stands out of
// it; pressed, it sinks.

// Where Adam is: each a mark drawn on a 24 unit square, as an SVG path, and the colour its rim glows when pointed at.
export const LINKS = [
  { name: "GitHub", href: REPO, glow: "#c9b6ff", d: "M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .31.2.69.82.57A12 12 0 0 0 12 .3" },
  { name: "X", href: X_URL, glow: "#ffffff", d: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" },
  { name: "LinkedIn", href: LINKEDIN_URL, glow: "#7fb8ff", d: "M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z" }
];

// A mark, stood up out of a face, centred, `size` across, with a little depth of its own.
export function markGeometry(d: string, size: number) {
  const data = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}"/></svg>`);
  const shapes = data.paths.flatMap((path) => SVGLoader.createShapes(path));
  const geometry = new THREE.ExtrudeGeometry(shapes, { depth: 1.6, bevelEnabled: true, bevelThickness: 0.5, bevelSize: 0.35, bevelSegments: 2, curveSegments: 10 });
  // SVG runs down the page; the world runs up.
  geometry.scale(size / 24, -size / 24, size / 24);
  geometry.center();
  return geometry;
}

// In CSS pixels of the page: their sizes as the page lays them out, how deep they stand, and the size of a mark.
const SIZE = { ...ACTIONS, depth: 12, mark: 18 };
// The page's white, on their faces, unlit, as the title's; their sides a warm grey, lit.
const WHITE = "#f2efe9";
const SIDE = "#c9c2b6";
const INK = "#241a10";
const SPRING = { stiffness: 140, damping: 11 };
// Seconds the way between the views takes to narrow to the way back, or widen again.
const SHORTEN = 0.55;
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
// How much bigger each grows when pointed at: a disc more, being small, so that it grows by as much to the eye as the pill.
const GROW = { pill: 0.06, disc: 0.2 };

// A solid with rounded edges, its back on the page and its face `depth` in front.
const BEVEL = 0.32;
const grows = (depth: number) => depth * BEVEL * 0.85;
function solid(shape: THREE.Shape, depth: number) {
  const bevel = depth * BEVEL;
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: depth - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelSegments: 5, curveSegments: 40 });
  geometry.translate(0, 0, bevel);
  return geometry;
}

function pill(w: number, h: number) {
  const r = h / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 + r, -r);
  shape.lineTo(w / 2 - r, -r);
  shape.absarc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, false);
  shape.lineTo(-w / 2 + r, r);
  shape.absarc(-w / 2 + r, 0, r, Math.PI / 2, (Math.PI * 3) / 2, false);
  return shape;
}

function disc(r: number) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, r, 0, Math.PI * 2, false);
  return shape;
}

// Words in ink on a clear ground, w by h CSS pixels, drawn at three times that for the camera coming close.
function words(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * 3);
  canvas.height = Math.ceil(h * 3);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(3, 3);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    draw(ctx);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.anisotropy = 8;
  return map;
}

// On the page: the button drawn as the browser draws, at the screen's density and at the size it is shown (`fit` of its own,
// on a narrow window), whole CSS pixels of it, so that it is as sharp as the page's own words and the page as HTML shows
// the same pixels; laid flat over the solid, which takes its place as the page starts to become the calendar.
const density = () => Math.min(globalThis.devicePixelRatio || 1, 2);
function flat(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, fit = 1) {
  const scale = density();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(Math.ceil(w * fit) * scale);
  canvas.height = Math.ceil(Math.ceil(h * fit) * scale);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(canvas.width / w, canvas.height / h);
    ctx.textBaseline = "middle";
    draw(ctx);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}

type Button = {
  body: THREE.Mesh;
  // What stands out of the page, and what lies flat on it in its place there.
  solid: THREE.Object3D[];
  flat: THREE.Mesh;
  // What is printed on its face, and how far in front of it.
  printed: { part: THREE.Object3D; gap: number }[];
  pivot: THREE.Object3D;
  glow: { value: number };
  rise: number;
  velocity: number;
  // How much bigger it grows when pointed at.
  grow: number;
  press: () => void;
};

export function SolidButtons({ month, layout }: { month: THREE.Object3D; layout: PageLayout }) {
  const fonts = suspend(loadFonts, ["cv-hub-fonts"]);
  const camera = useThree((state) => state.camera);
  const dom = useThree((state) => state.gl.domElement) as HTMLCanvasElement;

  // Drawn again at another size, or at another density of the screen (the browser zoomed).
  const fit = layout.actions.scale;
  const sharpness = density();
  const built = useMemo(() => {
    const group = new THREE.Group();
    const disposables: { dispose: () => void }[] = [];
    const { height: h, gap, depth } = SIZE;
    const face = new THREE.MeshBasicNodeMaterial({ color: WHITE });
    disposables.push(face);
    // Each its own sides, to glow at the rim in its own colour when pointed at.
    const material = (glowColour: string) => {
      const glow = uniform(0);
      const side = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0 });
      const rim = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2.5) as any;
      // Unlit white while the button lies flat in the page, so that no edge of it shows there; lit grey as it stands out.
      side.colorNode = color(SIDE).mul(unfold.solidness) as any;
      side.emissiveNode = mix(color(WHITE), color(glowColour).mul(rim.mul(glow.mul(1.6))), unfold.solidness) as any;
      disposables.push(side);
      return { m: [face, side], glow };
    };
    // Ink on the white. The GPU blends in linear light, which leaves dark ink thinner than the browser's, which blends in
    // sRGB: so its coverage is bent to give over the white the colour the browser would, as the page's words are.
    const inked = (map: THREE.Texture) => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
      m.toneMapped = false;
      const node = texture(map);
      const fade = uniform(1);
      const [ink, white] = [new THREE.Color(INK), new THREE.Color(WHITE)];
      const css = (c: THREE.Color) => c.clone().convertLinearToSRGB().g;
      const wanted = (sRGBTransferEOTF(vec3(mix(float(css(white)), float(css(ink)), node.a))) as any).g;
      m.colorNode = vec4(color(INK), wanted.sub(white.g).div(ink.g - white.g).clamp(0, 1).mul(fade)) as any;
      disposables.push(m, map);
      return { m, node, fade };
    };
    const buttons: Button[] = [];

    // The way between the views: its words, where it goes larger and bolder, and the arrow apart from them so that it can
    // nudge on toward where it goes.
    const { lead: font, where } = goFonts(fonts);
    const measure = words(1, 1, () => undefined);
    const measuring = (measure.image as HTMLCanvasElement).getContext("2d")!;
    const { at: lead, text: textWidth, w: natural } = goLabel(measuring, fonts);
    // Whole pixels across, so that drawn flat it lies on the screen's pixels.
    const w = Math.ceil(natural);
    // In the calendar it says the way back, shorter: "Back to 2D", the 2D as bold, and the pill as much narrower.
    measuring.font = font;
    const backAt = measuring.measureText("Back to").width + 5;
    measuring.font = where;
    const backWidth = Math.ceil(backAt + measuring.measureText("2D").width) + 2;
    const narrower = w - Math.ceil(SIZE.padding * 2 + backWidth + 10 + SIZE.arrow);
    measure.dispose();
    const label = (c: CanvasRenderingContext2D, view: "2D" | "3D", x: number) => {
      c.font = font;
      c.fillText("Explore projects in", x, h / 2);
      c.font = where;
      c.fillText(view, x + lead, h / 2 + 0.5);
    };
    const draw = (view: "2D" | "3D") => words(textWidth, h, (c) => label(c, view, 0));
    const plain = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    plain.toneMapped = false;
    // Over the solid, whatever their depths, while one goes over to the other.
    plain.depthTest = false;
    const flatMaterial = (map: THREE.Texture) => {
      const m = plain.clone();
      m.map = map;
      disposables.push(m, map);
      return m;
    };
    disposables.push(plain);
    // The pill flat, with its words: the arrow is its own, either way.
    const goFlat = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      flatMaterial(
        flat(w, h, (c) => {
          c.fillStyle = WHITE;
          c.beginPath();
          c.roundRect(0, 0, w, h, h / 2);
          c.fill();
          c.fillStyle = INK;
          label(c, "3D", SIZE.padding);
        }, fit)
      )
    );
    disposables.push(goFlat.geometry);
    const toWorld = draw("3D");
    const toPage = words(backWidth, h, (c) => {
      c.font = font;
      c.fillText("Back to", 0, h / 2);
      c.font = where;
      c.fillText("2D", backAt, h / 2 + 0.5);
    });
    const arrowMap = words(16, h, (c) => {
      c.font = font;
      c.fillText("→", 0, h / 2);
    });
    const pillGeometry = solid(pill(w - grows(depth) * 2, h - grows(depth) * 2), depth);
    const plane = new THREE.PlaneGeometry(1, 1);
    disposables.push(pillGeometry, plane, toPage);
    const go = material("#ffe2b0");
    const goPivot = new THREE.Object3D();
    goPivot.position.set(-w / 2, h / 2, 0);
    // Narrowing: its halves drawn in toward each other by `squeeze` each, its round ends kept round (useFrame, below).
    const squeeze = uniform(0);
    const pillFace = new THREE.MeshBasicNodeMaterial({ color: WHITE });
    disposables.push(pillFace);
    for (const m of [pillFace, go.m[1]] as THREE.MeshBasicNodeMaterial[]) m.positionNode = positionLocal.sub(vec3(sign(positionLocal.x).mul(squeeze), 0, 0)) as any;
    const goBody = new THREE.Mesh(pillGeometry, [pillFace, go.m[1]]);
    const text = inked(toWorld);
    const textMesh = new THREE.Mesh(plane, text.m);
    textMesh.scale.set(textWidth, h, 1);
    textMesh.position.set(-w / 2 + SIZE.padding + textWidth / 2, 0, depth + 0.3);
    const back = inked(toPage);
    const backMesh = new THREE.Mesh(plane, back.m);
    backMesh.scale.set(backWidth, h, 1);
    backMesh.position.set(-w / 2 + SIZE.padding + backWidth / 2, 0, depth + 0.3);
    const arrow = inked(arrowMap);
    // On the page, the arrow too drawn as the browser draws, at the screen's density, as the page as HTML shows it.
    const arrowFlat = flat(16, h, (c) => {
      c.fillStyle = "#fff";
      c.font = font;
      c.fillText("→", 0, h / 2);
    }, fit);
    disposables.push(arrowFlat);
    const arrowMesh = new THREE.Mesh(plane, arrow.m);
    arrowMesh.scale.set(16, h, 1);
    arrowMesh.position.set(w / 2 - SIZE.padding - 8, 0, depth + 0.3);
    goFlat.position.z = 0.1;
    // Drawn after the solid's printing, and the arrow after it.
    goFlat.renderOrder = 5;
    arrowMesh.renderOrder = 6;
    goPivot.add(goBody, textMesh, backMesh, arrowMesh, goFlat);
    group.add(goPivot);
    buttons.push({
      body: goBody,
      // Its words shown as it narrows (useFrame, below).
      solid: [goBody],
      flat: goFlat,
      printed: [
        { part: textMesh, gap: 0.3 },
        { part: backMesh, gap: 0.3 },
        { part: arrowMesh, gap: 0.3 }
      ],
      pivot: goPivot,
      glow: go.glow,
      rise: 0,
      velocity: 0,
      grow: GROW.pill,
      press: () => requestView(hubState().view === "2d" ? "3d" : "2d")
    });

    // Where else Adam is, left of it: X, Github, then LinkedIn beside it.
    const discGeometry = solid(disc(h / 2 - grows(depth)), depth);
    const discPlane = new THREE.PlaneGeometry(h, h);
    disposables.push(discGeometry, discPlane);
    const markMaterial = new THREE.MeshStandardNodeMaterial({ color: INK, roughness: 0.35, metalness: 0 });
    disposables.push(markMaterial);
    const order = ["X", "GitHub", "LinkedIn"].map((name) => LINKS.find((link) => link.name === name)!);
    order.forEach((link, i) => {
      const { m, glow } = material(link.glow);
      const pivot = new THREE.Object3D();
      pivot.position.set(-w - gap - h / 2 - (order.length - 1 - i) * (h + gap), h / 2, 0);
      const body = new THREE.Mesh(discGeometry, m);
      const markShape = markGeometry(link.d, SIZE.mark);
      disposables.push(markShape);
      const mark = new THREE.Mesh(markShape, markMaterial);
      mark.position.z = depth + 2;
      // The disc flat, with its mark.
      const path = new Path2D(link.d);
      const discFlat = new THREE.Mesh(
        discPlane,
        flatMaterial(
          flat(h, h, (c) => {
            c.fillStyle = WHITE;
            c.beginPath();
            c.arc(h / 2, h / 2, h / 2, 0, Math.PI * 2);
            c.fill();
            c.fillStyle = INK;
            c.translate((h - SIZE.mark) / 2, (h - SIZE.mark) / 2);
            c.scale(SIZE.mark / 24, SIZE.mark / 24);
            c.fill(path);
          }, fit)
        )
      );
      discFlat.position.z = 0.1;
      discFlat.renderOrder = 5;
      pivot.add(body, mark, discFlat);
      group.add(pivot);
      buttons.push({ body, solid: [body, mark], flat: discFlat, printed: [{ part: mark, gap: 2 }], pivot, glow, rise: 0, velocity: 0, grow: GROW.disc, press: () => window.open(link.href, "_blank", "noopener") });
    });

    // Flat, where the arrow lies and how big, on whole CSS pixels as the page as HTML has it (below).
    const arrowAt = { x: arrowMesh.position.x, y: 0, w: 16, h };
    const short = { w, narrower, squeeze, text, back, textMesh, backMesh, textX: textMesh.position.x, backX: backMesh.position.x, goX: goPivot.position.x, discX: buttons.slice(1).map((button) => button.pivot.position.x) };
    return { group, buttons, short, text, toWorld, toPage, arrowMesh, arrow: arrow.node, arrowMap, arrowFlat, arrowAt, arrowX: arrowMesh.position.x, disposables };
  }, [fonts, fit, sharpness]);
  useDispose(...built.disposables);

  // On the month, where the page lays them out, in CSS pixels of the page.
  useEffect(() => {
    month.add(built.group);
    return () => {
      month.remove(built.group);
    };
  }, [month, built]);
  useEffect(() => {
    const sheet = sheetOf(layout);
    const { right, bottom, scale } = layout.actions;
    onSheet(sheet, whole(right), whole(bottom), built.group.position, PAGE_Z);
    built.group.scale.setScalar(sheet.u * scale);
  }, [layout, built]);

  // On the page as HTML (mirror.ts): each flat, as drawn for the GPU, where it lies, growing and sinking as pointed at and
  // pressed; the pill with its arrow, in ink, nudged on toward where it goes. Made in an effect: a canvas can be in one
  // place only, and React's dev mode makes a memo twice.
  const mirrored = useRef<HTMLElement[]>([]);
  // Each on whole CSS pixels, as the browser paints a box, and the GPU's flat moved onto the same ones.
  useEffect(() => {
    const { right, bottom, scale } = layout.actions;
    const d = density();
    // A picture's box on the page, on whole CSS pixels, centred as near as can be on (cx, cy); and the GPU's flat of it
    // moved onto it, in its button's own units.
    const onPixels = (art: HTMLCanvasElement, cx: number, cy: number, mesh: THREE.Object3D, size: { w: number; h: number }, base = { x: 0, y: 0 }) => {
      const [w, h] = [art.width / d, art.height / d];
      const box = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
      mesh.position.x = base.x + (box.x + w / 2 - cx) / scale;
      mesh.position.y = base.y - (box.y + h / 2 - cy) / scale;
      mesh.scale.set(w / scale / size.w, h / scale / size.h, 1);
      return box;
    };
    const made = built.buttons.map((button, i) => {
      const art = (button.flat.material as THREE.MeshBasicNodeMaterial).map!.image as HTMLCanvasElement;
      const { width, height } = (button.flat.geometry as THREE.PlaneGeometry).parameters;
      const [cx, cy] = [whole(right) + button.pivot.position.x * scale, whole(bottom) - button.pivot.position.y * scale];
      const box = onPixels(art, cx, cy, button.flat, { w: width, h: height });
      const element = place(document.createElement("div"), box);
      element.className = "cv-page-html-button";
      element.style.setProperty("--grow", String(1 + button.grow));
      element.style.setProperty("--sink", String(1 - 0.4 * button.grow));
      element.appendChild(shown(art, { x: 0, y: 0, w: box.w, h: box.h }));
      if (i === 0) {
        const arrowArt = built.arrowFlat.image as HTMLCanvasElement;
        const probe = new THREE.Object3D();
        const at = onPixels(arrowArt, cx + built.arrowX * scale, cy, probe, { w: 16, h: SIZE.height }, { x: built.arrowX, y: 0 });
        Object.assign(built.arrowAt, { x: probe.position.x, y: probe.position.y, w: probe.scale.x * 16, h: probe.scale.y * SIZE.height });
        element.appendChild(shown(inked(arrowArt, INK), { x: at.x - box.x, y: at.y - box.y, w: at.w, h: at.h }, "cv-page-html-art cv-page-html-arrow"));
      }
      return element;
    });
    pageSheet().append(...made);
    mirrored.current = made;
    return () => made.forEach((element) => element.remove());
  }, [layout, built]);

  const state = useRef({ hovered: null as Button | null, down: null as null | { x: number; y: number; on: Button | null } });
  useEffect(() => {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const bodies = built.buttons.map((button) => button.body);
    const s = state.current;
    const pick = (event: PointerEvent) => {
      const bounds = dom.getBoundingClientRect();
      ndc.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      // The pill only as narrow as it is drawn (useFrame, below).
      const hit = raycaster.intersectObjects(bodies, false).find((h) => h.object !== bodies[0] || Math.abs(bodies[0].worldToLocal(h.point.clone()).x) <= built.short.w / 2 - built.short.squeeze.value);
      return hit ? built.buttons.find((button) => button.body === hit.object) ?? null : null;
    };
    const point = (button: Button | null) => {
      if (button === s.hovered) return;
      s.hovered = button;
      if (!button) {
        for (const surface of surfaces(dom)) surface.style.cursor = unfold.inWorld ? "grab" : "";
        return;
      }
      // Quiet on the page, as a page is.
      if (unfold.inWorld) hubSound("hover", { pitch: 1.2, gain: 0.8 });
    };
    // On the page, presses land on the scrolling box over the canvas (spaces/unfold.tsx): taken from the stage they both sit in.
    const stage = dom.closest<HTMLElement>(".cv-stage") ?? dom;
    const onDown = (event: PointerEvent) => {
      if (!surfaces(dom).some((surface) => surface.contains(event.target as Node))) return;
      s.down = { x: event.clientX, y: event.clientY, on: pick(event) };
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && !s.down) point(pick(event));
    };
    const onUp = (event: PointerEvent) => {
      const down = s.down;
      s.down = null;
      if (!down?.on || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6 || pick(event) !== down.on || hubState().moving) return;
      // The way between the views has its own press; the others, the engine's click.
      if (down.on === built.buttons[0]) hubSound("press");
      else sound.play("click", { gain: 0.25, pitch: 1.1 });
      down.on.press();
    };
    stage.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      stage.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [built, camera, dom]);

  // When the page came into view, for the buttons to pop up into it one after another, after the title and words.
  const intro = useRef(Infinity);
  // How far the way between the views has gone over to the way back, 0 to 1: it narrows once it stands in the calendar,
  // and widens again as soon as the way back to the page begins. Where it starts, in the calendar already, it is there.
  const shortened = useRef<number | null>(null);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 30);
    const now = performance.now() / 1000;
    if (intro.current === Infinity && scenePhase.current === "live") intro.current = now;
    const s = state.current;
    const moving = hubState().moving;
    // Flat in the page, there; standing out of it in the world. Never quite flat, so that its face never meets the page's.
    const solid = Math.max(unfold.solid, 0.02);
    // Flat and sharp while the page rests; going over to solid over the first moments of the move, the flat picture over
    // the solid, fading.
    const standing = unfold.standing;
    const inWorld = hubState().view === "3d";
    if (shortened.current === null) shortened.current = inWorld ? 1 : 0;
    if (!inWorld) shortened.current = Math.max(0, shortened.current - delta / SHORTEN);
    else if (standing >= 1) shortened.current = Math.min(1, shortened.current + delta / SHORTEN);
    const short = built.short;
    const k = smoother(shortened.current);
    // Narrowed from both sides about its middle, its middle moved over so that its right edge stays where it is, and the
    // others to its left moved over with its left edge; its words going over from the one to the other as it narrows.
    const squeeze = (short.narrower / 2) * k;
    short.squeeze.value = squeeze;
    built.buttons[0].pivot.position.x = short.goX + squeeze;
    built.buttons.slice(1).forEach((button, i) => (button.pivot.position.x = short.discX[i] + squeeze * 2));
    short.textMesh.position.x = short.textX + squeeze;
    short.backMesh.position.x = short.backX + squeeze;
    short.text.fade.value = Math.min(1, Math.max(0, 1 - k * 2));
    short.back.fade.value = Math.min(1, Math.max(0, k * 2 - 1));
    short.backMesh.visible = standing > 0 && k > 0.5;
    short.textMesh.visible = standing > 0 && k < 0.5;
    built.buttons.forEach((button, i) => {
      showHover(mirrored.current[i], button === s.hovered && !moving, s.down?.on === button);
      // From the right, the way between the views first: up from nothing on a spring, past full size and back.
      const since = (now - intro.current - 0.45 - (i === 0 ? 0 : (built.buttons.length - i) * 0.07)) / 0.7;
      const popped = since <= 0 ? 0 : since >= 1.4 ? 1 : 1 - Math.exp(-6 * since) * Math.cos(since * 6.5);
      button.flat.visible = standing < 1;
      (button.flat.material as THREE.MeshBasicNodeMaterial).opacity = 1 - standing;
      for (const part of button.solid) part.visible = standing > 0;
      const pressed = s.down?.on === button;
      const want = pressed ? -0.4 : button === s.hovered && !moving ? 1 : 0;
      const force = (want - button.rise) * SPRING.stiffness - button.velocity * SPRING.damping;
      button.velocity += force * delta;
      button.rise += button.velocity * delta;
      const grow = 1 + button.rise * button.grow;
      button.pivot.position.z = button.rise * 7 * unfold.solid;
      button.pivot.position.y = SIZE.height / 2 + RAISE * unfold.solid;
      button.pivot.scale.set(grow * popped + 1e-4, grow * popped + 1e-4, solid);
      // What is printed on it stays the same way in front of its face however flat it is, rather than being pressed into
      // it: pressed, the two would flicker through each other as it begins to stand out.
      // Flat, on the page, with it, so that it lies where the page as HTML shows it.
      for (const { part, gap } of button.printed) part.position.z = standing > 0 ? SIZE.depth + gap / solid : 0.2;
      button.glow.value = Math.max(0, button.rise) * unfold.solid;
    });
    // Its arrow nudged on toward where it goes while pointed at. Flat, drawn as the page as HTML shows it, and where;
    // standing, its own, sharper for the camera coming close, at the narrowed pill's end.
    const arrowAt = standing > 0 ? { x: built.arrowX - squeeze, y: 0, w: 16, h: SIZE.height } : built.arrowAt;
    built.arrowMesh.position.set(arrowAt.x + Math.max(0, built.buttons[0].rise) * 3, arrowAt.y, built.arrowMesh.position.z);
    built.arrowMesh.scale.set(arrowAt.w, arrowAt.h, 1);
    built.arrow.value = standing > 0 ? built.arrowMap : built.arrowFlat;
  });

  // A button pointed at keeps the pointing hand, over the page's and the space's own cursors.
  useFrame(() => {
    if (!state.current.hovered) return;
    for (const surface of surfaces(dom)) if (surface.style.cursor !== "pointer") surface.style.cursor = "pointer";
  }, 0.92);

  return null;
}

// What the pointer lands on: the canvas, and the page's scrolling box over it while there is one.
function surfaces(dom: HTMLCanvasElement) {
  const box = dom.closest(".cv-stage")?.querySelector<HTMLElement>(".cv-page-scroll");
  return box ? [dom, box] : [dom];
}
