import * as THREE from "three/webgpu";
import { lehmer } from "../shared/engine/random";

export const DOME_RADIUS = 34;
const THICKNESS = 0.26;

type Shard = {
  home: THREE.Vector3;
  direction: THREE.Vector3;
  hull: Float32Array;
  // Every face of the plate as it is drawn, relative to home, for picking it exactly.
  faces: Float32Array;
  reach: number;
};

// Cuts the upper half of a sphere into spherical Voronoi cells, each an extruded plate.
// One merged geometry: a vertex finds its plate's live transform through aShard.
export function buildDome(count: number) {
  const sites: THREE.Vector3[] = [];
  const rand = lehmer(8821);
  // Darts thrown at the sky, spaced by a slow field: some regions break into slivers, others stay in great slabs.
  const spacing = Math.sqrt((2 * Math.PI) / count) * 0.92;
  const field = (p: THREE.Vector3) => {
    const wave = Math.sin(p.x * 3.1 + 1) * Math.sin(p.y * 2.7 + 2) * Math.sin(p.z * 3.4 + 0.5) + Math.sin(p.x * 7.3 + 4) * Math.sin(p.z * 6.1 + 1) * 0.35;
    return 0.45 + 1.5 * Math.min(1, Math.max(0, wave * 0.75 + 0.5)) ** 1.6;
  };
  const candidate = new THREE.Vector3();
  for (let tries = 0; tries < count * 80 && sites.length < count * 1.4; tries++) {
    const y = rand() * 1.1 - 0.1;
    const r = Math.sqrt(1 - y * y);
    const turn = rand() * Math.PI * 2;
    candidate.set(Math.cos(turn) * r, y, Math.sin(turn) * r);
    // A few of any size land anywhere, so nothing looks too orderly.
    const local = spacing * field(candidate) * (0.72 + rand() * 0.5);
    let clear = true;
    for (const site of sites) {
      if (site.distanceToSquared(candidate) < local * local) {
        clear = false;
        break;
      }
    }
    if (clear) sites.push(candidate.clone());
  }

  const position: number[] = [];
  const normal: number[] = [];
  const shardId: number[] = [];
  const direction: number[] = [];
  const face: number[] = [];
  const shards: Shard[] = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const flat = new THREE.Vector3();

  const pushTriangle = (id: number, v0: THREE.Vector3, v1: THREE.Vector3, v2: THREE.Vector3, outward: THREE.Vector3 | null, kind: number, home: THREE.Vector3, d0: THREE.Vector3, d1: THREE.Vector3, d2: THREE.Vector3, smooth: boolean) => {
    a.subVectors(v1, v0);
    b.subVectors(v2, v0);
    flat.crossVectors(a, b).normalize();
    let p1 = v1;
    let p2 = v2;
    let n1 = d1;
    let n2 = d2;
    if (outward && flat.dot(outward) < 0) {
      p1 = v2;
      p2 = v1;
      n1 = d2;
      n2 = d1;
      flat.negate();
    }
    const sign = kind === 0 ? -1 : 1;
    for (const [vertex, dir] of [
      [v0, d0],
      [p1, n1],
      [p2, n2]
    ] as const) {
      position.push(vertex.x - home.x, vertex.y - home.y, vertex.z - home.z);
      if (smooth) normal.push(dir.x * sign, dir.y * sign, dir.z * sign);
      else normal.push(flat.x, flat.y, flat.z);
      shardId.push(id);
      direction.push(dir.x, dir.y, dir.z);
      face.push(kind);
    }
  };

  sites.forEach((site) => {
    const tangent = new THREE.Vector3(0, 1, 0).cross(site);
    if (tangent.lengthSq() < 1e-4) tangent.set(1, 0, 0);
    tangent.normalize();
    const bitangent = new THREE.Vector3().crossVectors(site, tangent);
    const size = 1.2;
    let polygon = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1]
    ].map(([u, v]) => site.clone().addScaledVector(tangent, u * size).addScaledVector(bitangent, v * size));

    // The 44 nearest sites, nearest first, ties in site order: exactly what a stable sort of them all gives, without
    // sorting every site for every site. Every sky size is cut while the page loads, so this has to be quick.
    const near: { other: THREE.Vector3; dot: number }[] = [];
    for (const other of sites) {
      if (other === site) continue;
      const dot = other.dot(site);
      if (near.length === 44 && dot <= near[43].dot) continue;
      let at = near.length;
      while (at > 0 && near[at - 1].dot < dot) at--;
      near.splice(at, 0, { other, dot });
      if (near.length > 44) near.pop();
    }

    const clip = (plane: THREE.Vector3, offset = 0) => {
      const next: THREE.Vector3[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i];
        const q = polygon[(i + 1) % polygon.length];
        const dp = p.dot(plane) - offset;
        const dq = q.dot(plane) - offset;
        if (dp <= 0) next.push(p);
        if (dp * dq < 0) next.push(p.clone().lerp(q, dp / (dp - dq)));
      }
      polygon = next;
    };
    for (const { other } of near) clip(c.subVectors(other, site).normalize());
    // The rim sits just under the water line, so the dome has no visible foot.
    const inner = polygon.map((point) => point.clone().normalize());
    polygon = inner;
    clip(new THREE.Vector3(0, -1, 0), 0.03);
    if (polygon.length < 3) return;

    const ring = polygon.map((point) => point.clone().normalize());
    const id = shards.length;
    const centre = new THREE.Vector3();
    ring.forEach((point) => centre.add(point));
    centre.normalize();
    const home = centre.clone().multiplyScalar(DOME_RADIUS + THICKNESS / 2);
    const scaled = (point: THREE.Vector3, radius: number) => point.clone().multiplyScalar(radius);
    const innerRadius = DOME_RADIUS;
    const outerRadius = DOME_RADIUS + THICKNESS;
    const toward = centre.clone().negate();
    const faces: number[] = [];
    const addFace = (...corners: THREE.Vector3[]) => {
      for (const corner of corners) faces.push(corner.x - home.x, corner.y - home.y, corner.z - home.z);
    };

    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      pushTriangle(id, scaled(centre, innerRadius), scaled(p, innerRadius), scaled(q, innerRadius), toward, 0, home, centre, p, q, true);
      pushTriangle(id, scaled(centre, outerRadius), scaled(p, outerRadius), scaled(q, outerRadius), centre, 2, home, centre, p, q, true);
      const side = new THREE.Vector3().subVectors(p.clone().add(q).multiplyScalar(0.5), centre);
      pushTriangle(id, scaled(p, innerRadius), scaled(q, innerRadius), scaled(q, outerRadius), side, 1, home, p, q, q, false);
      pushTriangle(id, scaled(p, innerRadius), scaled(q, outerRadius), scaled(p, outerRadius), side, 1, home, p, q, p, false);
      addFace(scaled(centre, innerRadius), scaled(p, innerRadius), scaled(q, innerRadius));
      addFace(scaled(centre, outerRadius), scaled(p, outerRadius), scaled(q, outerRadius));
      addFace(scaled(p, innerRadius), scaled(q, innerRadius), scaled(q, outerRadius));
      addFace(scaled(p, innerRadius), scaled(q, outerRadius), scaled(p, outerRadius));
    }

    const hull: number[] = [];
    let reach = 0;
    for (const point of ring) {
      for (const radius of [innerRadius, outerRadius]) {
        const v = scaled(point, radius).sub(home);
        hull.push(v.x, v.y, v.z);
        reach = Math.max(reach, v.length());
      }
    }
    shards.push({ home, direction: centre, hull: new Float32Array(hull), faces: new Float32Array(faces), reach });
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(position), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normal), 3));
  geometry.setAttribute("aShard", new THREE.BufferAttribute(new Float32Array(shardId), 1));
  geometry.setAttribute("aDirection", new THREE.BufferAttribute(new Float32Array(direction), 3));
  geometry.setAttribute("aFace", new THREE.BufferAttribute(new Float32Array(face), 1));
  // Measured now, while the page loads, rather than on the first frame a size change draws it.
  geometry.computeBoundingSphere();
  return { geometry, shards };
}

