// A Lichtenberg figure grown by the dielectric breakdown model, off the main thread.
//
// The block is a lattice of cells. A discharge starts at the cell under the strike and grows one cell at a time: every
// empty cell touching the figure is a candidate, holding the electric potential there, and the next cell is chosen at
// random with weight potential^eta. The potential is kept as Kim and Lin's closed form (each cell of the figure, an
// earthed sphere, adds 1 - R/r to every candidate), so a step costs one pass over the candidates rather than a solve.
// Exposed tips see the most potential and win, which is what makes the figure branch.
//
// The charge sits in a layer under the struck face, as in a block charged by an electron beam: candidates are weighted
// by how near that layer they lie, so the figure dives from the strike into the layer and spreads through it. Cells of
// earlier figures (and a cell round them) are closed, so a new figure threads between the old ones.
//
// Each cell added becomes a segment from the cell it grew from, its corners jittered off the lattice, split in two with
// a kink, and the finest tips get a few short fronds: the feathering of real figures. Every segment carries its birth
// (its cell's place in the growth order, 0 to 1), so the figure can be revealed as it grew.
//
// The worker is built from this file's own function source, so it needs no bundler support and imports nothing.

// Floats per segment: from (x, y, z, width), to (x, y, z, width), then birth, seed, thickness (0 to 1), and spare.
export const SEGMENT_FLOATS = 12;

export type GrowRequest = { type: "grow"; job: number; root: [number, number, number]; normal: [number, number, number]; sites: number; seed: number; layer: number; reach: number };
export type GrowResult = { type: "tree"; job: number; segments: Float32Array; count: number; ms: number };

export function createGrower(half: [number, number, number], cell: number): Worker | null {
  if (typeof Worker === "undefined") return null;
  const source = `(${growerMain.toString()})(${JSON.stringify(half)}, ${cell});`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}

