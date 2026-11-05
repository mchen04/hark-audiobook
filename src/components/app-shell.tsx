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
  const onPlayerPage = pathname.startsWith("/books/");
  const header = <AppHeader email={userId ? email : undefined} collapsible={onPlayerPage} />;

  if (!userId) return <main className="app-page">{header}</main>;

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
      <div className="app-actions">
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
