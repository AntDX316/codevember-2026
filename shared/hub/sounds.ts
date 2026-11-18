"use client";

import { useSyncExternalStore } from "react";
import { sound } from "@/shared/engine/sound";

// The hub's own sounds, with a choice of each to try out: pointing at something in the calendar, pressing the way between
// the page and the calendar, and the move between them, which plays forward into the calendar and backward out of it. Each
// is made fresh from oscillators and noise, through the engine's master level, so the sound button covers it.

type Make = (c: AudioContext, out: AudioNode, at: number, options: { pitch: number; gain: number; back: boolean }) => void;
type Choice = { id: string; name: string; make: Make | null };

// A tone that slides from one frequency to another, rising to `gain` over `attack` and dying away over `decay`.
function tone(c: AudioContext, out: AudioNode, at: number, type: OscillatorType, from: number, to: number, attack: number, decay: number, gain: number, lowpass?: number) {
  const oscillator = c.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(from, at);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + attack + decay);
  const envelope = c.createGain();
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  let head: AudioNode = oscillator;
  if (lowpass) {
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpass;
    oscillator.connect(filter);
    head = filter;
  }
  head.connect(envelope);
  envelope.connect(out);
  oscillator.start(at);
  oscillator.stop(at + attack + decay + 0.05);
}

// Noise through a filter that sweeps from one frequency to another, swelling over `attack` and dying over `decay`.
const noises = new WeakMap<AudioContext, AudioBuffer>();
function air(c: AudioContext, out: AudioNode, at: number, type: BiquadFilterType, from: number, to: number, q: number, attack: number, decay: number, gain: number) {
  let buffer = noises.get(c);
  if (!buffer) {
    buffer = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const data = buffer.getChannelData(0);
    // Pink, roughly: white noise leaning toward the low end.
    let last = 0;
    for (let i = 0; i < data.length; i++) data[i] = last = last * 0.86 + (Math.random() * 2 - 1) * 0.3;
    noises.set(c, buffer);
  }
  const source = c.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, at);
  filter.frequency.exponentialRampToValueAtTime(to, at + attack + decay);
  const envelope = c.createGain();
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(out);
  source.start(at, Math.random());
  source.stop(at + attack + decay + 0.05);
}

// Pointing at a day or a button: `pitch` rises with the day, so running along the month plays up a scale.
export const HOVERS: Choice[] = [
  {
    id: "tap",
    name: "Soft tap",
    // A felt-tipped tap on wood: a short low knock and a breath of air.
    make: (c, out, at, { pitch, gain }) => {
      tone(c, out, at, "sine", 620 * pitch, 380 * pitch, 0.002, 0.07, 0.22 * gain);
      air(c, out, at, "bandpass", 2400 * pitch, 1800 * pitch, 1.4, 0.002, 0.03, 0.05 * gain);
    }
  },
  {
    id: "marimba",
    name: "Marimba",
    // A wooden bar: the note, its fourth harmonic dying fast, the mallet's knock.
    make: (c, out, at, { pitch, gain }) => {
      const base = 520 * pitch;
      tone(c, out, at, "sine", base, base, 0.002, 0.32, 0.2 * gain);
      tone(c, out, at, "sine", base * 3.93, base * 3.93, 0.001, 0.05, 0.05 * gain);
      air(c, out, at, "bandpass", 1500, 1200, 2, 0.001, 0.012, 0.04 * gain);
    }
  },
  {
    id: "bubble",
    name: "Bubble",
    // A drop into water: a quick upward bend, round and soft.
    make: (c, out, at, { pitch, gain }) => {
      tone(c, out, at, "sine", 380 * pitch, 900 * pitch, 0.004, 0.09, 0.2 * gain);
    }
  },
  {
    id: "breath",
    name: "Breath",
    // Air through a reed: a short, rising puff of filtered noise with the faintest pitch in it.
    make: (c, out, at, { pitch, gain }) => {
      air(c, out, at, "bandpass", 900 * pitch, 2600 * pitch, 4, 0.03, 0.12, 0.14 * gain);
      tone(c, out, at, "sine", 1200 * pitch, 1250 * pitch, 0.03, 0.12, 0.02 * gain);
    }
  },
  {
    id: "glass",
    name: "Glass ping (before)",
    make: (c, out, at, { pitch, gain }) => {
      const base = 1568 * pitch * 0.6;
      tone(c, out, at, "sine", base, base, 0.001, 0.5, 0.12 * gain);
      tone(c, out, at + 0.06, "sine", base * 1.498, base * 1.498, 0.001, 0.6, 0.1 * gain);
    }
  },
  { id: "none", name: "None", make: null }
];

