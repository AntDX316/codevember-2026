"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraPosition, color, exp, float, fract, length, mix, normalize, positionGeometry, sin, smoothstep, texture, time, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import { useDispose } from "@/shared/engine/dispose";
import { PLATE_ROOM, type PageLayout } from "../hub/layout";
import { mulberry32, unfold } from "./kit";
import { inked, pageSheet, shown } from "./mirror";
import { onSheet, PAGE_Z, sheetOf } from "./unfold";
import { whole } from "../hub/text";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What the month stands in, in place: a pale floor some way under it, fading out into the sky all round, with the month's
// soft shadow on it; and on the month, how many days of it are left. The floor and shadow come in as the page becomes the
// calendar; the days left are on the page too, and settle back onto the plate.

const smooth = (t: number) => t * t * (3 - 2 * t);
// How far under the month the floor lies, in metres, and how far the floor reaches.
const UNDER = 0.45;
const FLOOR = 70;

export function Floor({ layout }: { layout: PageLayout }) {
  const built = useMemo(() => {
    const fade = uniform(0);
    const group = new THREE.Group();
    // The floor: the sky's own pale grey low down, solid near the month and gone well before its edge.
    const floorMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const r = length(uv().sub(0.5).mul(2)) as any;
    floorMaterial.colorNode = vec4(color("#b9b9be"), smoothstep(0.45, 0.08, r).mul(0.7).mul(fade)) as any;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR, FLOOR), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.renderOrder = -2;
    // The shadow: soft and wide, darkest straight under the month, the long way along it.
    const shadowMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const q = uv().sub(0.5).mul(2) as any;
    const d = q.mul(vec2(1, 1.6)) as any;
    shadowMaterial.colorNode = vec4(color("#24242a"), exp(d.dot(d).mul(-3.2)).mul(0.5).mul(fade)) as any;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = -1;
    group.add(floor, shadow);
    return { group, floor, shadow, fade, disposables: [floor.geometry, floorMaterial, shadow.geometry, shadowMaterial] };
  }, []);
  useDispose(...built.disposables);

  useEffect(() => {
    const sheet = sheetOf(layout);
    const strip = layout.countdown.strip ? (layout.countdown.h + 16) * sheet.u : 0;
    const y = -sheet.h / 2 - PLATE_ROOM - strip - UNDER;
    built.floor.position.set(0, y, -2);
    built.shadow.position.set(0, y + 0.004, -0.3);
    built.shadow.scale.set(sheet.w * 1.25, 2.6, 1);
  }, [layout, built]);

  useFrame(() => {
    built.fade.value = smooth(unfold.amount);
    built.group.visible = unfold.amount > 0;
  });

  return <primitive object={built.group} />;
}

// Motes in the air round the month, in front of it and behind: specks of warm white and gold, rising slowly and swaying as
// they go, each its own size and pace, twinkling a little. Come in with the calendar, gone again on the page.
const MOTES = { count: 160, round: [1.3, 0.9], before: 1.7, behind: 1.4 };
export function Motes({ layout }: { layout: PageLayout }) {
  const built = useMemo(() => {
    const random = mulberry32(23);
    const fade = uniform(0);
    // Room round the month, set from its size; the motes are laid out in the unit box and stretched over it.
    const room = uniform(new THREE.Vector3(1, 1, 1));
    const low = uniform(new THREE.Vector3());
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const at: number[] = [];
    const look: number[] = [];
    for (let i = 0; i < MOTES.count; i++) {
      // Where in the box, and how fast it rises, in boxes a second.
      at.push(random(), random(), random(), 0.012 + random() * 0.025);
      // Its size in metres, a phase for its sway and twinkle, how golden, and how bright.
      look.push(0.025 + random() ** 2 * 0.055, random() * 100, random() < 0.35 ? 1 : 0, 0.45 + random() * 0.55);
    }
    geometry.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(at), 4));
    geometry.setAttribute("aLook", new THREE.InstancedBufferAttribute(new Float32Array(look), 4));
    geometry.instanceCount = MOTES.count;
    // Both sides: which way round a quad faces the eye is of no matter for a speck.
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    material.toneMapped = false;
    const placed = attribute("aAt", "vec4") as any;
    const own = attribute("aLook", "vec4") as any;
    // Up through the box and round again, faded in at the bottom and out at the top.
    const up = fract(placed.y.add(time.mul(placed.w))) as any;
    const sway = vec3(sin(time.mul(0.4).add(own.y)).mul(0.12), 0, sin(time.mul(0.33).add(own.y.mul(1.3))).mul(0.1)) as any;
    const centre = vec3(placed.x, up, placed.z).mul(room).add(low).add(sway) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(vec3(toEye.z, 0, toEye.x.negate())) as any;
    const upward = normalize(toEye.cross(right).negate()) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(own.x))).add(upward.mul(positionGeometry.y.mul(own.x))) as any;
    const r = length(positionGeometry.xy) as any;
    const twinkle = sin(time.mul(1.3).add(own.y)).mul(0.25).add(0.75) as any;
    const ends = smoothstep(0, 0.12, up).mul(smoothstep(1, 0.82, up)) as any;
    material.colorNode = vec4(mix(color("#fffaf0"), color("#f0c987"), own.z) as any, smoothstep(1, 0.15, r).mul(own.w).mul(twinkle).mul(ends).mul(fade)) as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return { mesh, fade, room, low, disposables: [geometry, material] };
  }, []);
  useDispose(...built.disposables);

  useEffect(() => {
    const sheet = sheetOf(layout);
    const w = sheet.w + MOTES.round[0] * 2;
    const h = sheet.h + MOTES.round[1] * 2;
    built.room.value.set(w, h, MOTES.before + MOTES.behind);
    built.low.value.set(-w / 2, -h / 2, -MOTES.behind);
  }, [layout, built]);

  useFrame(() => {
    built.fade.value = smooth(Math.max(0, (unfold.amount - 0.25) / 0.75));
    built.mesh.visible = unfold.amount > 0.25;
  });

  return <primitive object={built.mesh} />;
}

