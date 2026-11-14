import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";

export const isEvalRemoteOrigin = (value: string) => /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(value);

export async function startEvalRemoteBridge(input: {
  gateway: { baseUrl: string; token: string };
  observability?: { baseUrl: string; token: string };
  deadlineAt: number;
}) {
  if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + 4 * 3_600_000
      || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(input.gateway.baseUrl)
      || input.observability && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/otel$/.test(input.observability.baseUrl)
      || !/^[a-f0-9]{64}$/.test(input.gateway.token)
      || input.observability && !/^[a-f0-9]{64}$/.test(input.observability.token)) throw new Error("Invalid remote eval bridge policy");
  try { new URL(input.gateway.baseUrl); if (input.observability) new URL(input.observability.baseUrl); }
  catch { throw new Error("Invalid remote eval bridge policy"); }
  const nonce = randomBytes(32).toString("hex");
  let closed = false;
  const server = createServer((incoming, outgoing) => {
    if (closed || Date.now() >= input.deadlineAt) { outgoing.writeHead(503).end(); return; }
    if (incoming.method === "GET" && incoming.url === "/health") {
      outgoing.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ nonce })); return;
    }
    const model = ["/responses", "/v1/responses", "/messages", "/messages?beta=true", "/v1/messages", "/v1/messages?beta=true"].includes(incoming.url ?? "");
    const otlp = ["/otel/v1/traces", "/otel/v1/logs"].includes(incoming.url ?? "");
    const destination = model ? input.gateway : otlp ? input.observability : undefined;
    if (incoming.method !== "POST" || !destination) { outgoing.writeHead(404).end(); return; }
    const auth = String(incoming.headers.authorization ?? "").replace(/^Bearer /, "") || String(incoming.headers["x-api-key"] ?? "");
    const presented = Buffer.from(auth), expected = Buffer.from(destination.token);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) { outgoing.writeHead(401).end(); return; }
    const suffix = otlp ? incoming.url!.slice("/otel".length) : incoming.url!;
    const headers: Record<string, string> = { authorization: `Bearer ${destination.token}` };
    for (const name of ["content-type", "content-encoding", "anthropic-beta", "anthropic-version", "x-bt-parent"]) {
      const value = incoming.headers[name]; if (typeof value === "string") headers[name] = value;
    }
    const upstream = httpRequest(destination.baseUrl + suffix, { method: "POST", headers }, response => {
      if (outgoing.destroyed) { response.destroy(); return; }
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
      response.on("error", () => outgoing.destroy());
    });
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy(); });
    incoming.on("aborted", () => upstream.destroy());
    incoming.on("error", () => upstream.destroy());
    outgoing.on("error", () => upstream.destroy());
    outgoing.on("close", () => { if (!outgoing.writableEnded) upstream.destroy(); });
    incoming.pipe(upstream);
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Remote eval bridge did not bind loopback");
  let timer: ReturnType<typeof setTimeout>;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    closed = true; clearTimeout(timer);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  })();
  timer = setTimeout(() => { void close().catch(() => {}); }, input.deadlineAt - Date.now()); timer.unref();
  return { baseUrl: `http://127.0.0.1:${address.port}`, nonce, close };
}

export async function startEvalRemoteGateway(input: Parameters<typeof startEvalRemoteBridge>[0], env: NodeJS.ProcessEnv) {
  const bridge = await startEvalRemoteBridge(input);
  let home: string;
  try { home = await mkdtemp(path.join(tmpdir(), "eval-cloudflare-")); }
  catch (error) { await bridge.close(); throw error; }
  let tunnel: ReturnType<typeof spawn> | undefined;
  let closing: Promise<void> | undefined, deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const close = () => closing ??= (async () => {
    clearTimeout(deadlineTimer);
    const errors: unknown[] = [];
    try { await bridge.close(); } catch (error) { errors.push(error); }
    try {
      if (tunnel?.pid && tunnel.exitCode === null && tunnel.signalCode === null) {
        const exited = once(tunnel, "exit").catch(() => {});
        tunnel.kill("SIGTERM"); const timer = setTimeout(() => tunnel?.kill("SIGKILL"), 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    } catch (error) { errors.push(error); }
    try { await rm(home, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Remote eval exposure cleanup failed");
  })();
  try {
    tunnel = spawn(env.PAPERCLIP_EVAL_CLOUDFLARED?.trim() || "cloudflared",
      ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", bridge.baseUrl],
      { stdio: ["ignore", "pipe", "pipe"], env: { PATH: env.PATH, HOME: home, TMPDIR: home } });
    deadlineTimer = setTimeout(() => { void close().catch(() => {}); }, input.deadlineAt - Date.now()); deadlineTimer.unref();
    const child = tunnel;
    const origin = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("Remote eval tunnel startup timed out")), Math.min(120_000, input.deadlineAt - Date.now()));
      const finish = (error?: Error, value?: string) => { clearTimeout(timer); if (error) reject(error); else resolve(value!); };
      child.once("error", () => finish(new Error("Remote eval tunnel executable unavailable")));
      child.once("exit", () => finish(new Error("Remote eval tunnel exited")));
      const read = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-32768);
        const value = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
        if (value && output.includes("Registered tunnel connection")) finish(undefined, value);
      };
      child.stdout!.on("data", read); child.stderr!.on("data", read);
    });
    const readyBy = Math.min(Date.now() + 120_000, input.deadlineAt);
    while (Date.now() < readyBy) {
      try {
        const response = await fetch(origin + "/health", { redirect: "error", signal: AbortSignal.timeout(Math.min(5000, readyBy - Date.now())) });
        if (response.ok && (await response.json() as { nonce?: string }).nonce === bridge.nonce) return { baseUrl: origin, close };
        await response.body?.cancel();
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("Remote eval tunnel not publicly reachable before admission");
  } catch (error) { await close(); throw error; }
}
