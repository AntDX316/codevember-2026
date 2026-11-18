# Day 10: Caustic

<img src="../videos/10-caustic.gif" alt="Caustic" width="384">

[Try it live](https://adamwebsite.com/codevember/10-caustic/)

Coloured glass on a table in low sun, its light bent and gathered into bright colours on the wood.

## How to play

Drag the glass about to push the pieces around, and turn the dial to move the sun.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/10-caustic/>.

## Technical overview

### Rendering

- R3F and three.js r187 on WebGPU, every surface a TSL node material; the glass is transmission with dispersion and thickness absorption.
- Every study is built out of sight during first load and kept, so choosing one only changes which is shown.

### Caustics

- Light is a mesh, after Evan Wallace: one ray per vertex traced in the vertex shader, brightness as triangle area before over after.
- Marbles, orbs and blocks are traced exactly by ray-sphere and ray-box, each colour band bending a little more to split edges into a spectrum.
- Suzanne is drawn from the sun into near and far normal-depth maps; each ray bends in, walks the far map, and bends out.

### Table

- All light is summed into one softened top-down map, recomputed only when a piece or the sun moves.
- Pieces roll on a pull to the centre, mass as size cubed; Suzannes rest as dropped in Rapier and collide as a few circles.
- The dial turns the sun, and colourways retint glass and light without rebuilding a shader.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
