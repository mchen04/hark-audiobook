import { pauseWithIntent } from "./pause-intent";

type PendingStart = {
  position: number;
  applied: boolean;
  cancel: () => void;
  restore: () => void;
};

const interruptedStartEnds = new WeakSet<HTMLMediaElement>();
const pendingStarts = new WeakMap<HTMLMediaElement, PendingStart>();
const sourceReadiness = new WeakMap<HTMLMediaElement, { usable: boolean; clear: () => void }>();

function trackSourceReadiness(audio: HTMLMediaElement): void {
  sourceReadiness.get(audio)?.clear();
  const events = ["loadeddata", "canplay", "canplaythrough", "playing", "timeupdate"];
  const clear = () => {
    for (const event of events) audio.removeEventListener(event, observe);
  };
  const state = { usable: false, clear };
  const observe = (event?: Event) => {
    if (
      audio.readyState < audio.HAVE_FUTURE_DATA &&
      !(
        audio.readyState >= audio.HAVE_CURRENT_DATA &&
        !audio.paused &&
        (event?.type === "playing" || (event?.type === "timeupdate" && audio.currentTime > 0))
      )
    )
      return;
    state.usable = true;
    clear();
  };
  sourceReadiness.set(audio, state);
  for (const event of events) audio.addEventListener(event, observe);
  observe();
}

export function mediaTime(audio: HTMLMediaElement | null | undefined): number {
  if (!audio) return 0;
  return pendingStarts.get(audio)?.position ?? audio.currentTime;
}

export function setMediaTime(audio: HTMLMediaElement, position: number): void {
  const pending = pendingStarts.get(audio);
  if (pending) {
    pending.position =
      pending.applied && Number.isFinite(audio.duration)
        ? Math.min(position, audio.duration)
        : position;
    if (!pending.applied) return;
  }
  audio.currentTime = pending?.position ?? position;
}

export function cancelMediaStart(audio: HTMLMediaElement): void {
  const pending = pendingStarts.get(audio);
  if (!pending) return;
  if (!audio.paused) pauseWithIntent(audio);
  pending.cancel();
}

export function recoverMediaStartEnd(audio: HTMLMediaElement): boolean {
  const pending = pendingStarts.get(audio);
  if (pending) pending.restore();
  const interrupted = interruptedStartEnds.delete(audio);
  return !!pending || interrupted;
}

export function primeMediaStart(audio: HTMLMediaElement): void {
  if (!audio.paused || pendingStarts.has(audio) || sourceReadiness.get(audio)?.usable) return;
  if (audio.readyState >= audio.HAVE_FUTURE_DATA && !audio.seeking) return;
  const position = audio.currentTime;
  if (position <= 0 || !audio.getAttribute("src")) return;
  const rate = audio.playbackRate;
  loadMediaSource(audio, audio.src, position);
  audio.playbackRate = rate;
}

export function loadMediaSource(
  audio: HTMLMediaElement,
  source: string,
  position: number,
  prime = true,
): void {
  cancelMediaStart(audio);
  interruptedStartEnds.delete(audio);
  if (audio.src === source) audio.load();
  else audio.src = source;
  trackSourceReadiness(audio);
  if (!prime || position <= 0 || audio.readyState >= audio.HAVE_FUTURE_DATA) {
    audio.currentTime = position;
    return;
  }
  const wasMuted = audio.muted;
  audio.muted = true;
  audio.currentTime = 0;
  let restoring = false;
  const cancel = () => {
    clearTimeout(deadline);
    audio.removeEventListener("loadeddata", apply);
    audio.removeEventListener("canplay", apply);
    audio.removeEventListener("playing", onPlayback);
    audio.removeEventListener("timeupdate", onPlayback);
    audio.removeEventListener("seeked", finish);
    audio.removeEventListener("pause", onPause, true);
    audio.removeEventListener("error", restore, true);
    audio.removeEventListener("ended", restore);
    pendingStarts.delete(audio);
    audio.muted = wasMuted;
  };
  const restore = () => {
    if (restoring) return;
    restoring = true;
    if (audio.ended) interruptedStartEnds.add(audio);
    try {
      if (!audio.paused) pauseWithIntent(audio);
      audio.currentTime = pending.position;
    } finally {
      cancel();
    }
  };
  const onPause = () => {
    if (audio.paused) restore();
  };
  const pending: PendingStart = { position, applied: false, cancel, restore };
  const apply = (event: Event) => {
    if (pending.applied) return;
    const playingCurrentData =
      audio.readyState >= audio.HAVE_CURRENT_DATA &&
      !audio.paused &&
      (event.type === "playing" || (event.type === "timeupdate" && audio.currentTime > 0));
    if (audio.readyState < audio.HAVE_FUTURE_DATA && !playingCurrentData) return;
    pending.applied = true;
    if (Number.isFinite(audio.duration))
      pending.position = Math.min(pending.position, audio.duration);
    if (audio.currentTime === pending.position && !audio.seeking) {
      cancel();
      return;
    }
    audio.currentTime = pending.position;
  };
  const finish = () => {
    if (
      !pending.applied ||
      audio.ended ||
      audio.seeking ||
      audio.currentTime < pending.position - 0.05
    )
      return;
    cancel();
  };
  const onPlayback = (event: Event) => {
    if (audio.ended) return;
    if (pending.applied) finish();
    else apply(event);
  };
  const deadline = setTimeout(restore, 10000);
  pendingStarts.set(audio, pending);
  audio.addEventListener("loadeddata", apply);
  audio.addEventListener("canplay", apply);
  audio.addEventListener("playing", onPlayback);
  audio.addEventListener("timeupdate", onPlayback);
  audio.addEventListener("seeked", finish);
  audio.addEventListener("pause", onPause, true);
  audio.addEventListener("error", restore, true);
  audio.addEventListener("ended", restore);
}
