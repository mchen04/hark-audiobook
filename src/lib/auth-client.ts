"use client";

import { createAuthClient } from "better-auth/react";

import {
  clearAccountSignOutFence,
  commitAccountSignOutFence,
  installAccountSignOutFence,
  reopenAccountAfterSignIn,
} from "@/lib/account-deletion-fence";
import { ACTIVE_USER_KEY, SIGN_OUT_REPORT_KEY } from "@/lib/app-keys";
import type { UndeliveredWrite } from "@/lib/offline/account-purge";

type AuthSuccessContext = {
  request?: { url?: string | URL };
  data?: unknown;
};

type AuthRequestContext = {
  url?: string | URL;
  method?: string;
};

export type SignOutReport = {
  undelivered: UndeliveredWrite[];
  purgeFailed: boolean;
};

function pathOf(context: AuthSuccessContext | AuthRequestContext): string {
  const url = "request" in context ? context.request?.url : (context as AuthRequestContext).url;
  if (!url) return "";
  try {
    return new URL(url, "https://placeholder.invalid").pathname;
  } catch {
    return "";
  }
}

function isSignOut(path: string): boolean {
  return path.endsWith("/sign-out");
}

function signedInUserId(data: unknown): string | null {
  const user = (data as { user?: { id?: unknown } } | null)?.user;
  return typeof user?.id === "string" ? user.id : null;
}

let signOutDrain: { ran: boolean; undelivered: UndeliveredWrite[] } = {
  ran: false,
  undelivered: [],
};
let signOutUserId: string | null = null;
let signOutReport: SignOutReport | null = null;
let storedSignOutReportRaw: string | null = null;
let storedSignOutReport: SignOutReport | null = null;
let purgeInFlight: Promise<void> = Promise.resolve();
let purgeGate: Promise<void> = Promise.resolve();

export const SIGN_IN_PURGE_TIMEOUT_MS = 5_000;

function bounded(work: Promise<void>, timeoutMs: number): Promise<void> {
  let expire: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    expire = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([work, bound]).finally(() => clearTimeout(expire));
}

export function takeSignOutReport(): SignOutReport | null {
  const report = peekSignOutReport();
  signOutReport = null;
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(SIGN_OUT_REPORT_KEY);
  storedSignOutReportRaw = null;
  storedSignOutReport = null;
  return report;
}

export function peekSignOutReport(): SignOutReport | null {
  return signOutReport ?? readStoredSignOutReport();
}

function rememberSignOutReport(report: SignOutReport): void {
  signOutReport = report;
  if (typeof sessionStorage === "undefined") return;
  if (report.undelivered.length > 0 || report.purgeFailed) {
    const raw = JSON.stringify(report);
    sessionStorage.setItem(SIGN_OUT_REPORT_KEY, raw);
    storedSignOutReportRaw = raw;
    storedSignOutReport = report;
  } else {
    sessionStorage.removeItem(SIGN_OUT_REPORT_KEY);
    storedSignOutReportRaw = null;
    storedSignOutReport = null;
  }
}

function readStoredSignOutReport(): SignOutReport | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SIGN_OUT_REPORT_KEY);
    if (raw === storedSignOutReportRaw) return storedSignOutReport;
    const value = JSON.parse(raw || "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<SignOutReport>;
    if (!Array.isArray(candidate.undelivered) || typeof candidate.purgeFailed !== "boolean") {
      return null;
    }
    storedSignOutReportRaw = raw;
    storedSignOutReport = candidate as SignOutReport;
    return storedSignOutReport;
  } catch {
    storedSignOutReportRaw = null;
    storedSignOutReport = null;
    return null;
  }
}

export function describeSignOutReport(report: SignOutReport): string | null {
  if (report.undelivered.length > 0) {
    return `${report.undelivered.length} ${report.undelivered.length === 1 ? "change" : "changes"} you made on this device (${describeKinds(report.undelivered)}) could not be sent to the server before signing out, and signing out removes this account's data from this device. ${report.undelivered.length === 1 ? "It is" : "They are"} gone.`;
  }
  return report.purgeFailed
    ? "Some of this account's data could not be removed from this device. It will be removed the next time an account signs in here."
    : null;
}

function describeKinds(undelivered: SignOutReport["undelivered"]): string {
  const counts = new Map<string, number>();
  for (const write of undelivered) counts.set(write.kind, (counts.get(write.kind) || 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
}

export function whenAccountPurgeSettled(): Promise<void> {
  return purgeInFlight;
}

export function whenAccountPurgeGateOpen(): Promise<void> {
  return purgeGate;
}

async function runSignOutDrain(context: AuthRequestContext): Promise<void> {
  if (typeof window === "undefined") return;
  if (!isSignOut(pathOf(context))) return;
  signOutDrain = { ran: false, undelivered: [] };
  const userId = localStorage.getItem(ACTIVE_USER_KEY);
  if (!userId) return;
  signOutUserId = userId;
  try {
    const purge = await import("@/lib/offline/account-purge");
    signOutDrain = { ran: true, undelivered: await purge.drainBeforeSignOut(userId) };
  } finally {
    installAccountSignOutFence(userId);
  }
}

export async function runAccountPurge(context: AuthSuccessContext): Promise<void> {
  if (typeof window === "undefined") return;
  const path = pathOf(context);
  if (!path) return;

  if (isSignOut(path)) {
    const userId = signOutUserId ?? localStorage.getItem(ACTIVE_USER_KEY);
    signOutUserId = null;
    const drain = signOutDrain;
    signOutDrain = { ran: false, undelivered: [] };
    if (userId) commitAccountSignOutFence();
    const purge = await import("@/lib/offline/account-purge");
    if (!userId) {
      rememberSignOutReport({ undelivered: drain.undelivered, purgeFailed: false });
      await purge.purgeCachedPages();
      return;
    }
    const outcome = await purge.purgeOnSignOut(
      userId,
      drain.ran ? { alreadyDrained: drain.undelivered } : {},
    );
    rememberSignOutReport({
      undelivered: outcome.undelivered,
      purgeFailed: !!outcome.failure,
    });
    if (outcome.failure) throw outcome.failure;
    return;
  }

  if (path.includes("/sign-in") || path.includes("/sign-up")) {
    const userId = signedInUserId(context.data);
    if (userId) {
      await reopenAccountAfterSignIn(userId);
      const purge = await import("@/lib/offline/account-purge");
      await purge.purgeOnSignIn(userId);
    }
  }
}

export const authFetchHooks = {
  onRequest: async (context: AuthRequestContext) => {
    await runSignOutDrain(context).catch(() => undefined);
  },
  onSuccess: async (context: AuthSuccessContext) => {
    purgeInFlight = runAccountPurge(context).catch(() => undefined);
    purgeGate = isSignOut(pathOf(context))
      ? purgeInFlight
      : bounded(purgeInFlight, SIGN_IN_PURGE_TIMEOUT_MS);
    await purgeGate;
  },
  onError: async (context: AuthSuccessContext) => {
    if (!isSignOut(pathOf(context))) return;
    const userId = signOutUserId ?? localStorage.getItem(ACTIVE_USER_KEY);
    signOutUserId = null;
    signOutDrain = { ran: false, undelivered: [] };
    if (userId) clearAccountSignOutFence(userId);
  },
};

export const authClient = createAuthClient({ fetchOptions: authFetchHooks });
