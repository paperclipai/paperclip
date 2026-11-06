import { constants } from "node:fs";
import { lstat, open, realpath, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
export class PublicOriginCleanupError extends Error {}
export const PUBLIC_ORIGIN_CONTROL_ENV = "PAPERCLIP_CHAT_EVAL_PUBLIC_ORIGIN_CONTROL_DIR";
export const PUBLIC_ORIGIN_RECEIPT_ENV = "PAPERCLIP_RUNNER_E2E_OWNED_PUBLIC_ORIGIN_RECEIPT";
export const ownedPublicOriginScenarios = ["agents.existing-grok-bot", "assistant-connections.connect-external-assistant", "connection-setup.notion-missing", "connection-setup.notion-wrong-account", "connection-setup.notion-expired", "connection-setup.return-from-login", "connection-setup.save-and-resume"] as const;
export interface PublicOriginIdentity { pid: number; uid: number; startedAt: string; executable: string; executableSha256: string; commandSha256: string; workingDirectory: string }
export interface PublicOriginRequest { schema: "paperclip.chat-public-origin-request.v1"; executionId: string; scenarioId: string; attemptId: string; backendOrigin: string; nonce: string }
export interface ValidatedPublicOriginReceipt { schema: "paperclip.chat-public-origin.v1"; executionId: string; scenarioId: string; attemptId: string; backendOrigin: string; publicOrigin: string; nonce: string; proxy: PublicOriginIdentity; routeVerifiedAt: string }
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const exactKeys = (value: unknown, keys: readonly string[]) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function publicHttpsOrigin(value: string) { try { const u = new URL(value); return u.protocol === "https:" && u.origin === value && !u.username && !u.password && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.hostname.endsWith(".localhost"); } catch { return false; } }
function validRequest(r: PublicOriginRequest) { try { const url = new URL(r.backendOrigin); return exactKeys(r, ["schema", "executionId", "scenarioId", "attemptId", "backendOrigin", "nonce"]) && r.schema === "paperclip.chat-public-origin-request.v1" && ownedPublicOriginScenarios.includes(r.scenarioId as typeof ownedPublicOriginScenarios[number]) && r.executionId.includes(r.scenarioId) && /^[a-f0-9]{32}$/.test(r.attemptId) && /^[a-f0-9]{48}$/.test(r.nonce) && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.origin === r.backendOrigin && Number(url.port) > 1024; } catch { return false; } }
export function publicOriginReceiptMatches(r: ValidatedPublicOriginReceipt, expected: Pick<PublicOriginRequest, "executionId" | "attemptId" | "backendOrigin"> & Partial<Pick<PublicOriginRequest, "scenarioId" | "nonce">>) {
  const p = r?.proxy;
  return exactKeys(r, ["schema", "executionId", "scenarioId", "attemptId", "backendOrigin", "publicOrigin", "nonce", "proxy", "routeVerifiedAt"]) && r.schema === "paperclip.chat-public-origin.v1" && validRequest({ schema: "paperclip.chat-public-origin-request.v1", executionId: r.executionId, scenarioId: r.scenarioId, attemptId: r.attemptId, backendOrigin: r.backendOrigin, nonce: r.nonce })
    && r.executionId === expected.executionId && r.attemptId === expected.attemptId && r.backendOrigin === expected.backendOrigin && (!expected.scenarioId || r.scenarioId === expected.scenarioId) && (!expected.nonce || r.nonce === expected.nonce)
    && publicHttpsOrigin(r.publicOrigin) && Number.isFinite(Date.parse(r.routeVerifiedAt)) && exactKeys(p, ["pid", "uid", "startedAt", "executable", "executableSha256", "commandSha256", "workingDirectory"])
    && Number.isSafeInteger(p.pid) && p.pid > 1 && p.pid !== process.pid && p.uid === process.getuid?.() && Number.isFinite(Date.parse(p.startedAt)) && path.isAbsolute(p.executable) && path.isAbsolute(p.workingDirectory) && /^[a-f0-9]{64}$/.test(p.executableSha256) && /^[a-f0-9]{64}$/.test(p.commandSha256);
}
async function privateDirectory(directory: string) { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid?.() || await realpath(directory) !== directory) throw new Error("Public origin control requires an owned canonical private0700 directory"); }
async function privateJson<T>(filename: string): Promise<T> {
  await privateDirectory(path.dirname(filename));
  const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = await fd.stat(); if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.uid !== process.getuid?.() || before.size > 32768 || await realpath(filename) !== filename) throw new Error("Invalid private public-origin receipt file");
    const bytes = await fd.readFile(), after = await fd.stat(), named = await lstat(filename);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || named.ino !== before.ino || named.dev !== before.dev) throw new Error("Public-origin receipt changed during read");
    return JSON.parse(bytes.toString("utf8")) as T;
  } finally { await fd.close(); }
}
/** No raw process arguments or provider credentials leave this local reader. */
export async function readPublicProxyIdentity(pid: number): Promise<PublicOriginIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !process.getuid) throw new Error("Invalid public proxy process identity");
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined; throw new Error("Public proxy ownership could not be independently read"); }
  const field = async (name: string) => (await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", `${name}=`], { timeout: 5000, maxBuffer: 65536 })).stdout.trim();
  try {
    const [uid, started, command, executableName] = await Promise.all([field("uid"), field("lstart"), field("args"), field("comm")]);
    if (!command || !Number.isFinite(Date.parse(started))) throw new Error("Missing process identity");
    const executable = await realpath(executableName), stat = await lstat(executable); if (!stat.isFile() || stat.size > 134217728) throw new Error("Unbounded public proxy executable");
    const workingDirectory = process.platform === "linux" ? await realpath(`/proc/${pid}/cwd`) : (await promisify(execFile)("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 5000, maxBuffer: 16384 })).stdout.split("\n").find(line => line.startsWith("n"))?.slice(1);
    if (!workingDirectory) throw new Error("Missing actual proxy working directory");
    return { pid, uid: Number(uid), startedAt: new Date(started).toISOString(), executable, executableSha256: hash(await readFile(executable)), commandSha256: hash(command), workingDirectory: await realpath(workingDirectory) };
  } catch { throw new Error("Public proxy identity inspection failed; private process diagnostics withheld"); }
}
export const samePublicProxyIdentity = (a: PublicOriginIdentity | undefined, b: PublicOriginIdentity) => !!a && Object.keys(b).every(key => a[key as keyof PublicOriginIdentity] === b[key as keyof PublicOriginIdentity]);
/** Finite coordinator handoff. Caller owns configuring/releasing the actual
 * already-authorized route/process; this helper never creates a public tunnel. */
export async function publishPublicOriginRoute(input: { controlDirectory: string; publicOrigin: string; proxyPid: number }) {
  const request = await privateJson<PublicOriginRequest>(path.join(input.controlDirectory, "request.json"));
  if (!validRequest(request) || !publicHttpsOrigin(input.publicOrigin)) throw new Error("Invalid selected owned public route request");
  const proxy = await readPublicProxyIdentity(input.proxyPid);
  if (!proxy || proxy.uid !== process.getuid?.() || !proxy.workingDirectory.startsWith(`${input.controlDirectory}${path.sep}`) && proxy.workingDirectory !== input.controlDirectory || !samePublicProxyIdentity(await readPublicProxyIdentity(input.proxyPid), proxy)) throw new Error("Public proxy must be the exact coordinator-owned process rooted in the private handoff directory");
  await writeFile(path.join(input.controlDirectory, "route.json"), JSON.stringify({ ...request, publicOrigin: input.publicOrigin, proxy }), { mode: 0o600, flag: "wx" });
  return { published: true, executionId: request.executionId, attemptId: request.attemptId };
}
/** After actual separately owned proxy/route teardown, publish its closed
 * completion. This helper never signals a process. The launcher also rechecks. */
export async function publishPublicOriginRelease(input: { controlDirectory: string; publicRouteReleased: true }) {
  const request = await privateJson<PublicOriginRequest>(path.join(input.controlDirectory, "request.json"));
  const release = await privateJson<PublicOriginRequest & { backendShutdown: boolean }>(path.join(input.controlDirectory, "release-request.json"));
  const route = await privateJson<PublicOriginRequest & { publicOrigin: string; proxy: PublicOriginIdentity }>(path.join(input.controlDirectory, "route.json"));
  if (!validRequest(request) || release.backendShutdown !== true || !exactKeys(release, [...Object.keys(request), "backendShutdown"]) || Object.entries(request).some(([key, value]) => release[key as keyof typeof release] !== value || route[key as keyof typeof route] !== value) || !exactKeys(route, [...Object.keys(request), "publicOrigin", "proxy"]) || !publicHttpsOrigin(route.publicOrigin) || input.publicRouteReleased !== true) throw new Error("Public-origin release does not belong to the completed backend attempt");
  const live = await readPublicProxyIdentity(route.proxy.pid);
  if (live?.startedAt === route.proxy.startedAt) throw new Error("The actual owned public proxy has not exited");
  const backend = await fetch(`${request.backendOrigin}/api/health`, { signal: AbortSignal.timeout(2000), redirect: "error" }).catch(() => undefined);
  if (backend) { await backend.body?.cancel(); throw new Error("Refusing a public route release receipt before backend shutdown"); }
  await writeFile(path.join(input.controlDirectory, "released.json"), JSON.stringify({ schema: "paperclip.chat-public-origin-release.v1", executionId: request.executionId, attemptId: request.attemptId, nonce: request.nonce, publicRouteReleased: true, proxyReleased: true }), { mode: 0o600, flag: "wx" });
  return { released: true, executionId: request.executionId, attemptId: request.attemptId };
}
export async function readValidatedPublicOriginReceipt(input: { receiptPath: string; executionId: string; attemptId: string; backendOrigin: string }): Promise<ValidatedPublicOriginReceipt> {
  const receipt = await privateJson<ValidatedPublicOriginReceipt>(input.receiptPath);
  if (!publicOriginReceiptMatches(receipt, input) || !samePublicProxyIdentity(await readPublicProxyIdentity(receipt.proxy.pid), receipt.proxy)) throw new Error("Validated public origin no longer belongs to this exact live attempt/proxy");
  return receipt;
}
async function responseFile<T>(filename: string, deadline: number): Promise<T> { while (Date.now() < deadline) { try { return await privateJson<T>(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await sleep(250); } throw new Error("Owned public-origin coordinator handoff timed out before backend exposure"); }
export function publicProxySocketMatches(text: string, remotePort: number, backendPort: number) {
  return Number.isSafeInteger(remotePort) && remotePort > 0 && Number.isSafeInteger(backendPort) && backendPort > 1024 && text.split("\n").includes(`n127.0.0.1:${remotePort}->127.0.0.1:${backendPort}`);
}
export function publicOriginReleaseMatches(release: unknown, request: PublicOriginRequest) {
  const r = release as Record<string, unknown> | undefined;
  return exactKeys(r, ["schema", "executionId", "attemptId", "nonce", "publicRouteReleased", "proxyReleased"]) && r?.schema === "paperclip.chat-public-origin-release.v1" && r.executionId === request.executionId && r.attemptId === request.attemptId && r.nonce === request.nonce && r.publicRouteReleased === true && r.proxyReleased === true;
}
async function boundedResponse(response: Response) {
  const reader = response.body?.getReader(); if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 256) throw new Error("Public-origin challenge response exceeded its finite bound"); chunks.push(next.value); } return Buffer.concat(chunks).toString("utf8"); }
  finally { await reader.cancel(); }
}
async function confirmProxySocket(proxy: PublicOriginIdentity, remotePort: number, backendPort: number) {
  const text = (await promisify(execFile)("lsof", ["-nP", "-a", "-p", String(proxy.pid), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"], { timeout: 5000, maxBuffer: 65536 })).stdout;
  if (!publicProxySocketMatches(text, remotePort, backendPort) || !samePublicProxyIdentity(await readPublicProxyIdentity(proxy.pid), proxy)) throw new Error("Actual public request did not traverse the exact owned proxy process/socket");
}
export async function prepareOwnedPublicOrigin(input: { controlDirectory?: string; executionId: string; scenarioId: string; attemptId: string; backendOrigin: string; temporaryRoot: string; privateSecrets: string[]; timeoutMs?: number }) {
  if (!input.controlDirectory) return undefined;
  const root = path.resolve(input.controlDirectory); await privateDirectory(root);
  const request: PublicOriginRequest = { schema: "paperclip.chat-public-origin-request.v1", executionId: input.executionId, scenarioId: input.scenarioId, attemptId: input.attemptId, backendOrigin: input.backendOrigin, nonce: randomBytes(24).toString("hex") };
  if (!validRequest(request)) throw new Error("Public origin handoff is forbidden outside its finite selected-case execution");
  input.privateSecrets.push(request.nonce);
  await writeFile(path.join(root, "request.json"), JSON.stringify(request), { mode: 0o600, flag: "wx" });
  let receipt: ValidatedPublicOriginReceipt | undefined, released = false;
  const close = async () => {
    if (released) return;
    const backend = await fetch(`${request.backendOrigin}/api/health`, { signal: AbortSignal.timeout(2000), redirect: "error" }).catch(() => undefined);
    if (backend) { await backend.body?.cancel(); throw new Error("Public route cleanup requires independently observed backend shutdown"); }
    await writeFile(path.join(root, "release-request.json"), JSON.stringify({ ...request, backendShutdown: true }), { mode: 0o600, flag: "wx" });
    const release = await responseFile<{ schema: string; executionId: string; attemptId: string; nonce: string; publicRouteReleased: boolean; proxyReleased: boolean }>(path.join(root, "released.json"), Date.now() + (input.timeoutMs ?? 90000));
    if (!publicOriginReleaseMatches(release, request) || !receipt) throw new Error("Owned public proxy release was not confirmed for this exact attempt");
    const live = await readPublicProxyIdentity(receipt.proxy.pid); if (live && live.startedAt === receipt.proxy.startedAt) throw new Error("Owned per-attempt public proxy remains alive after reported release");
    const response = await fetch(`${receipt.publicOrigin}/.well-known/paperclip-eval-route/${request.nonce}`, { redirect: "error", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (response) { const body = await boundedResponse(response); if (body === request.nonce) throw new Error("Old public route remains reachable after reported release"); }
    released = true;
  };
  try {
    const route = await responseFile<PublicOriginRequest & { publicOrigin: string; proxy: PublicOriginIdentity }>(path.join(root, "route.json"), Date.now() + (input.timeoutMs ?? 90000));
    if (!exactKeys(route, ["schema", "executionId", "scenarioId", "attemptId", "backendOrigin", "nonce", "publicOrigin", "proxy"]) || route.schema !== request.schema) throw new Error("Public proxy route receipt exceeds its exact request contract");
    receipt = { schema: "paperclip.chat-public-origin.v1", executionId: route.executionId, scenarioId: route.scenarioId, attemptId: route.attemptId, backendOrigin: route.backendOrigin, nonce: route.nonce, publicOrigin: route.publicOrigin, proxy: route.proxy, routeVerifiedAt: new Date().toISOString() };
    if (!publicOriginReceiptMatches(receipt, request) || !samePublicProxyIdentity(await readPublicProxyIdentity(receipt.proxy.pid), receipt.proxy) || !(receipt.proxy.workingDirectory === root || receipt.proxy.workingDirectory.startsWith(`${root}${path.sep}`))) throw new Error("Owned public proxy receipt has stale execution, route or process identity");
    input.privateSecrets.push(receipt.publicOrigin);
    const port = Number(new URL(input.backendOrigin).port); let routeObserved = false, requestClaimed = false;
    const responder = createServer((req, res) => {
      const expected = `/.well-known/paperclip-eval-route/${request.nonce}`;
      if (requestClaimed || req.method !== "GET" || req.url !== expected || !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || !req.socket.remotePort) { res.writeHead(404); res.end(); return; }
      requestClaimed = true;
      void confirmProxySocket(receipt!.proxy, req.socket.remotePort, port).then(() => { routeObserved = true; res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }); res.end(request.nonce); }).catch(() => { res.writeHead(403); res.end(); });
    });
    responder.requestTimeout = 10000; responder.headersTimeout = 10000;
    try {
      await new Promise<void>((resolve, reject) => { responder.once("error", reject); responder.listen(port, "127.0.0.1", resolve); });
      const response = await fetch(`${receipt.publicOrigin}/.well-known/paperclip-eval-route/${request.nonce}`, { redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!response.ok || await boundedResponse(response) !== request.nonce || !routeObserved) throw new Error("Actual HTTPS route failed its independently observed exact-process loopback challenge");
    } finally { responder.closeAllConnections(); await new Promise<void>(resolve => responder.close(() => resolve())); }
    if (!samePublicProxyIdentity(await readPublicProxyIdentity(receipt.proxy.pid), receipt.proxy)) throw new Error("Public proxy changed identity after route verification");
    receipt.routeVerifiedAt = new Date().toISOString(); const filename = path.join(input.temporaryRoot, "public-origin.json"); await writeFile(filename, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
    return { filename, receipt, close };
  } catch (error) { try { await close(); } catch { throw new PublicOriginCleanupError("Public-origin preparation failed and owned proxy/route cleanup is unconfirmed; private control state retained"); } throw error; }
}
export function publicOriginServerOverrides(receipt: ValidatedPublicOriginReceipt | undefined) {
  return receipt ? { PAPERCLIP_PUBLIC_URL: receipt.publicOrigin, PAPERCLIP_AUTH_PUBLIC_BASE_URL: receipt.publicOrigin, PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL: receipt.publicOrigin, PAPERCLIP_ALLOWED_HOSTNAMES: "127.0.0.1" } : {};
}
export function publicOriginFingerprintIdentity(executionId: string, scenarioId: string, env: NodeJS.ProcessEnv = process.env) {
  return { selected: ownedPublicOriginScenarios.includes(scenarioId as typeof ownedPublicOriginScenarios[number]), configured: !!env[PUBLIC_ORIGIN_RECEIPT_ENV] || !!env[PUBLIC_ORIGIN_CONTROL_ENV], referenceNames: [PUBLIC_ORIGIN_CONTROL_ENV, PUBLIC_ORIGIN_RECEIPT_ENV], executionId, protocol: "private-attempt-request-exact-proxy-route-and-release-v1" };
}
