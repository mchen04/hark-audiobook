"use client";

import { useEffect } from "react";

export function OfflineRedirect() {
  useEffect(() => {
    if (window.location.pathname === "/offline") {
      window.history.replaceState(null, "", "/library");
    }
  }, []);

  return null;
}
