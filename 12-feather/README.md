# Day 12: Feather

<img src="../videos/12-feather.gif" alt="Feather" width="384">

[Try it live](https://adamwebsite.com/codevember/12-feather/)

A pair of bird's wings built from the bone out: a skinned skeleton you can pose, and every feather on the bone it grows from.

## How to play

Drag a wing to fold and open it. Grab the ball at the neck to carry the body while the wingtips stay put. Switch to Fly to see it beat its wings.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/12-feather/>.

## Technical overview

### Research

- Bone proportions follow Hayward et al. (2009); elbow and wrist are coupled as in Vazquez (1994), so one opening value drives both.
- Feather tracts follow Proctor and Lynch (1993), and the wingbeat Tobalske and Dial's (1996) high-speed studies.

### Wing

- Each wing is a three-bone three.js skeleton with skinned mesh, dragged by inverse kinematics with joints on springs.
- About 330 feathers a wing in four instanced meshes, one TSL material with per-feather random shade, wear and width.
- Each feather is sprung in lift, twist and bend by the cursor's breeze and the wing's own motion.

### Airflow

- A vortex lattice per wing sheds a wake of vortex rings, each as strong as the wing's lift at that moment.
- Velocity is a Biot–Savart sum on the CPU within a per-frame budget, drawn as CFD-coloured streamlines or vortex filaments.

### Sky

- Clouds are raymarched through baked 3D Perlin–Worley noise, lit by Beer–Lambert and a two-lobe Henyey–Greenstein phase.
- The march runs at half resolution, jittered and reprojected; four moods change only light and colour.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
