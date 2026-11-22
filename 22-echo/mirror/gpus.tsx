"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, float, texture, uv, vec2 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { lehmer } from "../../shared/engine/random";
import { loadRetried, suspendRetried } from "../../shared/engine/retry";
import { useSettingRef } from "../../shared/engine/settings";
import { sound } from "../../shared/engine/sound";
import { StudioEnvironment } from "../../shared/engine/studio";
import { CARD, cardGeometry, cardMaterial, FANS, fanGeometry, ramGeometry } from "./card";
import { bob, CENTRE_Y, FLOOR, TEAR, yaw } from "./room";
import { BOUNDS, field, gradient } from "./shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The joke: the AI bubble was full of graphics cards. When it pops they burst out of it like confetti, from where it
// broke and then from all over the letters as the tear reaches them, tumbling end over end, fans still spinning, and
// float off weightless, carried round the hall on a slow swirling current, then shrink away before the next bubble is
// full. Sticks of memory go with them, a few flecks of foil, and among the cards, cut-out face stickers printed both sides, turning
// slowly enough to be recognised. (The sticker sheet is kept to this site; without it the confetti is all cards.)

// Each card is a box on the processor for its fall: gravity, a little drag, and impulses at whichever corners strike.
// No gravity: the cards float, carried round the hall on a slow swirling current, and shrink away after FLOAT seconds.
const GRAVITY = 0;
const DRAG = 1;
// Launch speeds are scaled by this, and past SPREAD from the bubble a piece is drawn gently back, so the burst flies wide
// but stays in view.
const THROW = 0.66;
const SPREAD = 2.4;
const FLOAT = 9;
const FADE = 1.4;
const SPIN_DRAG = 0.35;
const BOUNCE = 0.32;
const FRICTION = 0.32;
const SUBSTEPS = 3;
// A card further above the floor than this (its half-diagonal, at the largest size) cannot touch it this frame.
const CLEAR = 0.3;
// How long the cards lie on the floor before sinking, and how long the sinking takes.
const LIE = 5.6;
const SINK = 1.6;
// The cards are kept inside this radius, well within the mirrors.
const REACH = 4.4;
const FLECKS = 70;
// The stickers in the sheet, and a sticker's size (a cell is 256 by 320). The share that are faces is the Faces slider.
const FACES = 4;
// Of the confetti that is not faces, the share that is memory rather than graphics cards.
const RAM_SHARE = 0.35;
// Memory is drawn this much bigger than life beside the cards, so it reads.
const RAM_SCALE = 1.6;
// The most the Confetti slider multiplies a pop's count by.
export const MOST_CONFETTI = 3;
const STICKER = { width: 0.27, height: 0.27 * 1.25 };

type Card = {
  live: boolean;
  born: number;
  size: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  spin: THREE.Vector3;
  fan: number;
  fanSpeed: number;
  still: number;
  landed: number;
  lastClack: number;
  pitch: number;
  // Which sticker it is, or -1 for a card.
  face: number;
  // A stick of memory rather than a graphics card.
  ram: boolean;
};

type Fleck = { live: boolean; born: number; pos: THREE.Vector3; vel: THREE.Vector3; quat: THREE.Quaternion; spin: THREE.Vector3; down: boolean; landed: number };

// Pops waiting for the cards: where in the letters it broke, how plump and big the bubble was, and when.
const pending: { local: THREE.Vector3; fat: number; scale: number; time: number }[] = [];
export function scatterGpus(local: THREE.Vector3, fat: number, scale: number, time: number) {
  pending.push({ local: local.clone(), fat, scale, time });
}

const half = new THREE.Vector3(CARD.length / 2 + 0.01, CARD.height / 2 + 0.024, CARD.thick / 2 + 0.002);
// The card's inverse inertia, as a solid box of unit mass.
const inertia = new THREE.Vector3(12 / (half.y ** 2 * 4 + half.z ** 2 * 4), 12 / (half.x ** 2 * 4 + half.z ** 2 * 4), 12 / (half.x ** 2 * 4 + half.y ** 2 * 4));
const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new THREE.Vector3(x, y, z).multiply(half))));

