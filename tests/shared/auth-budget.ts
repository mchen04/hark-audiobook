/** Match src/server/auth.ts. Read the real bucket; never reset or reserve it. */
const RULES = {
  "sign-in": { max: 8, headroom: 2, windowMs: 60_000 },
  "sign-up": { max: 5, headroom: 1, windowMs: 600_000 },
};
export type AuthOperation = keyof typeof RULES;
export type AuthBucket = { count: number; lastRequest: number } | undefined;

/** Single-worker suites own their stable IP. Recheck after every idle wait. */
export async function awaitAuthBudget(
  operation: AuthOperation,
  readBucket: () => Promise<AuthBucket>,
  onWait: (milliseconds: number) => void,
): Promise<void> {
  const rule = RULES[operation];
  const slackMs = 1_500;
  let waitedMs = 0;
  let waits = 0;
  for (;;) {
    const bucket = await readBucket();
    if (!bucket || bucket.count < rule.max - rule.headroom) return;
    const remaining = bucket.lastRequest + rule.windowMs - Date.now();
    if (remaining <= 0) return;
    const waitMs = remaining + slackMs;
    if (waits >= 2 || waitedMs + waitMs > rule.windowMs + slackMs) {
      throw new Error(
        `Auth ${operation} budget wait limit exceeded: the stable test IP is still busy or its clock is inconsistent. ` +
          "Run suites serially and inspect the retained rate_limit row and server clock. " +
          "Do not clear the bucket, rotate IPs or disable rate limits.",
      );
    }
    waitedMs += waitMs;
    waits += 1;
    onWait(waitMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
