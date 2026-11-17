"use client";

import { useMusic } from "../shared/engine/sound";
import type { DayDefinition } from "../shared/engine/types";
import { Focus } from "./set";
import { SKIES } from "./sky";
import { Wing } from "./wing";

function Scene() {
  useMusic("/codevember/music/rising-spark.mp3", 0.32);
  return (
    <>
      <Focus />
      <Wing />
    </>
  );
}

const feather: DayDefinition = {
  camera: { position: [-1.3, 3.18, 1.2], target: [-0.36, 1.42, 0.06], fov: 34, phone: { position: [-2.2, 4.9, 2.3], target: [-0.3, 1.05, 0.05], fov: 40 } },
  phonePills: ["flapping", "sky"],
  // Open sky all round: no floor to stop the camera, and room to go well below and above the bird.
  extents: { centre: [0, 1, 0], radius: 14, color: "#ffe2b8" },
  passes: { bounce: true, haze: false, overlay: true, depthOfField: { range: 4 } },
  look: { background: "#0c0e11", exposure: 0.85, bloom: 0.08, bloomThreshold: 0.92, vignette: 0.55, grain: 0.015, ao: 1, aoRadius: 0.25, gi: 1 },
  settings: {
    flapping: { type: "toggle", label: "Flap", value: false, sides: ["Glide", "Fly"] },
    pace: { type: "range", label: "Speed", min: 0.2, max: 1, step: 0.01, value: 1 },
    flock: { type: "range", label: "Birds", min: 1, max: 5, phoneMax: 3, step: 1, value: 1 },
    bones: { type: "toggle", label: "X-ray bones", value: true },
    airflow: { type: "toggle", label: "Airflow simulation", value: false },
    airStyle: {
      type: "choice",
      label: "Air shown as",
      value: "streamlines",
      options: [
        { value: "streamlines", label: "Streamlines" },
        { value: "vortex", label: "Vortices" }
      ],
      when: { setting: "airflow", is: true }
    },
    sky: { type: "choice", label: "Sky", value: "sunset", options: SKIES },
    species: {
      type: "choice",
      label: "Bird",
      value: "gull",
      options: [
        { value: "gull", label: "Gull" },
        { value: "goose", label: "Goose" },
        { value: "kestrel", label: "Kestrel" }
      ]
    },
    rouse: { type: "action", label: "Shake out" }
  },
  hint: "Drag a wing to fold and open it. Grab the ball at the neck to carry the body while the wingtips stay put. Switch to Fly to see it beat its wings.",
  notes: "A pair of bird's wings built from the bone out: a skinned skeleton you can pose, and every feather on the bone it grows from.",
  overview: [
    {
      title: "Research",
      points: [
        "Bone proportions follow Hayward et al. (2009); elbow and wrist are coupled as in Vazquez (1994), so one opening value drives both.",
        "Feather tracts follow Proctor and Lynch (1993), and the wingbeat Tobalske and Dial's (1996) high-speed studies."
      ]
    },
    {
      title: "Wing",
      points: [
        "Each wing is a three-bone three.js skeleton with skinned mesh, dragged by inverse kinematics with joints on springs.",
        "About 330 feathers a wing in four instanced meshes, one TSL material with per-feather random shade, wear and width.",
        "Each feather is sprung in lift, twist and bend by the cursor's breeze and the wing's own motion."
      ]
    },
    {
      title: "Airflow",
      points: [
        "A vortex lattice per wing sheds a wake of vortex rings, each as strong as the wing's lift at that moment.",
        "Velocity is a Biot–Savart sum on the CPU within a per-frame budget, drawn as CFD-coloured streamlines or vortex filaments."
      ]
    },
    {
      title: "Sky",
      points: [
        "Clouds are raymarched through baked 3D Perlin–Worley noise, lit by Beer–Lambert and a two-lobe Henyey–Greenstein phase.",
        "The march runs at half resolution, jittered and reprojected; four moods change only light and colour."
      ]
    }
  ],
  Scene
};

export default feather;
