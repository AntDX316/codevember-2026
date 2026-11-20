// The skins the panel offers. skin and mottle colour the surface itself, kept dark so the light inside does the work;
// absorb is how strongly the flesh soaks up red, green and blue per unit of depth (what tints the glow); glow is the
// light the sleeper gives off; seam the gold the cracks burn with; film how much the surface plays oil-on-water colours;
// wing the hue the creature of light leans towards.
export type Skin = {
  label: string;
  swatch: string[];
  skin: string;
  mottle: string;
  absorb: [number, number, number];
  glow: string;
  strength: number;
  seam: string;
  gold: string;
  film: number;
  wing: string;
};

export const SKINS: Record<string, Skin> = {
  jade: {
    label: "Jade",
    swatch: ["#1f7a4c", "#e8c35a"],
    skin: "#0e2c20",
    mottle: "#1a4430",
    absorb: [4.2, 1.35, 2.1],
    glow: "#c2e09c",
    strength: 0.62,
    seam: "#ffc861",
    gold: "#f2c14e",
    film: 0.15,
    wing: "#9fffe0"
  },
  amber: {
    label: "Amber",
    swatch: ["#c7741c", "#ffe2a0"],
    skin: "#5a2a08",
    mottle: "#7a3c10",
    absorb: [0.45, 1.35, 3.6],
    glow: "#ffc070",
    strength: 0.85,
    seam: "#fff0b8",
    gold: "#ffd27a",
    film: 0.12,
    wing: "#ffd9a0"
  },
  obsidian: {
    label: "Obsidian",
    swatch: ["#0b0b0d", "#d6a645"],
    skin: "#040405",
    mottle: "#0c0b0e",
    absorb: [7.5, 9, 11],
    glow: "#ff7a2a",
    strength: 2.4,
    seam: "#ffb340",
    gold: "#d9a441",
    film: 0.3,
    wing: "#ffb070"
  },
  opal: {
    label: "Opal",
    swatch: ["#cfd6e6", "#f3b8d8"],
    skin: "#8a90a0",
    mottle: "#a49cb4",
    absorb: [1.25, 1.1, 0.85],
    glow: "#ffd8f4",
    strength: 0.65,
    seam: "#c8f6ff",
    gold: "#e9e2d0",
    film: 0.9,
    wing: "#d8c8ff"
  }
};

export const SKIN_OPTIONS = Object.entries(SKINS).map(([value, s]) => ({ value, label: s.label, swatch: s.swatch }));
