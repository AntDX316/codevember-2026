// The shape of a tracked hand as MediaPipe gives it: 21 landmarks, which of them are fingertips, and how they join. Shared by the
// tracker (loaded only when IRL Hands is on) and the hand drawn in the scene.

// Thumb, index, middle, ring, little: the tip, and the joint its straightness is measured against.
export const TIPS = [4, 8, 12, 16, 20];
export const JOINTS = [2, 6, 10, 14, 18];
export const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
];

// Which hand a key is, so its fingertips keep the same ids frame to frame.
const HAND_SLOTS: Record<string, number> = { Right: 0, Left: 1, Right2: 2, Left2: 3, Hand: 4, Hand2: 5 };
export const slotOf = (key: string) => HAND_SLOTS[key] ?? 6;
