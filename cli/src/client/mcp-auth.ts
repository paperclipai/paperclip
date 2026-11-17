import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PUBLIC_MCP_PATH, PUBLIC_MCP_SCOPES } from "@paperclipai/shared";
import { resolvePaperclipHomeDir } from "../config/home.js";

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
type Json = Record<string, unknown>;
export interface McpCredential {
  resource: string; issuer: string; clientId: string; companyId: string;
  accessToken: string; refreshToken?: string; expiresAt: number;
}
export function mcpResource(raw: string) {
  const url = new URL(raw);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== PUBLIC_MCP_PATH) throw new Error("Use the exact Paperclip HTTPS MCP URL from Connections.");
  return url.toString();
}
export function credentialPath(resource: string) {
  return path.join(resolvePaperclipHomeDir(), "mcp", createHash("sha256").update(resource).digest("hex") + ".json");
}
async function readCredential(file: string): Promise<McpCredential | null> {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("MCP credential file must be private (mode 0600).");
    let value: McpCredential;
    try { value = JSON.parse(await handle.readFile("utf8")); }
    catch { throw new Error("Invalid MCP credential file. Sign in again."); }
    if (!value || typeof value !== "object" || ![value.resource, value.issuer, value.clientId, value.companyId, value.accessToken].every(v => typeof v === "string" && v.length > 0)
      || !Number.isFinite(value.expiresAt) || (value.refreshToken !== undefined && typeof value.refreshToken !== "string")) throw new Error("Invalid MCP credential file. Sign in again.");
    return value;
  } finally { await handle.close(); }
}
async function saveCredential(file: string, credential: McpCredential) {
  const temporary = file + "." + randomUUID();
  try {
    await fs.writeFile(temporary, JSON.stringify(credential), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

/** One refresh owner per resource, including independent CLI/bridge processes. */
const processLocks = new Map<string, Promise<void>>();
export async function withMcpCredentialLock<T>(file: string, work: () => Promise<T>) {
  const key = path.resolve(file);
  const previous = processLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  processLocks.set(key, current);
  await previous;
  try { return await withMcpOsLock(key, work); }
  finally {
    release();
    if (processLocks.get(key) === current) processLocks.delete(key);
  }
}

async function withMcpOsLock<T>(file: string, work: () => Promise<T>) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("The MCP credential directory must be private (mode 0700).");
  // SQLite's OS lock is released when a process exits, including during acquisition.
  // No PID-file deletion or stale-lock takeover can race a new refresh owner.
  const lockPath = file + ".mutex.sqlite";
  // Never open/close an existing SQLite file outside SQLite: POSIX close can
  // release another connection's process-owned lock. The in-process queue also
  // serializes initial file creation before any SQLite descriptor is opened.
  try {
    await fs.writeFile(lockPath, "", { flag: "wx", mode: 0o600 });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const lockStat = await fs.lstat(lockPath);
  if (!lockStat.isFile() || lockStat.isSymbolicLink() || (lockStat.mode & 0o077) !== 0) throw new Error("The MCP mutex file must be private (mode 0600).");
  const lock = new DatabaseSync(lockPath);
  const deadline = Date.now() + 30_000;
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    while (true) {
      try { lock.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
        if (Date.now() >= deadline) throw new Error("Another Paperclip MCP login or refresh is in progress. Try again.");
        await sleep(100);
      }
    }
    try { return await work(); }
    finally { lock.exec("ROLLBACK"); }
  } finally { lock.close(); }

}

async function jsonRequest(url: string, body?: Json) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000),
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await safeJson(response);
  return { ok: response.ok, data };
}
async function safeJson(response: Response): Promise<Json> {
  try {
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Json;
  } catch { throw new Error("Paperclip returned an invalid response. Check the connection before retrying."); }
}
async function revoke(credential: McpCredential) {
  const response = await fetch(credential.issuer + "/mcp/oauth/revoke", { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: credential.clientId, token: credential.refreshToken ?? credential.accessToken }) });
  if (!response.ok) throw new Error("Could not revoke the previous connection.");
}
async function discovery(resource: string) {
  const origin = new URL(resource).origin;
  const protectedResource = await jsonRequest(origin + "/.well-known/oauth-protected-resource" + PUBLIC_MCP_PATH);
  if (!protectedResource.ok || protectedResource.data.resource !== resource || !Array.isArray(protectedResource.data.authorization_servers)
    || !protectedResource.data.authorization_servers.includes(origin)) throw new Error("Paperclip resource discovery does not match this instance.");
  const metadata = await jsonRequest(origin + "/.well-known/oauth-authorization-server");
  if (!metadata.ok || metadata.data.issuer !== origin || metadata.data.token_endpoint !== origin + "/mcp/oauth/token"
    || metadata.data.device_authorization_endpoint !== origin + "/mcp/oauth/device_authorization"
    || metadata.data.registration_endpoint !== origin + "/mcp/oauth/register") throw new Error("This Paperclip instance does not support device login.");
  return origin;
}
function tokens(data: Json, credential: Omit<McpCredential, "accessToken" | "expiresAt">): McpCredential {
  if (typeof data.access_token !== "string" || data.token_type !== "Bearer" || typeof data.expires_in !== "number" || data.expires_in <= 0) throw new Error("Invalid Paperclip token response. Reconnect.");
  return { ...credential, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000,
    ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}) };
}
export async function mcpRpc(resource: string, token: string, method: string, params: Json = {}) {
  const version = "2026-07-28";
  const response = await fetch(resource, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "MCP-Protocol-Version": version, "Mcp-Method": method,
      ...(method === "tools/call" && typeof params.name === "string" ? { "Mcp-Name": params.name } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "Paperclip CLI", version: "1" },
    } } }),
  });
  if (!response.ok) throw new Error(`Paperclip MCP returned HTTP ${response.status}. Check the connection before retrying; a write may already have completed.`);
  const data = await safeJson(response);
  if (data.error || !data.result || typeof data.result !== "object") throw new Error("Paperclip could not complete this MCP request. Check the connection before retrying.");
  return data.result as Json;
}

