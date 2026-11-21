// Packs a Poly Haven .hdr into a .room file for Bolt (plasma): node pack-room.mjs in.hdr out.room
// Packs a Radiance .hdr into a compact room file: RGBE bytes, planar (all R, all G, all B, all E), each plane
// delta-coded along rows, then deflated (zlib). Decoded in the browser with DecompressionStream("deflate").
import fs from "node:fs";
import zlib from "node:zlib";
const [src, out] = process.argv.slice(2);
const bytes = fs.readFileSync(src);
let at = 0;
const line = () => { let s = ""; while (bytes[at] !== 10) s += String.fromCharCode(bytes[at++]); at++; return s; };
while (line() !== "");
const [, H, W] = line().match(/-Y\s+(\d+)\s+\+X\s+(\d+)/).map(Number);
const rgbe = new Uint8Array(W * H * 4);
const scan = new Uint8Array(W * 4);
for (let y = 0; y < H; y++) {
  if (bytes[at] !== 2 || bytes[at + 1] !== 2) { rgbe.set(bytes.subarray(at, at + W * 4), y * W * 4); at += W * 4; continue; }
  at += 4;
  for (let c = 0; c < 4; c++) { let x = 0; while (x < W) { let n = bytes[at++]; if (n > 128) { n -= 128; const v = bytes[at++]; for (let i = 0; i < n; i++) scan[(x++) * 4 + c] = v; } else for (let i = 0; i < n; i++) scan[(x++) * 4 + c] = bytes[at++]; } }
  rgbe.set(scan, y * W * 4);
}
const planes = new Uint8Array(W * H * 4);
// The lowest bit of each colour mantissa is noise at this size: dropped, which leaves the exponent exact.
const q = (y, x, c) => (c < 3 ? rgbe[(y * W + x) * 4 + c] & 0xfe : rgbe[(y * W + x) * 4 + c]);
// Each value predicted from the mean of its left and upper neighbours, the residual stored.
for (let c = 0; c < 4; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const left = x > 0 ? q(y, x - 1, c) : 0;
  const up = y > 0 ? q(y - 1, x, c) : 0;
  const pred = x > 0 ? left : up;
  planes[c * W * H + y * W + x] = (q(y, x, c) - pred) & 255;
}
const header = Buffer.alloc(8); header.writeUInt32LE(W, 0); header.writeUInt32LE(H, 4);
const packed = Buffer.concat([header, zlib.deflateSync(planes, { level: 9, memLevel: 9 })]);
fs.writeFileSync(out, packed);
console.log(src.split("/").pop(), W + "x" + H, (packed.length / 1e6).toFixed(2) + " MB");
