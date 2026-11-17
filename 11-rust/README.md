# Day 11: Rust

<img src="../videos/11-rust.gif" alt="Rust" width="384">

[Try it live](https://adamwebsite.com/codevember/11-rust/)

A rusted fence post, scanned and drawn as Gaussian splats by three.js's own WebGPU splat renderer.

## How to play

Drag to look around the post.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/11-rust/>.

## Technical overview

### 3D capture

- A real beach post scanned by phone in Polycam; structure from motion solves the camera poses and a sparse point cloud.
- 3D Gaussian splatting trains soft ellipsoids to match every frame, saved as a 12 MB SPZ of 875,000 Gaussians.
- The beach behind is a second splat scene made from a single sunset photograph.

### Rendering

- three.js r187's TSL GaussianSplat on WebGPU draws about 1.5 million Gaussians a frame, depth-sorted by a compute counting sort.
- The scan is cropped to a faded cylinder, stray sky and blobs culled by colour and size, with a solid core so nothing shows through.

### Sea and sky

- Day 7's Tessendorf FFT ocean mirrors the scene and fades into the photo's sea, with foam at its surf line.
- Boats and gulls are instanced meshes, gull wings flapped in the vertex shader, under a drifting cloud sheet.
- Splats write no depth, so the soft frame edges are a screen-space blur rather than depth of field.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
