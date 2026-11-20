import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { abs, atan, cos, dot, max, mix, normalize, smoothstep, uniform, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The room the fluid reflects. Black fluid shows nothing of itself: every bit of shape it has is read from these strips.
type Light = { label: string; swatch: string[]; floor: string; horizon: string; zenith: string; left: string; right: string; key: string; tint: string };

export const LIGHTS: Record<string, Light> = {
  silver: { label: "Silver", swatch: ["#e9eef7", "#5d6470"], floor: "#030304", horizon: "#16181d", zenith: "#07080a", left: "#dfe7f5", right: "#ffffff", key: "#f2f5fa", tint: "#c8d2ff" },
  warm: { label: "Warm", swatch: ["#ffcf9a", "#6b3a1c"], floor: "#040202", horizon: "#22140c", zenith: "#0a0605", left: "#ffc48a", right: "#ffe6c4", key: "#fff0dc", tint: "#ffd7b0" },
  neon: { label: "Neon", swatch: ["#ff2fb9", "#1fe6ff"], floor: "#030108", horizon: "#170a2b", zenith: "#05030c", left: "#ff2fb9", right: "#1fe6ff", key: "#d8f4ff", tint: "#b8ffe9" }
};

export const lightOptions = Object.entries(LIGHTS).map(([value, light]) => ({ value, label: light.label, swatch: light.swatch }));

const COLOURS = ["floor", "horizon", "zenith", "left", "right", "key", "tint"] as const;
export const KEY = new THREE.Vector3(-0.62, 0.58, 0.55).normalize();
const scratch = new THREE.Color();

export type Studio = ReturnType<typeof useStudio>;

// The studio as uniforms, so a change of light slides the colours over rather than rebuilding a shader.
export function useStudio(name: string) {
  const start = LIGHTS[name] ?? LIGHTS.silver;
  const studio = useMemo(() => {
    const u = Object.fromEntries(COLOURS.map((key) => [key, uniform(new THREE.Color(start[key])) as any])) as Record<(typeof COLOURS)[number], any>;
    const keyDir = uniform(KEY) as any;
    // HDR on purpose: strips well over 1 are what the bloom catches on the spike tips.
    // Plain JS rather than a shader function: its colour uniforms came through a function's layout typed as floats.
    const room = (d: any, lights: any) => {
      const y = d.y as any;
      const around = atan(d.z, d.x) as any;
      const base = mix(mix(u.horizon, u.floor, smoothstep(0, 0.45, y.negate())), u.zenith, smoothstep(0.05, 0.85, y)) as any;
      // Eight tall strip lights standing round the room, and two thin hoops, like a light tent.
      const strips = smoothstep(0.86, 0.975, cos(around.mul(8).add(0.3))).mul(smoothstep(0.62, 0.42, abs(y.sub(0.12)))) as any;
      const hoops = smoothstep(0.024, 0.006, abs(y.sub(0.5))).add(smoothstep(0.018, 0.004, abs(y.add(0.22))).mul(0.6)) as any;
      // A square softbox overhead and a big round one up front and to the left, for the long highlight down the egg.
      const box = smoothstep(0.08, 0, max(abs(d.x).sub(0.3), abs(d.z.add(0.05)).sub(0.3))).mul(smoothstep(0.72, 0.8, y)) as any;
      const key = smoothstep(0.93, 0.975, dot(d, keyDir)) as any;
      const side = cos(around.sub(0.9)).mul(0.5).add(0.5) as any;
      const stripColour = mix(u.left, u.right, side) as any;
      // A broad, dim glow from the ceiling, so that the fluid's flanks read even where no strip is reflected.
      const canopy = smoothstep(-0.1, 1, y) as any;
      const lit = stripColour.mul(strips.mul(5).add(hoops.mul(3.5))).add(u.key.mul(box.mul(6).add(key.mul(7)).add(canopy.mul(canopy).mul(1.4)))) as any;
      return base.add(lit.mul(lights));
    };
    return { ...u, room };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- later changes ease in below.
  }, []);

  const target = useRef(start);
  target.current = LIGHTS[name] ?? LIGHTS.silver;
  useFrame((_, delta) => {
    const ease = 1 - Math.exp(-Math.min(delta, 0.05) * 4);
    for (const key of COLOURS) (studio[key].value as THREE.Color).lerp(scratch.set(target.current[key]), ease);
  });
  return studio;
}

// What you see of the room directly: the same strips, much dimmer, and soft behind the lens blur.
export function roomColour(studio: Studio, direction: any) {
  // Lit from the key's side; the far side of the room falls away into the dark.
  const flat = normalize(vec3(direction.x, 0, direction.z).add(vec3(1e-4, 0, 0))) as any;
  const side = smoothstep(-0.6, 0.8, dot(flat, normalize(vec3(KEY.x, 0, KEY.z)))) as any;
  return studio.room(direction, side.mul(side).mul(0.07).add(0.004)).mul(side.mul(0.7).add(0.3)).add(vec3(0.001, 0.001, 0.0015));
}
