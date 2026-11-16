// Three nights on the same forest floor, each with its own glow. They share everything but colour: the light the
// mushrooms and threads give off, the moonlight and the dark of the woods behind.

export type Style = "foxfire" | "ghost" | "aurora";

export type Look = {
  label: string;
  swatch: string[];
  // The mushrooms' light, at the gills and through the cap, and the threads' light under the litter; and the four
  // colours the clusters take between them.
  glow: string;
  palette: string[];
  cap: string;
  thread: string;
  // The moon: its colour, how strong, and which way it lies.
  moon: string;
  moonPower: number;
  toMoon: [number, number, number];
  // The woods behind, from overhead to the floor, and the far glows of other blooms deep among the trees.
  zenith: string;
  horizon: string;
  far: string[];
  exposure: number;
  bloom: number;
};

export const LOOKS: Record<Style, Look> = {
  foxfire: {
    label: "Foxfire",
    swatch: ["#9dff6a", "#123018"],
    glow: "#8cff5c",
    palette: ["#8cff5c", "#4dffc0", "#d8ff5a", "#3fe0ff"],
    cap: "#c8ff9a",
    thread: "#4dffc0",
    moon: "#9fb6d8",
    moonPower: 0.55,
    toMoon: [-0.35, 0.8, -0.55],
    zenith: "#03070b",
    horizon: "#0d1c1a",
    far: ["#5cff7a", "#b6ff6a", "#3fe8b0"],
    exposure: 1.05,
    bloom: 0.7
  },
  ghost: {
    label: "Ghost",
    swatch: ["#6ae0ff", "#0c1a30"],
    glow: "#5cd8ff",
    palette: ["#5cd8ff", "#7a8cff", "#9af6ff", "#4dffd0"],
    cap: "#c2f2ff",
    thread: "#7ab8ff",
    moon: "#a8b8e8",
    moonPower: 0.6,
    toMoon: [0.4, 0.75, -0.55],
    zenith: "#02050c",
    horizon: "#0b1528",
    far: ["#4fc8ff", "#8ae6ff", "#5a8cff"],
    exposure: 1.05,
    bloom: 0.72
  },
  aurora: {
    label: "Aurora",
    swatch: ["#c77bff", "#3ff0c8"],
    glow: "#c070ff",
    palette: ["#c070ff", "#ff5ad0", "#6a8cff", "#40f0c8"],
    cap: "#f0c8ff",
    thread: "#40f0c8",
    moon: "#c0b0e0",
    moonPower: 0.5,
    toMoon: [-0.2, 0.85, -0.5],
    zenith: "#06030c",
    horizon: "#160c24",
    far: ["#b46cff", "#ff6ad8", "#3ff0c8"],
    exposure: 1.05,
    bloom: 0.75
  }
};

export const STYLES = (Object.keys(LOOKS) as Style[]).map((value) => ({ value, label: LOOKS[value].label, swatch: LOOKS[value].swatch }));
