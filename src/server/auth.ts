import "server-only";

import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "@/server/db/client";
import { schema } from "@/server/db/schema";
import { env } from "@/server/env";
import { createDatabaseRateLimitStorage } from "@/server/auth-rate-limit-storage";
import {
  assertPasswordResetDeliveryConfigured,
  sendPasswordReset,
} from "@/server/mail/password-reset";

assertPasswordResetDeliveryConfigured();

const authRateLimitRules = {
  "/sign-in/email": { window: 60, max: 8 },
  "/sign-up/email": { window: 60 * 10, max: 5 },
  "/request-password-reset": { window: 60 * 10, max: 5 },
} as const;
const authRateLimitWindow = 60;
const authRateLimitRetention = Math.max(
  authRateLimitWindow,
  ...Object.values(authRateLimitRules).map((rule) => rule.window),
);

export const auth = betterAuth({
  appName: "Hark",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 30 * 60,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordReset(user.email, url);
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    enabled: true,
    customStorage: createDatabaseRateLimitStorage(authRateLimitRetention),
    window: authRateLimitWindow,
    max: 100,
    customRules: authRateLimitRules,
  },
  advanced: {
    cookiePrefix: "chapterline",
    useSecureCookies: new URL(env.BETTER_AUTH_URL).protocol === "https:",
  },
  trustedOrigins: [env.BETTER_AUTH_URL],
});
