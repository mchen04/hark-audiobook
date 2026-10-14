import type { BrowserContext } from "@playwright/test";

export declare function checkPlayback(
  context: BrowserContext,
  origin: string,
  report: Record<string, unknown>,
): Promise<Record<string, unknown>>;
