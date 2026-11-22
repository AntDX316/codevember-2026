// The rooms, fetched and decoded off the main thread so changing room never stalls a frame. Each is a compact .room file
// (made from the Poly Haven .hdr by pack-room.mjs): its RGBE bytes in four planes, each delta-coded along its rows and
// deflated, about 1 MB. The worker inflates it with the browser's own DecompressionStream, rebuilds the RGBE, turns it
// into RGBA half floats (as three's HDRLoader gives) and makes the small blurred copy for the background.
//
// One worker serves every request for the life of the page, so nothing a component does can end it mid-load. Each
// fetch is retried with a timeout; finished rooms are kept, so going back to one is instant.
//
// The worker is built from this file's own function source, so it needs no bundler support and imports nothing. Where
// it cannot run (no workers, a page policy that refuses blob: workers, or a browser without DecompressionStream, as
// Safari before 16.4 and Firefox before 113 are), the same decoding runs here on the main thread instead, inflating with
// fflate where it must: a stall on changing room, but the globe still stands in its room.

import { fetchRetried } from "../../shared/engine/retry";

export type Decoded = { data: Uint16Array; width: number; height: number; soft: Uint16Array };

// The small, blurred copy of a room shown behind the globe, out of focus.
export const SOFT_WIDTH = 512;
export const SOFT_HEIGHT = 256;

let worker: Worker | null = null;
// Once a worker has failed it is not tried again: whatever stopped one would stop the next.
let workerless = typeof Worker === "undefined" || typeof DecompressionStream === "undefined";
let nextId = 0;
const waiting = new Map<number, { url: string; resolve: (d: Decoded) => void; reject: (e: Error) => void }>();
const rooms = new Map<string, Promise<Decoded>>();

function decoder() {
  if (worker || workerless) return worker;
  const source = `self.softenRoom = ${soften.toString()};\nself.decodeRoom = ${decodeRoom.toString()};\n(${decoderMain.toString()})();`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    worker = new Worker(url);
  } catch {
    workerless = true;
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
  worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; data?: Uint16Array; width?: number; height?: number; soft?: Uint16Array; error?: string }>) => {
    const m = event.data;
    const job = waiting.get(m.id);
    if (!job) return;
    waiting.delete(m.id);
    if (m.ok && m.data && m.soft) job.resolve({ data: m.data, width: m.width as number, height: m.height as number, soft: m.soft });
    else job.reject(new Error(m.error ?? "Room failed to load"));
  };
  worker.onerror = () => {
    // A worker that cannot run (most often one refused by the page's policy, which says nothing more) hands everything
    // waiting on it to the main thread, and every room after goes there too.
    const jobs = [...waiting.values()];
    waiting.clear();
    worker?.terminate();
    worker = null;
    workerless = true;
    for (const job of jobs) decodeHere(job.url).then(job.resolve, job.reject);
  };
  return worker;
}

// The worker's work, done on the main thread.
async function decodeHere(url: string): Promise<Decoded> {
  const response = await fetchRetried(url);
  return decodeRoom(await response.arrayBuffer(), inflateHere, soften);
}

async function inflateHere(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // "deflate" in DecompressionStream's sense is zlib-wrapped, so fflate's unzlib is its match.
  const { unzlibSync } = await import("three/addons/libs/fflate.module.js");
  return unzlibSync(bytes);
}

// A room by its path, decoded, from the cache or fetched now. A failure is forgotten, so asking again tries again.
export function loadRoom(path: string): Promise<Decoded> {
  const known = rooms.get(path);
  if (known) return known;
  const url = new URL(path, window.location.href).href;
  const promise = new Promise<Decoded>((resolve, reject) => {
    const w = decoder();
    if (!w) return decodeHere(url).then(resolve, reject);
    const id = nextId++;
    waiting.set(id, { url, resolve, reject });
    w.postMessage({ id, url });
  });
  promise.catch(() => rooms.delete(path));
  rooms.set(path, promise);
  return promise;
}

// A .room file's bytes to a room: inflated, the delta coding undone, the RGBE interleaved again and turned to half
// floats, with its blurred copy. Runs in the worker or, failing that, here; self-contained and without async or other
// syntax a bundler might rewrite with outside helpers, as the worker copies its source.
export function decodeRoom(buffer: ArrayBuffer, inflate: (bytes: Uint8Array) => Promise<Uint8Array>, soften: (data: Uint16Array, width: number, height: number) => Uint16Array): Promise<Decoded> {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  // A float to a half float, rounded, with overflow held to the largest finite value and small values to zero.
  const toHalf = (value: number) => {
    f32[0] = value;
    const x = u32[0];
    const sign = (x >> 16) & 0x8000;
    const exponent = ((x >> 23) & 0xff) - 112;
    const mantissa = x & 0x7fffff;
    if (exponent <= 0) return sign;
    if (exponent >= 31) return sign | 0x7bff;
    return sign | (exponent << 10) | ((mantissa + 0x1000) >> 13);
  };
  const head = new DataView(buffer, 0, 8);
  const width = head.getUint32(0, true);
  const height = head.getUint32(4, true);
  return inflate(new Uint8Array(buffer, 8)).then((planes) => {
    const count = width * height;
    // Undo the delta coding along each row of each plane, then interleave back to RGBE and convert.
    const data = new Uint16Array(count * 4);
    const one = toHalf(1);
    const rgbe = new Uint8Array(count * 4);
    for (let c = 0; c < 4; c++) {
      const base = c * count;
      for (let y = 0; y < height; y++) {
        let value = 0;
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          // The first of each row was coded against the one above it.
          value = (x === 0 ? (y > 0 ? rgbe[((y - 1) * width) * 4 + c] : 0) : value) + planes[base + i];
          value &= 255;
          rgbe[i * 4 + c] = value;
        }
      }
    }
    for (let i = 0; i < count; i++) {
      const e = rgbe[i * 4 + 3];
      const scale = e === 0 ? 0 : Math.pow(2, e - 136);
      data[i * 4] = toHalf(rgbe[i * 4] * scale);
      data[i * 4 + 1] = toHalf(rgbe[i * 4 + 1] * scale);
      data[i * 4 + 2] = toHalf(rgbe[i * 4 + 2] * scale);
      data[i * 4 + 3] = one;
    }
    return { data, width, height, soft: soften(data, width, height) };
  });
}

