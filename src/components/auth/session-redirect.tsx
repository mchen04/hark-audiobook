"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useActiveUserId } from "@/components/use-active-user";

export function SessionRedirect({ userId }: { userId: string }) {
  const activeUserId = useActiveUserId(userId);
  const router = useRouter();

  useEffect(() => {
    if (activeUserId === userId) router.replace("/library");
  }, [activeUserId, router, userId]);

  return (
    <main className="auth-page">
      <p role="status">Opening your library…</p>
    </main>
  );
}