// Pressing the way between the page and the calendar.
export const PRESSES: Choice[] = [
  {
    id: "thock",
    name: "Thock",
    // A big key going down: a deep, damped knock and a soft click on top.
    make: (c, out, at, { gain }) => {
      tone(c, out, at, "sine", 180, 70, 0.002, 0.12, 0.45 * gain);
      air(c, out, at, "bandpass", 3200, 2600, 1.5, 0.0008, 0.018, 0.12 * gain);
    }
  },
  {
    id: "pop",
    name: "Pop",
    // A cork: a round upward pop with a little air behind it.
    make: (c, out, at, { gain }) => {
      tone(c, out, at, "sine", 300, 700, 0.002, 0.06, 0.32 * gain);
      air(c, out, at, "highpass", 2000, 4000, 0.7, 0.001, 0.04, 0.06 * gain);
    }
  },
  {
    id: "switch",
    name: "Switch",
    // A heavy toggle: two clicks, down and home, a moment apart.
    make: (c, out, at, { gain }) => {
      for (const [delay, f] of [
        [0, 2600],
        [0.07, 1900]
      ]) {
        air(c, out, at + delay, "bandpass", f, f * 0.8, 2.4, 0.0005, 0.012, 0.22 * gain);
        tone(c, out, at + delay, "sine", 320, 200, 0.001, 0.03, 0.18 * gain);
      }
    }
  },
  {
    id: "click",
    name: "Click (before)",
    make: (c, out, at, { gain }) => {
      air(c, out, at, "bandpass", 4200, 4000, 2.2, 0.0006, 0.01, 0.25 * gain);
      tone(c, out, at, "sine", 2300, 1300, 0.0006, 0.014, 0.16 * gain);
      tone(c, out, at, "sine", 380, 240, 0.001, 0.03, 0.2 * gain);
    }
  },
  { id: "none", name: "None", make: null }
];

