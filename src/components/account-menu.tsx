"use client";

import { GearSix, SignOut } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

type AccountMenuProps = {
  email: string;
};

/**
 * Sign-out does NOT clear `chapterline:active-user` here.
 *
 * That key is the only record of which account this device belongs to, and the
 * purge in `auth-client.ts` reads it to know whose data to remove. Clearing it
 * from the call site raced the purge — and won — leaving the departing
 * account's library, downloads and outbox on the device under the next user's
 * session. The purge owns the key now and removes it as part of the sweep.
 */
export function AccountMenu({ email }: AccountMenuProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    // Resolves only once the sweep has finished: `authClient` awaits it on the
    // sign-out path, so nothing below can run while this account's data is
    // still on the device.
    await authClient.signOut();
    leave();
  }

  function leave() {
    router.replace("/login");
  }

  return (
    <div className="account-menu">
      <span title={email}>{email}</span>
      <Link href="/settings" className="icon-text-button" prefetch={false}>
        <GearSix size={19} aria-hidden="true" />
        <span>Settings</span>
      </Link>
      <button type="button" className="icon-text-button" onClick={signOut} disabled={pending}>
        <SignOut size={19} aria-hidden="true" />
        <span>{pending ? "Signing out" : "Sign out"}</span>
      </button>
    </div>
  );
}
