// The page as HTML. Resting on the page, or scrolling it, the browser shows the page itself: the same pictures of its
// words, buttons and count that the GPU draws from, and its cards built of the same poster, shade and border, each laid
// where the GPU lays it, in the scrolling box the camera follows (unfold.tsx). Behind it the canvas holds a picture of the
// sky alone and draws nothing more, so a scroll is the browser's own, with nothing to wait for. The moment the page starts
// to move (the way into the calendar, or a page drawn rising into view) the GPU's copy takes its place in the same frame, and
// gives it back when the page comes to rest again. It only shows: presses and pointing go on through the box to the scene,
// which says what is pointed at (`hover`).

let sheet: HTMLDivElement | null = null;

// Everything the page shows, in CSS pixels from its top left.
export function pageSheet() {
  if (!sheet) {
    sheet = document.createElement("div");
    sheet.className = "cv-page-html";
    sheet.setAttribute("aria-hidden", "true");
  }
  return sheet;
}

// Laid on the page at `rect`, its own size there unless it is to be shown at another.
export function place(element: HTMLElement, rect: { x: number; y: number; w: number; h: number }) {
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.w}px`;
  element.style.height = `${rect.h}px`;
  return element;
}

// A picture drawn for the GPU, shown as it is: the canvas itself, which the texture made from it no longer needs.
export function shown(canvas: HTMLCanvasElement, rect: { x: number; y: number; w: number; h: number }, className = "cv-page-html-art") {
  canvas.className = className;
  return place(canvas, rect);
}

// The page's own ink, as the GPU colours a white picture: drawn again in it.
export function inked(source: HTMLCanvasElement, ink: string) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = ink;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

// Whether what is pointed at on the page is shown pointed at, and pressed.
export function hover(element: HTMLElement | undefined, on: boolean, pressed = false) {
  if (!element) return;
  if (element.classList.contains("cv-hover") !== on) element.classList.toggle("cv-hover", on);
  if (element.classList.contains("cv-pressed") !== pressed) element.classList.toggle("cv-pressed", pressed);
}
