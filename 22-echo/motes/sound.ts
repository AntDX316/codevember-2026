import { sound } from "../../shared/engine/sound";

// A soft puff of pressure: a low round thump with a breath of air through it, and a fine high hiss like dust stirred,
// trailing off. Then, when the front reaches the hidden form, its echo: a cool glassy chord, struck softly, and again
// fainter as the echo comes back past the tap. `touch` and `back` are seconds from now; a larger form rings lower.
export function sounding({ gain = 1, pan = 0, touch, back, pitch = 1 }: { gain?: number; pan?: number; touch: number | null; back: number | null; pitch?: number }) {
  sound.custom((context, out, at) => {
    const bus = context.createGain();
    bus.gain.value = gain;
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    bus.connect(panner);
    panner.connect(out);

    // The thump.
    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(118, at);
    body.frequency.exponentialRampToValueAtTime(46, at + 0.35);
    const bodyEnv = context.createGain();
    bodyEnv.gain.setValueAtTime(0, at);
    bodyEnv.gain.linearRampToValueAtTime(0.5, at + 0.012);
    bodyEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.6);
    body.connect(bodyEnv);
    bodyEnv.connect(bus);
    body.start(at);
    body.stop(at + 0.65);

    // The breath and the hiss, from one short burst of noise.
    const length = Math.floor(context.sampleRate * 1.6);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    const noise = context.createBufferSource();
    noise.buffer = buffer;
    const breath = context.createBiquadFilter();
    breath.type = "bandpass";
    breath.Q.value = 0.8;
    breath.frequency.setValueAtTime(900, at);
    breath.frequency.exponentialRampToValueAtTime(220, at + 0.4);
    const breathEnv = context.createGain();
    breathEnv.gain.setValueAtTime(0, at);
    breathEnv.gain.linearRampToValueAtTime(0.22, at + 0.01);
    breathEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
    noise.connect(breath);
    breath.connect(breathEnv);
    breathEnv.connect(bus);
    const hiss = context.createBiquadFilter();
    hiss.type = "highpass";
    hiss.frequency.value = 6500;
    const hissEnv = context.createGain();
    hissEnv.gain.setValueAtTime(0, at);
    hissEnv.gain.linearRampToValueAtTime(0.05, at + 0.08);
    hissEnv.gain.exponentialRampToValueAtTime(0.0001, at + 1.5);
    noise.connect(hiss);
    hiss.connect(hissEnv);
    hissEnv.connect(bus);
    noise.start(at);
    noise.stop(at + 1.6);

    // The echo off the form.
    const chime = (when: number, level: number, dull: number) => {
      const tone = context.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = 5200 * dull;
      tone.connect(bus);
      for (const [f, amp, decay] of [
        [659, 1, 2.2],
        [988, 0.55, 1.6],
        [1318 * 1.004, 0.3, 1.1],
        [2637, 0.08, 0.5]
      ] as const) {
        const osc = context.createOscillator();
        osc.type = "sine";
        osc.frequency.value = f * pitch;
        const env = context.createGain();
        env.gain.setValueAtTime(0, when);
        env.gain.linearRampToValueAtTime(amp * level, when + 0.025);
        env.gain.exponentialRampToValueAtTime(0.0001, when + decay);
        osc.connect(env);
        env.connect(tone);
        osc.start(when);
        osc.stop(when + decay + 0.05);
      }
    };
    if (touch !== null) chime(at + touch, 0.075, 1);
    if (back !== null) chime(at + back, 0.035, 0.4);
    window.setTimeout(() => bus.disconnect(), ((back ?? touch ?? 0) + 3) * 1000);
  });
}
