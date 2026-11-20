// The four butterflies, each true to size at the scene's scale (a fifth of a unit to the centimetre, so that the chrysalis
// reads at the size Tension's web does), with its wingbeat, its chrysalis and its wings in the atlas.

export type SpeciesName = "morpho" | "monarch" | "glasswing" | "paperkite";

// Where a wing's tile lies in wing space, in forewing lengths: its top-left corner (x out from the body, y toward the
// head) and its side. Measured when the wings were cut from the photographs (wings.json).
export type Frame = [x0: number, y0: number, size: number];

// What the card says about it: all true, checked against the sources in the scratch notes.
export type Info = { name: string; latin: string; range: string; wingspan: string; facts: string[] };

export type Species = {
  label: string;
  short: string;
  // Column in the wing atlas.
  column: number;
  fore: Frame;
  hind: Frame;
  // Forewing length, in scene units (5 = 1 cm... 0.2 a centimetre).
  wing: number;
  // Chrysalis length and half-width as a fraction of its length.
  pupa: number;
  plump: number;
  // Wingbeats a second in flight, and how much of a flight is spent gliding.
  beat: number;
  glide: number;
  // Structural colour on the upper side: none, Morpho blue (by its Bragg peak in nm), or the swallowtail's green bands.
  structure: 0 | 1 | 2;
  peak: number;
  // How much light comes through the wing from behind.
  through: number;
  // Walking legs: nymphalids walk on four, the forelegs folded up; swallowtails on six.
  legs: 4 | 6;
  body: string;
  fur: string;
  // The chrysalis: its jade, the deep colour in its grooves, the dots and spiracles, and how it looks once cleared.
  jade: string;
  deep: string;
  spot: string;
  gold: number;
  cleared: string;
  // Swallowtail pupae are angular, with two horns at the head end and a keel on the thorax.
  horns: number;
  info: Info;
  // How long it is a chrysalis, in days (see LIFE below for where each figure is from).
  pupaDays: number;
  // Motion (BUTTERFLY): beats in a flapping bout and seconds in a glide, each [least, most]; the V the wings are held
  // in while gliding (radians above level); stroke top and bottom (radians above level); walking speed on a branch
  // (scene units a second); how often and how wide it fans its wings when perched (1 = flat open).
  bout: [number, number];
  glideFor: [number, number];
  dihedral: number;
  stroke: [top: number, bottom: number];
  pace: number;
  bask: number;
  // Looks (BUTTERFLY): 1 for clear glass panes between the veins; pale markings on the body (0 none, 1 the monarch's
  // white dots, 2 the paper kite's white streaks and dots); the colour of those markings and of the compound eyes.
  glass: number;
  marks: 0 | 1 | 2;
  mark: string;
  eye: string;
};

