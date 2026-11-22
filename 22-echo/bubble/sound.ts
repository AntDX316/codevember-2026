import { sound } from "../../shared/engine/sound";

// The bubble's voices, built on the engine's context and ending in its master. A tap is a soft round thrum of the
// membrane, a breath of air and a glassy shimmer over it; when the ring closes on the far side the shimmer comes back,
// quieter, darker and from the other side, and once more, fainter, as it returns. A held press hums a pure tone whose
// pitch climbs with the pattern on the film.

let noise: AudioBuffer | null = null;
function air(context: AudioContext) {
  if (noise && noise.sampleRate === context.sampleRate) return noise;
  noise = context.createBuffer(1, Math.floor(context.sampleRate * 0.6), context.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

function stereo(context: AudioContext, out: AudioNode, pan: number) {
  const panner = context.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(out);
  return panner;
}

const tone = (context: AudioContext, into: AudioNode, at: number, freq: number, level: number, attack: number, decay: number, bend = 1) => {
  const osc = context.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq * bend, at);
  osc.frequency.exponentialRampToValueAtTime(freq, at + 0.25);
  const env = context.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  osc.connect(env);
  env.connect(into);
  osc.start(at);
  osc.stop(at + attack + decay + 0.05);
};

// A tap: `echo` 0 is the strike itself, 1 the ring meeting on the far side, 2 its return.
export function thrum(pitch: number, pan: number, echo = 0) {
  sound.custom((context, out, at) => {
    const bus = stereo(context, out, pan * 0.6);
    const shade = context.createBiquadFilter();
    shade.type = "lowpass";
    shade.frequency.value = [12000, 3800, 2200][echo];
    shade.connect(bus);
    const g = [1, 0.4, 0.2][echo];
    if (echo === 0) {
      // The membrane's thrum: low, soft, bending a little down as it settles; and the puff of air off it.
      tone(context, shade, at, pitch * 0.5, 0.42, 0.012, 0.9, 1.12);
      tone(context, shade, at, pitch * 0.5 * 1.51, 0.1, 0.01, 0.5, 1.08);
      const breath = context.createBufferSource();
      breath.buffer = air(context);
      const band = context.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.setValueAtTime(pitch * 7, at);
      band.frequency.exponentialRampToValueAtTime(pitch * 2.5, at + 0.25);
      band.Q.value = 1.4;
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(0.22, at + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      breath.connect(band);
      band.connect(env);
      env.connect(shade);
      breath.start(at);
      breath.stop(at + 0.35);
    }
    // The shimmer: a few glassy partials, a hair apart so they beat softly, the high ones shortest.
    const ring = (ratio: number, level: number, decay: number) => {
      tone(context, shade, at, pitch * ratio, level * g, echo ? 0.05 : 0.004, decay, 1.004);
      tone(context, shade, at, pitch * ratio * 1.0035, level * g * 0.6, echo ? 0.06 : 0.006, decay * 0.8, 1.004);
    };
    ring(2, 0.12, 2.4);
    ring(3.01, 0.07, 1.6);
    ring(4.97, 0.04, 0.9);
    ring(7.1, 0.018, 0.45);
    window.setTimeout(() => bus.disconnect(), 3500);
  });
}

// A held hum: returns its controls, to move its note and let it go.
export function hum(pitch: number) {
  let control: { note: (pitch: number, level: number) => void; stop: () => void } | null = null;
  sound.custom((context, out, at) => {
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.1, at + 0.5);
    env.connect(out);
    const oscs = [1, 2.003, 3.001].map((ratio, k) => {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.value = pitch * ratio;
      const g = context.createGain();
      g.gain.value = [1, 0.22, 0.08][k];
      osc.connect(g);
      g.connect(env);
      osc.start(at);
      return { osc, ratio };
    });
    // The film's slow beat, felt as a gentle swell.
    const swell = context.createOscillator();
    swell.frequency.value = 2.2;
    const depth = context.createGain();
    depth.gain.value = 0.025;
    swell.connect(depth);
    depth.connect(env.gain);
    swell.start(at);
    control = {
      note: (next, level) => {
        const now = context.currentTime;
        for (const { osc, ratio } of oscs) osc.frequency.setTargetAtTime(next * ratio, now, 0.12);
        env.gain.setTargetAtTime(0.1 * level, now, 0.1);
      },
      stop: () => {
        const now = context.currentTime;
        env.gain.cancelScheduledValues(now);
        env.gain.setValueAtTime(env.gain.value, now);
        env.gain.linearRampToValueAtTime(0, now + 0.7);
        for (const { osc } of oscs) osc.stop(now + 0.75);
        swell.stop(now + 0.75);
      }
    };
  });
  return {
    note: (next: number, level: number) => control?.note(next, level),
    stop: () => control?.stop()
  };
}
