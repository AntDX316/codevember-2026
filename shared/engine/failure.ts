// What went wrong, in words a visitor can act on, with the browser's own message kept underneath for a bug report.
// The hub and every day show the same error screen; the raw message alone ("A network error occurred.") says nothing
// about what failed or what to try. Each kind is also counted, anonymously, with the page view (see track.ts), so the
// admin portal can show how often visitors hit each.

import { track } from "./track";

export type FailureKind = "code" | "network" | "memory" | "no-3d" | "blocked" | "missing" | "other";
export type Failure = { kind: FailureKind; message: string; detail: string };

const RELOAD = "Reload to try again.";

export function explain(error: unknown): Failure {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  const raw =
    error instanceof Error || error instanceof DOMException
      ? error.message
      : typeof error === "string"
        ? error
        : error instanceof Event
          ? `${error.type} event${(error.target as unknown as { src?: string } | null)?.src ? ` (${(error.target as unknown as { src: string }).src})` : ""}`
          : String(error);
  const detail = [name && name !== "Error" ? name : "", raw].filter(Boolean).join(": ").slice(0, 240);
  const text = `${name} ${raw}`.toLowerCase();
  const say = (kind: FailureKind, message: string) => ({ kind, message, detail });

  // The scene's own code, a dynamic import: a dropped connection, or the site updated since this page was opened.
  if (/chunkload|loading chunk|dynamically imported module|importing a module script failed|error loading dynamically/.test(text)) {
    return say("code", `This scene's code could not be downloaded. The connection may have dropped, or the site was just updated. ${RELOAD}`);
  }
  // A file the scene needs: the connection, or a content blocker, privacy setting or data saver refusing it.
  if (error instanceof Event || /networkerror|network error|failed to fetch|load failed|could not be downloaded|err_|net::/.test(text)) {
    return say("network", `A file this scene needs could not be downloaded. Check the connection, or pause any content blocker for this site. ${RELOAD}`);
  }
  if (/out of memory|outofmemory|allocation|device lost|devicelost|context lost|contextlost/.test(text)) {
    return say("memory", "The device ran out of graphics memory. Close other tabs or apps, then reload; Low quality in the controls uses less.");
  }
  if (/webgl|webgpu|adapter|no gpu|getcontext/.test(text)) {
    return say("no-3d", "This browser could not start 3D graphics. Turn on hardware acceleration in its settings, or try Chrome, Safari or Edge.");
  }
  if (name === "SecurityError" || name === "QuotaExceededError") {
    return say("blocked", `This browser's privacy settings blocked something the scene needs. ${RELOAD}`);
  }
  return say("other", `Something went wrong while showing this scene. ${RELOAD}`);
}

// Neither WebGPU nor WebGL 2: the renderer cannot start at all.
export const NO_3D: Failure = {
  kind: "no-3d",
  message: "This browser cannot draw 3D: it has neither WebGPU nor WebGL 2. Turn on hardware acceleration, or try Chrome, Safari or Edge.",
  detail: ""
};

// The renderer was lost mid-visit (a phone reclaiming graphics memory, a driver reset).
export const lost = (detail: string): Failure => ({
  kind: "memory",
  message: "The graphics device was reset, usually from running out of memory. Reload to continue; Low quality in the controls uses less.",
  detail
});

// Counted once per kind per page view: "fail-network", "fail-memory" and so on.
export function reportFailure(failure: Failure) {
  track(`fail-${failure.kind}`);
}
