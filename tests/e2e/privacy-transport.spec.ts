import { expect, test } from "@playwright/test";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";

async function loopback(listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("cross-origin privacy controls expose browser capture gaps against actual loopback wire traffic", async ({
  page,
  context,
}, info) => {
  const wire: Array<{ url: string; body: string }> = [];
  const browser: Array<{ url: string; body: string | null }> = [];
  const sink = await loopback((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      wire.push({ url: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "access-control-allow-origin": "*" });
      response.end("ok");
    });
  });
  const fixture = await loopback((request, response) => {
    if (request.url === "/privacy-sw.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(`
        self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
        self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
        self.addEventListener("message", event => event.waitUntil(
          fetch(event.data.url, { method: "POST", body: event.data.body })
            .then(() => event.ports[0].postMessage("sent"))
        ));
      `);
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Disposable privacy transport fixture</title>");
    }
  });
  context.on("request", (request) => {
    if (request.url().startsWith(sink.origin + "/")) {
      browser.push({
        url: request.url(),
        body: request.postDataBuffer()?.toString("utf8") ?? null,
      });
    }
  });
  try {
    await page.goto(fixture.origin);
    await page.evaluate(async (sinkOrigin) => {
      const control = (kind: string) => `${sinkOrigin}/${kind}`;
      await fetch(`${control("url")}?text=${encodeURIComponent("cross origin url sentinel")}`);
      const form = new FormData();
      form.append("sentinel", "cross-origin-multipart");
      for (const [kind, body] of [
        ["json", JSON.stringify({ sentinel: "cross-origin-json" })],
        ["string", "cross-origin-string"],
        ["blob", new Blob(["cross-origin-blob"])],
        ["multipart", form],
      ] as const) {
        await fetch(control(kind), { method: "POST", body });
      }
      if (!navigator.sendBeacon(control("beacon"), "cross-origin-beacon"))
        throw new Error("Beacon not queued");
      await navigator.serviceWorker.register("/privacy-sw.js");
      const registration = await navigator.serviceWorker.ready;
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          resolve();
        };
        registration.active!.postMessage({ url: control("worker"), body: "cross-origin-worker" }, [
          channel.port2,
        ]);
      });
      await registration.unregister();
    }, sink.origin);
    await expect
      .poll(() => wire.some((request) => request.body.includes("cross-origin-beacon")))
      .toBe(true);
    const urlVisible = (requests: typeof wire | typeof browser) =>
      requests.some((request) =>
        decodeURIComponent(request.url).includes("cross origin url sentinel"),
      );
    expect(urlVisible(wire)).toBe(true);
    expect(urlVisible(browser)).toBe(true);
    const controls = ["json", "string", "blob", "multipart", "beacon", "worker"].map((kind) => ({
      kind,
      wireBodyObserved: wire.some((request) => request.body.includes(`cross-origin-${kind}`)),
      browserRequestObserved: browser.some(
        (request) => new URL(request.url).pathname === `/${kind}`,
      ),
      browserBodyObserved: browser.some((request) =>
        request.body?.includes(`cross-origin-${kind}`),
      ),
    }));
    for (const control of controls) expect(control.wireBodyObserved, control.kind).toBe(true);
    // Pin a positive control on the browser channel as well as the socket.
    expect(controls.find((control) => control.kind === "json")?.browserBodyObserved).toBe(true);
    writeFileSync(
      info.outputPath("cross-origin-privacy-controls.json"),
      JSON.stringify(
        {
          fixtureOrigin: fixture.origin,
          collectorOrigin: sink.origin,
          browserVersion: context.browser()?.version(),
          urlObservedByBoth: true,
          controls,
          scope:
            "Only disposable sentinel traffic to two loopback origins. This collector does not observe arbitrary app destinations; browser Blob bodies and service-worker requests may be invisible. No document content or credentials were sent.",
        },
        null,
        2,
      ),
    );
  } finally {
    await close(fixture.server);
    await close(sink.server);
  }
});
