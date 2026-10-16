import { pauseWithIntent } from "./pause-intent";

type PendingStart = {
  position: number;
  applied: boolean;
  cancel: () => void;
};

const pendingStarts = new WeakMap<HTMLMediaElement, PendingStart>();

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

export function loadMediaSource(audio: HTMLMediaElement, source: string, position: number): void {
  cancelMediaStart(audio);
  if (audio.src === source) audio.load();
  else audio.src = source;
  if (position <= 0 || audio.readyState >= audio.HAVE_FUTURE_DATA) {
    audio.currentTime = position;
    return;
  }
  const wasMuted = audio.muted;
  audio.muted = true;
  const cancel = () => {
    audio.removeEventListener("loadeddata", apply);
    audio.removeEventListener("canplay", apply);
    audio.removeEventListener("seeked", finish);
    pendingStarts.delete(audio);
    audio.muted = wasMuted;
  };
  const pending: PendingStart = { position, applied: false, cancel };
  const apply = () => {
    if (pending.applied || audio.readyState < audio.HAVE_FUTURE_DATA) return;
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
    if (!pending.applied || audio.seeking || audio.currentTime < pending.position - 0.05) return;
    cancel();
  };
  pendingStarts.set(audio, pending);
  audio.addEventListener("loadeddata", apply);
  audio.addEventListener("canplay", apply);
  audio.addEventListener("seeked", finish);
}
