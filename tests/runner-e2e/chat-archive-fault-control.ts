import { reviewedChatExecutionIds } from "./chat-runtime-profile.js";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { listenOnFetchAllowedPort } from "../e2e/fetch-allowed-port.js";
import { startArchiveFaultProxy, validArchiveBinding, type ArchiveBinding, type ArchiveFaultTransport, type ArchiveTransportReceipt } from "./chat-catalog-domains/internal-archive-transport.js";
export const ARCHIVE_CONTROL_ENV = "PAPERCLIP_RUNNER_E2E_ARCHIVE_CONTROL";
export const ARCHIVE_SCENARIO = "inbox-search.archive-partial-failure";
const executionIds = reviewedChatExecutionIds(ARCHIVE_SCENARIO);
interface Binding { version: 1; executionId: string; temporaryRoot: string; backendOrigin: string; origin: string; controlOrigin: string; token: string }
const origin = (value: unknown): value is string => { try { const u = new URL(String(value)); return u.protocol === "http:" && u.hostname === "127.0.0.1" && !!u.port && u.origin === value; } catch { return false; } };
async function privateDirectory(root: string) {
  try {
    const directory = path.join(root, "selected-private-inputs"), metadata = await lstat(root), dir = await lstat(directory);
    if (!path.basename(root).startsWith("paperclip-runner-e2e-") || await realpath(root) !== root || await realpath(directory) !== directory || !metadata.isDirectory() || !dir.isDirectory() || metadata.mode & 0o077 || dir.mode & 0o077
      || typeof process.getuid === "function" && (metadata.uid !== process.getuid() || dir.uid !== process.getuid())) throw new Error();
  } catch { throw new Error("Private archive root is unavailable or unsafe"); }
}
async function privateBinding(filename: string, root: string, selected: readonly string[]) {
  if (selected.length !== 1 || !executionIds.includes(selected[0]!) || filename !== path.join(root, "selected-private-inputs", "archive-fault.json")) throw new Error("Archive transport requires its exact selected owned case");
  try {
    await privateDirectory(root);
    const directory = path.dirname(filename), dir = await lstat(directory), file = await lstat(filename);
    if (await realpath(root) !== root || await realpath(directory) !== directory || !dir.isDirectory() || dir.mode & 0o077 || file.isSymbolicLink() || !file.isFile() || (file.mode & 0o777) !== 0o600 || file.size > 4096
      || typeof process.getuid === "function" && (dir.uid !== process.getuid() || file.uid !== process.getuid())) throw new Error();
    const value = JSON.parse(await readFile(filename, "utf8")) as Binding;
    if (Object.keys(value).sort().join() !== "backendOrigin,controlOrigin,executionId,origin,temporaryRoot,token,version" || value.version !== 1 || value.executionId !== selected[0] || value.temporaryRoot !== root
      || !origin(value.backendOrigin) || !origin(value.origin) || !origin(value.controlOrigin) || new Set([value.backendOrigin, value.origin, value.controlOrigin]).size !== 3 || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error();
    return value;
  } catch { throw new Error("Private archive transport binding is unavailable or unsafe"); }
}
function validReceipt(value: unknown): value is ArchiveTransportReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>, uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
  return Object.keys(row).every(key => ["requestId", "sequence", "taskId", "phase", "requestSha256", "runId", "explicitUserId", "forwarded", "status", "completedAt"].includes(key))
    && uuid(row.requestId) && uuid(row.taskId) && uuid(row.runId) && Number.isSafeInteger(row.sequence) && Number(row.sequence) > 0
    && ["initial", "retry"].includes(String(row.phase)) && typeof row.requestSha256 === "string" && /^[a-f0-9]{64}$/.test(row.requestSha256)
    && typeof row.forwarded === "boolean" && typeof row.completedAt === "string" && Number.isFinite(Date.parse(row.completedAt))
    && (row.explicitUserId === undefined || typeof row.explicitUserId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(row.explicitUserId))
    && (row.status === undefined || Number.isInteger(row.status) && Number(row.status) >= 100 && Number(row.status) <= 599);
}
export async function startArchiveFaultControl(input: { selected: readonly string[]; temporaryRoot: string; backendOrigin: string; privateSecrets: string[] }) {
  if (input.selected.length !== 1 || !executionIds.includes(input.selected[0]!) || !origin(input.backendOrigin)) throw new Error("Archive fault is allowlisted only for its owned local execution");
  await privateDirectory(input.temporaryRoot);
  if (/(?:^|[\s,])(?:http|net|tls|undici|\*)(?:$|[\s,])/i.test(process.env.NODE_DEBUG ?? "")) throw new Error("Archive private control refuses raw transport debug output");
  const proxy = await startArchiveFaultProxy(input.backendOrigin), token = randomBytes(32).toString("hex");
  const control = createServer((req, res) => { void (async () => {
    const supplied = req.headers.authorization;
    if (typeof supplied !== "string" || supplied.length !== token.length + 7 || !timingSafeEqual(Buffer.from(supplied.slice(7)), Buffer.from(token)) || !supplied.startsWith("Bearer ")) { res.writeHead(403); res.end(); return; }
    if (req.method !== "POST" || !["/arm", "/receipts", "/release"].includes(req.url ?? "")) { res.writeHead(404); res.end(); return; }
    const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 4096) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString() || "null"); let result: unknown = null;
    if (req.url === "/arm") { if (!validArchiveBinding(value as ArchiveBinding)) throw new Error(); await proxy.arm(value as ArchiveBinding); }
    else { if (value !== null) throw new Error(); if (req.url === "/release") await proxy.releaseForExplicitRetry(); else result = await proxy.receipts(); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result }));
  })().catch(() => { if (!res.headersSent) res.writeHead(409); res.end(JSON.stringify({ error: "Archive control operation rejected" })); }); });
  let filename: string | undefined, created = false;
  try {
    const port = await listenOnFetchAllowedPort(control), controlOrigin = `http://127.0.0.1:${port}`;
    filename = path.join(input.temporaryRoot, "selected-private-inputs", "archive-fault.json");
    input.privateSecrets.push(token, controlOrigin, filename);
    const binding: Binding = { version: 1, executionId: input.selected[0]!, temporaryRoot: input.temporaryRoot, backendOrigin: input.backendOrigin, origin: proxy.origin, controlOrigin, token };
    await writeFile(filename, `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: "wx" }); created = true;
    await privateBinding(filename, input.temporaryRoot, input.selected);
    let closed = false;
    return { filename, proxyOrigin: proxy.origin, async close() { if (closed) return; closed = true; control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve())); await proxy.close(); await rm(filename!, { force: true }); } };
  } catch (error) { control.closeAllConnections(); control.close(); await proxy.close(); if (created && filename) await rm(filename, { force: true }); throw error; }
}
/** Only the test supervisor sees this receipt. The product receives solely the
 * normal API-origin override; never a control filename, URL or bearer. */
export async function archiveServerEnvironment(input: { selected: readonly string[]; temporaryRoot: string; backendOrigin: string; env: NodeJS.ProcessEnv }) {
  const source = { ...input.env }, filename = source[ARCHIVE_CONTROL_ENV]; delete source[ARCHIVE_CONTROL_ENV];
  if (!filename) { if (input.selected.some(id => executionIds.includes(id))) throw new Error("Selected archive case is missing pre-server fault transport"); return { source, overrides: {} }; }
  const binding = await privateBinding(filename, input.temporaryRoot, input.selected);
  if (binding.backendOrigin !== input.backendOrigin) throw new Error("Archive backend origin differs from owned server");
  return { source, overrides: { PAPERCLIP_API_URL: binding.origin } };
}
export async function archiveFaultClient(input: { selected: string; backendOrigin: string; privateSecrets?: string[]; env?: NodeJS.ProcessEnv }): Promise<ArchiveFaultTransport | undefined> {
  const env = input.env ?? process.env, filename = env[ARCHIVE_CONTROL_ENV];
  if (!filename) { if (executionIds.includes(input.selected)) throw new Error("Selected archive case is missing private transport handoff"); return; }
  const binding = await privateBinding(filename, env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT ?? "", [input.selected]);
  if (binding.backendOrigin !== input.backendOrigin) throw new Error("Archive client belongs to another backend");
  input.privateSecrets?.push(binding.token, binding.controlOrigin, filename);
  const request = async (operation: "/arm" | "/receipts" | "/release", value: unknown = null) => {
    try { const response = await fetch(`${binding.controlOrigin}${operation}`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${binding.token}`, "content-type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new Error(); const envelope: unknown = await response.json();
      if (!envelope || typeof envelope !== "object" || Object.keys(envelope).join() !== "result") throw new Error();
      const result = (envelope as { result: unknown }).result;
      if (operation === "/receipts") { if (!Array.isArray(result) || !result.every(validReceipt)) throw new Error(); }
      else if (result !== null) throw new Error();
      return result; }
    catch { throw new Error("Private archive transport control failed"); }
  };
  return { origin: binding.origin, backendOrigin: binding.backendOrigin,
    async arm(value) { await request("/arm", value); }, async receipts() { return await request("/receipts") as ArchiveTransportReceipt[]; }, async releaseForExplicitRetry() { await request("/release"); },
    async close() { /* Launcher owns teardown after the backend has stopped. */ } };
}
