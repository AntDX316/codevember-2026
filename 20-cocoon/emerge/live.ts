import * as THREE from "three/webgpu";
import { texture as textureNode, uniform } from "three/tsl";

// Everything the shaders follow from moment to moment, set from the scene's frame loop: one emergence at a time, so one
// set for all. Changing species only changes these.

const loader = typeof window === "undefined" ? null : new THREE.TextureLoader();
export const atlas = loader ? loader.load("/assets/20-cocoon/wings.webp") : new THREE.Texture();
atlas.colorSpace = THREE.SRGBColorSpace;
atlas.anisotropy = 8;
atlas.generateMipmaps = true;
atlas.minFilter = THREE.LinearMipmapLinearFilter;
// One node for every material that reads the atlas.
export const atlasNode = textureNode(atlas);

export const live = {
  // The chrysalis: how far it has cleared to show the wings inside (0 jade, 1 milky and dark), the abdominal pleats
  // stretched apart, the dark body seen through it, and once empty, the papery exuvia it leaves.
  clear: uniform(0),
  stretch: uniform(0),
  core: uniform(1),
  empty: uniform(0),
  // Fading out (1 gone), for a new chrysalis.
  fade: uniform(0),
  // The eye in the chrysalis' own space, for the body's shadow through it.
  eye: uniform(new THREE.Vector3(0, 0, 3)),
  // Species, for the chrysalis.
  jade: uniform(new THREE.Color()),
  deep: uniform(new THREE.Color()),
  spot: uniform(new THREE.Color()),
  cleared: uniform(new THREE.Color()),
  gold: uniform(0),
  column: uniform(0),
  length: uniform(0.64),
  plump: uniform(0.23),
  // Maps the chrysalis' (t, |u|) to forewing space, for the wing pattern showing through its wing case.
  caseX: uniform(new THREE.Vector3()),
  caseY: uniform(new THREE.Vector3()),

  // Wings: each wing's place on the body (fore right, fore left, hind right, hind left), their bend, and how far
  // they have expanded from the crumpled stubs they come out as.
  wing: [0, 1, 2, 3].map(() => uniform(new THREE.Matrix4())),
  fore: uniform(new THREE.Vector3()),
  hind: uniform(new THREE.Vector3()),
  expand: uniform(1),
  // Packed: 1 while the wings are still pads inside the chrysalis, half the size of the stubs they come out as (the
  // size of the wing case); 0 once they are clear of it. Set by the scene, applied in wings.ts and the rig's probe.
  pack: uniform(0),
  // The pad once its root is out of the slit: 0 the size of the wing case, 1 the half-wing quilted pad it hangs with.
  pad: uniform(0),
  crumple: uniform(0),
  wet: uniform(0),
  // Spanwise bend (tip lag), twist, and chordwise camber (cupped in the upstroke and the clap).
  bend: uniform(0),
  twist: uniform(0),
  camber: uniform(0),
  structure: uniform(1),
  peak: uniform(465),
  through: uniform(0.3),
  hidden: uniform(0),
  // Body: the abdomen full of fluid at first, and its bend against the wingbeat.
  swell: uniform(0),
  tuck: uniform(0),
  body: uniform(new THREE.Color()),
  fur: uniform(new THREE.Color()),
  dots: uniform(0)
};

export type Live = typeof live;