// Which plate covers each texel of a latitude-longitude map, so the lake can reflect the holes, and the texels of each
// plate as one list (plate i owns pixels[start[i]] up to pixels[start[i + 1]]), so a plate opens its hole without
// searching the whole map.
export function buildCellMap(shards: Shard[], width: number, height: number) {
  const cells = new Int16Array(width * height);
  const n = shards.length;
  // Plates sorted into a coarse latitude-longitude grid. The last texel's plate nearly always covers this one too,
  // and the true nearest can be no further off than it, so only the grid squares within that angle are searched.
  // Every sky size is cut while the page loads, so a search of every plate for every texel costs too much. Ties
  // still go to the lowest plate, as that full search would give.
  const LAT_BINS = 32;
  const LON_BINS = 64;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const dz = new Float64Array(n);
  const latBin = (lat: number) => Math.min(LAT_BINS - 1, Math.max(0, Math.floor(((lat + Math.PI / 2) / Math.PI) * LAT_BINS)));
  const lonBin = (lon: number) => Math.floor(((lon + Math.PI) / (Math.PI * 2)) * LON_BINS);
  const binOf = new Int32Array(n);
  const bucketStart = new Int32Array(LAT_BINS * LON_BINS + 1);
  const rowFilled = new Int32Array(LAT_BINS);
  shards.forEach(({ direction: { x, y, z } }, s) => {
    dx[s] = x;
    dy[s] = y;
    dz[s] = z;
    const row = latBin(Math.asin(Math.max(-1, Math.min(1, y))));
    binOf[s] = row * LON_BINS + Math.min(LON_BINS - 1, Math.max(0, lonBin(Math.atan2(z, x))));
    bucketStart[binOf[s] + 1]++;
    rowFilled[row]++;
  });
  for (let b = 0; b < LAT_BINS * LON_BINS; b++) bucketStart[b + 1] += bucketStart[b];
  const bucketed = new Int32Array(n);
  const place = bucketStart.slice(0, LAT_BINS * LON_BINS);
  for (let s = 0; s < n; s++) bucketed[place[binOf[s]]++] = s;

  const lonCos = new Float64Array(width);
  const lonSin = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const lon = ((x + 0.5) / width - 0.5) * Math.PI * 2;
    lonCos[x] = Math.cos(lon);
    lonSin[x] = Math.sin(lon);
  }
  let seed = 0;
  for (let y = 0; y < height; y++) {
    const lat = ((y + 0.5) / height - 0.5) * Math.PI;
    const latCos = Math.cos(lat);
    const py = Math.sin(lat);
    let previous = seed;
    for (let x = 0; x < width; x++) {
      const lon = ((x + 0.5) / width - 0.5) * Math.PI * 2;
      const px = latCos * lonCos[x];
      const pz = latCos * lonSin[x];
      let best = previous;
      let bestDot = dx[best] * px + dy[best] * py + dz[best] * pz;
      const reach = Math.acos(Math.min(1, bestDot)) + 1e-6;
      const nearPole = lat + reach >= Math.PI / 2 || lat - reach <= -Math.PI / 2;
      const across = nearPole ? Math.PI : Math.asin(Math.min(1, Math.sin(reach) / latCos));
      const lonFrom = across >= Math.PI ? 0 : lonBin(lon - across);
      const lonTo = across >= Math.PI ? LON_BINS - 1 : Math.min(lonFrom + LON_BINS - 1, lonBin(lon + across));
      for (let row = latBin(lat - reach), last = latBin(lat + reach); row <= last; row++) {
        if (!rowFilled[row]) continue;
        for (let column = lonFrom; column <= lonTo; column++) {
          const bucket = row * LON_BINS + (((column % LON_BINS) + LON_BINS) % LON_BINS);
          for (let k = bucketStart[bucket]; k < bucketStart[bucket + 1]; k++) {
            const s = bucketed[k];
            const dot = dx[s] * px + dy[s] * py + dz[s] * pz;
            if (dot > bestDot || (dot === bestDot && s < best)) {
              bestDot = dot;
              best = s;
            }
          }
        }
      }
      if (x === 0) seed = best;
      previous = best;
      cells[y * width + x] = best;
    }
  }

  const start = new Int32Array(n + 1);
  for (let i = 0; i < cells.length; i++) start[cells[i] + 1]++;
  for (let s = 0; s < n; s++) start[s + 1] += start[s];
  const pixels = new Int32Array(cells.length);
  const fill = start.slice(0, n);
  for (let i = 0; i < cells.length; i++) pixels[fill[cells[i]]++] = i;
  return { cells, start, pixels };
}
