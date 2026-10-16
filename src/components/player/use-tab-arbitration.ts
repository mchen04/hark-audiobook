"use client";

import { RefObject, useCallback, useEffect, useRef } from "react";

import { pauseWithIntent } from "./pause-intent";

/**
 * Only one tab may play at a time: announcing playback makes every other tab
 * of this origin pause itself.
 */
export function useTabArbitration(audioRef: RefObject<HTMLAudioElement | null>) {
  const tabIdRef = useRef<string | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    tabIdRef.current = tabIdRef.current || crypto.randomUUID();
    const channel = new BroadcastChannel("chapterline-playback");
    channel.addEventListener(
      "message",
      (event: MessageEvent<{ type?: string; tabId?: string }>) => {
        if (event.data?.type === "playing" && event.data.tabId !== tabIdRef.current) {
          if (audioRef.current) pauseWithIntent(audioRef.current);
        }
      },
    );
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, [audioRef]);

  return useCallback(() => {
    channelRef.current?.postMessage({ type: "playing", tabId: tabIdRef.current });
  }, []);
}
