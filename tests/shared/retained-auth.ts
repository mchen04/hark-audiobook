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
  let user: { id: string } | undefined;
  let credential: { password: string | null } | undefined;
  try {
    [user] = await sql()<{ id: string }[]>`select id from "user" where email=${RETAINED_EMAIL}`;
    if (user) {
      [credential] = await sql()<{ password: string | null }[]>`
        select password from account where user_id=${user.id} and provider_id='credential'
      `;
    }
  } catch (error) {
    throw operationFailure("database read", error);
  }
  if (!user) return undefined;
  if (!credential?.password) {
    throw new Error(
      "Disposable retained-workflows identity exists but its email/password credential is missing. " +
        "Inspect this disposable identity's provisioning; an env backup cannot repair a missing credential. " +
        "Use HARK_ENV_FILE with a separate new disposable database and matching credentials if needed. " +
        "No fixture reset was performed. Do not reset an existing database/volume or silently replace credentials.",
    );
  }
  let matches: boolean;
  try {
    matches = await verifyPassword({ hash: credential.password, password });
  } catch (error) {
    throw operationFailure("credential verification", error);
  }
  if (!matches) throw new Error(RETAINED_CREDENTIAL_DIAGNOSTIC);
  return user;
}

function operationFailure(stage: "database read" | "credential verification", error: unknown) {
  // Raw driver/crypto messages and causes can contain connection strings,
  // inputs or hashes. Retain only known diagnostic categories, never their text.
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  const knownCodes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "28P01", "3D000", "42P01"];
  const category =
    typeof code === "string" && knownCodes.includes(code)
      ? code
      : error instanceof TypeError
        ? "TypeError"
        : error instanceof RangeError
          ? "RangeError"
          : "Error";
  const action =
    stage === "database read"
      ? "Check the local test database, HARK_ENV_FILE connection and migrations."
      : "Check the test runtime and disposable credential hash format; this is not a confirmed password mismatch.";
  return new Error(
    `Disposable retained-workflows ${stage} failed (${category}). ${action} ` +
      "No fixture reset was performed. Do not reset an existing database/volume or replace credentials. " +
      "Underlying error text and credentials are omitted.",
  );
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
