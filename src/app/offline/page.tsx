import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import { LibraryClient } from "@/components/library/library-client";
import { OfflineRedirect } from "@/components/offline-redirect";

export const metadata: Metadata = { title: "Library" };

export default function OfflinePage() {
  return (
    <AppShell>
      <OfflineRedirect />
      <Suspense>
        <LibraryClient />
      </Suspense>
    </AppShell>
  );
}
