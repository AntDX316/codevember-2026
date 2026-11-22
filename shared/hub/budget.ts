// How much memory the hub may spend. A phone's browser closes a tab that uses much more than a gigabyte, and allows the
// GPU far less, so on a phone or tablet, or a computer short of memory, the hub keeps its pictures smaller (its posters
// at about a third of the pixels, the words on its tiles in one channel at a lower resolution). Seen whole on such a
// screen, a poster is only a few hundred pixels across, so little is lost. Decided once per visit, before the posters load.

const LOST = "cv-device-lost";
let refused = false;

const storage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

// Whether the graphics device has been lost already in this tab: the next load starts as light as it can.
export const lostBefore = () => typeof window !== "undefined" && storage()?.getItem(LOST) === "1";
export const markLost = () => storage()?.setItem(LOST, "1");

// The memory the browser says the device has, in GB, rounded down and capped at 8; Chrome and Edge only.
const deviceMemory = () => (typeof navigator === "undefined" ? undefined : (navigator as { deviceMemory?: number }).deviceMemory);

// The renderer had to fall back from WebGPU, which a phone short of memory can refuse, or the adapter is a phone's (its
// largest texture 8192 or less, where a desktop's is 16384).
export function noteAdapter({ fellBack, maxTexture }: { fellBack: boolean; maxTexture?: number }) {
  if (fellBack || (maxTexture !== undefined && maxTexture <= 8192)) refused = true;
}

export function lightHub() {
  if (typeof window === "undefined") return false;
  const memory = deviceMemory();
  return window.matchMedia("(pointer: coarse)").matches || (memory !== undefined && memory <= 4) || refused || lostBefore();
}

// So short of memory (2 GB or less, or a loss already in this tab) that the hub is drawn a little below the screen's density.
export function scarce() {
  const memory = deviceMemory();
  return (memory !== undefined && memory <= 2) || lostBefore();
}

// Two GB or less, or a loss already in this tab: the stage starts at the lowest tier, the hub and the days alike, since
// they share one renderer. Not at four: Chrome reports any phone under 8 GB as 4, most of which hold Medium well, and Auto
// steps down by itself where one does not. A tier chosen by hand still applies.
export function startLow() {
  const memory = deviceMemory();
  return (memory !== undefined && memory <= 2) || lostBefore();
}
