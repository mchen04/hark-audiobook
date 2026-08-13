"use client";

import { useEffect, useState } from "react";

import {
  checkLemonade,
  describeLemonadeStatus,
  type LemonadeStatus,
} from "@/lib/kestrel/lemonade-status";
import { DEFAULT_LEMONADE_ORIGIN, lemonadeOrigin, setLemonadeOrigin } from "@/lib/kestrel/lemonade";

/**
 * Where this device's Lemonade lives, and whether it can actually be reached.
 *
 * Without this, a device that cannot reach Lemonade simply narrates in the page
 * and says nothing about it — which is the correct behavior but an opaque one
 * when a reader is expecting the faster engine and wondering why it is slow.
 */
export function LemonadeSettings() {
  const [origin, setOrigin] = useState(DEFAULT_LEMONADE_ORIGIN);
  const [status, setStatus] = useState<LemonadeStatus | null>(null);
  const [checking, setChecking] = useState(true);

  // The saved address is read after the first paint rather than during render,
  // so the server and client agree on the markup they produce. Checked once on
  // mount; afterwards only when the reader asks.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = lemonadeOrigin();
      const result = await checkLemonade(saved);
      if (cancelled) return;
      setOrigin(saved);
      setStatus(result);
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runCheck(target: string) {
    setChecking(true);
    try {
      setStatus(await checkLemonade(target));
    } finally {
      setChecking(false);
    }
  }

  function save(next: string) {
    setOrigin(next);
    setLemonadeOrigin(next);
  }

  return (
    <section className="settings-group" aria-labelledby="settings-lemonade-title">
      <h2 id="settings-lemonade-title">Lemonade narration</h2>
      <p className="details-hint">
        If AMD&apos;s Lemonade server is running on this machine, Hark narrates documents through it
        instead of in the browser — the same voice, on this device&apos;s own hardware. Without it,
        narration falls back to the browser engine. This address is remembered on this device only.
      </p>

      <label className="lemonade-field">
        <span>Server address</span>
        <input
          type="url"
          inputMode="url"
          spellCheck={false}
          value={origin}
          placeholder={DEFAULT_LEMONADE_ORIGIN}
          onChange={(event) => save(event.target.value)}
          aria-describedby="settings-lemonade-status"
        />
      </label>

      <div className="lemonade-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void runCheck(origin)}
          disabled={checking}
        >
          {checking ? "Checking…" : "Check connection"}
        </button>
        {origin !== DEFAULT_LEMONADE_ORIGIN && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              save(DEFAULT_LEMONADE_ORIGIN);
              void runCheck(DEFAULT_LEMONADE_ORIGIN);
            }}
          >
            Reset to default
          </button>
        )}
      </div>

      <p
        id="settings-lemonade-status"
        className={`lemonade-status lemonade-status-${status?.kind ?? "unknown"}`}
        role="status"
        aria-live="polite"
      >
        {status ? describeLemonadeStatus(status) : "Checking this device…"}
      </p>
    </section>
  );
}
