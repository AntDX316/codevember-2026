import { sound } from "../../shared/engine/sound";

// Thunder and the crack of a strike, made here from noise as the shared engine has nothing like them. A near strike is
// a tearing crack, then a hard clap and a long rolling rumble; a far one, only the rumble, softer and duller.

let brown: { context: AudioContext; buffer: AudioBuffer } | null = null;
let white: { context: AudioContext; buffer: AudioBuffer } | null = null;

function noise(context: AudioContext, kind: "brown" | "white") {
  const held = kind === "brown" ? brown : white;
  if (held && held.context === context) return held.buffer;
  const buffer = context.createBuffer(1, context.sampleRate * 6, context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "white") data[i] = w * 0.6;
    else {
      last = (last + w * 0.02) / 1.02;
      data[i] = last * 3.4;
    }
  }
  if (kind === "brown") brown = { context, buffer };
  else white = { context, buffer };
  return buffer;
}

function panned(context: AudioContext, out: AudioNode, pan: number) {
  if (!context.createStereoPanner) return out;
  const p = context.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(out);
  return p;
}

// The crack: a burst of torn high noise made of many tiny clicks, then a low thump under it.
export function crack(gain: number, pan: number, pitch = 1) {
  sound.custom((context, out, at) => {
    const dest = panned(context, out, pan);
    const source = context.createBufferSource();
    source.buffer = noise(context, "white");
    source.playbackRate.value = pitch;
    const high = context.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 1400 * pitch;
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, at);
    // Tearing: the level stutters for a fifth of a second as the channel rips through the air.
    let t = at;
    for (let i = 0; i < 26; i++) {
      const level = gain * 0.9 * Math.pow(1 - i / 26, 1.6) * (0.35 + Math.random() * 0.65);
      env.gain.linearRampToValueAtTime(Math.max(0.0002, level), t + 0.002);
      t += 0.004 + Math.random() * 0.01;
      env.gain.linearRampToValueAtTime(Math.max(0.0002, level * 0.2), t);
    }
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    source.connect(high);
    high.connect(env);
    env.connect(dest);
    source.start(at, Math.random() * 4);
    source.stop(t + 0.3);

    const thump = context.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(110 * pitch, at);
    thump.frequency.exponentialRampToValueAtTime(38 * pitch, at + 0.35);
    const thumpEnv = context.createGain();
    thumpEnv.gain.setValueAtTime(0.0001, at);
    thumpEnv.gain.exponentialRampToValueAtTime(gain * 0.7, at + 0.01);
    thumpEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
    thump.connect(thumpEnv);
    thumpEnv.connect(dest);
    thump.start(at);
    thump.stop(at + 0.5);
  });
}

// Thunder: a clap (for a near strike) and a rumble that swells and rolls for several seconds, its swells at random.
// `near` from 0 (far off, all rumble) to 1 (overhead, sharp clap).
export function thunder(gain: number, near: number, pan: number, seconds = 5) {
  sound.custom((context, out, at) => {
    const dest = panned(context, out, pan);
    const source = context.createBufferSource();
    source.buffer = noise(context, "brown");
    source.loop = true;
    source.playbackRate.value = 0.8 + Math.random() * 0.25;
    const low = context.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.setValueAtTime(220 + near * 900, at);
    low.frequency.exponentialRampToValueAtTime(90 + near * 60, at + seconds * 0.8);
    low.Q.value = 0.6;
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, at);
    // A clap first, then swells that roll away.
    env.gain.exponentialRampToValueAtTime(gain * (0.5 + near * 0.9), at + 0.03 + (1 - near) * 0.25);
    let t = at + 0.25 + (1 - near) * 0.3;
    env.gain.exponentialRampToValueAtTime(gain * 0.35, t);
    const swells = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < swells; i++) {
      const left = 1 - i / swells;
      t += (seconds / swells) * (0.6 + Math.random() * 0.8);
      env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * left * (0.25 + Math.random() * 0.55)), t);
    }
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    source.connect(low);
    low.connect(env);
    env.connect(dest);
    source.start(at, Math.random() * 5);
    source.stop(t + 1.3);

    // Under it, a sub-bass that the speakers feel more than play.
    const sub = context.createBufferSource();
    sub.buffer = noise(context, "brown");
    sub.loop = true;
    const subLow = context.createBiquadFilter();
    subLow.type = "lowpass";
    subLow.frequency.value = 70;
    const subEnv = context.createGain();
    subEnv.gain.setValueAtTime(0.0001, at);
    subEnv.gain.exponentialRampToValueAtTime(gain * 1.1, at + 0.08 + (1 - near) * 0.3);
    subEnv.gain.exponentialRampToValueAtTime(0.0001, at + seconds * 0.7);
    sub.connect(subLow);
    subLow.connect(subEnv);
    subEnv.connect(dest);
    sub.start(at, Math.random() * 5);
    sub.stop(at + seconds * 0.7 + 0.1);
  });
}

// The faint electric sizzle of a leader feeling its way down, heard in slow motion.
export function sizzle(gain: number, seconds: number, pan: number) {
  sound.custom((context, out, at) => {
    const dest = panned(context, out, pan);
    const source = context.createBufferSource();
    source.buffer = noise(context, "white");
    source.loop = true;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(2400, at);
    band.frequency.linearRampToValueAtTime(5200, at + seconds);
    band.Q.value = 1.4;
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain * 0.3, at + seconds * 0.3);
    env.gain.exponentialRampToValueAtTime(gain, at + seconds);
    env.gain.exponentialRampToValueAtTime(0.0001, at + seconds + 0.05);
    // Crackle: the level flutters fast.
    const flutter = context.createOscillator();
    flutter.frequency.value = 37;
    const depth = context.createGain();
    depth.gain.value = gain * 0.5;
    flutter.connect(depth);
    depth.connect(env.gain);
    source.connect(band);
    band.connect(env);
    env.connect(dest);
    source.start(at, Math.random() * 4);
    source.stop(at + seconds + 0.1);
    flutter.start(at);
    flutter.stop(at + seconds + 0.1);
  });
}
