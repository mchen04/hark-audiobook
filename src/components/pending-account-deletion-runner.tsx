"use client";

import { useEffect } from "react";

import { finishPendingAccountDeletion } from "@/lib/account-deletion";

/** Resumes the prepared → local purge → server commit journal after a crash. */
export function PendingAccountDeletionRunner() {
  useEffect(() => {
    let mounted = true;
    const finish = () => {
      void finishPendingAccountDeletion().then((result) => {
        if (mounted && result?.ok) window.location.replace("/register");
      });
    };
    finish();
    window.addEventListener("online", finish);
    return () => {
      mounted = false;
      window.removeEventListener("online", finish);
    };
  }, []);
  return null;
}
