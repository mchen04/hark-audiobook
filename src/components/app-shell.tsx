"use client";

import { ReactNode, Suspense } from "react";
import { DownloadSimple, GearSix } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { AccountMenu } from "@/components/account-menu";
import { AppNavigation } from "@/components/app-navigation";
import { BrandMark } from "@/components/brand-mark";
import { LibraryClient } from "@/components/library/library-client";
import { LibraryViewProvider } from "@/components/library/library-view-state";
import { MiniPlayer } from "@/components/player/mini-player";
import { PlaybackProvider } from "@/components/player/playback-provider";
import { PreferencesProvider } from "@/components/player/preferences-provider";
import { useActiveUserId } from "@/components/use-active-user";

/**
 * The one chrome the app has. A server-rendered page passes the session it
 * already loaded; a warm launch served from Cache Storage has no session in
 * hand, so the shell resolves the device's active user and shows the
 * account-agnostic header — the same chrome, minus what only the server knows.
 */
export function AppShell({
  userId: serverUserId,
  email,
  children,
}: {
  userId?: string;
  email?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const userId = useActiveUserId(serverUserId);
  // The player brings its own topbar with a back button; on phones the
  // global header would just duplicate chrome above it.
  const onPlayerPage = pathname.startsWith("/books/");
  const header = <AppHeader email={userId ? email : undefined} collapsible={onPlayerPage} />;

  // The device has not answered with its active user yet. Everything in the
  // header above is account-agnostic, so it is rendered now rather than a beat
  // later: a warm launch is served from Cache Storage, where the alternative is
  // a genuinely empty page whose chrome pops in once storage has been read —
  // the header appearing to come and go with the connection.
  if (!userId) return <main className="app-page">{header}</main>;

  // The shell owns the library view instead of asking the router for another
  // document. This makes leaving a player a local URL transition: the one
  // PlaybackProvider stays mounted even when the network disappears between
  // opening the book and tapping Library. A cached anonymous shell also uses
  // this path to answer an offline `/books/:id` navigation from IndexedDB.
  const showLocalLibrary = pathname === "/library" || (!serverUserId && onPlayerPage);
  const route = showLocalLibrary ? (
    <Suspense>
      <LibraryClient userId={userId} />
    </Suspense>
  ) : (
    children
  );

  return (
    <PreferencesProvider userId={userId}>
      <PlaybackProvider userId={userId}>
        <LibraryViewProvider userId={userId}>
          <AppNavigation pathname={pathname}>
            <main className="app-page">
              {header}
              {route}
            </main>
            <MiniPlayer />
          </AppNavigation>
        </LibraryViewProvider>
      </PlaybackProvider>
    </PreferencesProvider>
  );
}

function AppHeader({ email, collapsible }: { email?: string; collapsible: boolean }) {
  return (
    <header className={`app-header ${collapsible ? "app-header-collapsible" : ""}`}>
      <BrandMark />
      {/* These links do not prefetch: speculatively fetching /settings and
          a second copy of /library on every launch puts server round trips
          and their session lookups back on the launch path for screens
          nobody asked for. */}
      <div className="app-actions">
        {/* Downloads is a facet of the library now, not a screen of its own. */}
        <Link href="/library?device=1" className="icon-text-button" prefetch={false}>
          <DownloadSimple size={19} aria-hidden="true" />
          <span>Downloads</span>
        </Link>
        {email ? (
          <AccountMenu email={email} />
        ) : (
          <Link href="/settings" className="icon-text-button" prefetch={false}>
            <GearSix size={19} aria-hidden="true" />
            <span>Settings</span>
          </Link>
        )}
      </div>
    </header>
  );
}
