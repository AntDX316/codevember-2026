"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useDispose } from "../../shared/engine/dispose";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { sound } from "../../shared/engine/sound";
import { shellMaterial, type NacreLook } from "./material";
import { DEPTH, LAYERS, PEARL, dims, hitShell, layout, outside, type Dims } from "./shape";

// Pieces that sink this far below the cocoon melt away there: it floats free, with nothing under it.
const FLOOR = -1.6;
// How long a freed piece may drift before it fades.
const DRIFT = 8;
// How long a brick takes to grow back.
const GROW = 1.8;
// How near the swipe a brick has to be to tear free.
const REACH = 0.18;
// Once this much of a shell is gone, the rest of it falls open by itself.
const OPEN = 0.45;
// After the pearl has been shown this long, untouched, the shells grow back over it.
const REGROW_AFTER = 9;

const ATTACHED = 0;
const PEELING = 1;
const FREE = 2;
const GONE = 3;
const GROWING = 4;

type Piece = {
  phase: number;
  start: number;
  duration: number;
  kick: number;
  axis: number;
  roll: number;
  fold: number;
  lift: number;
  liftVelocity: number;
  heard: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  turn: THREE.Quaternion;
  spin: THREE.Vector3;
  rest: THREE.Quaternion;
  age: number;
  landed: number;
  fadeAt: number;
  fadeFor: number;
  scale: number;
  glow: number;
  growAt: number;
  regrow: boolean;
};

const SEGMENTS = { high: [14, 12], medium: [10, 8], low: [6, 5] } as const;

