"use client";

import { useEffect, useState } from "react";

import {
  abandonExpiredAccountDeletion,
  type AccountDeletionResult,
  finishPendingAccountDeletion,
} from "@/lib/account-deletion";
import {
  readPendingAccountDeletion,
  subscribeAccountDeletionFence,
} from "@/lib/account-deletion-fence";

/** Resumes the prepared → purge → commit → final-purge journal after a crash. */
export function PendingAccountDeletionRunner() {
  const [pending, setPending] = useState(() => readPendingAccountDeletion() !== null);
  const [result, setResult] = useState<AccountDeletionResult | null>(null);

  useEffect(() => {
    let mounted = true;
    let running = false;
    const finish = () => {
      const hasPending = readPendingAccountDeletion() !== null;
      if (mounted) setPending(hasPending);
      if (!hasPending || running) return;
      running = true;
      void finishPendingAccountDeletion()
        .then((next) => {
          if (!mounted) return;
          setResult(next);
          setPending(readPendingAccountDeletion() !== null);
          if (next?.ok) window.location.replace("/register");
        })
        .finally(() => {
          running = false;
        });
    };
    const unsubscribe = subscribeAccountDeletionFence(finish);
    finish();
    window.addEventListener("online", finish);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("online", finish);
    };
  }, []);

  if (!pending) return null;
  const expired = !result?.ok && result?.phase === "expired";
  return (
    <div className="account-deletion-overlay" role="status" aria-live="polite">
      <section>
        <p className="library-kicker">Account deletion</p>
        <h1>{result && !result.ok ? "Deletion needs attention" : "Deleting your account…"}</h1>
        <p>{deletionStatusMessage(result)}</p>
        {result && !result.ok && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              if (expired) {
                abandonExpiredAccountDeletion();
                window.location.replace("/login");
              } else {
                setResult(null);
                window.dispatchEvent(new Event("online"));
              }
            }}
          >
            {expired ? "Return to sign in" : "Try again"}
          </button>
        )}
      </section>
    </div>
  );
}

function deletionStatusMessage(result: AccountDeletionResult | null): string {
  if (!result || result.ok) {
    return "Keep Hark open while this device removes its local files and confirms deletion.";
  }
  if (result.phase === "purge") {
    return "This browser could not clear every local file. Free storage or clear Hark's website data, then try again.";
  }
  if (result.phase === "final-purge") {
    return "The account is deleted, but this browser still has local data to clear. Try again before closing Hark.";
  }
  if (result.phase === "expired") {
    return "The deletion request expired. Return to sign in, then start account deletion again.";
  }
  return "This device is cleared, but deletion could not be confirmed. Reconnect, then try again.";
}
