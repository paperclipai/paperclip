import { createServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { listenOnFetchAllowedPort } from "../../e2e/fetch-allowed-port.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Keep a real prerequisite worker active without the app gateway's short call deadline. */
export async function startNativeRunBriefGate(workerId: string, deadlineAt: number) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(workerId)) throw new Error("Invalid prerequisite worker identity");
  if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) throw new Error("Original prerequisite observation deadline is exhausted or missing");
  const route = `/website-brief/${workerId}`;
  const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
  const calls: Array<{ workerId: string; workerBound: boolean; receivedAt: string }> = [];
  const pending = new Set<ServerResponse>();
  let released = false;
  const reply = (response: ServerResponse) => {
    if (response.destroyed) return;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("The website brief is now available: Acorn Notes needs a semantic heading and an accessible signup link. Record a short implementation note and complete this prerequisite task. No website file or delivery is requested yet.");
  };
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== route) { response.writeHead(404); response.end(); return; }
    if (request.headers.authorization !== authorization) { response.writeHead(401); response.end(); return; }
    calls.push({ workerId, workerBound: true, receivedAt: new Date().toISOString() });
    if (released) reply(response);
    else { pending.add(response); response.once("close", () => pending.delete(response)); }
  });
  const port = await listenOnFetchAllowedPort(server);
  // fetch has a separate five-minute header timeout. The prerequisite must
  // follow only its original absolute observation deadline, including a wait
  // for headers. A one-use HTTP agent also avoids inherited socket timeouts.
  const script = `import {get} from "node:http"; const brief = await new Promise((resolve, reject) => { const request = get(${JSON.stringify(`http://127.0.0.1:${port}${route}`)}, {agent: false, timeout: 0, headers: {authorization: ${JSON.stringify(authorization)}}, signal: AbortSignal.timeout(Math.max(1, ${deadlineAt} - Date.now()))}, response => { if (response.statusCode !== 200) { response.resume(); reject(new Error("Website brief read failed")); return; } response.setEncoding("utf8"); let body = ""; response.on("data", chunk => { body += chunk; }); response.on("end", () => resolve(body)); response.on("error", reject); }); request.on("error", reject); }); process.stdout.write(brief);`;
  return {
    calls,
    command: `exec ${quote(process.execPath)} --input-type=module --eval ${quote(script)}`,
    release() { released = true; for (const response of pending) reply(response); pending.clear(); },
    async close() { for (const response of pending) response.destroy(); pending.clear(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
