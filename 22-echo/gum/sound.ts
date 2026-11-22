import { sound } from "../../shared/engine/sound";
import { ECHOES, KEEP, PERIOD } from "./echo";

// The gum's voices, built on the engine's context and ending in its master. The pop is a wet snap: a bright crack of
// noise, a smack, and a low thump of the air let go. The hall answers it: the same snap back again every round trip,
// weaker and duller each time and swinging side to side, over the long bright wash of a tiled room (a convolution with
// decaying noise). Blowing it bigger makes the film creak: a rubbery stick-slip squeak, higher as it stretches.

const rooms = new WeakMap<AudioContext, { input: GainNode }>();

// The tiled room's tail: two seconds and more of bright noise dying away, a little different in each ear.
function hall(context: AudioContext, out: AudioNode) {
  let room = rooms.get(context);
  if (room) return room;
  const seconds = 2.6;
  const length = Math.floor(context.sampleRate * seconds);
  const ir = context.createBuffer(2, length, context.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / context.sampleRate;
      const white = Math.random() * 2 - 1;
      // Duller as it dies: a one-pole lowpass closing over the tail.
      const k = 0.85 - 0.6 * Math.min(1, t / seconds);
      low += (white - low) * k;
      data[i] = low * Math.exp(-t * 2.4) * (t < 0.012 ? t / 0.012 : 1);
    }
  }
  const convolver = context.createConvolver();
  convolver.buffer = ir;
  const input = context.createGain();
  input.gain.value = 0.5;
  input.connect(convolver);
  convolver.connect(out);
  room = { input };
  rooms.set(context, room);
  return room;
}

let noiseBuffer: AudioBuffer | null = null;
function noise(context: AudioContext) {
  if (noiseBuffer && noiseBuffer.sampleRate === context.sampleRate) return noiseBuffer;
  noiseBuffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.5), context.sampleRate);
  const d = noiseBuffer.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

// One snap, into `dest`, at `at`.
function crack(context: AudioContext, dest: AudioNode, at: number, gain: number, size: number) {
  const n = context.createBufferSource();
  n.buffer = noise(context);
  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 2600 / Math.sqrt(size);
  band.Q.value = 0.7;
  const nEnv = context.createGain();
  nEnv.gain.setValueAtTime(0, at);
  nEnv.gain.linearRampToValueAtTime(1.3 * gain, at + 0.0015);
  nEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
  n.connect(band);
  band.connect(nEnv);
  nEnv.connect(dest);
  n.start(at, Math.random() * 0.3);
  n.stop(at + 0.14);

  const thump = context.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(210 / Math.sqrt(size), at);
  thump.frequency.exponentialRampToValueAtTime(48, at + 0.11);
  const tEnv = context.createGain();
  tEnv.gain.setValueAtTime(0, at);
  tEnv.gain.linearRampToValueAtTime(1.1 * gain, at + 0.003);
  tEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
  thump.connect(tEnv);
  tEnv.connect(dest);
  thump.start(at);
  thump.stop(at + 0.2);

  // The wet smack of the film slapping back.
  const smack = context.createOscillator();
  smack.type = "triangle";
  smack.frequency.setValueAtTime(900, at + 0.004);
  smack.frequency.exponentialRampToValueAtTime(380, at + 0.05);
  const sEnv = context.createGain();
  sEnv.gain.setValueAtTime(0, at + 0.004);
  sEnv.gain.linearRampToValueAtTime(0.35 * gain, at + 0.007);
  sEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
  smack.connect(sEnv);
  sEnv.connect(dest);
  smack.start(at + 0.004);
  smack.stop(at + 0.08);
}

export function snap(pan: number, size: number) {
  sound.custom((context, out, at) => {
    const room = hall(context, out);
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan * 0.5));
    panner.connect(out);
    panner.connect(room.input);
    crack(context, panner, at, 0.9, size);
    // The hall's answers: each a round trip later, weaker, duller, from the other side.
    for (let k = 1; k <= ECHOES; k++) {
      const dull = context.createBiquadFilter();
      dull.type = "lowpass";
      dull.frequency.value = 7000 * Math.pow(0.55, k);
      const side = context.createStereoPanner();
      side.pan.value = (k % 2 ? -1 : 1) * Math.max(-1, Math.min(1, pan * 0.5 + (k % 2 ? 0.35 : -0.35))) * 0.8;
      dull.connect(side);
      side.connect(out);
      side.connect(room.input);
      crack(context, dull, at + k * PERIOD, 0.8 * Math.pow(KEEP, k), size);
    }
    window.setTimeout(() => panner.disconnect(), (ECHOES * PERIOD + 4) * 1000);
  });
}

// A creak of the stretching film; `stretch` 0 to 1.
export function creak(stretch: number) {
  sound.custom((context, out, at) => {
    const room = hall(context, out);
    const f = 85 + stretch * 120 + Math.random() * 20;
    const length = 0.18 + Math.random() * 0.16;
    const saw = context.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.setValueAtTime(f, at);
    saw.frequency.linearRampToValueAtTime(f * (1.12 + Math.random() * 0.15), at + length);
    // Stick and slip: the level chattering a few dozen times a second.
    const chatter = context.createOscillator();
    chatter.type = "square";
    chatter.frequency.value = 22 + Math.random() * 18;
    const chatterDepth = context.createGain();
    chatterDepth.gain.value = 0.5;
    const body = context.createGain();
    body.gain.value = 0.5;
    chatter.connect(chatterDepth);
    chatterDepth.connect(body.gain);
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 700 + stretch * 600;
    band.Q.value = 2.5;
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.22, at + 0.03);
    env.gain.setValueAtTime(0.22, at + length - 0.05);
    env.gain.linearRampToValueAtTime(0, at + length);
    saw.connect(body);
    body.connect(band);
    band.connect(env);
    env.connect(out);
    const send = context.createGain();
    send.gain.value = 0.25;
    env.connect(send);
    send.connect(room.input);
    saw.start(at);
    chatter.start(at);
    saw.stop(at + length + 0.02);
    chatter.stop(at + length + 0.02);
  });
}

// A breath blowing the new bubble.
export function blow() {
  sound.custom((context, out, at) => {
    const n = context.createBufferSource();
    n.buffer = noise(context);
    n.loop = true;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.2;
    band.frequency.setValueAtTime(500, at);
    band.frequency.exponentialRampToValueAtTime(1300, at + 1.1);
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.14, at + 0.25);
    env.gain.linearRampToValueAtTime(0, at + 1.2);
    n.connect(band);
    band.connect(env);
    env.connect(out);
    n.start(at);
    n.stop(at + 1.25);
  });
}
