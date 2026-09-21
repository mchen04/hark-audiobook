import { verifyPassword } from "better-auth/crypto";
import { sql } from "../sync/harness/app";
import { awaitAuthBudget, type AuthOperation } from "./auth-budget";
import { TEST_CLIENT_HEADERS } from "./test-client-ip";

export const RETAINED_EMAIL = "retained-workflows@hark.test";
export const RETAINED_CREDENTIAL_DIAGNOSTIC =
  "Disposable retained-workflows fixture credential mismatch: .env.test's " +
  "HARK_TEST_ACCOUNT_PASSWORD does not match the retained test database. " +
  "Restore the matching .env.test backup, or use HARK_ENV_FILE with a separate new " +
  "disposable database and its matching credentials. No fixture reset was performed. " +
  "Do not reset an existing database/volume. Passwords and hashes are omitted.";

/** Read-only, restricted to this disposable identity, before any content reset. */
export async function findRetainedAccount(password: string): Promise<{ id: string } | undefined> {
  const [user] = await sql()<{ id: string }[]>`select id from "user" where email=${RETAINED_EMAIL}`;
  if (!user) return undefined;
  const [credential] = await sql()<{ password: string | null }[]>`
    select password from account where user_id=${user.id} and provider_id='credential'
  `;
  const matches = credential?.password
    ? await verifyPassword({ hash: credential.password, password }).catch(() => false)
    : false;
  if (!matches) throw new Error(RETAINED_CREDENTIAL_DIAGNOSTIC);
  return user;
}

export async function awaitRetainedAuthBudget(
  operation: AuthOperation,
  onWait: (milliseconds: number) => void,
): Promise<void> {
  const key = `${TEST_CLIENT_HEADERS.retained["x-forwarded-for"]}|/${operation}/email`;
  await awaitAuthBudget(
    operation,
    async () => {
      const [row] = await sql()<{ count: number; last_request: string }[]>`
      select count, last_request from rate_limit where key=${key}
    `;
      return row ? { count: row.count, lastRequest: Number(row.last_request) } : undefined;
    },
    onWait,
  );
}