// The move between the page and the calendar, about three seconds: forward into the calendar, and `back` out of it, falling
// where it rose.
export const MOVES: Choice[] = [
  {
    id: "rise",
    name: "Rising air",
    // Wind lifting through a widening filter, a low swell under it, and a shimmer as the calendar lands.
    make: (c, out, at, { gain, back }) => {
      const [low, high] = back ? [2400, 260] : [260, 2400];
      air(c, out, at, "bandpass", low, high, 1.2, 1.1, 1.6, 0.32 * gain);
      tone(c, out, at, "sine", back ? 110 : 55, back ? 55 : 110, 0.9, 1.6, 0.18 * gain);
      const land = at + (back ? 2.4 : 2.2);
      [1, 1.5, 2, 2.5].forEach((step, i) => tone(c, out, land + i * 0.05, "sine", 880 * step * (back ? 0.5 : 1), 880 * step * (back ? 0.5 : 1), 0.004, 0.7, 0.03 * gain));
    }
  },
  {
    id: "bloom",
    name: "Chord bloom",
    // A soft major-seventh pad swelling up as the page opens out, and settling; a lower voicing on the way back.
    make: (c, out, at, { gain, back }) => {
      const root = back ? 146.8 : 196;
      [1, 1.26, 1.498, 1.888, 2].forEach((step, i) => {
        tone(c, out, at + i * 0.12, "triangle", root * step, root * step * (back ? 0.997 : 1.003), 0.9, 2.2, 0.05 * gain, 2200);
        tone(c, out, at + i * 0.12, "sine", root * step * 2, root * step * 2, 0.9, 1.6, 0.02 * gain);
      });
      air(c, out, at, "lowpass", back ? 3000 : 400, back ? 400 : 3000, 0.5, 1.2, 1.4, 0.08 * gain);
    }
  },
  {
    id: "warp",
    name: "Warp",
    // A ship spooling up: detuned saws through an opening filter, pitch climbing, and a low hit as it arrives.
    make: (c, out, at, { gain, back }) => {
      for (const detune of [0.995, 1, 1.006]) {
        tone(c, out, at, "sawtooth", (back ? 330 : 82) * detune, (back ? 82 : 330) * detune, 1.2, 1.3, 0.035 * gain, back ? 900 : 1600);
      }
      air(c, out, at, "bandpass", back ? 3000 : 300, back ? 300 : 3000, 2, 1.4, 1.2, 0.14 * gain);
      tone(c, out, at + 2.1, "sine", 120, 40, 0.005, 0.6, 0.35 * gain);
    }
  },
  {
    id: "gears",
    name: "Clockwork",
    // The calendar built out of the page: ticks quickening as the tiles grow out, and a solid thunk as it locks in place.
    make: (c, out, at, { gain, back }) => {
      let t = 0;
      for (let i = 0; i < 18; i++) {
        const gap = 0.2 * Math.pow(0.88, i);
        t += gap;
        air(c, out, at + t, "bandpass", 2800 + i * 90, 2400, 3, 0.0005, 0.012, (0.08 + i * 0.006) * gain);
        tone(c, out, at + t, "sine", 700 + i * 30, 500, 0.001, 0.02, 0.05 * gain);
      }
      tone(c, out, at + t + 0.12, "sine", back ? 220 : 150, back ? 140 : 60, 0.003, 0.35, 0.4 * gain);
      air(c, out, at + t + 0.12, "lowpass", 900, 300, 0.7, 0.002, 0.2, 0.15 * gain);
    }
  },
  {
    id: "whoosh",
    name: "Whoosh (before)",
    make: (c, out, at, { gain, back }) => air(c, out, at, "bandpass", back ? 700 : 130, back ? 130 : 700, 1.1, 0.14, 0.34, 0.4 * gain)
  },
  { id: "none", name: "None", make: null }
];

// Which of each is in use. While trying them out (the Sounds panel in SpaceHud.tsx, now commented out), a choice was kept
// in the browser between visits under this key; it is no longer read, so that everyone hears these.
const KEY = "cv-hub-sounds";
const KINDS = { hover: HOVERS, press: PRESSES, move: MOVES };
export type SoundKind = keyof typeof KINDS;
let chosen: Record<SoundKind, string> = { hover: "bubble", press: "pop", move: "bloom" };
const listeners = new Set<() => void>();
export const chooseSound = (kind: SoundKind, id: string) => {
  chosen = { ...chosen, [kind]: id };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(chosen));
  } catch {
    // For this visit only.
  }
  listeners.forEach((listener) => listener());
};
export const useSounds = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => chosen,
    () => chosen
  );
export const SOUND_KINDS = KINDS;

// A card flicked over: a short breath of air, high and quick. `pitch` near 1, varied a little from card to card.
export function flick(pitch = 1, gain = 1) {
  sound.custom((c, out, at) => {
    air(c, out, at, "bandpass", 5200 * pitch, 2600 * pitch, 1.1, 0.003, 0.05, 0.2 * gain);
    air(c, out, at, "highpass", 7000 * pitch, 6000 * pitch, 0.7, 0.002, 0.025, 0.08 * gain);
  });
}

// Play the chosen sound of a kind.
export function hubSound(kind: SoundKind, options: { pitch?: number; gain?: number; back?: boolean } = {}) {
  const make = KINDS[kind].find((choice) => choice.id === chosen[kind])?.make;
  if (!make) return;
  sound.custom((c, out, at) => make(c, out, at, { pitch: options.pitch ?? 1, gain: options.gain ?? 1, back: options.back ?? false }));
}
