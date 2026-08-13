import { DEFAULT_LEMONADE_ORIGIN, LEMONADE_MODEL_ID, lemonadeOrigin } from "./lemonade";

export type LemonadeStatus =
  | { kind: "ready"; origin: string }
  | { kind: "model-missing"; origin: string }
  | { kind: "unreachable"; origin: string }
  | { kind: "blocked-by-https"; origin: string }
  | { kind: "bad-origin"; origin: string };

/**
 * Browsers refuse a loopback request from a page served over HTTPS: Chromium
 * fails it outright (`net::ERR_FAILED`) and WebKit does the same, because
 * Private Network Access wants a preflight header Lemonade does not send.
 *
 * This is worth detecting rather than reporting as "unreachable", because the
 * fix is completely different — the user has to run Hark locally, and no amount
 * of correcting the port will help.
 */
export function loopbackBlockedByHttps(origin: string, pageProtocol: string): boolean {
  if (pageProtocol !== "https:") return false;
  try {
    return new URL(origin).protocol === "http:";
  } catch {
    return false;
  }
}

/** What Settings shows about this device's Lemonade, with the reason it says it. */
export async function checkLemonade(
  origin = lemonadeOrigin(),
  pageProtocol = window.location.protocol,
): Promise<LemonadeStatus> {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { kind: "bad-origin", origin };
  }
  if (loopbackBlockedByHttps(origin, pageProtocol)) {
    return { kind: "blocked-by-https", origin };
  }
  try {
    const response = await fetch(`${url.origin}/api/v1/models`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return { kind: "unreachable", origin };
    const models = ((await response.json()) as { data?: unknown })?.data;
    if (!Array.isArray(models)) return { kind: "unreachable", origin };
    const kokoro = models.find((model: { id?: unknown }) => model?.id === LEMONADE_MODEL_ID) as
      { downloaded?: unknown } | undefined;
    if (!kokoro) return { kind: "model-missing", origin };
    return kokoro.downloaded === true
      ? { kind: "ready", origin }
      : { kind: "model-missing", origin };
  } catch {
    return { kind: "unreachable", origin };
  }
}

export function describeLemonadeStatus(status: LemonadeStatus): string {
  switch (status.kind) {
    case "ready":
      return "Connected. Documents on this device will be narrated by Lemonade.";
    case "model-missing":
      return `Lemonade answered, but the voice is not downloaded. Run "lemonade pull ${LEMONADE_MODEL_ID}".`;
    case "blocked-by-https":
      return "Your browser blocks this page from reaching a server on your own machine, because the page is served over HTTPS. Run Hark locally to narrate through Lemonade.";
    case "bad-origin":
      return `That is not a valid address. Use something like ${DEFAULT_LEMONADE_ORIGIN}.`;
    case "unreachable":
      return "Nothing answered there. Start Lemonade, or check the port it is listening on.";
  }
}
