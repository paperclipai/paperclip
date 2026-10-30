import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { antigravityPrivateEnvironment, checkAntigravityPrivateHome, retireAntigravityProcess } from "./antigravity-process.js";
import { antigravityNativeDistributionSpec } from "./antigravity-installation.js";
import { verifyNativeAcpxInstallation, type VerifiedAcpxCommandLease } from "./installation-integrity.js";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPES = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"];
const AUTH_PREFIX = "Open the following link to authenticate the ACP server: ";
const MAX_BYTES = 64 * 1024;
const LOGIN_ERROR = "Google sign-in did not complete. Start sign-in again.";
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const verifiedCredentials = new Map<string, { credential: string; accountEmail: string }>();
const activeBrowserHomes = new Set<string>();

export type AntigravityBrowserLoginState = {
  authorizationUrl?: string;
  outcome?: "success" | "failure";
  error?: string;
  /** Resolves only after physical process retirement and lease release. */
  abort(): Promise<void>;
};

/** Pure validation for the native credential projection and refresh writeback. */
export function sanitizeAntigravityCredential(serialized: string): string {
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Invalid Antigravity credential");
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(serialized)); } catch { throw new Error("Invalid Antigravity credential"); }
  const text = (entry: unknown, max: number): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= max && !/[\x00-\x20\x7f]/.test(entry);
  if (value.client_id !== CLIENT_ID || value.token_uri !== TOKEN_URI
    || !text(value.client_secret, 1024) || !text(value.refresh_token, 16_384)
    || !Array.isArray(value.scopes) || value.scopes.length > 4
    || !value.scopes.every(scope => typeof scope === "string" && [...SCOPES, "openid"].includes(scope))
    || !SCOPES.every(scope => (value.scopes as unknown[]).includes(scope))
    || new Set(value.scopes).size !== value.scopes.length
    || (value.project_id !== undefined && !text(value.project_id, 1024))) throw new Error("Invalid Antigravity credential");
  return JSON.stringify({ client_id: CLIENT_ID, client_secret: value.client_secret, refresh_token: value.refresh_token,
    token_uri: TOKEN_URI, scopes: [...SCOPES, ...((value.scopes as unknown[]).includes("openid") ? ["openid"] : [])], ...(value.project_id !== undefined ? { project_id: value.project_id } : {}) });
}

/** Only the official PKCE loopback authorization URL may reach the browser. */
export function validateAntigravityAuthorizationUrl(raw: string): string {
  if (raw.length > 16_384 || /[\x00-\x20\x7f]/.test(raw)) throw new Error(LOGIN_ERROR);
  const url = new URL(raw), query = url.searchParams;
  const keys = ["client_id", "response_type", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "access_type", "prompt"];
  if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.hash || url.username || url.password
    || [...query.keys()].some(key => !keys.includes(key) || query.getAll(key).length !== 1)
    || query.get("client_id") !== CLIENT_ID || query.get("response_type") !== "code"
    || query.get("access_type") !== "offline" || query.get("prompt") !== "consent"
    || query.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") ?? "")
    || !/^[A-Za-z0-9._~-]{16,1024}$/.test(query.get("state") ?? "")) throw new Error(LOGIN_ERROR);
  const redirect = new URL(query.get("redirect_uri") ?? "");
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || !redirect.port || redirect.pathname !== "/"
    || redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error(LOGIN_ERROR);
  const scopes = (query.get("scope") ?? "").split(" ");
  if (scopes.length > 4 || !SCOPES.every(scope => scopes.includes(scope)) || scopes.some(scope => ![...SCOPES, "openid"].includes(scope))) throw new Error(LOGIN_ERROR);
  return url.href;
}

async function credentialFile(home: string): Promise<string> {
  await checkAntigravityPrivateHome(home);
  const parent = join(home, "antigravity-acp"), stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error("Invalid Antigravity credential");
  // Darwin's O_NOFOLLOW_ANY rejects symlinks in every component, including a
  // concurrently replaced parent. This candidate is macOS ARM64 only.
  const noFollow = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
  const file = await open(join(parent, "acp_token.json"), constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > MAX_BYTES) throw new Error("Invalid Antigravity credential");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error("Invalid Antigravity credential");
    return sanitizeAntigravityCredential(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await file.close(); }
}

