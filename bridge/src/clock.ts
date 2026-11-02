export interface Clock {
  /** UTC milliseconds. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
