import type { Metadata } from "next";

import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignOutNotice } from "@/components/auth/sign-out-notice";
import { SessionRedirect } from "@/components/auth/session-redirect";
import { getSession } from "@/server/auth-session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  const session = await getSession();
  if (session) return <SessionRedirect userId={session.user.id} />;

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Sign in to your library"
      summary="Your listening position and private books stay connected across your devices."
    >
      <SignOutNotice />
      <AuthForm mode="login" />
    </AuthShell>
  );
}
