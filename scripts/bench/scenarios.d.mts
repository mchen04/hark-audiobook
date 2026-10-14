import type { BrowserContext } from "@playwright/test";

export declare const scenarioNames: string[];
export declare function recordScenarios(options: {
  origin: string;
  directory?: string;
  output: string;
  names?: string[];
  context?: BrowserContext;
}): Promise<{
  scenarios: Array<{
    name: string;
    failure: string | null;
    errors: string[];
    events: unknown[];
    frameCount: number;
    falseEmptyFrames: number;
    falseEmptyMs: number;
  }>;
  events: unknown[];
}>;
