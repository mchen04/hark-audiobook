"use client";

import { ArrowLeft, Play, SpeakerHigh, WaveSine } from "@phosphor-icons/react";
import Link from "next/link";
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
 * It reads from the same import the library shows, because that import lives
 * outside React and survives the navigation that brought you here. There is no
 * scrubbing and no chapter list: the audio past this moment does not exist yet.
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
    <section className="narrating-page" aria-labelledby="narrating-title">
      <Link href="/library" className="secondary-button narrating-back">
        <ArrowLeft size={17} aria-hidden="true" />
        Library
      </Link>

      <div className="narrating-art" aria-hidden="true">
        {upload.listening ? (
          <SpeakerHigh size={54} weight="fill" />
        ) : (
          <WaveSine size={54} weight="duotone" />
        )}
      </div>

      <h1 id="narrating-title">{upload.title}</h1>
      <p className="narrating-stage">{upload.stage}</p>

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

      <p className="narrating-note">
        This book is still being narrated on this device. Chapters, scrubbing and your saved
        position arrive when it finishes — you can leave this screen and it keeps going.
      </p>
    </section>
  );
}
