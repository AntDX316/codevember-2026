import { sound } from "../../shared/engine/sound";

// Two sounds, both made here: the soft pip of a pulse leaving the probe with its echo coming back a moment later,
// fainter and duller; and the hiss of the beam as it is swept, following the sweep's speed.

let noise: { context: AudioContext; buffer: AudioBuffer } | null = null;

function pinkNoise(context: AudioContext) {
  if (noise && noise.context === context) return noise.buffer;
  const buffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  noise = { context, buffer };
  return buffer;
}

function pip(context: AudioContext, out: AudioNode, at: number, frequency: number, gain: number, length: number, cutoff: number) {
  const oscillator = context.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, at);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.94, at + length);
  const low = context.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = cutoff;
  const env = context.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(gain, at + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  oscillator.connect(low);
  low.connect(env);
  env.connect(out);
  oscillator.start(at);
  oscillator.stop(at + length + 0.02);
}

// A pulse: the pip out, then its echo after `delay` seconds (from how deep the first strong echo lies), and a second,
// fainter one off the walls behind.
export function pulse(gain: number, delay: number) {
  sound.custom((context, out, at) => {
    pip(context, out, at, 2350, 0.11 * gain, 0.07, 9000);
    pip(context, out, at + delay, 2280, 0.05 * gain, 0.12, 3200);
    pip(context, out, at + delay * 1.6 + 0.04, 2250, 0.018 * gain, 0.16, 2000);
  });
}

// The sweep: a band of soft noise that opens up and brightens with the beam's speed. Built once, on the first call
// after sound is woken, then only steered.
let sweep: { level: GainNode; band: BiquadFilterNode; context: AudioContext; source: AudioBufferSourceNode } | null = null;

export function sweepAt(speed: number) {
  if (!sweep) {
    sound.custom((context, out) => {
      const source = context.createBufferSource();
      source.buffer = pinkNoise(context);
      source.loop = true;
      const band = context.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 700;
      band.Q.value = 1.6;
      const level = context.createGain();
      level.gain.value = 0;
      source.connect(band);
      band.connect(level);
      level.connect(out);
      source.start();
      sweep = { level, band, context, source };
    });
    return;
  }
  const now = sweep.context.currentTime;
  const amount = Math.min(1, speed / 2.2);
  sweep.level.gain.setTargetAtTime(amount * amount * 0.22, now, 0.06);
  sweep.band.frequency.setTargetAtTime(600 + amount * 1700, now, 0.08);
}

// Stops the sweep when the scene goes, so it does not hiss on into the next day.
export function stopSweep() {
  if (!sweep) return;
  const now = sweep.context.currentTime;
  sweep.level.gain.setTargetAtTime(0, now, 0.05);
  sweep.source.stop(now + 0.3);
  sweep = null;
}
