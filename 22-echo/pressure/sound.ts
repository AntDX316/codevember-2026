import { sound } from "../../shared/engine/sound";

// A deep thump with a soft round ping on top, like a stone dropped into deep water heard from inside it. Its echo is the
// same sound come back: quieter, darker and lower.
export function thump({ gain = 1, echo = false, pan = 0 }: { gain?: number; echo?: boolean; pan?: number }) {
  sound.custom((context, out, at) => {
    const bus = context.createGain();
    bus.gain.value = gain * (echo ? 0.42 : 0.8);
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = echo ? 900 : 4000;
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    bus.connect(tone);
    tone.connect(panner);
    panner.connect(out);

    // The body: a low sine that drops as it strikes.
    const low = context.createOscillator();
    low.type = "sine";
    low.frequency.setValueAtTime(echo ? 92 : 120, at);
    low.frequency.exponentialRampToValueAtTime(echo ? 40 : 44, at + 0.22);
    const lowEnv = context.createGain();
    lowEnv.gain.setValueAtTime(0, at);
    lowEnv.gain.linearRampToValueAtTime(1, at + (echo ? 0.025 : 0.005));
    lowEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
    low.connect(lowEnv);
    lowEnv.connect(bus);
    low.start(at);
    low.stop(at + 0.75);

    // The ping: a pure tone with a faint fifth, ringing a little longer.
    const f = echo ? 392 : 440;
    for (const [freq, amp, decay] of [
      [f, 0.22, 1.1],
      [f * 1.5, 0.06, 0.6],
      [f * 2.76, 0.03, 0.3]
    ]) {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(amp, at + (echo ? 0.03 : 0.006));
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      osc.connect(env);
      env.connect(bus);
      osc.start(at);
      osc.stop(at + decay + 0.05);
    }
    window.setTimeout(() => panner.disconnect(), 1600);
  });
}

// A held tone: the low note pulsing at the wave's own pitch, so each beat is a band leaving. Returns a stop.
export function tone({ gain = 1, echo = false, pan = 0, pulse }: { gain?: number; echo?: boolean; pan?: number; pulse: number }) {
  let stop = () => {};
  sound.custom((context, out, at) => {
    const bus = context.createGain();
    bus.gain.setValueAtTime(0, at);
    bus.gain.linearRampToValueAtTime(gain * (echo ? 0.22 : 0.42), at + 0.08);
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = echo ? 700 : 2200;
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    bus.connect(filter);
    filter.connect(panner);
    panner.connect(out);
    // The beat: a gain swung by a slow sine, so the note throbs.
    const throb = context.createGain();
    throb.gain.value = 0.5;
    const lfo = context.createOscillator();
    lfo.frequency.value = pulse;
    const depth = context.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth);
    depth.connect(throb.gain);
    throb.connect(bus);
    const voices = [
      [echo ? 98 : 110, 1],
      [echo ? 196 : 220, 0.3],
      [echo ? 294 : 330, 0.08]
    ].map(([freq, amp]) => {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = context.createGain();
      g.gain.value = amp;
      osc.connect(g);
      g.connect(throb);
      osc.start(at);
      return osc;
    });
    lfo.start(at);
    stop = () => {
      const now = context.currentTime;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.linearRampToValueAtTime(0, now + 0.25);
      for (const osc of [...voices, lfo]) osc.stop(now + 0.3);
      window.setTimeout(() => panner.disconnect(), 500);
    };
  });
  return () => stop();
}