export async function loginMcpDevice(raw: string, companyId?: string, notify: (message: string) => void = console.error) {
  const resource = mcpResource(raw);
  const issuer = await discovery(resource);
  const registration = await jsonRequest(issuer + "/mcp/oauth/register", { client_name: "Paperclip CLI (device)", redirect_uris: [], grant_types: [deviceGrant, "refresh_token"], response_types: [], token_endpoint_auth_method: "none" });
  if (!registration.ok || typeof registration.data.client_id !== "string") throw new Error("Could not register the Paperclip device client.");
  const clientId = registration.data.client_id;
  const authorization = await jsonRequest(issuer + "/mcp/oauth/device_authorization", { client_id: clientId, resource, scope: PUBLIC_MCP_SCOPES.join(" "), ...(companyId ? { company_id: companyId } : {}) });
  const device = authorization.data;
  if (!authorization.ok || typeof device.device_code !== "string" || typeof device.user_code !== "string"
    || device.verification_uri !== issuer + "/mcp-device" || typeof device.expires_in !== "number") throw new Error("Could not start device authorization.");
  const verification = new URL(device.verification_uri); verification.searchParams.set("user_code", device.user_code);
  notify(`Approve Paperclip access in your browser: ${verification}\nConfirm code: ${device.user_code}\nWaiting for your approval…`);
  let interval = typeof device.interval === "number" ? Math.max(5, device.interval) : 5;
  const deadline = Date.now() + Math.min(600, device.expires_in) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const result = await jsonRequest(issuer + "/mcp/oauth/token", { grant_type: deviceGrant, client_id: clientId, resource, device_code: device.device_code });
    if (!result.ok) {
      if (result.data.error === "authorization_pending") continue;
      if (result.data.error === "slow_down") { interval += 5; continue; }
      throw new Error(result.data.error === "access_denied" ? "Connection declined. No access was granted." : "Device authorization expired or failed. Start login again.");
    }
    const credential = tokens(result.data, { resource, issuer, clientId, companyId: companyId ?? "" });
    const identity = await mcpRpc(resource, credential.accessToken, "tools/call", { name: "paperclip_connection", arguments: {} });
    const connected = identity.structuredContent as Json | undefined;
    if (identity.isError || typeof connected?.companyId !== "string" || (companyId && connected.companyId !== companyId)) throw new Error("The approved organization did not match. Reconnect before doing work.");
    credential.companyId = connected.companyId;
    const file = credentialPath(resource);
    await replaceMcpCredential(file, credential, notify);
    return { resource, companyId: credential.companyId };
  }
  throw new Error("Device authorization expired. Start login again.");
}

export async function replaceMcpCredential(file: string, credential: McpCredential, notify: (message: string) => void) {
  await withMcpCredentialLock(file, async () => {
    const previous = await readCredential(file);
    // Persist the working replacement before changing authority on the server.
    await saveCredential(file, credential);
    if (previous && previous.resource === credential.resource && previous.issuer === credential.issuer) {
      try { await revoke(previous); }
      catch { notify("Connected. The previous connection could not be revoked; revoke it in Paperclip Connections."); }
    }
  });
}

export async function mcpAccessToken(raw: string) {
  const resource = mcpResource(raw);
  const file = credentialPath(resource);
  return withMcpCredentialLock(file, async () => {
    const credential = await readCredential(file);
    if (!credential || credential.resource !== resource || credential.issuer !== new URL(resource).origin) throw new Error("Connect first with paperclipai mcp login --device --url <MCP URL>.");
    if (credential.expiresAt > Date.now() + 30_000) return credential.accessToken;
    if (!credential.refreshToken) throw new Error("Paperclip access expired. Sign in again.");
    // Validate issuer discovery again before sending a stored credential.
    await discovery(resource);
    const result = await jsonRequest(credential.issuer + "/mcp/oauth/token", { grant_type: "refresh_token", client_id: credential.clientId, resource, refresh_token: credential.refreshToken });
    if (!result.ok) throw new Error("Paperclip access was revoked or expired. Sign in again.");
    const updated = tokens(result.data, credential);
    await saveCredential(file, updated);
    return updated.accessToken;
  });
}
