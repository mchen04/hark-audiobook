import { describe, expect, it } from "vitest";

import { isLoginRscAccessControlError } from "./login-rsc-error";

const origin = "http://localhost:3000";
const request = `${origin}/login?_rsc=PP2lNEZrbmDZ-RSK`;
const script = `${origin}/_next/static/chunks/1popd3lb49orp.js`;
const message = (url: string) => `Fetch API cannot load ${url} due to access control checks.`;
const error = (url = request, source = script, frame = "T") =>
  `${message(url)}\n    at ${frame} (${source}:1:99510)`;

describe("known login RSC access-control error", () => {
  it.each([
    error(request, `${origin}/_next/static/chunks/12czkog7d-pir.js`).replace("99510", "99505"),
    `Fetch API cannot load http: /localhost:3000/login?_rsc=PP2lNEZrbmDZ-RSK due to access control checks.\n${error()}`,
    error().replace(":1:99510", ":8:24"),
    error(request, script, "fetchServerResponse"),
    `${message(request)}\n    at ${script}:2:300`,
    error(request, `${origin}/_next/static/chunks/app/login/page.js`),
  ])("accepts a login RSC failure independent of build output: %s", (value) => {
    expect(isLoginRscAccessControlError(value, origin)).toBe(true);
  });

  it.each([
    error("http://elsewhere.test/login?_rsc=value"),
    error("http://localhost:3001/login?_rsc=value"),
    error(`${origin}/api/sync/pull?_rsc=value`),
    error(`${origin}/settings?_rsc=value`),
    error(`${origin}/login`),
    error(`${origin}/login?_rsc=`),
    error(`${origin}/login?_rsc2=value`),
    error().replace("due to access control checks.", "because the connection was lost."),
    error(request, "http://elsewhere.test/_next/static/chunks/1popd3lb49orp.js"),
    error(request, "http://localhost:3001/_next/static/chunks/1popd3lb49orp.js"),
    error(request, `${origin}/scripts/client.js`),
    error(request, `${origin}/_next/static/chunks/client.css`),
    `${message(request)}\n    at fail (${origin}/scripts/client.js:1:3)\n    at T (${script}:1:99510)`,
    message(request),
    error("not-a-url"),
    error(request, "not-a-url"),
    `TypeError: unrelated failure\n    at T (${script}:1:99510)`,
  ])("retains other page errors: %s", (value) => {
    expect(isLoginRscAccessControlError(value, origin)).toBe(false);
  });
});