const tmp = {
  m: new THREE.Matrix4(),
  fan: new THREE.Matrix4(),
  fm: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  s: new THREE.Vector3(),
  r: new THREE.Vector3(),
  v: new THREE.Vector3(),
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
  c: new THREE.Vector3(),
  w: new THREE.Vector3(),
  g: new THREE.Vector3(),
  p: new THREE.Vector3(),
  inv: new THREE.Quaternion(),
  e: new THREE.Euler(),
  at: new THREE.Vector3(),
  local: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  zero: new THREE.Matrix4().makeScale(0, 0, 0)
};

// A sticker: two faces back to back a hair apart, each printed the right way round from its own side.
function stickerGeometry() {
  const front = new THREE.PlaneGeometry(STICKER.width, STICKER.height);
  front.translate(0, 0, 0.0015);
  const back = new THREE.PlaneGeometry(STICKER.width, STICKER.height);
  back.translate(0, 0, 0.0015).rotateY(Math.PI);
  const both = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const a = front.getAttribute(name);
    const b = back.getAttribute(name);
    const data = new Float32Array(a.array.length + b.array.length);
    data.set(a.array as Float32Array);
    data.set(b.array as Float32Array, a.array.length);
    both.setAttribute(name, new THREE.BufferAttribute(data, a.itemSize));
  }
  const index = front.getIndex()!.array as ArrayLike<number>;
  both.setIndex([...Array.from(index), ...Array.from(index, (i) => i + front.getAttribute("position").count)]);
  front.dispose();
  back.dispose();
  return both;
}

// The world inverse inertia applied to a world vector: into the card's frame, scaled, and back out.
function applyInertia(card: Card, scale: number, v: THREE.Vector3, out: THREE.Vector3) {
  tmp.inv.copy(card.quat).invert();
  out.copy(v).applyQuaternion(tmp.inv).multiply(inertia).divideScalar(scale * scale).applyQuaternion(card.quat);
  return out;
}

// A metal clack: a few inharmonic partials of a thin plate, a tick of noise, all over in a moment.
function clack(strength: number, pitch: number, pan: number) {
  sound.custom((context, out, at) => {
    const level = Math.min(1, strength) * 0.09;
    const panner = context.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(out);
    const base = 900 * pitch;
    [1, 2.32, 4.25, 6.8].forEach((ratio, k) => {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.value = base * ratio * (1 + (Math.random() - 0.5) * 0.02);
      const env = context.createGain();
      const decay = 0.16 / (1 + k * 0.7);
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(level / (1 + k * 0.5), at + 0.001);
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      osc.connect(env);
      env.connect(panner);
      osc.start(at);
      osc.stop(at + decay + 0.02);
    });
    const length = Math.floor(context.sampleRate * 0.03);
    const tick = context.createBuffer(1, length, context.sampleRate);
    const data = tick.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (length * 0.12));
    const src = context.createBufferSource();
    src.buffer = tick;
    const high = context.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 2500;
    const env = context.createGain();
    env.gain.value = level * 1.6;
    src.connect(high);
    high.connect(env);
    env.connect(panner);
    src.start(at);
    window.setTimeout(() => panner.disconnect(), 400);
  });
}