// The nested shells, every brick of every one, and everything they do: torn open by a swipe, rolling back in curls,
// drifting down to the floor, and growing back, innermost first, once the pearl has been seen.
export function Shells({ look, light }: { look: NacreLook; light: THREE.PointLight }) {
  const { tier } = useQuality();
  const { bricks, starts } = useMemo(layout, []);
  const total = bricks.length;
  const peelSound = useSettingRef<string>("nacreSound");

  const buffers = useMemo(() => {
    const make = () => new THREE.InstancedBufferAttribute(new Float32Array(total * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const b = { patch: make(), curl: make(), place: make(), turn: make() };
    bricks.forEach((brick, i) => {
      b.patch.setXYZW(i, brick.phi, brick.half, brick.top, brick.bottom);
      b.curl.setXYZW(i, 10, 0, 0, brick.layer);
      b.place.setXYZW(i, 0, 0, 0, 1);
      b.turn.setXYZW(i, 0, 0, 0, 1);
    });
    return b;
  }, [bricks, total]);

  const pieces = useMemo<Piece[]>(
    () =>
      bricks.map((brick) => ({
        phase: ATTACHED,
        start: 0,
        duration: 1,
        kick: 1,
        axis: 0,
        roll: 2.5,
        fold: 10,
        lift: 0,
        liftVelocity: 0,
        heard: false,
        position: brick.centre.clone(),
        velocity: new THREE.Vector3(),
        turn: new THREE.Quaternion(),
        spin: new THREE.Vector3(),
        rest: new THREE.Quaternion(),
        age: 0,
        landed: -1,
        fadeAt: Infinity,
        fadeFor: 1.2,
        scale: 1,
        glow: 0,
        growAt: Infinity,
        regrow: false
      })),
    [bricks]
  );

  const material = useMemo(() => shellMaterial(buffers, look), [buffers, look]);
  const geometry = useMemo(() => {
    const [across, up] = SEGMENTS[tier] ?? SEGMENTS.high;
    return new THREE.BoxGeometry(1, 1, DEPTH, across, up, 1);
  }, [tier]);
  // A new tier only swaps the box for a finer or coarser one: the same material, so nothing compiles again.
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, total);
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
    m.count = starts[2];
    return m;
  }, [geometry, material, total, starts]);
  useDispose(geometry, material, mesh);

  const camera = useThree((three) => three.camera);
  const sim = useRef({
    now: 0,
    current: 0,
    revealedAt: -1,
    regrowing: false,
    opened: new Array<boolean>(LAYERS).fill(false),
    // When each shell starts growing back, to be heard then.
    growCue: new Array<number>(LAYERS).fill(Infinity),
    chimeAt: Infinity,
    // Where the last swipe touched, so a shell falls open from there.
    last: new THREE.Vector3(),
    hasLast: false,
    lastTime: 0,
    moved: 0,
    grabbed: "" as "" | "shell" | "pearl",
    soundGap: 0,
    flare: 0
  });

  const temp = useMemo(
    () => ({
      d: dims(0) as Dims,
      out: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      q: new THREE.Quaternion(),
      ray: new THREE.Ray()
    }),
    []
  );

  // Starts a brick peeling: `toward` is the way to the tear, so the edge nearest it lifts first and the brick rolls
  // back away from it.
  const peel = (i: number, delay: number, toward: THREE.Vector3, duration: number, kick: number) => {
    const p = pieces[i];
    if (p.phase !== ATTACHED) return;
    const brick = bricks[i];
    p.phase = PEELING;
    p.start = sim.current.now + delay;
    p.duration = duration * (0.85 + Math.random() * 0.3);
    p.kick = kick;
    p.axis = Math.atan2(toward.dot(brick.u), toward.dot(brick.e)) + (Math.random() - 0.5) * 0.5;
    p.roll = 2 + Math.random() * 1.6;
    p.fold = 10;
    p.lift = 0;
    p.liftVelocity = 0;
    p.heard = false;
  };

  // Once enough of a shell is open, the rest rolls back from the opening by itself, like petals.
  const openRest = (layer: number) => {
    const st = sim.current;
    if (st.opened[layer]) return;
    let gone = 0;
    const from = starts[layer];
    const to = starts[layer + 1];
    for (let i = from; i < to; i++) if (pieces[i].phase !== ATTACHED) gone++;
    if (gone / (to - from) < OPEN) return;
    st.opened[layer] = true;
    for (let i = from; i < to; i++) {
      if (pieces[i].phase !== ATTACHED) continue;
      const centre = bricks[i].centre;
      const distance = st.hasLast ? centre.distanceTo(st.last) : 1;
      temp.a.copy(st.hasLast ? st.last : temp.b.set(0, 0, 3)).sub(centre);
      peel(i, 0.12 + distance * 0.55 + Math.random() * 0.25, temp.a, 0.85, 0.8);
    }
    sound.play("whoosh", { gain: 0.1, pitch: 1.25 });
  };

  // A stretch of swipe across the shell: every brick it passes near tears free, as fast as the hand moves.
  const brush = (from: THREE.Vector3, to: THREE.Vector3, seconds: number) => {
    const st = sim.current;
    if (st.current >= LAYERS) return;
    const along = temp.b.copy(to).sub(from);
    const length = along.length();
    const speed = length / Math.max(seconds, 0.008);
    const duration = THREE.MathUtils.clamp(0.35 + 0.4 / Math.max(speed, 0.05), 0.45, 1.2);
    const kick = THREE.MathUtils.clamp(0.6 + speed * 0.25, 0.6, 1.8);
    for (let i = starts[st.current]; i < starts[st.current + 1]; i++) {
      if (pieces[i].phase !== ATTACHED) continue;
      const brick = bricks[i];
      const t = length > 0 ? THREE.MathUtils.clamp(temp.a.copy(brick.centre).sub(from).dot(along) / (length * length), 0, 1) : 0;
      const nearest = temp.out.copy(from).addScaledVector(along, t);
      const distance = nearest.distanceTo(brick.centre);
      if (distance > REACH) continue;
      const toward = temp.a.copy(nearest).sub(brick.centre);
      // Right under the swipe: it tears to one side or the other of it.
      if (toward.lengthSq() < 0.03 * 0.03) toward.crossVectors(brick.n, along).multiplyScalar(Math.random() < 0.5 ? 1 : -1);
      peel(i, distance * 0.3, toward, duration, kick);
    }
    openRest(st.current);
  };

  // A tap tears a little hole round where it lands.
  const burst = (at: THREE.Vector3) => {
    const st = sim.current;
    if (st.current >= LAYERS) return;
    for (let i = starts[st.current]; i < starts[st.current + 1]; i++) {
      const distance = bricks[i].centre.distanceTo(at);
      if (distance < 0.3) peel(i, distance * 0.4, temp.a.copy(at).sub(bricks[i].centre), 0.8, 0.9);
    }
    openRest(st.current);
  };

  // Every shell that is not whole grows back, innermost first, each laid down from the bottom up.
  const regrow = () => {
    const st = sim.current;
    const now = st.now;
    let delay = 0.3;
    let any = false;
    for (let layer = LAYERS - 1; layer >= 0; layer--) {
      let whole = true;
      for (let i = starts[layer]; i < starts[layer + 1]; i++) if (pieces[i].phase !== ATTACHED && !pieces[i].regrow) whole = false;
      if (whole) continue;
      any = true;
      st.opened[layer] = false;
      st.growCue[layer] = now + delay;
      for (let i = starts[layer]; i < starts[layer + 1]; i++) {
        const p = pieces[i];
        if (p.phase === ATTACHED || p.regrow) continue;
        // Anything of it still about melts away quickly first.
        if (p.phase === PEELING) {
          p.phase = FREE;
          p.velocity.set(0, 0, 0);
          p.spin.set(0, 0, 0);
          p.age = 0;
          p.landed = -1;
        }
        if (p.phase === FREE) {
          p.fadeAt = Math.min(p.fadeAt, now);
          p.fadeFor = 0.5;
        }
        const brick = bricks[i];
        const height = 1 - (brick.top + brick.bottom) / 2 / Math.PI;
        p.regrow = true;
        p.growAt = now + delay + 0.5 + height * 1.4 + brick.seed * 0.35;
      }
      delay += 1.15;
    }
    if (any) {
      st.regrowing = true;
      sound.play("chime", { gain: 0.18, pitch: 0.5 });
    }
  };
  useSettingAction("nacreRegrow", regrow);

  const ray = (point: THREE.Vector3) => {
    temp.ray.origin.copy(camera.position);
    temp.ray.direction.copy(point).sub(camera.position).normalize();
    return temp.ray;
  };
  const hitPearl = (r: THREE.Ray) => {
    const t = r.origin.dot(r.direction);
    const closest = r.origin.lengthSq() - t * t;
    const radius = PEARL * 1.1;
    if (closest > radius * radius || t > 0) return null;
    return -t - Math.sqrt(radius * radius - closest);
  };

  useGrabbable({
    pick: (r) => {
      const st = sim.current;
      if (st.current >= LAYERS) {
        const t = hitPearl(r);
        return t !== null ? { distance: t, point: r.at(t, new THREE.Vector3()) } : null;
      }
      const t = hitShell(r, dims(st.current, temp.d), DEPTH);
      return t !== null ? { distance: t, point: r.at(t, new THREE.Vector3()) } : null;
    },
    grab: (point) => {
      dismissPrompt();
      const st = sim.current;
      st.grabbed = st.current >= LAYERS ? "pearl" : "shell";
      st.last.copy(point);
      st.hasLast = true;
      st.lastTime = st.now;
      st.moved = 0;
    },
    drag: (point) => {
      const st = sim.current;
      if (st.grabbed !== "shell" || st.current >= LAYERS) return;
      // The drag point lies on a plane facing the camera: what counts is where it falls on the shell now on top.
      const r = ray(point);
      const t = hitShell(r, dims(st.current, temp.d), DEPTH);
      if (t === null) {
        st.hasLast = false;
        return;
      }
      const at = r.at(t, temp.out.clone());
      if (!st.hasLast) {
        st.last.copy(at);
        st.hasLast = true;
        st.lastTime = st.now;
        return;
      }
      if (at.distanceTo(st.last) < 0.012) return;
      brush(st.last, at, st.now - st.lastTime);
      st.moved += at.distanceTo(st.last);
      st.last.copy(at);
      st.lastTime = st.now;
    },
    release: () => {
      const st = sim.current;
      if (st.grabbed === "pearl") {
        st.flare = 1;
        sound.play("chime", { gain: 0.35, pitch: 1.5 + Math.random() * 0.3 });
      } else if (st.grabbed === "shell" && st.moved < 0.03 && st.hasLast) burst(st.last.clone());
      st.grabbed = "";
    }
  });

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 1 / 30);
    const st = sim.current;
    st.now += dt;
    const now = st.now;
    camera.matrixWorld.extractBasis(temp.right, temp.a, temp.b);

    // The outermost shell that still has any of itself on, or is growing back.
    let current = LAYERS;
    for (let i = 0; i < total; i++) {
      const phase = pieces[i].phase;
      if (phase === ATTACHED || phase === GROWING) {
        current = bricks[i].layer;
        break;
      }
    }
    if (current >= LAYERS && st.current < LAYERS) {
      st.revealedAt = now;
      st.chimeAt = now + 0.35;
      sound.play("chime", { gain: 0.55, pitch: 1 });
    }
    st.current = current;
    if (now >= st.chimeAt) {
      st.chimeAt = Infinity;
      sound.play("chime", { gain: 0.28, pitch: 1.5 });
    }
    if (current >= LAYERS && !st.regrowing && now - st.revealedAt > REGROW_AFTER) regrow();
    for (let layer = 0; layer < LAYERS; layer++)
      if (now >= st.growCue[layer]) {
        st.growCue[layer] = Infinity;
        sound.play("tinkle", { gain: 0.12, pitch: 0.7 + (LAYERS - layer) * 0.08 });
      }
    const cocoon = current < LAYERS ? dims(current, temp.d) : null;

    let began = 0;
    let pan = 0;
    let growing = 0;
    for (let i = 0; i < total; i++) {
      const p = pieces[i];
      const brick = bricks[i];
      if (p.phase === PEELING) {
        const k = (now - p.start) / p.duration;
        if (k >= 0) {
          const kk = Math.min(1, k);
          const eased = kk * kk * (3 - 2 * kk);
          const reach = Math.abs(Math.cos(p.axis)) * brick.reachAcross + Math.abs(Math.sin(p.axis)) * brick.reachUp;
          // The fold sweeps across from the torn edge, and the part behind it springs up into a curl.
          p.fold = reach * 1.02 - eased * reach * 1.75;
          const target = p.roll * Math.min(1, eased * 1.2);
          p.liftVelocity += ((target - p.lift) * 110 - p.liftVelocity * 12) * dt;
          p.lift = Math.max(0, p.lift + p.liftVelocity * dt);
          p.position.copy(brick.centre).addScaledVector(brick.n, eased * eased * eased * 0.015);
          if (!p.heard && k > 0.3) {
            p.heard = true;
            began++;
            pan += brick.centre.dot(temp.right);
          }
          if (k >= 1) {
            // Free: it lifts away outwards, drawn back the way it was peeled, still turning over the way it rolled.
            p.phase = FREE;
            p.age = 0;
            p.landed = -1;
            p.fadeAt = now + DRIFT;
            p.fadeFor = 1.4;
            const away = temp.a.copy(brick.e).multiplyScalar(Math.cos(p.axis)).addScaledVector(brick.u, Math.sin(p.axis));
            p.velocity
              .copy(brick.n)
              .multiplyScalar((0.22 + Math.random() * 0.2) * p.kick)
              .addScaledVector(away, -0.22 * p.kick)
              .add(temp.b.set((Math.random() - 0.5) * 0.08, 0.06, (Math.random() - 0.5) * 0.08));
            p.spin.crossVectors(away, brick.n).multiplyScalar((0.9 + Math.random() * 1.1) * (0.5 + p.kick * 0.4));
          }
        }
      } else if (p.phase === FREE) {
        p.age += dt;
        const t = p.age;
        if (p.landed < 0) {
          // It drifts like a petal: lifts away, then slowly sinks, swaying, held back hard by the air.
          const settle = THREE.MathUtils.smoothstep(t, 0, 1.4);
          p.velocity.y -= 0.42 * settle * dt;
          p.velocity.x += Math.sin(t * 2.6 + brick.seed * 20) * 0.35 * settle * dt;
          p.velocity.z += Math.cos(t * 2.1 + brick.seed * 13) * 0.3 * settle * dt;
          p.velocity.multiplyScalar(Math.exp(-1.2 * dt));
          p.position.addScaledVector(p.velocity, dt);
          p.spin.multiplyScalar(Math.exp(-0.6 * dt));
          p.spin.x += Math.sin(t * 1.9 + brick.seed * 9) * 0.35 * dt;
          p.spin.z += Math.cos(t * 1.5 + brick.seed * 7) * 0.3 * dt;
          // It cannot fall back through the cocoon: it slides off round it.
          if (cocoon) {
            const gap = outside(p.position, cocoon, temp.out) - 0.07;
            if (gap < 0) {
              p.position.addScaledVector(temp.out, Math.min(-gap, 0.4 * dt));
              const into = p.velocity.dot(temp.out);
              if (into < 0) p.velocity.addScaledVector(temp.out, -into);
            }
          }
          const angle = p.spin.length() * dt;
          if (angle > 1e-6) {
            temp.q.setFromAxisAngle(temp.b.copy(p.spin).divideScalar(p.spin.length()), angle);
            p.turn.premultiply(temp.q);
          }
          if (p.position.y < FLOOR) p.fadeAt = Math.min(p.fadeAt, now);
          // Still breathing a little as it floats.
          const target = p.roll + Math.sin(t * 2.3 + brick.seed * 5) * 0.14;
          p.liftVelocity += ((target - p.lift) * 60 - p.liftVelocity * 6) * dt;
          p.lift = Math.max(0, p.lift + p.liftVelocity * dt);
        } else {
          p.turn.slerp(p.rest, 1 - Math.exp(-dt * 8));
        }
        p.scale = 1 - THREE.MathUtils.smoothstep(now, p.fadeAt, p.fadeAt + p.fadeFor);
        if (now >= p.fadeAt + p.fadeFor) {
          p.phase = GONE;
          p.scale = 0;
        }
      } else if (p.phase === GONE) {
        if (p.regrow && now >= p.growAt) {
          p.phase = GROWING;
          p.turn.identity();
          p.fold = 10;
          p.lift = 0;
        }
      }
      if (p.phase === GROWING) {
        // Laid down from beneath: it swells up out of the shell below, glowing faintly as it sets.
        const k = Math.min(1, (now - p.growAt) / GROW);
        const eased = 1 - Math.pow(1 - k, 3);
        p.scale = 0.05 + eased * 0.95;
        p.position.copy(brick.centre).addScaledVector(brick.n, -(1 - eased) * 0.05);
        p.glow = Math.sin(Math.PI * Math.min(1, k * 1.1)) * 0.9;
        growing++;
        if (k >= 1) {
          p.phase = ATTACHED;
          p.regrow = false;
          p.growAt = Infinity;
          p.fadeAt = Infinity;
          p.scale = 1;
          p.glow = 0;
          p.position.copy(brick.centre);
          p.turn.identity();
        }
      }
      const scale = p.phase === GONE ? 0 : p.scale;
      buffers.curl.setXYZW(i, p.phase === ATTACHED || p.phase === GROWING ? 10 : p.fold, p.lift, p.axis, brick.layer + Math.max(0, Math.min(1, p.glow)) * 0.9);
      buffers.place.setXYZW(i, p.position.x - brick.centre.x, p.position.y - brick.centre.y, p.position.z - brick.centre.z, scale);
      buffers.turn.setXYZW(i, p.turn.x, p.turn.y, p.turn.z, p.turn.w);
    }
    if (st.regrowing && growing === 0 && current < LAYERS) {
      let pending = false;
      for (let i = 0; i < total && !pending; i++) if (pieces[i].regrow) pending = true;
      if (!pending) st.regrowing = false;
    }

    // Only the shell on top and the one under it are ever seen, besides pieces in the air: the rest are left undrawn.
    const drawn = starts[Math.min(LAYERS, current + 2)];
    mesh.count = drawn;
    for (const attribute of [buffers.curl, buffers.place, buffers.turn]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, drawn * 4);
      attribute.needsUpdate = true;
    }

    st.soundGap -= dt;
    if (began > 0 && st.soundGap <= 0) {
      st.soundGap = 0.07;
      sound.play("peel", {
        variant: peelSound.current,
        gain: Math.min(0.8, 0.3 + began * 0.06),
        pitch: 0.9 + Math.random() * 0.25 + Math.min(current, LAYERS - 1) * 0.04,
        pan: THREE.MathUtils.clamp(pan / began / 1.2, -0.7, 0.7)
      });
    }

    // The pearl's light wells up as the last shell opens, and fills the room once it is bare.
    let shine = 0;
    if (current >= LAYERS) shine = 1;
    else if (current === LAYERS - 1) {
      let gone = 0;
      for (let i = starts[current]; i < starts[current + 1]; i++) if (pieces[i].phase !== ATTACHED && pieces[i].phase !== GROWING) gone++;
      shine = (0.4 * gone) / (starts[current + 1] - starts[current]);
    }
    look.shine.value += (shine - look.shine.value) * (1 - Math.exp(-dt * 2.2));
    st.flare *= Math.exp(-dt * 3);
    look.flare.value = st.flare;
    light.intensity = look.shine.value * 2.4 + st.flare * 1.5;
  });

  return <primitive object={mesh} />;
}
