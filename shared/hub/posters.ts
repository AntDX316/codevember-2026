// What the hub knows about each day's poster, beyond its picture: the settings the day was in when it was taken, where a
// day's defaults are not what it shows (Labyrinth opens flat and folds itself up a moment later), and the day's music,
// which leaks out of its portal when you stand close.

import * as THREE from "three/webgpu";
import type { SettingValue } from "@/shared/engine/types";

export const POSTER_SETTINGS: Record<string, Record<string, SettingValue>> = {
  "13-labyrinth": { study: "fold", style: "natural", walk: false, game: false }
};

// Days whose own "reset" would undo more than the poster needs. Labyrinth's would lay the maze flat again.
export const KEEP_ON_RETURN = new Set(["13-labyrinth"]);

// The hub's own posters, sharper than the calendar's and zoomed out from each day's starting view (the same place, seeing
// more round it), so that a portal shows the whole scene. Made by scripts/capture-hub-posters.mjs, which poses each day as
// the way back does, so that coming back from a day lands on its poster exactly.
export const POSTERS = "/hub";
// How much wider than the starting view, across the picture.
const POSTER_WIDEN: Record<string, number> = {};
export const posterWiden = (slug: string) => POSTER_WIDEN[slug] ?? 1.25;
// A poster is 4:5, as its portal is. Arriving back from its day, the hub stands so close to that portal that it covers the
// screen, overfilled by this much (1 is edge to edge): only the middle of the poster shows, across the width of a wide
// screen or the height of a tall one.
export const POSTER_ASPECT = 0.8;
export const ARRIVE_COVER = 0.9;

// The vertical field of view, on a screen `aspect` wide, that sees what the hub will show of a poster taken at `fov`
// (vertical, on a 4:5 frame) when it arrives at that poster: so that the day's last frame and the poster line up.
export function arrivalFov(fov: number, aspect: number) {
  const tall = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const wide = tall * POSTER_ASPECT;
  const shown = aspect >= POSTER_ASPECT ? (wide * ARRIVE_COVER) / aspect : tall * ARRIVE_COVER;
  return THREE.MathUtils.radToDeg(2 * Math.atan(shown));
}

export const HUB_MUSIC = "/codevember/music/choir-of-magical-sounds.mp3";

export const DAY_MUSIC: Record<string, string> = {
  "01-fold": "/codevember/music/the-journey-home.mp3",
  "02-shatter": "/codevember/music/festival-of-lights-dhol.mp3",
  "03-melt": "/codevember/music/midnight-reflections.mp3",
  "04-tangle": "/codevember/music/uplifting-moment.mp3",
  "05-moss": "/codevember/music/cinematic-uplifting.mp3",
  "06-orrery": "/codevember/music/icy-shimmering.mp3",
  "07-hollow": "/codevember/music/uplifting-cinematic-vlog.mp3",
  "08-tesseract": "/codevember/music/across-infinite-worlds.mp3",
  "09-membrane": "/codevember/music/radiant-echoes.mp3",
  "10-caustic": "/codevember/music/born-to-rise.mp3",
  "11-rust": "/codevember/music/where-time-rests.mp3",
  "12-feather": "/codevember/music/rising-spark.mp3",
  "13-labyrinth": "/codevember/music/the-ultimate-betrayal.mp3",
  "14-tension": "/codevember/music/analytical-crime-underscore.mp3",
  "15-mirage": "/codevember/music/spaghetti-waxtern.mp3",
  "16-spore": "/codevember/music/choir-of-magical-sounds.mp3"
};
