const pendingSeeks = new WeakMap<HTMLMediaElement, { position: number; apply: () => void }>();

export function mediaTime(audio: HTMLMediaElement | null | undefined): number {
  return audio ? (pendingSeeks.get(audio)?.position ?? audio.currentTime) : 0;
}

export function clearMediaSeek(audio: HTMLMediaElement): void {
  const pending = pendingSeeks.get(audio);
  if (pending) audio.removeEventListener("loadedmetadata", pending.apply);
  pendingSeeks.delete(audio);
}

export function setMediaTime(audio: HTMLMediaElement, position: number): void {
  clearMediaSeek(audio);
  if (audio.readyState < audio.HAVE_METADATA) {
    const apply = () => {
      const pending = pendingSeeks.get(audio);
      clearMediaSeek(audio);
      if (pending) audio.currentTime = pending.position;
    };
    pendingSeeks.set(audio, { position, apply });
    audio.addEventListener("loadedmetadata", apply, { once: true });
    return;
  }
  if (audio.currentTime !== position) audio.currentTime = position;
}

export function loadMediaSource(audio: HTMLMediaElement, source: string, position: number): void {
  clearMediaSeek(audio);
  if (audio.src === source || audio.getAttribute("src") === source) audio.load();
  else audio.src = source;
  setMediaTime(audio, position);
}
