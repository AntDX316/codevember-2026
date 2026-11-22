import * as THREE from "three/webgpu";

// The soap film's colour is real thin-film interference: light reflected off the film's two faces, one of them flipped
// half a wave, adds or cancels by wavelength as the thickness changes. A table worked out once on the processor gives
// the colour reflected for every thickness and angle, summed over the spectrum through the eye's colour response.
// (From the bubble version.)

// Thickest film in the table, in nanometres.
const MOST = 1500;
const INDEX = 1.33;

// CIE 1931 colour matching, by Wyman, Sloan and Shirley's sums of skewed Gaussians.
function lobe(l: number, mu: number, below: number, above: number) {
  const t = (l - mu) / (l < mu ? below : above);
  return Math.exp(-0.5 * t * t);
}
const cmf = (l: number) => [
  1.056 * lobe(l, 599.8, 37.9, 31) + 0.362 * lobe(l, 442, 16, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2),
  0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1),
  1.217 * lobe(l, 437, 11.8, 36) + 0.681 * lobe(l, 459, 26, 13.8)
];
const toRgb = (x: number, y: number, z: number) => [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z];

// The reflected colour by thickness (across) and the cosine of the angle of incidence (up), as linear RGB with white 1.
export function filmTable() {
  const W = 512;
  const H = 32;
  const lambdas: number[] = [];
  for (let l = 380; l <= 780; l += 5) lambdas.push(l);
  const curves = lambdas.map(cmf);
  let ySum = 0;
  for (const c of curves) ySum += c[1];
  const white = toRgb(...(curves.reduce((s, c) => [s[0] + c[0], s[1] + c[1], s[2] + c[2]], [0, 0, 0]).map((v) => v / ySum) as [number, number, number]));
  const data = new Uint16Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    const cosi = Math.max(j / (H - 1), 0.001);
    const sini2 = 1 - cosi * cosi;
    const cost = Math.sqrt(1 - sini2 / (INDEX * INDEX));
    const rs = (cosi - INDEX * cost) / (cosi + INDEX * cost);
    const rp = (INDEX * cosi - cost) / (INDEX * cosi + cost);
    for (let i = 0; i < W; i++) {
      const d = (i / (W - 1)) * MOST;
      let X = 0;
      let Y = 0;
      let Z = 0;
      lambdas.forEach((l, k) => {
        const cd = Math.cos((4 * Math.PI * INDEX * d * cost) / l);
        // Airy's sum for a film between two equal media: the two faces' reflections, and every bounce between them.
        const airy = (r: number) => {
          const r2 = r * r;
          return (2 * r2 * (1 - cd)) / (1 + r2 * r2 - 2 * r2 * cd);
        };
        const R = 0.5 * (airy(rs) + airy(rp));
        X += R * curves[k][0];
        Y += R * curves[k][1];
        Z += R * curves[k][2];
      });
      const rgb = toRgb(X / ySum, Y / ySum, Z / ySum);
      for (let c = 0; c < 3; c++) data[(j * W + i) * 4 + c] = THREE.DataUtils.toHalfFloat(Math.max(0, rgb[c] / white[c]));
      data[(j * W + i) * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, most: MOST };
}
