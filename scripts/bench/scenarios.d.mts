export declare const scenarioNames: string[];
export declare function recordScenarios(options: {
  origin: string;
  directory?: string;
  output: string;
  names?: string[];
}): Promise<{
  scenarios: Array<{
    name: string;
    failure: string | null;
    errors: string[];
    events: unknown[];
    frameCount: number;
    falseEmptyFrames: number;
    falseEmptyMs: number;
    video: string | null;
  }>;
  events: unknown[];
}>;
