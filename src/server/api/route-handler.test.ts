import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: async () => ({ user: { id: "fixture-user" } }) } },
}));
vi.mock("@/server/security/request-origin", () => ({ isTrustedMutationOrigin: () => true }));

import { SyncBusyError } from "@/server/db/sync-receipt";
import { withMutation } from "./route-handler";

it("turns only busy account admission into a retryable, credential-free response", async () => {
  const route = withMutation(async () => {
    throw new SyncBusyError();
  });
  const response = await route(new Request("http://localhost/api/books/local", { method: "POST" }));
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toEqual({ error: "Account sync is busy. Retry shortly." });
});

it("does not disguise unexpected errors as successful or busy writes", async () => {
  const fault = new Error("unrelated failure");
  const route = withMutation(async () => {
    throw fault;
  });
  await expect(
    route(new Request("http://localhost/api/books/local", { method: "POST" })),
  ).rejects.toBe(fault);
});
