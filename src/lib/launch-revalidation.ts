"use client";

const SETTLE_MS = 500;
const NO_LIBRARY_DEADLINE_MS = 2_000;
const IDLE_TIMEOUT_MS = 2_000;

let painted = false;
const waitingForPaint = new Set<() => void>();

export function markLaunchPainted(): void {
  if (painted) return;
  painted = true;
  const pending = [...waitingForPaint];
  waitingForPaint.clear();
  for (const release of pending) release();
}

export function afterLaunchPaint(task: () => void): () => void {
  let cancelled = false;
  let settleTimer = 0;
  let deadlineTimer = 0;
  let idleHandle: number | null = null;

  const release = () => {
    if (cancelled) return;
    window.clearTimeout(deadlineTimer);
    waitingForPaint.delete(release);
    settleTimer = window.setTimeout(() => {
      idleHandle = whenIdle(() => {
        if (!cancelled) task();
      });
    }, SETTLE_MS);
  };

  if (painted) {
    release();
  } else {
    waitingForPaint.add(release);
    deadlineTimer = window.setTimeout(release, NO_LIBRARY_DEADLINE_MS);
  }

  return () => {
    cancelled = true;
    waitingForPaint.delete(release);
    window.clearTimeout(deadlineTimer);
    window.clearTimeout(settleTimer);
    if (idleHandle !== null) cancelIdle(idleHandle);
  };
}

function whenIdle(run: () => void): number {
  if (typeof requestIdleCallback === "function") {
    return requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
  }
  return window.setTimeout(run, 0);
}

function cancelIdle(handle: number): void {
  if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
  else window.clearTimeout(handle);
}
