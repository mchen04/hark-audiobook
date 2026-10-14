import type { BrowserContext, Page } from "@playwright/test";

export declare function attachSampler(context: BrowserContext): Promise<{
  begin(page: Page, target: string, leaving: string[], kind?: string): Promise<unknown>;
  end(page: Page, action: unknown): Promise<void>;
  stop(page: Page): Promise<void>;
  read(context: BrowserContext): Promise<unknown>;
}>;
export declare function frameSampler(): void;
export declare function analyzeFrames(
  recording: unknown,
): Array<{ kind: string; landmark?: string; emptyFrames?: number; emptyDurationMs?: number }>;
