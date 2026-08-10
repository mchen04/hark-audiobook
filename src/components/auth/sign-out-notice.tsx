"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  describeSignOutReport,
  peekSignOutReport,
  takeSignOutReport,
  type SignOutReport,
} from "@/lib/auth-client";

/** The login page survives the account provider being revoked mid-sign-out. */
export function SignOutNotice() {
  const report = useSyncExternalStore(subscribeToNoUpdates, peekSignOutReport, serverSignOutReport);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (report) takeSignOutReport();
  }, [report]);

  const message = report && !dismissed ? describeSignOutReport(report) : null;
  if (!message) return null;
  return (
    <div className="sign-out-notice">
      <p role="alert" className="form-error">
        {message}
      </p>
      <button type="button" className="secondary-button" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}

function subscribeToNoUpdates(): () => void {
  return () => undefined;
}

function serverSignOutReport(): SignOutReport | null {
  return null;
}
