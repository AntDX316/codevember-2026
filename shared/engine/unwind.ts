import { useEffect, useRef } from "react";

// Asking a day to put itself back as it starts, in view and over a moment, rather than all at once as its reset does: an
// oasis drying back to dunes, say. A day that can, listens with useUnwind; the day's page never asks, so on its own a day
// behaves as it always has. Whatever asks waits for the longest of the answers.

type Unwinder = () => number;
const unwinders = new Set<{ current: Unwinder }>();

// `unwind` starts the day on its way back and returns how many seconds it will take.
export function useUnwind(unwind: Unwinder) {
  const latest = useRef(unwind);
  useEffect(() => {
    latest.current = unwind;
  });
  useEffect(() => {
    const entry = latest;
    unwinders.add(entry);
    return () => {
      unwinders.delete(entry);
    };
  }, []);
}

// Asks every day that is up to unwind. Returns the seconds the slowest will take, or null if none can.
export function unwind(): number | null {
  if (unwinders.size === 0) return null;
  let longest = 0;
  for (const entry of unwinders) longest = Math.max(longest, entry.current());
  return longest;
}
