export type BrowserAudioSession = EventTarget & {
  type: string;
  readonly state?: string;
};

export function readAudioSession(): BrowserAudioSession | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as Navigator & { audioSession?: BrowserAudioSession }).audioSession ?? null;
}

export function configurePlaybackAudioSession(): void {
  const session = readAudioSession();
  if (!session) return;
  try {
    if (session.type !== "playback") session.type = "playback";
  } catch {
    return;
  }
}
