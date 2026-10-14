import { Server } from "node:http";

let records = [];
let resetAt = 0;
const sockets = new WeakMap();
const emit = Server.prototype.emit;

Server.prototype.emit = function (event, ...args) {
  if (event === "request") {
    const [request, response] = args;
    const socket = request.socket;
    const pending = sockets.get(socket) ?? new Set();
    sockets.set(socket, pending);
    const record = {
      pathname: request.url.split("?")[0],
      startedAt: Date.now(),
      finishedAt: null,
      wireBytes: 0,
      pipelined: false,
    };
    pending.add(record);
    if (pending.size > 1) for (const active of pending) active.pipelined = true;
    const startedBytes = socket.bytesWritten;
    response.once("finish", () => {
      pending.delete(record);
      record.finishedAt = Date.now();
      record.wireBytes = socket.bytesWritten - startedBytes;
      if (record.pathname.startsWith("/_next/static/") && record.startedAt >= resetAt)
        records.push(record);
    });
    response.once("close", () => pending.delete(record));
  }
  return emit.call(this, event, ...args);
};

process.on("message", (message) => {
  if (message?.type === "bench-reset") {
    resetAt = Date.now();
    records = [];
    process.send?.({ id: message.id, records: [] });
  }
  if (message?.type === "bench-read") process.send?.({ id: message.id, records });
});
