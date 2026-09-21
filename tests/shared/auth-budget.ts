/** Match src/server/auth.ts. Read the real bucket; never reset or reserve it. */
const RULES = {
  "sign-in": { max: 8, windowMs: 60_000 },
  "sign-up": { max: 5, windowMs: 600_000 },
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
  for (;;) {
    const bucket = await readBucket();
    if (!bucket || bucket.count < rule.max) return;
    const remaining = bucket.lastRequest + rule.windowMs - Date.now();
    if (remaining <= 0) return;
    const waitMs = remaining + 100;
    onWait(waitMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
