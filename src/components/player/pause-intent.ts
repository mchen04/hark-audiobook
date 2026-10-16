export const APP_PAUSE_EVENT = "hark:app-pause";
export const APP_POSITION_EVENT = "hark:app-position";
const pendingPauses = new WeakSet<HTMLAudioElement>();

export function pauseWithIntent(audio: HTMLAudioElement): void {
  if (!audio.paused) pendingPauses.add(audio);
  audio.dispatchEvent(new Event(APP_PAUSE_EVENT));
  audio.pause();
}

export function consumeAppPause(audio: HTMLAudioElement): boolean {
  return pendingPauses.delete(audio);
}

export function hasAppPause(audio: HTMLAudioElement): boolean {
  return pendingPauses.has(audio);
}
