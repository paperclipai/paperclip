import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { listenOnFetchAllowedPort } from "../../e2e/fetch-allowed-port.js";
import { startArchiveFaultProxy } from "./internal-archive-transport.js";
const ids = () => ({ companyId: randomUUID(), agentId: randomUUID(), personId: randomUUID(), taskIds: [randomUUID(), randomUUID(), randomUUID()], runId: randomUUID() });
it("preserves real bytes/responses, independently checks actor/run/person and drops only the third before admission", async () => {
  const binding = ids(), admitted: Array<{ path: string; body: string; actor?: string }> = [];
  const backend = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/agents/me") { res.end(JSON.stringify({ id: binding.agentId, companyId: binding.companyId })); return; }
    if (req.url === `/api/heartbeat-runs/${binding.runId}`) { res.end(JSON.stringify({ id: binding.runId, agentId: binding.agentId, companyId: binding.companyId, responsibleUserId: binding.personId })); return; }
    if (req.url?.startsWith("/api/heartbeat-runs/")) { res.writeHead(404); res.end("{}"); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    admitted.push({ path: req.url!, body: Buffer.concat(chunks).toString(), actor: req.headers.authorization }); res.writeHead(200, { "x-original-response": "preserved" }); res.end(JSON.stringify({ backendReceipt: admitted.length }));
  });
  const port = await listenOnFetchAllowedPort(backend), proxy = await startArchiveFaultProxy(`http://127.0.0.1:${port}`);
  try {
    await proxy.arm({ companyId: binding.companyId, agentId: binding.agentId, personId: binding.personId, taskIds: binding.taskIds });
    await expect(proxy.releaseForExplicitRetry()).rejects.toThrow();
    const body = `{ "userId": "${binding.personId}" }`;
    const send = (id: string, requestBody = body, run = binding.runId) => fetch(`${proxy.origin}/api/issues/${id}/inbox-archive`, { method: "POST", headers: { authorization: "Bearer unit-only", "content-type": "application/json", "x-paperclip-run-id": run }, body: requestBody, signal: AbortSignal.timeout(5000) });
    const first = await send(binding.taskIds[0]!); expect(first.headers.get("x-original-response")).toBe("preserved"); expect(await first.json()).toEqual({ backendReceipt: 1 });
    expect(await (await send(binding.taskIds[1]!)).json()).toEqual({ backendReceipt: 2 });
    // Wrong person/run and unrelated task still reach the backend unchanged.
    await (await send(binding.taskIds[2]!, '{ "userId": "another-person" }')).arrayBuffer();
    await (await send(binding.taskIds[2]!, body, randomUUID())).arrayBuffer();
    await (await send(randomUUID())).arrayBuffer();
    expect(await proxy.receipts()).toHaveLength(2);
    await expect(send(binding.taskIds[2]!)).rejects.toThrow(); await expect(send(binding.taskIds[2]!)).rejects.toThrow();
    expect(admitted).toHaveLength(5); expect(admitted[0]).toEqual({ path: `/api/issues/${binding.taskIds[0]}/inbox-archive`, body, actor: "Bearer unit-only" });
    expect((await proxy.receipts()).map(row => [row.taskId, row.forwarded, row.phase])).toEqual([[binding.taskIds[0], true, "initial"], [binding.taskIds[1], true, "initial"], [binding.taskIds[2], false, "initial"], [binding.taskIds[2], false, "initial"]]);
    await proxy.releaseForExplicitRetry(); expect(await (await send(binding.taskIds[2]!)).json()).toEqual({ backendReceipt: 6 });
    expect((await proxy.receipts()).at(-1)).toMatchObject({ taskId: binding.taskIds[2], phase: "retry", forwarded: true, status: 200, explicitUserId: binding.personId, runId: binding.runId });
    await expect(proxy.releaseForExplicitRetry()).rejects.toThrow();
  } finally { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); await proxy.close(); }
});
it("rejects external backends and malformed/duplicate binding without admitting a fault", async () => {
  await expect(startArchiveFaultProxy("https://example.com")).rejects.toThrow();
  const backend = createServer((_req, res) => res.end()), port = await listenOnFetchAllowedPort(backend), proxy = await startArchiveFaultProxy(`http://127.0.0.1:${port}`);
  try { await expect(proxy.arm({ companyId: "wrong", agentId: "wrong", personId: "person", taskIds: ["one", "one", "three"] })).rejects.toThrow(); }
  finally { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); await proxy.close(); }
});

