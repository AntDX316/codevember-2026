import type { DayDefinition } from "@/shared/engine/types";
import { HubScene } from "./Hub";

// The calendar as one more module for the stage: it owns its camera and its look, so the camera here goes unused.
export const hubDefinition: DayDefinition = {
  camera: { position: [0, 10, 0], target: [0, 0, 0] },
  Scene: HubScene
};
