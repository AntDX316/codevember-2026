import { clear, suspend } from "suspend-react";

// A dropped connection on a phone should not end the visit. Asks again a few times, waiting a little longer each time.
export async function withRetries<T>(load: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await load();
    } catch (failure) {
      if (attempt >= attempts) throw failure;
      await new Promise((resolve) => window.setTimeout(resolve, 500 * attempt));
    }
  }
}

// One file through one of three's loaders, asked for again on its own if it drops, so that one bad request among
// twenty does not send all twenty again.
export function loadRetried<T>(loader: { loadAsync(url: string): Promise<T> }, url: string): Promise<T> {
  return withRetries(() => loader.loadAsync(url));
}

// A fetch that counts a 404 or 500 as a failure (fetch itself only fails when the connection does), retried the same.
export function fetchRetried(url: string, init?: RequestInit): Promise<Response> {
  return withRetries(async () => {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response;
  });
}

// suspend-react keeps a failure under its key for good, so a day whose load failed once would fail again on every later
// visit without asking. This throws the failure on to the error screen as before, then forgets it once React has shown
// that screen, so the next visit loads afresh. (Forgotten at once, React's own second try at the render would start the
// load again and the failure would never be seen.)
export function suspendRetried<T, Keys extends [unknown, ...unknown[]]>(load: () => Promise<T>, keys: Keys): T {
  try {
    return suspend(load, keys) as T;
  } catch (thrown) {
    if (!(thrown && typeof (thrown as PromiseLike<unknown>).then === "function")) window.setTimeout(() => clear(keys), 0);
    throw thrown;
  }
}
