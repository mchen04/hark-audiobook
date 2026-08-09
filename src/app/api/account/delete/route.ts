import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/server/auth";
import { db } from "@/server/db/client";
import { user, verification } from "@/server/db/schema";
import { isTrustedMutationOrigin } from "@/server/security/request-origin";

export const runtime = "nodejs";

const prepareSchema = z.object({
  phase: z.literal("prepare"),
  confirmEmail: z.string().trim().min(3).max(320),
  currentPassword: z.string().min(12).max(128),
});
const commitSchema = z.object({
  phase: z.literal("commit"),
  userId: z.string().min(1).max(200),
  deleteToken: z.string().min(32).max(200),
});
const deleteSchema = z.discriminatedUnion("phase", [prepareSchema, commitSchema]);
const DELETE_INTENT_MS = 24 * 60 * 60 * 1_000;

/**
 * Two phases make the irreversible boundary recoverable:
 *
 *  1. an authenticated password check issues a short-lived bearer intent;
 *  2. the device journals that intent, purges itself, then commits deletion.
 *
 * The commit is idempotent and the token remains usable after the user/session
 * rows are gone. If the successful HTTP response is lost, the device retries
 * instead of retaining a deleted account's mirror forever.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedMutationOrigin(request)) {
    return Response.json({ error: "Untrusted request origin." }, { status: 403 });
  }
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Invalid deletion request." }, { status: 400 });
  return parsed.data.phase === "prepare"
    ? prepareDeletion(request, parsed.data)
    : commitDeletion(parsed.data);
}

async function prepareDeletion(
  request: Request,
  data: z.infer<typeof prepareSchema>,
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (data.confirmEmail.toLowerCase() !== session.user.email.toLowerCase()) {
    return Response.json(
      { error: "Type your account email exactly to confirm deletion." },
      { status: 400 },
    );
  }
  try {
    await auth.api.verifyPassword({
      headers: request.headers,
      body: { password: data.currentPassword },
    });
  } catch {
    return Response.json({ error: "The current password is incorrect." }, { status: 403 });
  }

  const deleteToken = randomBytes(32).toString("base64url");
  const id = intentId(session.user.id);
  const expiresAt = new Date(Date.now() + DELETE_INTENT_MS);
  await db
    .insert(verification)
    .values({
      id,
      identifier: id,
      value: intentValue(deleteToken, "prepared"),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: verification.id,
      set: {
        value: intentValue(deleteToken, "prepared"),
        expiresAt,
        updatedAt: new Date(),
      },
    });
  return Response.json({ deleteToken });
}

async function commitDeletion(data: z.infer<typeof commitSchema>): Promise<Response> {
  const id = intentId(data.userId);
  const prepared = intentValue(data.deleteToken, "prepared");
  const deleted = intentValue(data.deleteToken, "deleted");
  const now = new Date();
  const committed = await db.transaction(async (transaction) => {
    const [claimed] = await transaction
      .update(verification)
      .set({ value: deleted, updatedAt: now })
      .where(
        and(
          eq(verification.id, id),
          eq(verification.value, prepared),
          gt(verification.expiresAt, now),
        ),
      )
      .returning({ id: verification.id });
    if (claimed) {
      await transaction.delete(user).where(eq(user.id, data.userId));
      return true;
    }
    const [existing] = await transaction
      .select({ value: verification.value, expiresAt: verification.expiresAt })
      .from(verification)
      .where(eq(verification.id, id))
      .limit(1);
    return !!existing && existing.expiresAt > now && existing.value === deleted;
  });
  if (!committed) {
    return Response.json({ error: "Deletion intent is invalid or expired." }, { status: 410 });
  }
  return Response.json(
    { deleted: true },
    {
      status: 200,
      headers: {
        "Set-Cookie": "chapterline.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
      },
    },
  );
}

function intentId(userId: string): string {
  return `account-delete:${userId}`;
}

function intentValue(token: string, status: "prepared" | "deleted"): string {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return JSON.stringify({ status, tokenHash });
}