async function googleJson(url: string, options: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) throw new Error(LOGIN_ERROR);
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_BYTES) throw new Error(LOGIN_ERROR);
      parts.push(next.value);
    }
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))));
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Refresh and check Google identity privately; this never calls a model API.
 * Callers must also require the setup process's successful authenticate result.
 */
export async function verifyAntigravityCredential(home: string, options: { signal?: AbortSignal } = {}): Promise<{ credential: string; accountEmail: string }> {
  options.signal?.throwIfAborted();
  const credential = await credentialFile(home), cached = verifiedCredentials.get(home);
  if (cached?.credential === credential) return { ...cached };
  const value = record(JSON.parse(credential));
  const token = await googleJson(TOKEN_URI, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: value.refresh_token as string, client_id: CLIENT_ID, client_secret: value.client_secret as string }) });
  if (typeof token.access_token !== "string" || token.access_token.length > 16_384 || /[\x00-\x20\x7f]/.test(token.access_token) || !token.access_token
    || (token.token_type !== undefined && String(token.token_type).toLowerCase() !== "bearer")) throw new Error(LOGIN_ERROR);
  let next = credential;
  if (token.refresh_token !== undefined && token.refresh_token !== value.refresh_token) {
    next = sanitizeAntigravityCredential(JSON.stringify({ ...value, refresh_token: token.refresh_token }));
    // Preserve a consumed rotation before another request can fail. This is a
    // private, unverified receipt until userinfo succeeds; the connection owner
    // still performs identity and generation-checked encrypted writeback.
    await checkAntigravityPrivateHome(home);
    const target = join(home, "antigravity-acp", "acp_token.json"), temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(next);
      await file.sync();
    } finally { await file.close(); }
    try {
      await rename(temporary, target);
      const directory = await open(join(home, "antigravity-acp"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  const identity = await googleJson("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` },
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
  if (identity.email_verified !== true || typeof identity.email !== "string" || identity.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(identity.email)) throw new Error("Google could not verify the signed-in account.");
  const result = { credential: next, accountEmail: identity.email };
  // Runtime refresh checks use short-lived prepared homes. Retain credentials
  // only for an active, bounded browser attempt, whose abort owns eviction.
  if (activeBrowserHomes.has(home)) verifiedCredentials.set(home, result);
  return { ...result };
}

/** A setup-only native ACP client. Its complete outgoing method set is
 * initialize/authenticate; pending provider qualification remains enforced for
 * every session and prompt by the ordinary runtime installation path.
 */
export function startAntigravityBrowserLogin(home: string): AntigravityBrowserLoginState {
  const controller = new AbortController();
  activeBrowserHomes.add(home);
  let resolveStopped: () => void;
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
  const state: AntigravityBrowserLoginState = { abort() { controller.abort(); activeBrowserHomes.delete(home); verifiedCredentials.delete(home); return stopped; } };
  void (async () => {
    let lease: VerifiedAcpxCommandLease | undefined;
    let child: ChildProcessWithoutNullStreams | undefined, closed: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined, failPending: ((error: Error) => void) | undefined;
    try {
      await checkAntigravityPrivateHome(home);
      const installation = await verifyNativeAcpxInstallation(antigravityNativeDistributionSpec());
      lease = await installation.openCommand({ signal: controller.signal });
      const environment = await antigravityPrivateEnvironment(home);
      if (controller.signal.aborted) throw new Error(LOGIN_ERROR);
      child = lease.spawn([], { cwd: home, stdio: "pipe", detached: process.platform !== "win32", env: environment }) as ChildProcessWithoutNullStreams;
      closed = new Promise(resolve => child!.once("close", () => resolve()));
      const peer = child;
      let phase = 1, stdout = "", stderr = "", total = 0, failure: Error | undefined;
      const outputDecoder = new StringDecoder("utf8"), errorDecoder = new StringDecoder("utf8");
      const authenticated = new Promise<void>((resolve, reject) => {
        const fail = (error = new Error(LOGIN_ERROR)) => { failure ??= error; reject(failure); };
        failPending = fail;
        const send = (id: 1 | 2) => peer.stdin.write(`${JSON.stringify(id === 1
          ? { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "paperclip-runner", version: "1" }, clientCapabilities: {} } }
          : { jsonrpc: "2.0", id, method: "authenticate", params: { methodId: "oauth-personal" } })}\n`);
        peer.stdout.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 2 * 1024 * 1024) { fail(); return; }
          stdout += outputDecoder.write(chunk);
          while (stdout.includes("\n") && !failure) {
            const end = stdout.indexOf("\n"), line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
            if (!line.trim()) continue;
            let message: Record<string, unknown>;
            try { message = record(JSON.parse(line)); } catch { fail(); return; }
            if (phase > 2 || message.jsonrpc !== "2.0" || message.id !== phase || "method" in message || "error" in message || !Object.hasOwn(message, "result")) { fail(); return; }
            if (phase === 1) {
              const initialized = record(message.result), info = record(initialized.agentInfo);
              if (initialized.protocolVersion !== 1 || info.name !== "antigravity-acp" || info.version !== "1.4.3"
                || record(record(record(initialized.agentCapabilities)._meta).antigravity).paperclipAdmission !== 1
                || !Array.isArray(initialized.authMethods) || !initialized.authMethods.some(method => record(method).id === "oauth-personal")) { fail(); return; }
              phase = 2; send(2);
            } else { phase = 3; resolve(); }
          }
        });
        peer.stderr.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 2 * 1024 * 1024) { fail(); return; }
          stderr += errorDecoder.write(chunk);
          while (stderr.includes("\n") && !failure) {
            const end = stderr.indexOf("\n"), line = stderr.slice(0, end); stderr = stderr.slice(end + 1);
            if (!line.startsWith(AUTH_PREFIX)) continue;
            try {
              const url = validateAntigravityAuthorizationUrl(line.slice(AUTH_PREFIX.length));
              if (phase !== 2 || state.authorizationUrl !== undefined) throw new Error(LOGIN_ERROR);
              state.authorizationUrl = url;
            } catch { fail(); }
          }
          if (stderr.length > MAX_BYTES) fail();
        });
        peer.once("error", () => fail());
        peer.once("close", () => { if (phase !== 3) fail(); });
        peer.stdin.on("error", () => { if (phase !== 3) fail(); });
        timeout = setTimeout(() => fail(), 360_000);
        send(1);
      });
      const abort = () => failPending?.(new Error(LOGIN_ERROR));
      controller.signal.addEventListener("abort", abort, { once: true });
      try { if (controller.signal.aborted) abort(); await authenticated; }
      finally { controller.signal.removeEventListener("abort", abort); }
      if (timeout) clearTimeout(timeout);
      await retireAntigravityProcess(peer, closed); child = undefined;
      await lease.close(); lease = undefined;
      if (failure || controller.signal.aborted) throw new Error(LOGIN_ERROR);
      await verifyAntigravityCredential(home, { signal: controller.signal });
      if (controller.signal.aborted) throw new Error(LOGIN_ERROR);
      state.outcome = "success";
    } catch {
      state.outcome = "failure"; state.error = LOGIN_ERROR;
    } finally {
      if (timeout) clearTimeout(timeout);
      let observedClose = child === undefined;
      let cleanupWasUncertain = false;
      void closed?.then(() => { observedClose = true; });
      // The active login owns these references until cleanup is proven. Only
      // this unresolved obligation schedules retries; physical close wakes it
      // early. Callers keep the private home while awaiting abort's completion.
      while (true) {
        try {
          if (child && closed) await retireAntigravityProcess(child, closed);
          await lease?.close();
          break;
        } catch {
          cleanupWasUncertain = true;
          state.outcome = "failure";
          state.error = "Google sign-in is still stopping. Wait before trying again.";
          let retryTimer: ReturnType<typeof setTimeout> | undefined;
          const retry = new Promise<void>(resolve => { retryTimer = setTimeout(resolve, 1_000); });
          try { await (observedClose || !closed ? retry : Promise.race([closed, retry])); }
          finally { if (retryTimer) clearTimeout(retryTimer); }
        }
      }
      if (cleanupWasUncertain) state.error = LOGIN_ERROR;
      if (state.outcome !== "success") { activeBrowserHomes.delete(home); verifiedCredentials.delete(home); }
      resolveStopped!();
    }
  })();
  return state;
}
