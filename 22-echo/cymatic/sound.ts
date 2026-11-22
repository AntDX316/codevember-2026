import { sound } from "../../shared/engine/sound";

// The root the modes are tuned up from, in hertz: each mode sounds its own note of a minor pentatonic scale above it.
const ROOT = 196;
export const noteOf = (semitones: number) => ROOT * Math.pow(2, semitones / 12);

// A struck singing bowl: a pure fundamental with its slightly beating twin, a few inharmonic partials that die fast, and a
// soft felt knock, ringing out through a long dark delay so the tone comes back as an echo, lower in the mix each time.
export function strike(semitones: number, { gain = 1, pan = 0, echo = false }: { gain?: number; pan?: number; echo?: boolean } = {}) {
  sound.custom((context, out, at) => {
    const f = noteOf(semitones);
    const bus = context.createGain();
    bus.gain.value = gain * (echo ? 0.16 : 0.42);
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = echo ? 1600 : 5200;
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    bus.connect(tone);
    tone.connect(panner);
    panner.connect(out);
    const delay = context.createDelay(1);
    delay.delayTime.value = 0.31;
    const back = context.createGain();
    back.gain.value = echo ? 0.2 : 0.36;
    const damp = context.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 1300;
    tone.connect(delay);
    delay.connect(damp);
    damp.connect(back);
    back.connect(delay);
    damp.connect(panner);

    const partials: [number, number, number][] = [
      [f, 1, 4.2],
      [f * 1.004, 0.6, 4.6],
      [f * 2.71, 0.22, 1.3],
      [f * 5.2, 0.08, 0.45],
      [f * 0.5, 0.18, 2.4]
    ];
    const stop = at + 6;
    for (const [freq, amp, decay] of partials) {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq * 1.006, at);
      osc.frequency.exponentialRampToValueAtTime(freq, at + 0.12);
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(amp, at + (echo ? 0.03 : 0.006));
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      osc.connect(env);
      env.connect(bus);
      osc.start(at);
      osc.stop(stop);
    }
    if (!echo) {
      const knock = context.createOscillator();
      knock.frequency.setValueAtTime(260, at);
      knock.frequency.exponentialRampToValueAtTime(90, at + 0.1);
      const kenv = context.createGain();
      kenv.gain.setValueAtTime(0.22, at);
      kenv.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      knock.connect(kenv);
      kenv.connect(bus);
      knock.start(at);
      knock.stop(at + 0.16);
    }
    window.setTimeout(() => {
      back.gain.value = 0;
      bus.disconnect();
      panner.disconnect();
    }, 8500);
  });
}

// A held tone: the bowl bowed rather than struck, swelling in and singing for as long as the press lasts, a slow shimmer in
// it from two detuned voices. Returns what lets it go.
export function bow(semitones: number) {
  let release = () => {};
  sound.custom((context, out, at) => {
    const f = noteOf(semitones);
    const bus = context.createGain();
    bus.gain.setValueAtTime(0, at);
    bus.gain.linearRampToValueAtTime(0.2, at + 0.9);
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2400;
    bus.connect(tone);
    tone.connect(out);
    const oscs: OscillatorNode[] = [];
    for (const [freq, amp] of [
      [f, 0.55],
      [f * 1.003, 0.45],
      [f * 2, 0.12],
      [f * 3.01, 0.05]
    ] as const) {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = context.createGain();
      g.gain.value = amp;
      osc.connect(g);
      g.connect(bus);
      osc.start(at);
      oscs.push(osc);
    }
    release = () => {
      const now = context.currentTime;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);
      for (const osc of oscs) osc.stop(now + 2.3);
      window.setTimeout(() => bus.disconnect(), 2600);
    };
  });
  return () => release();
}
