// Five deserts, the same dunes in each: the hour, the sand, the sky, and what the water is like. A style changes
// materials and light only, never the shape of the land.

export type Style = "sahara" | "gypsum" | "rum" | "moonlit" | "obsidian";

export type Look = {
  label: string;
  swatch: string[];
  // The sky: overhead, at the horizon, and the sun (or moon) and its light.
  zenith: string;
  horizon: string;
  sun: string;
  power: number;
  toSun: [number, number, number];
  // How much the sun's disc and glow show, and how many stars.
  disc: number;
  stars: number;
  // Sand: its body, its darker grains, and the odd bright or coloured one.
  sand: string;
  sandDark: string;
  fleck: string;
  // Water: its colour deep, how quickly light dies in it, and whether it is a mirror of metal.
  water: string;
  absorb: number;
  metal: boolean;
  // The oasis: the dark earth under it, grass at its root and tip, palm fronds and trunks, and the odd flower.
  soil: string;
  grass: string;
  grassTip: string;
  frond: string;
  trunk: string;
  flower: string;
  exposure: number;
  bloom: number;
};

export const LOOKS: Record<Style, Look> = {
  sahara: {
    label: "Sahara",
    swatch: ["#e0a868", "#1aa6a0", "#f2b27a"],
    zenith: "#3f6fb0",
    horizon: "#f3c495",
    sun: "#ffc98a",
    power: 2.6,
    toSun: [-0.75, 0.24, -0.55],
    disc: 1,
    stars: 0,
    sand: "#e3a565",
    sandDark: "#b06e38",
    fleck: "#fff0d0",
    water: "#1aa8a0",
    absorb: 14,
    metal: false,
    soil: "#6e5432",
    grass: "#2f5a1c",
    grassTip: "#8fb04a",
    frond: "#3a6a26",
    trunk: "#7a5a3a",
    flower: "#ff7a5a",
    exposure: 1,
    bloom: 0.4
  },
  gypsum: {
    label: "White Sands",
    swatch: ["#f2eee6", "#62cfd4", "#2563c4"],
    zenith: "#2463c2",
    horizon: "#cddcec",
    sun: "#fffaf0",
    power: 1.6,
    toSun: [0.45, 0.42, -0.5],
    disc: 1,
    stars: 0,
    sand: "#ebe2d2",
    sandDark: "#b3a690",
    fleck: "#ffffff",
    water: "#3fc2cc",
    absorb: 14,
    metal: false,
    soil: "#8a8270",
    grass: "#3c6a2a",
    grassTip: "#a8c860",
    frond: "#4c8a3a",
    trunk: "#9a8a70",
    flower: "#ffd45a",
    exposure: 0.9,
    bloom: 0.3
  },
  rum: {
    label: "Red Desert",
    swatch: ["#c8643a", "#1f4fa8", "#f0a27a"],
    zenith: "#4e5596",
    horizon: "#f2a47c",
    sun: "#ffb27a",
    power: 2.4,
    toSun: [0.8, 0.16, -0.45],
    disc: 1,
    stars: 0.15,
    sand: "#c9693d",
    sandDark: "#86361c",
    fleck: "#ffd2a8",
    water: "#2a9db5",
    absorb: 30,
    metal: false,
    soil: "#4a2418",
    grass: "#2c5220",
    grassTip: "#94a848",
    frond: "#3a6e2a",
    trunk: "#6a4030",
    flower: "#ffb0d0",
    exposure: 1.05,
    bloom: 0.45
  },
  moonlit: {
    label: "Moonlit",
    swatch: ["#8f9ab0", "#0d2a40", "#050a1c"],
    zenith: "#03081a",
    horizon: "#1b2a4c",
    sun: "#cfe0ff",
    power: 1.1,
    toSun: [-0.55, 0.3, -0.7],
    disc: 0.7,
    stars: 1,
    sand: "#a4adc2",
    sandDark: "#5d6680",
    fleck: "#e8f0ff",
    water: "#1d5a7a",
    absorb: 28,
    metal: false,
    soil: "#2a2e3a",
    grass: "#1a3a34",
    grassTip: "#5a8a7a",
    frond: "#24504a",
    trunk: "#3a3a44",
    flower: "#e8e0ff",
    exposure: 1.6,
    bloom: 0.6
  },
  obsidian: {
    label: "Black Sand",
    swatch: ["#2b2a2c", "#cfd3dc", "#e3e0da"],
    zenith: "#5f6c7c",
    horizon: "#c9c5be",
    sun: "#fff6ea",
    power: 2.2,
    toSun: [0.5, 0.45, -0.6],
    disc: 0.5,
    stars: 0,
    sand: "#38353a",
    sandDark: "#141316",
    fleck: "#d9e2ff",
    water: "#b4bcc9",
    absorb: 0,
    metal: true,
    soil: "#141416",
    grass: "#2a4a30",
    grassTip: "#7a9a6a",
    frond: "#3a5a40",
    trunk: "#2a2626",
    flower: "#ff5a3a",
    exposure: 1,
    bloom: 0.5
  }
};

export const STYLES = (Object.keys(LOOKS) as Style[]).map((value) => ({
  value,
  label: LOOKS[value].label,
  swatch: LOOKS[value].swatch
}));
