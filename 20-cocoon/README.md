# Day 20: Cocoon

<img src="../videos/20-cocoon.gif" alt="Cocoon" width="384">

[Try it live](https://adamwebsite.com/codevember/20-cocoon/)

A butterfly coming out of its chrysalis under a branch in Tension's garden: the case clears and splits, it climbs out, fills and dries its wings, flies up to walk the branch, and leaves; the next one's chrysalis grows.

## How to play

Click the chrysalis to start the transformation. Hover over the butterfly to send it up to the branch, and again to let it fly away.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/20-cocoon/>.

## Technical overview

### Chrysalis

- Moulded per species with its anatomy (wing cases, sheaths, eye caps, ringed segments, spiracles) and cut along its real lines of weakness into a lid and two sides, which bend open about their hinges in the vertex shader on a spring with a little overshoot.
- Whole, it is drawn opaque with its depth faked in the shading (light through it, absorbed by its thickness, shadowed by the folded butterfly); split, it is an alpha-blended, paper-thin film. The empty shell drops and the next species' grows from a bead under the silk pad.

### Emergence

- Stepped at a fixed 1/60 s from a seed per species, whatever the frame rate, so every visitor sees the same run: the climb out and the flip onto the shell follow a plan searched over a grid of poses against the shell as drawn, each foot holding a real point of the shell and stepping in diagonal pairs.
- A CPU test keeps it clean: the open shell sampled into a grid of cells, every probe of body, head and legs measured against it, and each leg segment against each wing's triangles, the wing pads parting only as far as the legs need.

### Butterfly

- Wings cut from museum photographs (upper and under sides), bent per vertex as they fill and dry; the Morpho's blue is a narrow, one-way multilayer lobe that slides to violet and then dark with angle, the Glasswing's panes a second see-through pass.
- Legs are two-bone chains of fixed length solved toward each foothold; on the branch it walks on four in diagonal pairs. Flight is a spring steered along a path, heaved by every wingbeat, in beats and glides at the species' own rhythm.

### Garden

- One function gives the branch's surface (taper, knots, moss and the heights of a scanned bark, Poly Haven), so the mesh, the hanging point and every foothold agree. Dew is one GPU-placed mesh of small lenses showing the garden upside down.
- Tension's sky is drawn once into a small panorama that every reflection looks up; motes, bokeh and light shafts are additive in the overlay pass, hidden by the scene's depth; far butterflies fly on the GPU.

### Performance

- Each species' 4096² wing photograph is decoded and reduced to mips in a worker, then copied to the GPU in 2 MB strips, behind the loader or while the old shell falls rather than as the case splits. The clash test's shell grid is built a few rows a frame before it is needed.
- Counts and detail scale by tier (dew, motes, far butterflies, bark and shell detail); phones start on Low with 2048² wings, at one pixel per CSS pixel.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
