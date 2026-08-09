import { expect, test } from "@playwright/test";

import { origin, sql } from "./harness/app";

/**
 * The limiter's database row is the cross-process contract. An HTTP-only test
 * can see one process reject its ninth attempt while the implementation still
 * uses a private Map that every other process starts empty. Reading the shared
 * row proves the attempt budget lives where a second instance will find it.
 */
test("authentication attempts are consumed atomically in shared database storage", async ({
  request,
}) => {
  const ip = "198.51.100.77";
  const key = `${ip}|/sign-in/email`;
  const baseUrl = await origin();
  await sql()`DELETE FROM rate_limit WHERE key = ${key}`;
  try {
    const attempt = () =>
      request.post(`${baseUrl}/api/auth/sign-in/email`, {
        headers: { "x-forwarded-for": ip },
        data: { email: "rate-limit-probe@hark.test", password: "deliberately-wrong" },
      });

    const first = await attempt();
    expect(first.status()).toBe(401);
    await expect
      .poll(async () => {
        const [row] = await sql()<{ count: number }[]>`
          SELECT count FROM rate_limit WHERE key = ${key}
        `;
        return row?.count ?? 0;
      })
      .toBe(1);

    const burst = await Promise.all(Array.from({ length: 8 }, attempt));
    expect(burst.filter((response) => response.status() === 429)).toHaveLength(1);
    const [row] = await sql()<{ count: number }[]>`
      SELECT count FROM rate_limit WHERE key = ${key}
    `;
    expect(row?.count).toBe(8);
  } finally {
    await sql()`DELETE FROM rate_limit WHERE key = ${key}`;
  }
});
