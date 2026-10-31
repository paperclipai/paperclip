import { createServer, type ServerResponse } from "node:http";
import { listenOnFetchAllowedPort } from "../../e2e/fetch-allowed-port.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const NATIVE_BRIEF_HOLD_MS = 420_000;

/** Keep a real prerequisite worker active without the app gateway's short call deadline. */
export async function startNativeRunBriefGate(workerId: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(workerId)) throw new Error("Invalid prerequisite worker identity");
  const route = `/website-brief/${workerId}`;
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
    calls.push({ workerId, workerBound: true, receivedAt: new Date().toISOString() });
    if (released) reply(response);
    else { pending.add(response); response.once("close", () => pending.delete(response)); }
  });
  const port = await listenOnFetchAllowedPort(server);
  const script = `const response = await fetch(${JSON.stringify(`http://127.0.0.1:${port}${route}`)}, {signal: AbortSignal.timeout(${NATIVE_BRIEF_HOLD_MS})}); if (!response.ok) throw new Error("Website brief read failed"); process.stdout.write(await response.text());`;
  return {
    calls,
    command: `exec ${quote(process.execPath)} --input-type=module --eval ${quote(script)}`,
    release() { released = true; for (const response of pending) reply(response); pending.clear(); },
    async close() { for (const response of pending) response.destroy(); pending.clear(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
