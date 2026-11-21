// The rooms, fetched and decoded off the main thread so changing room never stalls a frame. Each is a compact .room file
// (made from the Poly Haven .hdr by pack-room.mjs): its RGBE bytes in four planes, each delta-coded along its rows and
// deflated, about 1 MB. The worker inflates it with the browser's own DecompressionStream, rebuilds the RGBE, turns it
// into RGBA half floats (as three's HDRLoader gives) and makes the small blurred copy for the background.
//
// One worker serves every request for the life of the page, so nothing a component does can end it mid-load. Each
// fetch is retried with a timeout; finished rooms are kept, so going back to one is instant.
//
// The worker is built from this file's own function source, so it needs no bundler support and imports nothing.

export type Decoded = { data: Uint16Array; width: number; height: number; soft: Uint16Array };

// The small, blurred copy of a room shown behind the globe, out of focus.
export const SOFT_WIDTH = 512;
export const SOFT_HEIGHT = 256;

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve: (d: Decoded) => void; reject: (e: Error) => void }>();
const rooms = new Map<string, Promise<Decoded>>();

function decoder() {
  if (worker || typeof Worker === "undefined") return worker;
  const source = `self.softenRoom = ${soften.toString()};\n(${decoderMain.toString()})();`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; data?: Uint16Array; width?: number; height?: number; soft?: Uint16Array; error?: string }>) => {
    const m = event.data;
    const job = waiting.get(m.id);
    if (!job) return;
    waiting.delete(m.id);
    if (m.ok && m.data && m.soft) job.resolve({ data: m.data, width: m.width as number, height: m.height as number, soft: m.soft });
    else job.reject(new Error(m.error ?? "Room failed to load"));
  };
  worker.onerror = () => {
    // A worker that cannot run fails everything waiting on it; the next request starts a fresh one.
    for (const job of waiting.values()) job.reject(new Error("Room decoder failed"));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

// A room by its path, decoded, from the cache or fetched now. A failure is forgotten, so asking again tries again.
export function loadRoom(path: string): Promise<Decoded> {
  const known = rooms.get(path);
  if (known) return known;
  const url = new URL(path, window.location.href).href;
  const promise = new Promise<Decoded>((resolve, reject) => {
    const w = decoder();
    if (!w) return reject(new Error("No workers"));
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, url });
  });
  promise.catch(() => rooms.delete(path));
  rooms.set(path, promise);
  return promise;
}

// Everything below runs inside the worker: plain loops and typed arrays only, no imports, no helpers from outside.
export function decoderMain() {
  const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (message: unknown, transfer?: Transferable[]) => void };
  const soften = (self as unknown as { softenRoom: (data: Uint16Array, width: number, height: number) => Uint16Array }).softenRoom;
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
      .then((buffer) => {
        const head = new DataView(buffer, 0, 8);
        const width = head.getUint32(0, true);
        const height = head.getUint32(4, true);
        return inflate(new Uint8Array(buffer, 8)).then((planes) => ({ planes, width, height }));
      })
      .then(({ planes, width, height }) => {
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
        const soft = soften(data, width, height);
        scope.postMessage({ id, ok: true, data, width, height, soft }, [data.buffer, soft.buffer]);
      })
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
