import { sound } from "../../shared/engine/sound";

// A bat's call brought down into hearing: a quick downward sweep, glassy and clean, with a soft breath of air under it.
// Its echo is the same sweep come back off the flock: later, duller and quieter. A startled flock answers with a rush of
// wings as the front runs through it.

let noise: AudioBuffer | null = null;
const noiseFor = (context: AudioContext) => {
  if (noise && noise.sampleRate === context.sampleRate) return noise;
  noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
};

export function chirp({ gain = 1, pan = 0, echo = false, short = false, pitch = 1 }: { gain?: number; pan?: number; echo?: boolean; short?: boolean; pitch?: number } = {}) {
  sound.custom((context, out, at) => {
    const bus = context.createGain();
    bus.gain.value = gain * (echo ? 0.11 : 0.3);
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = echo ? 2600 : 9000;
    bus.connect(tone);
    tone.connect(panner);
    panner.connect(out);

    const span = short ? 0.028 : 0.06;
    const top = 5200 * pitch;
    const bottom = (short ? 2600 : 1900) * pitch;
    for (const [mult, amp] of [
      [1, 1],
      [2, 0.18]
    ] as const) {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(top * mult, at);
      osc.frequency.exponentialRampToValueAtTime(bottom * mult, at + span);
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(amp, at + 0.004);
      env.gain.setValueAtTime(amp, at + span * 0.5);
      env.gain.exponentialRampToValueAtTime(0.0001, at + span + (echo ? 0.09 : 0.05));
      osc.connect(env);
      env.connect(bus);
      osc.start(at);
      osc.stop(at + span + 0.15);
    }
    // A low, soft pulse under it so a tap lands in the hand, not only in the ear.
    if (!echo && !short) {
      const body = context.createOscillator();
      body.frequency.setValueAtTime(320, at);
      body.frequency.exponentialRampToValueAtTime(120, at + 0.12);
      const benv = context.createGain();
      benv.gain.setValueAtTime(0.0001, at);
      benv.gain.exponentialRampToValueAtTime(0.35, at + 0.006);
      benv.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      body.connect(benv);
      benv.connect(bus);
      body.start(at);
      body.stop(at + 0.22);
    }
    // A little room after it, dark and short.
    const delay = context.createDelay(1);
    delay.delayTime.value = 0.09;
    const back = context.createGain();
    back.gain.value = 0.32;
    const damp = context.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 1800;
    tone.connect(delay);
    delay.connect(damp);
    damp.connect(back);
    back.connect(delay);
    back.connect(panner);
    window.setTimeout(() => {
      back.gain.value = 0;
      bus.disconnect();
      panner.disconnect();
    }, 2000);
  });
}

// The flock's wings as the front sweeps through it: filtered air swelling and falling away over the time it takes to cross.
export function rush({ gain = 1, pan = 0, length = 1.2 }: { gain?: number; pan?: number; length?: number } = {}) {
  sound.custom((context, out, at) => {
    const src = context.createBufferSource();
    src.buffer = noiseFor(context);
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 0.7;
    band.frequency.setValueAtTime(700, at);
    band.frequency.linearRampToValueAtTime(1500, at + length * 0.4);
    band.frequency.linearRampToValueAtTime(600, at + length);
    // The flutter of thousands of wings: the level shaken quickly.
    const flutter = context.createOscillator();
    flutter.frequency.value = 17 + Math.random() * 6;
    const depth = context.createGain();
    depth.gain.value = 0.35;
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(0.16 * gain, at + length * 0.3);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    const trem = context.createGain();
    trem.gain.value = 0.65;
    flutter.connect(depth);
    depth.connect(trem.gain);
    src.connect(band);
    band.connect(trem);
    trem.connect(env);
    env.connect(panner);
    panner.connect(out);
    src.start(at);
    src.stop(at + length + 0.05);
    flutter.start(at);
    flutter.stop(at + length + 0.05);
  });
}
