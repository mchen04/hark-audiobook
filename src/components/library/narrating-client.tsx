"use client";

import { ArrowLeft, Play, WaveSine } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

import {
  emptyImportSnapshot,
  importSnapshot,
  startListeningToImport,
  subscribeToImport,
} from "@/lib/document-import/import-controller";

/**
 * The book that is still being written, opened while it is being written.
 *
 * It wears the player's own layout, because it is the player screen for a book
 * that does not exist yet — a second visual language here would make a book
 * feel like a different kind of thing depending on when you opened it.
 *
 * The controls a finished book has are absent rather than disabled: there is no
 * scrubbing, no chapter list and no saved position, because the audio past this
 * moment has not been made. It reads from the same import the library shows,
 * which lives outside React and survives the navigation that brought you here.
 */
export function NarratingClient() {
  const router = useRouter();
  const upload = useSyncExternalStore(subscribeToImport, importSnapshot, emptyImportSnapshot);

  // The import finishing is the book existing. Nothing to stay here for.
  useEffect(() => {
    if (upload === null) router.replace("/library");
  }, [upload, router]);

  if (!upload) return null;

  return (
    <div className="player-page">
      <div className="player-topbar">
        <button type="button" className="icon-text-button" onClick={() => router.push("/library")}>
          <ArrowLeft size={19} aria-hidden="true" />
          <span>Library</span>
        </button>
        <span>{upload.stage}</span>
        <div className="player-topbar-actions" />
      </div>

      <div className="player-layout">
        <section className="player-main" aria-labelledby="book-title">
          <div className="player-hero">
            <div className="player-cover narrating-cover-art" aria-hidden="true">
              <WaveSine size={54} weight="duotone" />
            </div>

            <div className="player-book-copy">
              <h1 id="book-title">{upload.title}</h1>
              <p>Narrating on this device</p>
            </div>
          </div>

          <div className="narrating-scrubber">
            <div
              className="narrating-bar"
              role="progressbar"
              aria-valuenow={upload.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Narrating ${upload.title}`}
            >
              <span style={{ width: `${upload.percent}%` }} />
            </div>
            <div className="narrating-scrubber-legend">
              <span>{upload.percent}% narrated</span>
              <span>{upload.listening ? "Playing live" : "Not playing"}</span>
            </div>
          </div>

          <div className="narrating-transport">
            {upload.narrated ? (
              upload.listening ? (
                <p className="narrating-live">Playing as it is narrated</p>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  onClick={startListeningToImport}
                  disabled={!upload.canListen}
                >
                  <Play size={20} weight="fill" aria-hidden="true" />
                  <span>{upload.canListen ? "Listen now" : "Narrating…"}</span>
                </button>
              )
            ) : null}
          </div>

          <p className="narrating-note">
            Chapters, scrubbing and your saved position arrive when narration finishes. You can
            leave this screen and it keeps going.
          </p>
        </section>
      </div>
    </div>
  );
}