// Everything below runs inside the worker: plain loops and typed arrays only, no imports, no helpers from outside.
export function decoderMain() {
  const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (message: unknown, transfer?: Transferable[]) => void };
  const within = self as unknown as { softenRoom: typeof soften; decodeRoom: typeof decodeRoom };

  // Fetch with a timeout, tried up to three times with a growing pause between.
  function fetchBytes(url: string, attempt: number): Promise<ArrayBuffer> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    return fetch(url, { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.arrayBuffer();
      })
      .finally(() => clearTimeout(timer))
      .catch((error) => {
        if (attempt >= 2) throw error;
        return new Promise<ArrayBuffer>((resolve, reject) => setTimeout(() => fetchBytes(url, attempt + 1).then(resolve, reject), 600 * (attempt + 1)));
      });
  }

  function inflate(bytes: Uint8Array) {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Response(stream).arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }

  scope.onmessage = (event: MessageEvent) => {
    const { id, url } = event.data as { id: number; url: string };
    fetchBytes(url, 0)
      .then((buffer) => within.decodeRoom(buffer, inflate, within.softenRoom))
      .then(({ data, width, height, soft }) => scope.postMessage({ id, ok: true, data, width, height, soft }, [data.buffer, soft.buffer]))
      .catch((error) => scope.postMessage({ id, ok: false, error: String(error) }));
  };
}

// A room picture (RGBA half floats) shrunk to 512 × 256 and blurred, wrapping round the sides, as the background seen far
// out of focus. Runs in the worker for later rooms, and once at load for the first. Self-contained, as the worker copies it.
export function soften(data: Uint16Array, width: number, height: number) {
  const W = 512;
  const H = 256;
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const fromHalf = (h: number) => {
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    const v = e === 0 ? m * Math.pow(2, -24) : e === 31 ? 65504 : Math.pow(2, e - 15) * (1 + m / 1024);
    return h & 0x8000 ? -v : v;
  };
  const toHalf = (value: number) => {
    f32[0] = value;
    const x = u32[0];
    const sign = (x >> 16) & 0x8000;
    const exponent = ((x >> 23) & 0xff) - 112;
    const mantissa = x & 0x7fffff;
    if (exponent <= 0) return sign;
    if (exponent >= 31) return sign | 0x7bff;
    return sign | (exponent << 10) | ((mantissa + 0x1000) >> 13);
  };
  // Box-average down to the small size; very bright lights are softened first so one lamp does not dominate a cell.
  let a = new Float32Array(W * H * 3);
  const sx = width / W;
  const sy = height / H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let n = 0;
      for (let j = Math.floor(y * sy); j < Math.floor((y + 1) * sy); j += 2) {
        for (let i = Math.floor(x * sx); i < Math.floor((x + 1) * sx); i += 2) {
          const k = (j * width + i) * 4;
          rs += Math.min(fromHalf(data[k]), 64);
          gs += Math.min(fromHalf(data[k + 1]), 64);
          bs += Math.min(fromHalf(data[k + 2]), 64);
          n++;
        }
      }
      const o = (y * W + x) * 3;
      a[o] = rs / n;
      a[o + 1] = gs / n;
      a[o + 2] = bs / n;
    }
  }
  // A few passes of a small blur each way, wrapping round horizontally: close to a gaussian of about seven texels.
  let b = new Float32Array(W * H * 3);
  const weights = [0.06, 0.24, 0.4, 0.24, 0.06];
  for (let pass = 0; pass < 4; pass++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let t = -2; t <= 2; t++) sum += a[(y * W + ((x + t + W) % W)) * 3 + c] * weights[t + 2];
          b[(y * W + x) * 3 + c] = sum;
        }
      }
    }
    [a, b] = [b, a];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let t = -2; t <= 2; t++) sum += a[(Math.min(H - 1, Math.max(0, y + t)) * W + x) * 3 + c] * weights[t + 2];
          b[(y * W + x) * 3 + c] = sum;
        }
      }
    }
    [a, b] = [b, a];
  }
  const out = new Uint16Array(W * H * 4);
  const one = toHalf(1);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = toHalf(a[i * 3]);
    out[i * 4 + 1] = toHalf(a[i * 3 + 1]);
    out[i * 4 + 2] = toHalf(a[i * 3 + 2]);
    out[i * 4 + 3] = one;
  }
  return out;
}
