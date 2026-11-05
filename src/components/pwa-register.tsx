"use client";

import { useEffect } from "react";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import { afterLaunchPaint } from "@/lib/launch-revalidation";
import { retryAllPendingOfflineDeletions } from "@/lib/offline/deletion-journal";

function warmImportChunks(): void {
  void Promise.allSettled([warmMp3Parser(), import("@/lib/media-hash")]).then(() => {
    document.documentElement.dataset.importReady = "1";
  });
}

async function warmMp3Parser(): Promise<void> {
  const { parseBlob } = await import("music-metadata");
  await parseBlob(new Blob([mp3ParserWarmupFrame()], { type: "audio/mpeg" }), { duration: false });
}

export function mp3ParserWarmupFrame(): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(new ArrayBuffer(417));
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return frame;
}

export function PwaRegister() {
  useEffect(() => {
    if (localStorage.getItem(ACTIVE_USER_KEY)) {
      const idle =
        typeof requestIdleCallback === "function"
          ? requestIdleCallback
          : (callback: () => void) => window.setTimeout(callback, 3_000);
      idle(() => void retryAllPendingOfflineDeletions());
    }
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;

    void navigator.serviceWorker.register("/sw.js", { scope: "/" });

    return afterLaunchPaint(() => {
      if (!navigator.onLine) return;
      void navigator.serviceWorker.ready
        .then((registration) => registration.active?.postMessage({ type: "REFRESH_SHELL" }))
        .catch(() => undefined);
      warmImportChunks();
    });
  }, []);

  return null;
}