// How many days are left, said in the corner the last week leaves empty, or under the cards: pale on the page's dark, and
// once the plate is out behind it, in warm ink on it. Drawn at the screen's density, as the page's words are.
export function Countdown({ layout, month, plate, fonts }: { layout: PageLayout; month: THREE.Object3D; plate: number; fonts: { display: string; body: string } }) {
  const built = useMemo(() => {
    const { w, h, left, strip } = layout.countdown;
    const scale = Math.min(globalThis.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(scale, scale);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      const number = left > 0 ? String(left) : "";
      const word = left > 1 ? "DAYS LEFT" : left === 1 ? "DAY LEFT" : "THAT'S A WRAP";
      const inset = 14;
      if (strip) {
        // One line: the number, then the words, along the bottom right.
        const size = h * 0.72;
        const small = Math.max(11, size * 0.26);
        ctx.font = `600 ${small}px ${fonts.body}`;
        ctx.letterSpacing = `${small * 0.14}px`;
        ctx.fillText(word, w - inset, h - inset);
        const across = ctx.measureText(word).width;
        ctx.font = `800 ${size}px ${fonts.display}`;
        ctx.letterSpacing = `${-size * 0.03}px`;
        ctx.fillText(number, w - inset - across - 10, h - inset);
      } else {
        // The number large, the words small under it, in the bottom right corner.
        const size = Math.min(h * 0.5, w * 0.4, 110);
        const small = Math.max(11, size * 0.16);
        ctx.font = `600 ${small}px ${fonts.body}`;
        ctx.letterSpacing = `${small * 0.14}px`;
        ctx.fillText(word, w - inset, h - inset);
        ctx.font = `800 ${size}px ${fonts.display}`;
        ctx.letterSpacing = `${-size * 0.03}px`;
        ctx.fillText(number, w - inset + size * 0.03, h - inset - small * 1.5);
      }
    }
    const map = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    material.toneMapped = false;
    material.colorNode = vec4(mix(color("#f2efe9"), color("#6b5638"), unfold.solidness), texture(map).a.mul(float(0.88))) as any;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    // As big as its pixels, one to each of the screen's.
    return { mesh, canvas, across: canvas.width / scale, down: canvas.height / scale, disposables: [map, material, mesh.geometry] };
  }, [layout, fonts]);
  useDispose(...built.disposables);

  useEffect(() => {
    month.add(built.mesh);
    return () => {
      month.remove(built.mesh);
    };
  }, [month, built]);

  const at = useMemo(() => {
    const sheet = sheetOf(layout);
    const { across, down } = built;
    built.mesh.scale.set(across * sheet.u, down * sheet.u, 1);
    return onSheet(sheet, whole(layout.countdown.x) + across / 2, whole(layout.countdown.y) + down / 2, new THREE.Vector3());
  }, [layout, built]);

  // On the page as HTML (mirror.ts): in the page's ink, as the GPU colours it.
  useEffect(() => {
    const element = shown(inked(built.canvas, "#f2efe9"), { x: whole(layout.countdown.x), y: whole(layout.countdown.y), w: built.across, h: built.down });
    element.style.opacity = "0.88";
    pageSheet().appendChild(element);
    return () => element.remove();
  }, [layout, built]);

  // On the page, in it; then back onto the plate's face as the plate comes out behind it.
  useFrame(() => {
    built.mesh.position.set(at.x, at.y, THREE.MathUtils.lerp(PAGE_Z, plate + 0.004, smooth(unfold.plate)));
  });

  return null;
}
