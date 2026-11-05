import type { Metadata } from "next";

import { requireSession } from "@/server/auth-session";

export const metadata: Metadata = { title: "Library" };

export default async function LibraryPage() {
  await requireSession();
  return null;
}
