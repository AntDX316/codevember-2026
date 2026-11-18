import type { DayDefinition } from "@/shared/engine/types";

// The 3D calendar, loaded as a day is.
export const loadSpace = (): Promise<{ default: DayDefinition }> => import("./calendar");