export const SPECIES: Record<SpeciesName, Species> = {
  morpho: {
    label: "Blue Morpho",
    short: "Morpho",
    column: 0,
    fore: [-0.0025, 0.7645, 0.7811],
    hind: [-0.0025, 0.0626, 0.7811],
    wing: 1.2,
    pupa: 0.64,
    plump: 0.27,
    beat: 6,
    glide: 0.35,
    structure: 1,
    peak: 465,
    through: 0.07,
    legs: 4,
    body: "#2a2019",
    fur: "#5a4634",
    jade: "#4f9a52",
    deep: "#2c5e33",
    spot: "#e8d84a",
    gold: 0,
    cleared: "#6b5a44",
    horns: 0,
    bout: [2, 6],
    glideFor: [0.25, 0.8],
    dihedral: 0.16,
    stroke: [1.48, -0.62],
    pace: 0.42,
    bask: 0.8,
    glass: 0,
    marks: 0,
    mark: "#b9a488",
    eye: "#4a3520",
    pupaDays: 14,
    info: {
      name: "Blue Morpho",
      latin: "Morpho peleides",
      range: "Rainforests from Mexico through Central America to Colombia and Venezuela",
      wingspan: "12–15 cm",
      facts: [
        "Its blue is not pigment: ridges on the wing scales, finer than a wavelength of light, reflect only blue.",
        "The underside is brown with eyespots, so in flight it flashes blue and vanishes with every beat.",
        "Adults do not visit flowers much: they drink the juice of rotting fruit."
      ]
    }
  },
  monarch: {
    label: "Monarch",
    short: "Monarch",
    column: 1,
    fore: [-0.0034, 0.719, 0.8566],
    hind: [-0.0034, 0.1508, 0.8566],
    wing: 0.98,
    pupa: 0.55,
    plump: 0.24,
    beat: 9,
    glide: 0.4,
    structure: 0,
    peak: 0,
    through: 0.9,
    legs: 4,
    body: "#141110",
    fur: "#2a2522",
    jade: "#79c46e",
    deep: "#3f8a46",
    spot: "#e9c45a",
    gold: 1,
    cleared: "#4a3a2c",
    horns: 0,
    bout: [2, 5],
    glideFor: [0.4, 1.4],
    dihedral: 0.35,
    stroke: [1.4, -0.5],
    pace: 0.36,
    bask: 1,
    glass: 0,
    marks: 1,
    mark: "#f1eee6",
    eye: "#1c1512",
    pupaDays: 10,
    info: {
      name: "Monarch",
      latin: "Danaus plexippus",
      range: "North America, wintering in the mountain fir forests of central Mexico and on the California coast",
      wingspan: "9–10 cm",
      facts: [
        "Each autumn it flies up to 4,000 km south to forests it has never seen.",
        "The migrating generation lives up to eight months; summer generations only a few weeks.",
        "Its caterpillar eats milkweed and keeps the poison, which the orange warns birds about."
      ]
    }
  },
  glasswing: {
    label: "Glasswing",
    short: "Glasswing",
    column: 2,
    fore: [-0.0058, 0.7582, 0.9182],
    hind: [-0.0058, 0.3422, 0.9182],
    wing: 0.6,
    pupa: 0.42,
    plump: 0.21,
    beat: 9,
    glide: 0.2,
    structure: 0,
    peak: 0,
    through: 1,
    legs: 4,
    body: "#1d1813",
    fur: "#3b2e24",
    jade: "#8fc6a4",
    deep: "#4c8a68",
    spot: "#dfe8e4",
    gold: 0.6,
    cleared: "#5b5046",
    horns: 0,
    bout: [8, 22],
    glideFor: [0.08, 0.25],
    dihedral: 0.2,
    stroke: [1.3, -0.45],
    pace: 0.26,
    bask: 0.7,
    glass: 1,
    marks: 1,
    mark: "#e6e2d6",
    eye: "#2a1f18",
    pupaDays: 8,
    info: {
      name: "Glasswing",
      latin: "Greta oto",
      range: "Rainforests of Central America, from Mexico to Panama and Colombia",
      wingspan: "5.5–6 cm",
      facts: [
        "Its wings have almost no scales, only clear membrane between the veins.",
        "Tiny pillars of random heights cover the membrane and stop it glinting: it reflects about 2% of light.",
        "Its chrysalis is a mirror too, silvered to reflect the leaves around it."
      ]
    }
  },
  paperkite: {
    label: "Paper Kite",
    short: "Kite",
    column: 3,
    fore: [-0.0031, 0.7355, 0.9019],
    hind: [-0.0031, 0.1762, 0.9019],
    wing: 1.25,
    pupa: 0.5,
    plump: 0.25,
    beat: 4,
    glide: 0.7,
    structure: 0,
    peak: 0,
    through: 0.7,
    legs: 4,
    body: "#15130f",
    fur: "#3a3632",
    jade: "#e0a92c",
    deep: "#8a5a10",
    spot: "#14100a",
    gold: 0,
    cleared: "#5a4a30",
    horns: 0,
    bout: [1, 3],
    glideFor: [0.9, 2.6],
    dihedral: 0.3,
    stroke: [1.2, -0.38],
    pace: 0.34,
    bask: 1,
    glass: 0,
    marks: 2,
    mark: "#f4f2ea",
    eye: "#1a1512",
    pupaDays: 12,
    info: {
      name: "Paper Kite",
      latin: "Idea leuconoe",
      range: "Coastal and mangrove forests of Southeast Asia: the Philippines, Borneo, Taiwan and southern Japan",
      wingspan: "12–14 cm",
      facts: [
        "Its chrysalis is mirror gold with black spots, among the brightest of any butterfly.",
        "It barely flaps: it floats and glides so slowly it looks like paper drifting on the air.",
        "It is poisonous to birds, from the vines its caterpillar eats, and flies slowly because it can afford to."
      ]
    }
  }
};

export const SPECIES_NAMES = Object.keys(SPECIES) as SpeciesName[];
export const SPECIES_OPTIONS = SPECIES_NAMES.map((value) => ({ value, label: SPECIES[value].label, short: SPECIES[value].short }));

// Real time, for the status line: what the few seconds on screen stand for. Only what a source gives; the rest is left
// out. Chrysalis days (pupaDays above): Blue Morpho about 14 (13 to 15: UF/IFAS IN1101; PMC12623030); Monarch 8 to 15,
// about 10 in warm weather (Espace pour la vie; Monarch Joint Venture rearing data: 8 d at 25 C, 12 d at 20 C);
// Glasswing about 8 (Butterfly Farm, Costa Rica: one source); Paper Kite 10 to 14 (a breeder's figure: one source).
// The rest is from the notes in research/eclosion.md and holds for butterflies generally.
export const LIFE = {
  // The wing colours begin to show through the shell this many days before it opens, and the shell goes clear in
  // about the last day.
  colourDays: 3,
  clearDays: 1,
  // The pleats of the abdomen stretch apart in the last hour.
  pleatsMinutes: 60,
  // From the first crack to out and holding on: a minute or so, up to five; then the wings fill in about a quarter of
  // an hour from the crack, and are dry enough to fly in one to two hours.
  outMinutes: 3,
  filledMinutes: 15,
  dryMinutes: 120
};