it("forwards malformed and oversized bound requests unchanged without fault receipts", async () => {
  const binding = ids(), admitted: string[] = [];
  const backend = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    admitted.push(Buffer.concat(chunks).toString()); res.end("backend-original");
  });
  const port = await listenOnFetchAllowedPort(backend), proxy = await startArchiveFaultProxy(`http://127.0.0.1:${port}`);
  try {
    await proxy.arm({ companyId: binding.companyId, agentId: binding.agentId, personId: binding.personId, taskIds: binding.taskIds });
    const endpoint = `${proxy.origin}/api/issues/${binding.taskIds[0]}/inbox-archive`, headers = { "x-paperclip-run-id": binding.runId };
    for (const body of ["not-json", "null", "[]", '{"unexpected":true}', "x".repeat(70000)]) {
      expect(await (await fetch(endpoint, { method: "POST", headers, body })).text()).toBe("backend-original"); expect(admitted.at(-1)).toBe(body);
    }
    // Unknown-length chunked input crosses the inspection bound without losing
    // the already-buffered prefix or applying a synthetic transport failure.
    const body = "y".repeat(90000);
    await new Promise<void>((resolve, reject) => {
      const outgoing = request(endpoint, { method: "POST", headers }, response => { response.resume(); response.on("end", resolve); });
      outgoing.on("error", reject); outgoing.write(body.slice(0, 50000)); setTimeout(() => outgoing.end(body.slice(50000)), 5);
    });
    expect(admitted.at(-1)).toBe(body); expect(await proxy.receipts()).toEqual([]);
    const escaped = await new Promise<number>((resolve, reject) => {
      const outgoing = request(proxy.origin, { path: "http://example.invalid/not-owned" }, response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); }); outgoing.on("error", reject); outgoing.end();
    });
    expect(escaped).toBe(400); expect(admitted).toHaveLength(6);
  } finally { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); await proxy.close(); }
});

it("passes the owned backend upgrade stream unchanged and closes its owned sockets", async () => {
  const backend = createServer(); let seenHeader: string | undefined;
  backend.on("upgrade", (req, socket, head) => {
    seenHeader = req.headers["x-offline-identity"] as string;
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: offline-echo\r\n\r\n");
    if (head.length) socket.write(head); socket.on("data", bytes => socket.write(bytes)); socket.on("end", () => socket.destroy());
  });
  const port = await listenOnFetchAllowedPort(backend), proxy = await startArchiveFaultProxy(`http://127.0.0.1:${port}`);
  try {
    expect(await new Promise<string>((resolve, reject) => {
      const outgoing = request(`${proxy.origin}/actual-native-control`, { headers: { connection: "Upgrade", upgrade: "offline-echo", "x-offline-identity": "opaque-preserved" } });
      outgoing.setTimeout(5000, () => { outgoing.destroy(); reject(new Error("Offline upgrade timed out")); }); outgoing.on("error", reject);
      outgoing.on("upgrade", (_response, socket) => { socket.on("error", reject); socket.once("data", bytes => { resolve(bytes.toString()); socket.destroy(); }); socket.write("unchanged-native-frame"); }); outgoing.end();
    })).toBe("unchanged-native-frame");
    expect(seenHeader).toBe("opaque-preserved"); expect(await proxy.receipts()).toEqual([]);
  } finally { await proxy.close(); await new Promise<void>(resolve => backend.close(() => resolve())); }
});
