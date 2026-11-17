// PRIVATE UNRUN transport fault for ONE actual committed Dot operation.
// No business row/result/receipt write. All tokens/bytes stay off diagnostics.
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { externalOperationDigest } from "../../../vendor/paperclip-runner/index.js";

export async function createCommittedReplyLoss(input: {
  cloudLoopback: string;
  assignmentId: string;
  requestId: string;
  inputDigest: string;
  // Existing original operation-status/DB/document assertions, bounded by the
  // original10-second operation deadline and90-second case. No added observer.
  awaitActualCommit(): Promise<void>;
}) {
  const backend = new URL(input.cloudLoopback);
  if (backend.protocol !== "http:" || backend.hostname !== "127.0.0.1" || backend.username || backend.password
      || backend.pathname !== "/" || backend.search || backend.hash) throw new Error("owned_reply_loss_backend_denied");
  const sockets = new Set<Socket>(), pending = new Set<Promise<void>>();
  let observedDropClose: (()=>void)|undefined;
  const droppedResponseClosed=new Promise<void>(resolve=>{observedDropClose=resolve;});
  const evidence = { armed: true, selected: 0, backendCompleted: 0, committed: 0, dropped: 0, closedAfterDrop: 0, overflow: 0, observerFailures: 0 };
  const server = createServer((request, response) => {
    const work = (async () => {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const part of request) { bytes += Buffer.byteLength(part); if (bytes > 1048576) { evidence.overflow++; throw new Error("reply_loss_request_overflow"); } chunks.push(Buffer.from(part)); }
      const body = Buffer.concat(chunks); let selected = false;
      if (evidence.armed && request.method === "POST" && request.url === "/mcp/runner") {
        const value = JSON.parse(body.toString("utf8")), args = value?.params?.arguments;
        if (value?.method === "tools/call" && value?.params?.name === "paperclip_dot_tool" && args && typeof args === "object"
            && args.assignmentId === input.assignmentId && args.requestId === input.requestId) {
          const { assignmentId: _assignment, requestId: _request, ...actualInput } = args;
          if (externalOperationDigest("tool", actualInput) !== input.inputDigest) throw new Error("reply_loss_input_mismatch");
          evidence.armed = false; evidence.selected++; selected = true;
        }
      }
      const upstream = httpRequest({ hostname: backend.hostname, port: backend.port, path: request.url, method: request.method,
        headers: request.headers, agent: false });
      const result = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        upstream.once("error", reject); upstream.once("response", incoming => {
          const parts: Buffer[] = []; let length = 0;
          incoming.on("data", part => { length += Buffer.byteLength(part); if (length > 1048576) { evidence.overflow++; return; } parts.push(Buffer.from(part)); });
          incoming.once("error", reject); incoming.once("end", () => length > 1048576 ? reject(new Error("reply_loss_response_overflow"))
            : resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(parts) }));
        }); upstream.end(body);
      });
      if (selected) {
        // The actual handler/transaction/HTTP response has ended. Holding this
        // CLIENT response cannot retain its DB lock or fake an ACK/outcome.
        evidence.backendCompleted++;
        const value = JSON.parse(result.body.toString("utf8"));
        if (result.status !== 200 || value?.result?.isError !== false) throw new Error("reply_loss_actual_operation_refused");
        try { await input.awaitActualCommit(); evidence.committed++; }
        catch (error) { evidence.observerFailures++; throw error; }
        evidence.dropped++;
        response.once("close", () => { evidence.closedAfterDrop++; observedDropClose?.(); });
        // Deliberate ONE request fault, not cleanup or a timeout/guard bypass.
        response.destroy(); return;
      }
      response.writeHead(result.status, result.headers); response.end(result.body);
    })();
    pending.add(work); void work.catch(() => { evidence.observerFailures++; if (!response.headersSent) response.writeHead(502); response.end(); }).finally(() => pending.delete(work));
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address();
  if (!address || typeof address === "string") throw new Error("owned_reply_loss_listener_missing");
  return { origin: `http://127.0.0.1:${address.port}`, evidence, droppedResponseClosed,
    async close() {
      const joins = [...sockets].map(socket => once(socket, "close"));
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all([stopped, ...joins, ...pending]);
      if (sockets.size || pending.size) throw new Error("owned_reply_loss_close_unknown");
    },
  };
}
