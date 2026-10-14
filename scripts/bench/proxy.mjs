import { createServer, request } from "node:http";

import { ownResource } from "./runtime.mjs";

export const PROBE_PATH = "/api/perf/probe";

export async function startLatencyProxy(target) {
  const upstreamOrigin = new URL(target);
  const origin = "http://127.0.0.1:3300";
  let delay = 0;
  let offline = false;
  let hits = [];
  const pending = new Set();
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, origin).pathname;
    hits.push({ method: req.method, pathname });
    if (offline) {
      req.socket.destroy();
      return;
    }
    req.pause();
    const timer = setTimeout(() => {
      pending.delete(timer);
      if (pathname === PROBE_PATH) {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end(`probe delay=${delay}`);
        req.resume();
        return;
      }
      const headers = { ...req.headers, host: upstreamOrigin.host };
      for (const key of ["origin", "referer"])
        if (headers[key]?.startsWith(origin))
          headers[key] = upstreamOrigin.origin + headers[key].slice(origin.length);
      delete headers.connection;
      const upstream = request(
        {
          hostname: upstreamOrigin.hostname,
          port: upstreamOrigin.port || 80,
          method: req.method,
          path: req.url,
          headers,
        },
        (response) => {
          const headers = { ...response.headers };
          if (headers.location?.startsWith(upstreamOrigin.origin))
            headers.location = origin + headers.location.slice(upstreamOrigin.origin.length);
          res.writeHead(response.statusCode, headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("Local proxy upstream failed.");
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      req.resume();
    }, delay);
    pending.add(timer);
    res.on("close", () => {
      clearTimeout(timer);
      pending.delete(timer);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(3300, "127.0.0.1", resolve);
  });
  const close = () =>
    new Promise((resolve) => {
      release();
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      server.closeAllConnections();
      server.close(resolve);
    });
  const release = ownResource(close);
  return {
    origin,
    setDelay: (ms) => {
      delay = ms;
    },
    setOffline: (value) => {
      offline = value;
    },
    reset: () => {
      hits = [];
    },
    report: () => ({ total: hits.length, requests: [...hits] }),
    close,
  };
}