export function Gpus({ count }: { count: number }) {
  const camera = useThree((state) => state.camera);
  // Room for two pops in the air at the slider's most.
  const pool = count * MOST_CONFETTI * 2;
  const amount = useSettingRef<number>("confetti");
  const faceShare = useSettingRef<number>("faces");
  const [loaded] = suspendRetried(() => Promise.all([loadRetried(new THREE.TextureLoader(), "/assets/22-echo/faces.webp").catch(() => null)]), ["echo-mirror-faces"]);
  const parts = useMemo(() => {
    const cardGeo = cardGeometry();
    const fanGeo = fanGeometry();
    // Cards and fans share one material, so one shader.
    const cardMat = cardMaterial();
    const cards = new THREE.InstancedMesh(cardGeo, cardMat, pool);
    const ramGeo = ramGeometry();
    const rams = new THREE.InstancedMesh(ramGeo, cardMat, pool);
    const fans = new THREE.InstancedMesh(fanGeo, cardMat, pool * FANS.length);
    const fleckGeo = new THREE.BoxGeometry(0.03, 0.019, 0.0012);
    const fleckMat = new THREE.MeshStandardNodeMaterial({ metalness: 1, roughness: 0.22 });
    const flecks = new THREE.InstancedMesh(fleckGeo, fleckMat, FLECKS * 2);
    // The faces: one sheet, one draw; each sticker picks its cell. Cut out sharp, and a little self-lit so they read in
    // the dark hall.
    const sheet = loaded ?? new THREE.DataTexture(new Uint8Array(4), 1, 1);
    sheet.colorSpace = THREE.SRGBColorSpace;
    sheet.anisotropy = 4;
    const stickerGeo = stickerGeometry();
    const cells = new THREE.InstancedBufferAttribute(new Float32Array(pool), 1);
    cells.setUsage(THREE.DynamicDrawUsage);
    stickerGeo.setAttribute("aCell", cells);
    const stickerMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.38, metalness: 0, alphaTest: 0.5 });
    const print = texture(sheet, vec2(uv().x.add(attribute("aCell", "float")).div(FACES), uv().y)) as any;
    stickerMat.colorNode = print.rgb;
    stickerMat.opacityNode = print.a;
    stickerMat.emissiveNode = print.rgb.mul(float(0.32));
    const stickers = new THREE.InstancedMesh(stickerGeo, stickerMat, pool);
    const random = lehmer(7741);
    const foil = ["#f2c14e", "#d8dde6", "#7fd6e8", "#e58ad0", "#b7f08c"].map((c) => new THREE.Color(c));
    for (let i = 0; i < FLECKS * 2; i++) flecks.setColorAt(i, foil[Math.floor(random() * foil.length)]);
    // Only the instances in use are drawn (the live ones are packed to the front each frame); one hidden one stands in
    // while none are, so the warm-up still builds the shaders.
    for (const mesh of [cards, fans, rams, flecks, stickers]) {
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, tmp.zero);
      mesh.count = 1;
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    const make = (): Card => ({
      live: false,
      born: 0,
      size: 1,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      spin: new THREE.Vector3(),
      fan: 0,
      fanSpeed: 0,
      still: 0,
      landed: -1,
      lastClack: -1,
      pitch: 1,
      face: -1,
      ram: false
    });
    return {
      cardGeo,
      fanGeo,
      cardMat,
      ramGeo,
      rams,
      sheet,
      stickerGeo,
      stickerMat,
      stickers,
      cells,
      fleckGeo,
      fleckMat,
      cards,
      fans,
      flecks,
      random,
      bodies: Array.from({ length: pool }, make),
      bits: Array.from({ length: FLECKS * 2 }, (): Fleck => ({ live: false, born: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), spin: new THREE.Vector3(), down: false, landed: -1 })),
      next: 0,
      nextBit: 0,
      now: 0,
      lastClack: -1,
      // Anything flying, or anything still drawn that has to be cleared.
      busy: false
    };
  }, [pool, loaded]);
  useDispose(parts.cardGeo, parts.fanGeo, parts.ramGeo, parts.cardMat, parts.stickerGeo, parts.stickerMat, parts.fleckGeo, parts.fleckMat, loaded ? null : parts.sheet);

  // A pop's cards: some straight from where it broke, the rest from points over the film, each as the tear reaches it.
  const launch = (pop: (typeof pending)[number]) => {
    const p = parts;
    const rnd = p.random;
    const spin = yaw(pop.time);
    const lift = bob(pop.time);
    const toWorld = (v: THREE.Vector3, out: THREE.Vector3, scaled: boolean) => {
      const k = scaled ? pop.scale : 1;
      return out.set((v.x * Math.cos(spin) - v.z * Math.sin(spin)) * k, v.y * k + (scaled ? lift : 0), (v.z * Math.cos(spin) + v.x * Math.sin(spin)) * k);
    };
    const local = tmp.local;
    p.busy = true;
    const total = Math.round(count * (amount.current ?? 1));
    const share = loaded ? (faceShare.current ?? 0.3) : 0;
    for (let made = 0, tries = 0; made < total && tries < 18000; tries++) {
      const fromPop = made < total * 0.22;
      if (fromPop) local.copy(pop.local);
      else {
        local.set((rnd() * 2 - 1) * BOUNDS.x, (rnd() * 2 - 1) * BOUNDS.y, (rnd() * 2 - 1) * BOUNDS.z);
        for (let it = 0; it < 4; it++) {
          const d = field(local.x, local.y, local.z, pop.fat);
          gradient(local.x, local.y, local.z, tmp.g, pop.fat);
          local.addScaledVector(tmp.g, -d / Math.max(tmp.g.lengthSq(), 1e-6));
        }
        if (Math.abs(field(local.x, local.y, local.z, pop.fat)) > 0.01) continue;
      }
      const card = p.bodies[p.next];
      p.next = (p.next + 1) % pool;
      gradient(local.x, local.y, local.z, tmp.g, pop.fat).normalize();
      // Out of the film on whichever side, away from where it broke, and up.
      const side = rnd() < 0.5 ? 1 : -1;
      toWorld(tmp.g, tmp.a, false).multiplyScalar(side * (0.4 + rnd() * 1.0));
      toWorld(tmp.b.copy(local).sub(pop.local), tmp.c, false);
      if (tmp.c.lengthSq() < 1e-4) tmp.c.set(rnd() * 2 - 1, 0, rnd() * 2 - 1);
      tmp.c.normalize().multiplyScalar(fromPop ? 0.8 + rnd() * 1.4 : 0.7 + rnd() * 1.2);
      card.vel.copy(tmp.a).add(tmp.c);
      card.vel.y += rnd() * 0.6 - 0.2;
      if (fromPop) card.vel.add(tmp.b.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).multiplyScalar(1.3));
      card.vel.multiplyScalar(THROW);
      toWorld(local, card.pos, true);
      card.born = p.now + (fromPop ? rnd() * 0.06 : local.distanceTo(pop.local) / TEAR + rnd() * 0.04);
      card.size = 0.82 + rnd() * 0.36;
      // Every so often a face, taking turns so each of them comes out about as often; a face turns slowly, mostly about
      // its own upright, so it keeps showing itself.
      card.face = rnd() < share ? made % FACES : -1;
      card.ram = card.face < 0 && rnd() < RAM_SHARE;
      card.quat.setFromEuler(tmp.e.set(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3));
      if (card.face >= 0) card.quat.setFromEuler(tmp.e.set((rnd() - 0.5) * 0.8, rnd() * 6.3, (rnd() - 0.5) * 0.6));
      card.spin.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).multiplyScalar(2.6 + rnd() * 4.4);
      if (card.face >= 0) card.spin.set((rnd() - 0.5) * 0.8, (rnd() < 0.5 ? 1 : -1) * (1.2 + rnd() * 2.2), (rnd() - 0.5) * 0.6);
      card.fan = rnd() * 6.3;
      card.fanSpeed = (rnd() < 0.5 ? 1 : -1) * (25 + rnd() * 35);
      card.still = 0;
      card.landed = -1;
      card.lastClack = -1;
      card.pitch = 0.75 + rnd() * 0.6;
      card.live = true;
      made++;
    }
    // The foil, all from where it broke, fluttering.
    const at = toWorld(pop.local, tmp.at, true);
    for (let i = 0; i < FLECKS; i++) {
      const bit = p.bits[p.nextBit];
      p.nextBit = (p.nextBit + 1) % p.bits.length;
      bit.pos.copy(at);
      bit.vel.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize().multiplyScalar(1.5 + rnd() * 3);
      bit.vel.y += 1.2;
      bit.quat.setFromEuler(tmp.e.set(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3));
      bit.spin.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).multiplyScalar(8 + rnd() * 14);
      bit.born = p.now + rnd() * 0.08;
      bit.down = false;
      bit.landed = -1;
      bit.live = true;
    }
  };

  // Launched once behind the loader and cleared again, so the first pop runs code that is already warm.
  useEffect(() => {
    const p = parts;
    launch({ local: new THREE.Vector3(0.3, 0, 0), fat: 0, scale: 1, time: 0 });
    for (const card of p.bodies) {
      step(card, 1 / 60, true);
      card.live = false;
    }
    for (const bit of p.bits) bit.live = false;
    p.next = 0;
    p.nextBit = 0;
  }, [parts]);

  // One step of a card's flight, and its corners against the floor if it is near enough to touch it.
  const step = (card: Card, dt: number, low: boolean) => {
    const s = card.size;
    // The air: lazy eddies with no centre, so the confetti spreads through the hall rather than circling the bubble. Each
    // push leaves out its own direction, so the flow neither gathers nor thins anything. Kept off the floor and ceiling.
    const t = parts.now;
    const { x, y, z } = card.pos;
    card.vel.x += dt * Math.sin(y * 1.1 + z * 0.6 + t * 0.21) * 0.4;
    card.vel.y += dt * (Math.sin(z * 1 + x * 0.7 - t * 0.17) * 0.24 + Math.max(0, FLOOR + 0.7 - y) * 0.6 - Math.max(0, y - 2.1) * 0.6 - GRAVITY);
    card.vel.z += dt * Math.sin(x * 1.2 - y * 0.5 + t * 0.19) * 0.4;
    const away = Math.hypot(x, y - CENTRE_Y, z);
    if (away > SPREAD) {
      const pull = (dt * (away - SPREAD) * 0.9) / away;
      card.vel.x -= x * pull;
      card.vel.y -= (y - CENTRE_Y) * pull;
      card.vel.z -= z * pull;
    }
    card.vel.multiplyScalar(Math.exp(-DRAG * dt));
    // Tumbling settles to a slow, graceful turn rather than stopping.
    if (card.spin.length() > 0.8) card.spin.multiplyScalar(Math.exp(-SPIN_DRAG * dt));
    card.pos.addScaledVector(card.vel, dt);
    const w = card.spin;
    const angle = w.length() * dt;
    if (angle > 1e-6) {
      tmp.q.setFromAxisAngle(tmp.w.copy(w).normalize(), angle);
      card.quat.premultiply(tmp.q).normalize();
    }
    // Kept off the mirrors.
    const r = Math.hypot(card.pos.x, card.pos.z);
    if (r > REACH) {
      const nx = card.pos.x / r;
      const nz = card.pos.z / r;
      card.pos.x = nx * REACH;
      card.pos.z = nz * REACH;
      const out = card.vel.x * nx + card.vel.z * nz;
      if (out > 0) {
        card.vel.x -= 1.4 * out * nx;
        card.vel.z -= 1.4 * out * nz;
      }
    }
    if (!low) return 0;
    // The floor: the lowest corner pushed back out, then an impulse at each corner that is in it and still going in.
    let deepest = 0;
    for (const c of corners) {
      const y = card.pos.y + tmp.p.copy(c).multiplyScalar(s).applyQuaternion(card.quat).y;
      deepest = Math.min(deepest, y - FLOOR);
    }
    if (deepest >= 0) return 0;
    card.pos.y -= deepest;
    let hardest = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const c of corners) {
        tmp.r.copy(c).multiplyScalar(s).applyQuaternion(card.quat);
        if (card.pos.y + tmp.r.y - FLOOR > 0.002) continue;
        // The corner's velocity, and how hard it is going into the floor.
        tmp.v.copy(card.spin).cross(tmp.r).add(card.vel);
        const vn = tmp.v.y;
        if (vn >= 0) continue;
        hardest = Math.max(hardest, -vn);
        const e = vn < -0.6 ? BOUNCE : 0;
        // How much the corner gives to a push up: the mass and the turn it makes about the middle.
        tmp.a.copy(tmp.r).cross(tmp.up);
        applyInertia(card, s, tmp.a, tmp.b).cross(tmp.r);
        const j = (-(1 + e) * vn) / (1 + tmp.b.dot(tmp.up));
        tmp.a.set(0, j, 0);
        card.vel.add(tmp.a);
        card.spin.add(applyInertia(card, s, tmp.c.copy(tmp.r).cross(tmp.a), tmp.b));
        // Friction against the slide, no more than the polished stone allows.
        tmp.v.copy(card.spin).cross(tmp.r).add(card.vel);
        tmp.v.y = 0;
        const slide = tmp.v.length();
        if (slide > 1e-5) {
          tmp.g.copy(tmp.v).divideScalar(slide);
          tmp.a.copy(tmp.r).cross(tmp.g);
          applyInertia(card, s, tmp.a, tmp.b).cross(tmp.r);
          const k = Math.min(slide / (1 + tmp.b.dot(tmp.g)), FRICTION * j);
          tmp.a.copy(tmp.g).multiplyScalar(-k);
          card.vel.add(tmp.a);
          card.spin.add(applyInertia(card, s, tmp.c.copy(tmp.r).cross(tmp.a), tmp.b));
        }
      }
    }
    // Rolling and rocking on the floor die away.
    card.spin.multiplyScalar(Math.exp(-2.2 * dt));
    return hardest;
  };

  useFrame((_, raw) => {
    const p = parts;
    const dt = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1 / 20) : 1 / 60;
    p.now += dt;
    const now = p.now;
    while (pending.length) launch(pending.shift()!);
    // Nothing flying and nothing left drawn: nothing to do.
    if (!p.busy) return;

    let clacks = 0;
    let shown = 0;
    let faces = 0;
    let sticks = 0;
    let waiting = false;
    for (let i = 0; i < pool; i++) {
      const card = p.bodies[i];
      if (!card.live) continue;
      if (now < card.born) {
        waiting = true;
        continue;
      }
      const age = now - card.born;
      let sink = 0;
      let fade = 0;
      if (age > FLOAT) {
        fade = Math.min(1, (age - FLOAT) / FADE);
        if (fade >= 1) {
          card.live = false;
          continue;
        }
      }
      if (card.landed >= 0 && now - card.landed > LIE) {
        // Lying long enough: down into the stone, slowly, then gone.
        sink = Math.min(1, (now - card.landed - LIE) / SINK);
        card.pos.y -= dt * (0.04 + sink * 0.22) * card.size;
        if (sink >= 1) {
          card.live = false;
          continue;
        }
      } else if (card.still < 0.4) {
        // Well clear of the floor, one step will do; near it, smaller steps for the knocks.
        let hit = 0;
        if (card.pos.y - FLOOR > CLEAR * card.size + Math.max(0, -card.vel.y) * dt) step(card, dt, false);
        else for (let k = 0; k < SUBSTEPS; k++) hit = Math.max(hit, step(card, dt / SUBSTEPS, true));
        if (hit > 0 && card.landed < 0) card.landed = now;
        // The clatter, thinned: only real knocks, not too often from one card or from all of them together.
        if (hit > 0.5 && now - card.lastClack > 0.12 && now - p.lastClack > 0.03 && clacks < 2) {
          card.lastClack = now;
          p.lastClack = now;
          clacks++;
          tmp.p.copy(card.pos).project(camera);
          clack((hit - 0.4) * 0.45, card.pitch * (0.9 + Math.random() * 0.2), Math.max(-0.8, Math.min(0.8, tmp.p.x)));
        }
        const slow = card.vel.lengthSq() < 0.004 && card.spin.lengthSq() < 0.04 && card.landed >= 0;
        card.still = slow ? card.still + dt : 0;
        if (card.still >= 0.4) {
          card.vel.set(0, 0, 0);
          card.spin.set(0, 0, 0);
        }
      }
      // Popping out of the film, a little small, and grown to full in a blink.
      const grow = Math.min(1, age / 0.12);
      const scale = card.size * (0.35 + 0.65 * grow * (2 - grow)) * (1 - fade * fade * (3 - 2 * fade));
      tmp.m.compose(card.pos, card.quat, tmp.s.setScalar(scale));
      if (card.face >= 0) {
        p.stickers.setMatrixAt(faces, tmp.m);
        p.cells.setX(faces, card.face);
        faces++;
        continue;
      }
      if (card.ram) {
        p.rams.setMatrixAt(sticks, tmp.m.compose(card.pos, card.quat, tmp.s.setScalar(scale * RAM_SCALE)));
        sticks++;
        continue;
      }
      p.cards.setMatrixAt(shown, tmp.m);
      card.fanSpeed *= Math.exp(-dt * (card.landed >= 0 ? 1.2 : 0.15));
      card.fan += card.fanSpeed * dt;
      for (let f = 0; f < FANS.length; f++) {
        tmp.fan.makeRotationZ(card.fan + f * 1.3).setPosition(FANS[f], 0, 0);
        p.fans.setMatrixAt(shown * FANS.length + f, tmp.fm.multiplyMatrices(tmp.m, tmp.fan));
      }
      shown++;
    }
    if (shown === 0) p.cards.setMatrixAt(0, tmp.zero);
    if (faces === 0) p.stickers.setMatrixAt(0, tmp.zero);
    if (sticks === 0) p.rams.setMatrixAt(0, tmp.zero);
    p.rams.count = Math.max(1, sticks);
    p.stickers.count = Math.max(1, faces);
    p.cells.clearUpdateRanges();
    p.cells.addUpdateRange(0, p.stickers.count);
    p.cells.needsUpdate = true;
    if (shown === 0) for (let f = 0; f < FANS.length; f++) p.fans.setMatrixAt(f, tmp.zero);
    p.cards.count = Math.max(1, shown);
    p.fans.count = Math.max(1, shown) * FANS.length;
    for (const mesh of [p.cards, p.fans, p.rams, p.stickers]) {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }

    // The foil: heavy drag so it flutters, tumbling, lies flat if it touches the floor, and shrinks away with the cards.
    // Each keeps its slot (its colour is the slot's), so the flecks are drawn up to the last one in use.
    let top = 0;
    for (let i = 0; i < p.bits.length; i++) {
      const bit = p.bits[i];
      if (bit.live && now - bit.born > FLOAT + FADE) bit.live = false;
      if (!bit.live || now < bit.born) {
        p.flecks.setMatrixAt(i, tmp.zero);
        if (bit.live) waiting = true;
        continue;
      }
      top = i + 1;
      if (!bit.down) {
        bit.vel.y -= (GRAVITY * 0.6 + 0.05) * dt;
        bit.vel.multiplyScalar(Math.exp(-2.6 * dt));
        bit.pos.addScaledVector(bit.vel, dt);
        bit.pos.x += Math.sin(now * 7 + i) * dt * 0.12;
        const angle = bit.spin.length() * dt;
        tmp.q.setFromAxisAngle(tmp.w.copy(bit.spin).normalize(), angle);
        bit.quat.premultiply(tmp.q).normalize();
        if (bit.pos.y < FLOOR + 0.001) {
          bit.down = true;
          bit.landed = now;
          bit.pos.y = FLOOR + 0.0007;
          bit.quat.setFromAxisAngle(tmp.w.set(1, 0, 0), -Math.PI / 2).premultiply(tmp.q.setFromAxisAngle(tmp.up, Math.random() * 6.3));
        }
      } else if (now - bit.landed > LIE) {
        bit.pos.y -= dt * 0.01;
        if (now - bit.landed > LIE + 1) bit.live = false;
      }
      const fade = Math.min(1, Math.max(0, (now - bit.born - FLOAT) / FADE));
      tmp.m.compose(bit.pos, bit.quat, tmp.s.setScalar(1 - fade * fade * (3 - 2 * fade)));
      p.flecks.setMatrixAt(i, tmp.m);
    }
    p.flecks.count = Math.max(1, top);
    p.flecks.instanceMatrix.clearUpdateRanges();
    p.flecks.instanceMatrix.addUpdateRange(0, p.flecks.count * 16);
    p.flecks.instanceMatrix.needsUpdate = true;
    // This frame cleared the last of them, so the next has nothing to do.
    p.busy = shown > 0 || faces > 0 || sticks > 0 || top > 0 || waiting;
  });

  return (
    <>
      <primitive object={parts.cards} />
      <primitive object={parts.fans} />
      <primitive object={parts.rams} />
      <primitive object={parts.stickers} />
      <primitive object={parts.flecks} />
      {/* Light for the cards alone (the room is traced): the round softbox overhead and its copies round the walls. */}
      <StudioEnvironment
        ambient="#030505"
        intensity={1}
        boxes={[
          { position: [0, 2.9, 0], scale: [1.7, 0.05, 1.7], color: "#ffeed6", intensity: 5 },
          ...Array.from({ length: 6 }, (_, k) => ({
            position: [Math.sin((k * Math.PI) / 3) * 5, 1.6, Math.cos((k * Math.PI) / 3) * 5] as [number, number, number],
            scale: [2.2, 0.5, 2.2] as [number, number, number],
            color: "#ffeed6",
            intensity: 1.3
          })),
          // The mirrors all round, dimly lit: what the silver sees when it faces sideways.
          ...Array.from({ length: 6 }, (_, k) => ({
            position: [Math.sin(((k + 0.5) * Math.PI) / 3) * 5.5, 0, Math.cos(((k + 0.5) * Math.PI) / 3) * 5.5] as [number, number, number],
            scale: [3.5, 4.5, 3.5] as [number, number, number],
            color: "#cfe0dc",
            intensity: 0.22
          }))
        ]}
      />
      <directionalLight position={[0.3, 5, 0.6]} intensity={2.4} color="#fff2e0" />
    </>
  );
}
