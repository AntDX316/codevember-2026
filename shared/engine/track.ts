// A moment worth counting, by name: a follow link opened, a share, the follow card offered. The site's own anonymous
// analytics listens for these and counts them with the page they happened on; where nothing listens, nothing happens.
export function track(name: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cv-track", { detail: name }));
}