// Everything below runs inside the worker: plain loops and typed arrays only, no imports, no helpers from outside.
export function growerMain(half: number[], cell: number) {
  const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (message: unknown, transfer?: Transferable[]) => void };
  const nx = Math.ceil((half[0] * 2) / cell);
  const ny = Math.ceil((half[1] * 2) / cell);
  const nz = Math.ceil((half[2] * 2) / cell);
  const total = nx * ny * nz;
  // 1 where an earlier figure (or the cell round it) already is.
  const closed = new Uint8Array(total);
  // Per job: 1 in the figure, 2 a candidate.
  const state = new Uint8Array(total);
  const touched: number[] = [];
  // The last figure grown, kept until told how much of it was used.
  let lastSites: Int32Array | null = null;
  let births = new Float32Array(0);
  let lastCount = 0;
  let lastJob = -1;

  // Floats per segment (as SEGMENT_FLOATS, which the worker cannot see), and the most segments one cell can make: two
  // halves and up to three fronds.
  const FLOATS = 12;
  const PER_SITE = 5;
  const toX = (i: number) => (i + 0.5) * cell - half[0];
  const toY = (j: number) => (j + 0.5) * cell - half[1];
  const toZ = (k: number) => (k + 0.5) * cell - half[2];

  function grow(request: GrowRequest) {
    const started = performance.now();
    let seed = request.seed >>> 0 || 1;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const N = request.sites;
    const n = request.normal;
    // Thickness of the block along the struck face's normal, and the charge layer's depth and spread in it.
    const thick = Math.abs(n[0]) * half[0] * 2 + Math.abs(n[1]) * half[1] * 2 + Math.abs(n[2]) * half[2] * 2;
    const layer = request.layer * thick;
    const spread = cell * 0.9;
    const reach = request.reach;
    const root = request.root;

    // The cell under the strike, a cell inside the face.
    const ri = Math.min(nx - 1, Math.max(0, Math.floor((root[0] - n[0] * cell + half[0]) / cell)));
    const rj = Math.min(ny - 1, Math.max(0, Math.floor((root[1] - n[1] * cell + half[1]) / cell)));
    const rk = Math.min(nz - 1, Math.max(0, Math.floor((root[2] - n[2] * cell + half[2]) / cell)));

    // How welcome the discharge is at a cell: near the charge layer, within reach of the strike across the face, and
    // a cell or more inside every face. Near the strike's axis it may cross the shallow part to reach the layer.
    const weight = (i: number, j: number, k: number) => {
      if (i < 1 || j < 1 || k < 1 || i > nx - 2 || j > ny - 2 || k > nz - 2) return 0;
      const x = toX(i) - root[0];
      const y = toY(j) - root[1];
      const z = toZ(k) - root[2];
      const depth = -(x * n[0] + y * n[1] + z * n[2]);
      const lx = x + n[0] * depth;
      const ly = y + n[1] * depth;
      const lz = z + n[2] * depth;
      const lateral = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (lateral > reach * 1.25 || depth > layer + spread * 3.2) return 0;
      const off = (depth - layer) / spread;
      let w = Math.exp(-off * off);
      // A single channel down from the strike: only the cells right on its axis.
      const axis = lateral / (cell * 0.75);
      if (depth < layer) w = Math.max(w, 0.35 * Math.exp(-axis * axis));
      const past = Math.max(0, (lateral - reach * 0.7) / (reach * 0.55));
      return w * Math.max(0, 1 - past * past) + 1e-4;
    };

    const maxCand = Math.min(total, N * 30 + 64);
    const candCell = new Int32Array(maxCand);
    const candX = new Float32Array(maxCand);
    const candY = new Float32Array(maxCand);
    const candZ = new Float32Array(maxCand);
    const candPhi = new Float32Array(maxCand);
    const candW = new Float32Array(maxCand);
    const candFrom = new Int32Array(maxCand);
    const candP = new Float32Array(maxCand);
    let C = 0;

    const sites = new Int32Array(N);
    const parent = new Int32Array(N);
    const sx = new Float32Array(N);
    const sy = new Float32Array(N);
    const sz = new Float32Array(N);
    let S = 0;

    const addCandidates = (site: number, ci: number, cj: number, ck: number, phi: number) => {
      for (let dk = -1; dk <= 1; dk++)
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj && !dk) continue;
            const i = ci + di;
            const j = cj + dj;
            const k = ck + dk;
            if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
            const c = i + nx * (j + ny * k);
            if (state[c] || closed[c] || C >= maxCand) continue;
            const w = weight(i, j, k);
            if (w <= 1e-4 + 1e-6) continue;
            state[c] = 2;
            touched.push(c);
            candCell[C] = c;
            candX[C] = i;
            candY[C] = j;
            candZ[C] = k;
            // A new candidate takes its neighbour's potential, less what the new cell beside it takes away.
            const r = Math.sqrt(di * di + dj * dj + dk * dk);
            candPhi[C] = phi + (1 - 0.5 / r);
            candW[C] = w;
            candFrom[C] = site;
            C++;
          }
    };

    const place = (c: number, from: number, i: number, j: number, k: number) => {
      state[c] = 1;
      touched.push(c);
      sites[S] = c;
      parent[S] = from;
      // Off the lattice by up to a third of a cell, so no line runs along it.
      sx[S] = toX(i) + (random() - 0.5) * cell * 0.45;
      sy[S] = toY(j) + (random() - 0.5) * cell * 0.45;
      sz[S] = toZ(k) + (random() - 0.5) * cell * 0.45;
      S++;
    };

    const rc = ri + nx * (rj + ny * rk);
    place(rc, -1, ri, rj, rk);
    // The strike itself sits on the face.
    sx[0] = root[0];
    sy[0] = root[1];
    sz[0] = root[2];
    addCandidates(0, ri, rj, rk, 0);

    // The potential's range over the candidates, kept up as they change: the choice weighs where each stands in it.
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = 0; a < C; a++) {
      lo = Math.min(lo, candPhi[a]);
      hi = Math.max(hi, candPhi[a]);
    }
    while (S < N && C > 0) {
      // Pick by potential squared (eta = 2) times the layer's welcome.
      const span = hi - lo > 1e-6 ? 1 / (hi - lo) : 0;
      let sum = 0;
      for (let a = 0; a < C; a++) {
        const u = span ? (candPhi[a] - lo) * span : 1;
        const p = u * u * candW[a];
        candP[a] = p;
        sum += p;
      }
      let pick = random() * sum;
      let chosen = C - 1;
      for (let a = 0; a < C; a++) {
        pick -= candP[a];
        if (pick <= 0) {
          chosen = a;
          break;
        }
      }
      const c = candCell[chosen];
      const i = candX[chosen];
      const j = candY[chosen];
      const k = candZ[chosen];
      const from = candFrom[chosen];
      const phi = candPhi[chosen];
      // Out of the candidates: the last takes its place.
      C--;
      candCell[chosen] = candCell[C];
      candX[chosen] = candX[C];
      candY[chosen] = candY[C];
      candZ[chosen] = candZ[C];
      candPhi[chosen] = candPhi[C];
      candW[chosen] = candW[C];
      candFrom[chosen] = candFrom[C];
      const site = S;
      place(c, from, i, j, k);
      // Every candidate's potential, raised by the new cell's sphere.
      lo = Infinity;
      hi = -Infinity;
      for (let a = 0; a < C; a++) {
        const dx = candX[a] - i;
        const dy = candY[a] - j;
        const dz = candZ[a] - k;
        const p = candPhi[a] + 1 - 0.5 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        candPhi[a] = p;
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
      const before = C;
      addCandidates(site, i, j, k, phi);
      for (let a = before; a < C; a++) {
        if (candPhi[a] < lo) lo = candPhi[a];
        if (candPhi[a] > hi) hi = candPhi[a];
      }
    }

    // How much hangs off each cell, for the width of its segment: leaves first, since every cell comes after its parent.
    const below = new Float32Array(S);
    for (let s = S - 1; s > 0; s--) below[parent[s]] += below[s] + 1;
    let most = 1;
    for (let s = 1; s < S; s++) if (below[s] > most) most = below[s];

    const out = new Float32Array(S * PER_SITE * FLOATS);
    let count = 0;
    const push = (ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number, birth: number, thickness: number) => {
      const o = count * FLOATS;
      out[o] = ax;
      out[o + 1] = ay;
      out[o + 2] = az;
      out[o + 3] = aw;
      out[o + 4] = bx;
      out[o + 5] = by;
      out[o + 6] = bz;
      out[o + 7] = bw;
      out[o + 8] = birth;
      out[o + 9] = random();
      out[o + 10] = thickness;
      out[o + 11] = 0;
      count++;
    };
    // A channel's weight, by how much hangs off it on a log scale: the trunk 1, main limbs well up, the tips 0.
    const logMost = Math.log(1 + most);
    const weightOf = (s: number) => Math.log(1 + below[s]) / logMost;
    const widthOf = (s: number) => cell * (0.06 + 0.42 * Math.pow(weightOf(s), 2));
    // When each cell is reached: by its distance along the channels from the strike, so the discharge runs outward
    // along every branch at once.
    const path = new Float32Array(S);
    let longest = 1e-6;
    for (let s = 1; s < S; s++) {
      const p = parent[s];
      path[s] = path[p] + Math.hypot(sx[s] - sx[p], sy[s] - sy[p], sz[s] - sz[p]);
      if (path[s] > longest) longest = path[s];
    }
    births = new Float32Array(S);
    for (let s = 0; s < S; s++) births[s] = path[s] / longest;
    for (let s = 1; s < S; s++) {
      const p = parent[s];
      const ax = sx[p];
      const ay = sy[p];
      const az = sz[p];
      const bx = sx[s];
      const by = sy[s];
      const bz = sz[s];
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      // A kink halfway, off to one side.
      const kink = len * 0.16;
      const mx = (ax + bx) / 2 + (random() - 0.5) * kink;
      const my = (ay + by) / 2 + (random() - 0.5) * kink;
      const mz = (az + bz) / 2 + (random() - 0.5) * kink;
      const birth = births[s];
      const wa = widthOf(p);
      const wb = widthOf(s);
      const thickness = weightOf(s);
      const half = (births[s] - births[p]) / 2;
      push(ax, ay, az, wa, mx, my, mz, (wa + wb) / 2, birth - half, thickness);
      push(mx, my, mz, (wa + wb) / 2, bx, by, bz, wb, birth, thickness);
      // Feathering: the finest tips throw out a few short fronds, leaning on along the way they grew.
      if (below[s] < 3) {
        const fronds = Math.floor(random() * (below[s] < 1 ? 3 : 2));
        for (let f = 0; f < fronds; f++) {
          let fx = random() - 0.5;
          let fy = random() - 0.5;
          let fz = random() - 0.5;
          // Mostly within the charge layer: lose some of the part along the normal.
          const along = fx * n[0] + fy * n[1] + fz * n[2];
          fx -= n[0] * along * 0.7;
          fy -= n[1] * along * 0.7;
          fz -= n[2] * along * 0.7;
          const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
          const size = cell * (0.35 + random() * 0.6);
          const lean = 0.6;
          const ux = (fx / fl) * (1 - lean) + (dx / len) * lean;
          const uy = (fy / fl) * (1 - lean) + (dy / len) * lean;
          const uz = (fz / fl) * (1 - lean) + (dz / len) * lean;
          const t = 0.35 + random() * 0.6;
          const ox = ax + dx * t;
          const oy = ay + dy * t;
          const oz = az + dz * t;
          push(ox, oy, oz, wb * 0.8, ox + ux * size, oy + uy * size, oz + uz * size, wb * 0.3, birth + 0.004, 0);
        }
      }
    }

    // Clear this job's marks; the cells it may keep are closed when told how much of it was used.
    for (let t = 0; t < touched.length; t++) state[touched[t]] = 0;
    touched.length = 0;
    lastSites = sites;
    lastCount = S;
    return { segments: out.slice(0, count * FLOATS), count, ms: performance.now() - started };
  }

  // Close the cells of the part of the last figure that was used, and the cells touching them.
  function commit(job: number, fraction: number) {
    if (job !== lastJob || !lastSites) return;
    for (let s = 0; s < lastCount; s++) {
      if (births[s] > fraction) continue;
      const c = lastSites[s];
      const i = c % nx;
      const j = Math.floor(c / nx) % ny;
      const k = Math.floor(c / (nx * ny));
      for (let dk = -1; dk <= 1; dk++)
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const a = i + di;
            const b = j + dj;
            const d = k + dk;
            if (a < 0 || b < 0 || d < 0 || a >= nx || b >= ny || d >= nz) continue;
            closed[a + nx * (b + ny * d)] = 1;
          }
    }
    lastSites = null;
  }

  scope.onmessage = (event: MessageEvent) => {
    const m = event.data;
    if (m.type === "grow") {
      lastJob = m.job;
      const result = grow(m as GrowRequest);
      scope.postMessage({ type: "tree", job: m.job, segments: result.segments, count: result.count, ms: result.ms }, [result.segments.buffer]);
    } else if (m.type === "commit") {
      commit(m.job, m.fraction);
    } else if (m.type === "reset") {
      closed.fill(0);
      lastSites = null;
    }
  };
}
