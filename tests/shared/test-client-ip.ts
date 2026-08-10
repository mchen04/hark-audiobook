/**
 * Stable TEST-NET-2 addresses keep independent browser projects in independent
 * auth-rate-limit buckets while preserving the real limiter inside each suite.
 * They are documentation-only addresses and can never name an external host.
 */
export const TEST_CLIENT_HEADERS = {
  iphone: { "x-forwarded-for": "198.51.100.101" },
  parity: { "x-forwarded-for": "198.51.100.102" },
  sync: { "x-forwarded-for": "198.51.100.103" },
  resume: { "x-forwarded-for": "198.51.100.104" },
  launch: { "x-forwarded-for": "198.51.100.105" },
} as const;
