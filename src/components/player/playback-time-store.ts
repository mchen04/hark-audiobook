export type PlaybackTimeStore = {
  subscribe: (onChange: () => void) => () => void;
  read: () => number;
  write: (positionMs: number) => void;
};

export function createTimeStore(): PlaybackTimeStore {
  let timeMs = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    read: () => timeMs,
    write(positionMs) {
      if (positionMs === timeMs) return;
      timeMs = positionMs;
      listeners.forEach((listener) => listener());
    },
  };
}
