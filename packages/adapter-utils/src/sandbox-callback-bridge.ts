import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { preferredShellForSandbox, shellCommandArgs } from "./sandbox-shell.js";
import type { RunProcessResult } from "./server-utils.js";

const DEFAULT_BRIDGE_TOKEN_BYTES = 24;
const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 100;
const DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_BRIDGE_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_BRIDGE_MAX_QUEUE_DEPTH = 64;
const DEFAULT_BRIDGE_MAX_BODY_BYTES = 256 * 1024;
const REMOTE_WRITE_BASE64_CHUNK_SIZE = 32 * 1024;
const SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT = "paperclip-bridge-server.mjs";

export const DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES = DEFAULT_BRIDGE_MAX_BODY_BYTES;

export interface SandboxCallbackBridgeRouteRule {
  method: string;
  path: RegExp;
}

// Routes the in-sandbox heartbeat skill is documented to call. The server
// still enforces actor-level permissions on top of this allowlist; the list
// exists to bound the surface area a compromised CLI could reach via the
// reverse bridge. Keep this in sync with the Paperclip skill in
// `skills/paperclip/SKILL.md` and `references/api-reference.md`.
export const DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST: readonly SandboxCallbackBridgeRouteRule[] = [
  // Identity, inbox, agent self-management
  { method: "GET", path: /^\/api\/agents\/me$/ },
  { method: "GET", path: /^\/api\/agents\/me\/inbox-lite$/ },
  { method: "GET", path: /^\/api\/agents\/me\/inbox\/mine$/ },
  { method: "GET", path: /^\/api\/agents\/[^/]+$/ },
  { method: "GET", path: /^\/api\/agents\/[^/]+\/skills$/ },
  { method: "POST", path: /^\/api\/agents\/[^/]+\/skills\/sync$/ },
  { method: "PATCH", path: /^\/api\/agents\/[^/]+\/instructions-path$/ },

  // Company-level reads used to discover work and context
  { method: "GET", path: /^\/api\/companies\/[^/]+$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/dashboard$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/agents$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/issues$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/projects$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/goals$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/org$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/approvals$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/routines$/ },
  { method: "GET", path: /^\/api\/companies\/[^/]+\/skills$/ },
  { method: "GET", path: /^\/api\/projects\/[^/]+$/ },
  { method: "GET", path: /^\/api\/goals\/[^/]+$/ },

  // Issue lifecycle: read context, checkout, update, comment, document, release
  { method: "GET", path: /^\/api\/issues\/[^/]+$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/heartbeat-context$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/comments(?:\/[^/]+)?$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/comments$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/documents(?:\/[^/]+)?$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/documents\/[^/]+\/revisions$/ },
  { method: "PUT", path: /^\/api\/issues\/[^/]+\/documents\/[^/]+$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/checkout$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/release$/ },
  { method: "PATCH", path: /^\/api\/issues\/[^/]+$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/approvals$/ },

  // Issue-thread interactions (suggest tasks, ask questions, request confirmation)
  { method: "GET", path: /^\/api\/issues\/[^/]+\/interactions(?:\/[^/]+)?$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/interactions$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/interactions\/[^/]+\/(?:accept|reject|respond)$/ },

  // Subtasks / delegation
  { method: "POST", path: /^\/api\/companies\/[^/]+\/issues$/ },

  // Approvals (request, read, comment)
  { method: "GET", path: /^\/api\/approvals\/[^/]+$/ },
  { method: "GET", path: /^\/api\/approvals\/[^/]+\/issues$/ },
  { method: "GET", path: /^\/api\/approvals\/[^/]+\/comments$/ },
  { method: "POST", path: /^\/api\/approvals\/[^/]+\/comments$/ },
  { method: "POST", path: /^\/api\/companies\/[^/]+\/approvals$/ },

  // Execution workspaces and runtime services (start/stop/restart dev servers)
  { method: "GET", path: /^\/api\/execution-workspaces\/[^/]+$/ },
  { method: "POST", path: /^\/api\/execution-workspaces\/[^/]+\/runtime-services\/(?:start|stop|restart)$/ },

  // Routines (agents manage their own routines and triggers)
  { method: "GET", path: /^\/api\/routines\/[^/]+$/ },
  { method: "GET", path: /^\/api\/routines\/[^/]+\/runs$/ },
  { method: "POST", path: /^\/api\/companies\/[^/]+\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[^/]+$/ },
  { method: "POST", path: /^\/api\/routines\/[^/]+\/run$/ },
  { method: "POST", path: /^\/api\/routines\/[^/]+\/triggers$/ },
  { method: "PATCH", path: /^\/api\/routine-triggers\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/routine-triggers\/[^/]+$/ },
] as const;

export const DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST = [
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
] as const;

export interface SandboxCallbackBridgeRequest {
  id: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  /**
   * UTF-8 body contents. The bridge rejects non-JSON request bodies; binary
   * payloads are intentionally out of scope for this queue protocol.
   */
  body: string;
  createdAt: string;
}

export interface SandboxCallbackBridgeResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  completedAt: string;
}

export interface SandboxCallbackBridgeAsset {
  localDir: string;
  entrypoint: string;
  cleanup(): Promise<void>;
}

export interface SandboxCallbackBridgeDirectories {
  rootDir: string;
  requestsDir: string;
  responsesDir: string;
  logsDir: string;
  readyFile: string;
  pidFile: string;
  logFile: string;
}

export interface SandboxCallbackBridgeQueueClient {
  makeDir(remotePath: string): Promise<void>;
  listJsonFiles(remotePath: string): Promise<string[]>;
  readTextFile(remotePath: string): Promise<string>;
  writeTextFile(remotePath: string, body: string): Promise<void>;
  writeResponseFile?(
    responsePath: string,
    body: string,
    options?: {
      requestPath?: string | null;
    },
  ): Promise<{ wrote: boolean }>;
  rename(fromPath: string, toPath: string): Promise<void>;
  remove(remotePath: string): Promise<void>;
}

export interface SandboxCallbackBridgeWorkerHandle {
  stop(options?: { drainTimeoutMs?: number }): Promise<void>;
}

export interface StartedSandboxCallbackBridgeServer {
  baseUrl: string;
  host: string;
  port: number;
  pid: number;
  directories: SandboxCallbackBridgeDirectories;
  stop(): Promise<void>;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeMethod(value: string | null | undefined): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toUpperCase() : "GET";
}

function normalizeTimeoutMs(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function toBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function buildRunnerFailureMessage(action: string, result: RunProcessResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const detail = stderr || stdout;
  if (result.timedOut) {
    return `${action} timed out${detail ? `: ${detail}` : ""}`;
  }
  return `${action} failed with exit code ${result.exitCode ?? "null"}${detail ? `: ${detail}` : ""}`;
}

async function runShell(
  runner: CommandManagedRuntimeRunner,
  cwd: string,
  script: string,
  timeoutMs: number,
  shellCommand: "bash" | "sh" = "sh",
  stdin?: string,
): Promise<RunProcessResult> {
  return await runner.execute({
    command: shellCommand,
    args: shellCommandArgs(script),
    cwd,
    timeoutMs,
    stdin,
  });
}

function requireSuccessfulResult(action: string, result: RunProcessResult): RunProcessResult {
  if (!result.timedOut && result.exitCode === 0) return result;
  throw new Error(buildRunnerFailureMessage(action, result));
}

function base64Chunks(body: string): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < body.length; offset += REMOTE_WRITE_BASE64_CHUNK_SIZE) {
    out.push(body.slice(offset, offset + REMOTE_WRITE_BASE64_CHUNK_SIZE));
  }
  return out;
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs.stat(filePath).then(() => true).catch(() => false);
}

function buildRemotePidLockAcquireScript(lockDirExpr: string, timeoutMessage: string): string[] {
  return [
    "attempts=0",
    `while ! mkdir ${lockDirExpr} 2>/dev/null; do`,
    "  holder_pid=\"\"",
    `  if [ -s ${lockDirExpr}/pid ]; then`,
    `    holder_pid="$(cat ${lockDirExpr}/pid 2>/dev/null || true)"`,
    "  fi",
    "  if [ -n \"$holder_pid\" ] && ! kill -0 \"$holder_pid\" 2>/dev/null; then",
    `    rm -rf ${lockDirExpr}`,
    "    continue",
    "  fi",
    "  attempts=$((attempts + 1))",
    "  if [ \"$attempts\" -ge 600 ]; then",
    `    echo ${shellQuote(timeoutMessage)} >&2`,
    "    exit 1",
    "  fi",
    "  sleep 0.05",
    "done",
    `printf '%s\\n' "$$" > ${lockDirExpr}/pid`,
  ];
}

function buildRemotePidLockCleanupScript(lockDirExpr: string, cleanupLines: string[]): string[] {
  return [
    "cleanup() {",
    ...cleanupLines.map((line) => `  ${line}`),
    `  rm -rf ${lockDirExpr}`,
    "}",
    "trap cleanup EXIT INT TERM",
  ];
}

export function createSandboxCallbackBridgeToken(bytes = DEFAULT_BRIDGE_TOKEN_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

export function authorizeSandboxCallbackBridgeRequestWithRoutes(
  request: Pick<SandboxCallbackBridgeRequest, "method" | "path">,
  routes: readonly SandboxCallbackBridgeRouteRule[] = DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
): string | null {
  const method = normalizeMethod(request.method);
  return routes.some((route) => route.method === method && route.path.test(request.path))
    ? null
    : `Route not allowed: ${method} ${request.path}`;
}

export function sanitizeSandboxCallbackBridgeHeaders(
  headers: Record<string, string>,
  allowlist: readonly string[] = DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
): Record<string, string> {
  const allowed = new Set(allowlist.map((header) => header.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => allowed.has(key.toLowerCase())),
  );
}

export function sandboxCallbackBridgeDirectories(rootDir: string): SandboxCallbackBridgeDirectories {
  return {
    rootDir,
    requestsDir: path.posix.join(rootDir, "requests"),
    responsesDir: path.posix.join(rootDir, "responses"),
    logsDir: path.posix.join(rootDir, "logs"),
    readyFile: path.posix.join(rootDir, "ready.json"),
    pidFile: path.posix.join(rootDir, "server.pid"),
    logFile: path.posix.join(rootDir, "logs", "bridge.log"),
  };
}

export function buildSandboxCallbackBridgeEnv(input: {
  queueDir: string;
  bridgeToken: string;
  host?: string;
  port?: number | null;
  pollIntervalMs?: number | null;
  responseTimeoutMs?: number | null;
  maxQueueDepth?: number | null;
  maxBodyBytes?: number | null;
}): Record<string, string> {
  return {
    PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    PAPERCLIP_BRIDGE_QUEUE_DIR: input.queueDir,
    PAPERCLIP_BRIDGE_TOKEN: input.bridgeToken,
    PAPERCLIP_BRIDGE_HOST: input.host?.trim() || "127.0.0.1",
    PAPERCLIP_BRIDGE_PORT: String(input.port && input.port > 0 ? Math.trunc(input.port) : 0),
    PAPERCLIP_BRIDGE_POLL_INTERVAL_MS: String(
      normalizeTimeoutMs(input.pollIntervalMs, DEFAULT_BRIDGE_POLL_INTERVAL_MS),
    ),
    PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS: String(
      normalizeTimeoutMs(input.responseTimeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS),
    ),
    PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH: String(
      normalizeTimeoutMs(input.maxQueueDepth, DEFAULT_BRIDGE_MAX_QUEUE_DEPTH),
    ),
    PAPERCLIP_BRIDGE_MAX_BODY_BYTES: String(
      normalizeTimeoutMs(input.maxBodyBytes, DEFAULT_BRIDGE_MAX_BODY_BYTES),
    ),
  };
}

export async function createSandboxCallbackBridgeAsset(): Promise<SandboxCallbackBridgeAsset> {
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-asset-"));
  const entrypoint = path.join(localDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  await fs.writeFile(entrypoint, getSandboxCallbackBridgeServerSource(), "utf8");
  return {
    localDir,
    entrypoint,
    cleanup: async () => {
      await fs.rm(localDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function createFileSystemSandboxCallbackBridgeQueueClient(): SandboxCallbackBridgeQueueClient {
  return {
    makeDir: async (remotePath) => {
      await fs.mkdir(remotePath, { recursive: true });
    },
    listJsonFiles: async (remotePath) => {
      const entries = await fs.readdir(remotePath, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    },
    readTextFile: async (remotePath) => await fs.readFile(remotePath, "utf8"),
    writeTextFile: async (remotePath, body) => {
      await fs.mkdir(path.posix.dirname(remotePath), { recursive: true });
      await fs.writeFile(remotePath, body, "utf8");
    },
    writeResponseFile: async (responsePath, body, options = {}) => {
      const responseDir = path.posix.dirname(responsePath);
      const tempPath = `${responsePath}.tmp`;
      const lockDir = `${responsePath}.paperclip-write.lock`;
      const lockPidFile = `${lockDir}/pid`;
      if (options.requestPath) {
        const requestExists = await pathExists(options.requestPath);
        if (!requestExists) {
          return { wrote: false };
        }
      }
      await fs.mkdir(responseDir, { recursive: true });
      // PID-liveness mkdir-mutex: mirrors the shell-based bridge mutex so a
      // crashed holder (SIGKILL / OOM) doesn't deadlock subsequent writers
      // for the full timeout window.
      let attempts = 0;
      while (true) {
        try {
          await fs.mkdir(lockDir);
          await fs.writeFile(lockPidFile, `${process.pid}\n`, "utf8");
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code !== "EEXIST") {
            throw error;
          }
          let holderPid: number | null = null;
          try {
            const raw = await fs.readFile(lockPidFile, "utf8");
            const parsed = Number.parseInt(raw.trim(), 10);
            if (Number.isFinite(parsed) && parsed > 0) holderPid = parsed;
          } catch {
            // pid file missing or unreadable — treat as stale lock
          }
          let holderAlive = false;
          if (holderPid !== null) {
            try {
              process.kill(holderPid, 0);
              holderAlive = true;
            } catch {
              holderAlive = false;
            }
          }
          if (!holderAlive) {
            await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
            continue;
          }
          attempts += 1;
          if (attempts >= 600) {
            throw new Error("Timed out acquiring sandbox callback bridge response lock.");
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      try {
        if (options.requestPath) {
          const requestExists = await pathExists(options.requestPath);
          if (!requestExists) {
            return { wrote: false };
          }
        }
        const responseExists = await pathExists(responsePath);
        if (responseExists) {
          return { wrote: false };
        }
        await fs.writeFile(tempPath, body, "utf8");
        await fs.rename(tempPath, responsePath);
        return { wrote: true };
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    rename: async (fromPath, toPath) => {
      await fs.mkdir(path.posix.dirname(toPath), { recursive: true });
      await fs.rename(fromPath, toPath);
    },
    remove: async (remotePath) => {
      await fs.rm(remotePath, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function createCommandManagedSandboxCallbackBridgeQueueClient(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): SandboxCallbackBridgeQueueClient {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const runChecked = async (action: string, script: string) =>
    requireSuccessfulResult(action, await runShell(input.runner, input.remoteCwd, script, timeoutMs, shellCommand));

  return {
    makeDir: async (remotePath) => {
      await runChecked(`mkdir ${remotePath}`, `mkdir -p ${shellQuote(remotePath)}`);
    },
    listJsonFiles: async (remotePath) => {
      const result = await runShell(
        input.runner,
        input.remoteCwd,
        [
          `if [ -d ${shellQuote(remotePath)} ]; then`,
          `  for file in ${shellQuote(remotePath)}/*.json; do`,
          `    [ -f "$file" ] || continue`,
          "    basename \"$file\"",
          "  done",
          "fi",
        ].join("\n"),
        timeoutMs,
        shellCommand,
      );
      requireSuccessfulResult(`list ${remotePath}`, result);
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .sort((left, right) => left.localeCompare(right));
    },
    readTextFile: async (remotePath) => {
      const result = await runChecked(`read ${remotePath}`, `base64 < ${shellQuote(remotePath)}`);
      return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString("utf8");
    },
    writeTextFile: async (remotePath, body) => {
      const remoteDir = path.posix.dirname(remotePath);
      const tempPath = `${remotePath}.paperclip-upload.b64`;
      await runChecked(
        `prepare upload ${remotePath}`,
        `mkdir -p ${shellQuote(remoteDir)} && rm -f ${shellQuote(tempPath)} && : > ${shellQuote(tempPath)}`,
      );
      const base64Body = toBuffer(Buffer.from(body, "utf8")).toString("base64");
      for (const chunk of base64Chunks(base64Body)) {
        await runChecked(
          `append upload chunk ${remotePath}`,
          `printf '%s' ${shellQuote(chunk)} >> ${shellQuote(tempPath)}`,
        );
      }
      await runChecked(
        `finalize upload ${remotePath}`,
        `base64 -d < ${shellQuote(tempPath)} > ${shellQuote(remotePath)} && rm -f ${shellQuote(tempPath)}`,
      );
    },
    writeResponseFile: async (responsePath, body, options = {}) => {
      const responseDir = path.posix.dirname(responsePath);
      const tempPath = `${responsePath}.tmp`;
      const lockDir = `${responsePath}.paperclip-write.lock`;
      const requestPath = options.requestPath?.trim() || "";
      const result = await runShell(
        input.runner,
        input.remoteCwd,
        [
          "set -eu",
          `response_dir=${shellQuote(responseDir)}`,
          `response_path=${shellQuote(responsePath)}`,
          `temp_path=${shellQuote(tempPath)}`,
          `lock_dir=${shellQuote(lockDir)}`,
          `request_path=${shellQuote(requestPath)}`,
          "mkdir -p \"$response_dir\"",
          ...buildRemotePidLockAcquireScript("\"$lock_dir\"", "Timed out acquiring sandbox callback bridge response lock."),
          ...buildRemotePidLockCleanupScript("\"$lock_dir\"", [
            "rm -f \"$temp_path\"",
          ]),
          "if [ -n \"$request_path\" ] && [ ! -f \"$request_path\" ]; then",
          "  printf '{\"wrote\":false}\\n'",
          "  exit 0",
          "fi",
          "if [ -f \"$response_path\" ]; then",
          "  printf '{\"wrote\":false}\\n'",
          "  exit 0",
          "fi",
          "cat > \"$temp_path\"",
          "mv \"$temp_path\" \"$response_path\"",
          "printf '{\"wrote\":true}\\n'",
        ].join("\n"),
        timeoutMs,
        shellCommand,
        body,
      );
      requireSuccessfulResult(`write bridge response ${responsePath}`, result);
      try {
        return {
          wrote: JSON.parse(result.stdout.trim())?.wrote === true,
        };
      } catch (error) {
        throw new Error(
          `Sandbox callback bridge response write wrote invalid result JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    rename: async (fromPath, toPath) => {
      await runChecked(
        `rename ${fromPath}`,
        `mkdir -p ${shellQuote(path.posix.dirname(toPath))} && mv ${shellQuote(fromPath)} ${shellQuote(toPath)}`,
      );
    },
    remove: async (remotePath) => {
      await runChecked(`remove ${remotePath}`, `rm -rf ${shellQuote(remotePath)}`);
    },
  };
}

async function writeBridgeResponse(
  client: SandboxCallbackBridgeQueueClient,
  requestPath: string,
  responsePath: string,
  response: SandboxCallbackBridgeResponse,
  options: { requireRequestPath?: boolean } = {},
) {
  const body = `${JSON.stringify(response)}\n`;
  if (client.writeResponseFile) {
    await client.writeResponseFile(responsePath, body, options.requireRequestPath === false ? {} : { requestPath });
    return;
  }
  const tempPath = `${responsePath}.tmp`;
  await client.writeTextFile(tempPath, body);
  await client.rename(tempPath, responsePath);
}

export async function startSandboxCallbackBridgeWorker(input: {
  client: SandboxCallbackBridgeQueueClient;
  queueDir: string;
  pollIntervalMs?: number | null;
  authorizeRequest?: (request: SandboxCallbackBridgeRequest) => string | null | Promise<string | null>;
  handleRequest: (request: SandboxCallbackBridgeRequest) => Promise<{
    status: number;
    headers?: Record<string, string>;
    body?: string;
  }>;
  maxBodyBytes?: number | null;
}): Promise<SandboxCallbackBridgeWorkerHandle> {
  const pollIntervalMs = normalizeTimeoutMs(input.pollIntervalMs, DEFAULT_BRIDGE_POLL_INTERVAL_MS);
  const maxBodyBytes = normalizeTimeoutMs(input.maxBodyBytes, DEFAULT_BRIDGE_MAX_BODY_BYTES);
  const directories = sandboxCallbackBridgeDirectories(input.queueDir);
  await input.client.makeDir(directories.rootDir);
  await input.client.makeDir(directories.requestsDir);
  await input.client.makeDir(directories.responsesDir);
  await input.client.makeDir(directories.logsDir);

  let stopping = false;
  let inFlight = 0;
  let settled = false;
  let stopDeadline = Number.POSITIVE_INFINITY;
  let settleResolve: (() => void) | null = null;
  const settledPromise = new Promise<void>((resolve) => {
    settleResolve = resolve;
  });
  const authorizeRequest = input.authorizeRequest ??
    ((request: SandboxCallbackBridgeRequest) => authorizeSandboxCallbackBridgeRequestWithRoutes(request));
  const buildWorkerFailureMessage = (error: unknown) =>
    `Sandbox callback bridge worker failed: ${error instanceof Error ? error.message : String(error)}`;

  const processRequestFile = async (fileName: string) => {
    const requestPath = path.posix.join(directories.requestsDir, fileName);
    const responsePath = path.posix.join(directories.responsesDir, fileName);
    const raw = await input.client.readTextFile(requestPath);
    let request: SandboxCallbackBridgeRequest;
    try {
      request = JSON.parse(raw) as SandboxCallbackBridgeRequest;
    } catch {
      const requestId = fileName.replace(/\.json$/i, "") || randomUUID();
      await writeBridgeResponse(input.client, requestPath, responsePath, {
        id: requestId,
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Invalid bridge request payload." }),
        completedAt: new Date().toISOString(),
      });
      await input.client.remove(requestPath);
      return;
    }

    const denialReason = await authorizeRequest(request);
    if (denialReason) {
      await writeBridgeResponse(input.client, requestPath, responsePath, {
        id: request.id,
        status: 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: denialReason }),
        completedAt: new Date().toISOString(),
      });
      await input.client.remove(requestPath);
      return;
    }

    try {
      const result = await input.handleRequest(request);
      const responseBody = result.body ?? "";
      if (Buffer.byteLength(responseBody, "utf8") > maxBodyBytes) {
        throw new Error(`Bridge response body exceeded the configured size limit of ${maxBodyBytes} bytes.`);
      }
      await writeBridgeResponse(input.client, requestPath, responsePath, {
        id: request.id,
        status: result.status,
        headers: result.headers ?? {},
        body: responseBody,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(
        `[paperclip] sandbox callback bridge handler failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await writeBridgeResponse(input.client, requestPath, responsePath, {
        id: request.id,
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        completedAt: new Date().toISOString(),
      });
    } finally {
      await input.client.remove(requestPath);
    }
  };

  const failPendingRequests = async (message: string) => {
    const fileNames = await input.client.listJsonFiles(directories.requestsDir).catch(() => []);
    for (const fileName of fileNames) {
      const requestPath = path.posix.join(directories.requestsDir, fileName);
      const responsePath = path.posix.join(directories.responsesDir, fileName);
      const requestId = fileName.replace(/\.json$/i, "") || randomUUID();
      try {
        const raw = await input.client.readTextFile(requestPath);
        const parsed = JSON.parse(raw) as Partial<SandboxCallbackBridgeRequest>;
        await input.client.remove(requestPath).catch(() => undefined);
        await writeBridgeResponse(input.client, requestPath, responsePath, {
          id: typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : requestId,
          status: 503,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: message }),
          completedAt: new Date().toISOString(),
        }, {
          requireRequestPath: false,
        });
      } catch (error) {
        console.warn(
          `[paperclip] sandbox callback bridge failed to abort pending request ${requestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await input.client.remove(requestPath).catch(() => undefined);
      }
    }
  };

  const loop = (async () => {
    try {
      while (true) {
        const fileNames = await input.client.listJsonFiles(directories.requestsDir);
        if (fileNames.length === 0) {
          if (stopping) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }
        for (const fileName of fileNames) {
          if (stopping && Date.now() >= stopDeadline) break;
          inFlight += 1;
          try {
            await processRequestFile(fileName);
          } finally {
            inFlight -= 1;
          }
        }
        if (stopping && Date.now() >= stopDeadline) {
          break;
        }
      }
    } catch (error) {
      const message = buildWorkerFailureMessage(error);
      console.warn(`[paperclip] ${message}`);
      try {
        await failPendingRequests(message);
      } catch (failPendingError) {
        console.warn(
          `[paperclip] sandbox callback bridge failed to abort queued requests after worker failure: ${failPendingError instanceof Error ? failPendingError.message : String(failPendingError)}`,
        );
      }
    } finally {
      settled = true;
      if (settleResolve) {
        settleResolve();
      }
    }
  })();

  void loop;

  return {
    stop: async (options = {}) => {
      stopping = true;
      const drainMs = normalizeTimeoutMs(options.drainTimeoutMs, DEFAULT_BRIDGE_STOP_TIMEOUT_MS);
      stopDeadline = Date.now() + drainMs;
      if (!settled) {
        await Promise.race([
          settledPromise,
          new Promise<void>((resolve) => setTimeout(resolve, drainMs)),
        ]);
      }
      await failPendingRequests("Bridge worker stopped before request could be handled.");
    },
  };
}

export async function syncSandboxCallbackBridgeEntrypoint(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  assetRemoteDir: string;
  bridgeAsset: SandboxCallbackBridgeAsset;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): Promise<{ remoteEntrypoint: string; sha256: string; uploaded: boolean }> {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const remoteEntrypoint = path.posix.join(input.assetRemoteDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  const remoteEntrypointPartial = `${remoteEntrypoint}.partial`;
  const remoteUploadPath = `${remoteEntrypoint}.paperclip-upload.b64`;
  const remoteLockDir = path.posix.join(input.assetRemoteDir, ".paperclip-bridge-upload.lock");
  const entrypointSource = await fs.readFile(input.bridgeAsset.entrypoint, "utf8");
  const entrypointBase64 = toBuffer(Buffer.from(entrypointSource, "utf8")).toString("base64");
  const sha256 = createHash("sha256").update(entrypointSource, "utf8").digest("hex");

  const syncResult = await runShell(
    input.runner,
    input.remoteCwd,
    [
      "set -eu",
      `remote_dir=${shellQuote(input.assetRemoteDir)}`,
      `remote_path=${shellQuote(remoteEntrypoint)}`,
      `remote_partial=${shellQuote(remoteEntrypointPartial)}`,
      `remote_upload=${shellQuote(remoteUploadPath)}`,
      `lock_dir=${shellQuote(remoteLockDir)}`,
      `expected_sha=${shellQuote(sha256)}`,
      "hash_file() {",
      "  if command -v sha256sum >/dev/null 2>&1; then",
      "    sha256sum \"$1\" | awk '{print $1}'",
      "    return 0",
      "  fi",
      "  if command -v shasum >/dev/null 2>&1; then",
      "    shasum -a 256 \"$1\" | awk '{print $1}'",
      "    return 0",
      "  fi",
      "  return 127",
      "}",
      "mkdir -p \"$remote_dir\"",
      ...buildRemotePidLockAcquireScript("\"$lock_dir\"", "Timed out acquiring sandbox callback bridge upload lock."),
      ...buildRemotePidLockCleanupScript("\"$lock_dir\"", [
        "rm -f \"$remote_upload\" \"$remote_partial\"",
      ]),
      "current_sha=\"\"",
      "if [ -f \"$remote_path\" ]; then",
      "  current_sha=\"$(hash_file \"$remote_path\" 2>/dev/null)\" || current_sha=\"\"",
      "fi",
      "if [ -n \"$current_sha\" ] && [ \"$current_sha\" = \"$expected_sha\" ]; then",
      "  printf '{\"uploaded\":false}\\n'",
      "  exit 0",
      "fi",
      "rm -f \"$remote_upload\" \"$remote_partial\"",
      "cat > \"$remote_upload\"",
      "base64 -d < \"$remote_upload\" > \"$remote_partial\"",
      // Verify upload integrity. If neither sha256sum nor shasum is on PATH
      // (minimal Alpine/scratch images), surface the missing-tool error
      // instead of a misleading "sha mismatch" — the verify step is then
      // best-effort and we trust base64-decode + atomic rename below.
      "if partial_sha=\"$(hash_file \"$remote_partial\" 2>/dev/null)\"; then",
      "  if [ \"$partial_sha\" != \"$expected_sha\" ]; then",
      "    echo \"Sandbox callback bridge entrypoint upload sha mismatch.\" >&2",
      "    exit 1",
      "  fi",
      "else",
      "  echo \"Sandbox callback bridge entrypoint sha verify skipped: no sha256sum/shasum on remote.\" >&2",
      "fi",
      "mv \"$remote_partial\" \"$remote_path\"",
      "printf '{\"uploaded\":true}\\n'",
    ].join("\n"),
    timeoutMs,
    shellCommand,
    entrypointBase64,
  );
  requireSuccessfulResult("sync sandbox callback bridge entrypoint", syncResult);

  let uploaded = false;
  try {
    uploaded = JSON.parse(syncResult.stdout.trim())?.uploaded === true;
  } catch (error) {
    throw new Error(
      `Sandbox callback bridge sync wrote invalid result JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    remoteEntrypoint,
    sha256,
    uploaded,
  };
}

export async function startSandboxCallbackBridgeServer(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  assetRemoteDir: string;
  queueDir: string;
  bridgeToken: string;
  bridgeAsset?: SandboxCallbackBridgeAsset | null;
  host?: string;
  port?: number | null;
  pollIntervalMs?: number | null;
  responseTimeoutMs?: number | null;
  timeoutMs?: number | null;
  nodeCommand?: string;
  shellCommand?: "bash" | "sh" | null;
  maxQueueDepth?: number | null;
  maxBodyBytes?: number | null;
}): Promise<StartedSandboxCallbackBridgeServer> {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const shellCommand = preferredShellForSandbox(input.shellCommand);
  const directories = sandboxCallbackBridgeDirectories(input.queueDir);
  let remoteEntrypoint = path.posix.join(input.assetRemoteDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  if (input.bridgeAsset) {
    const assetSync = await syncSandboxCallbackBridgeEntrypoint({
      runner: input.runner,
      remoteCwd: input.remoteCwd,
      assetRemoteDir: input.assetRemoteDir,
      bridgeAsset: input.bridgeAsset,
      timeoutMs,
      shellCommand,
    });
    remoteEntrypoint = assetSync.remoteEntrypoint;
  }
  const env = buildSandboxCallbackBridgeEnv({
    queueDir: input.queueDir,
    bridgeToken: input.bridgeToken,
    host: input.host,
    port: input.port,
    pollIntervalMs: input.pollIntervalMs,
    responseTimeoutMs: input.responseTimeoutMs,
    maxQueueDepth: input.maxQueueDepth,
    maxBodyBytes: input.maxBodyBytes,
  });
  const nodeCommand = input.nodeCommand?.trim() || "node";
  const startResult = await input.runner.execute({
    command: shellCommand,
    args: shellCommandArgs(
      [
        `mkdir -p ${shellQuote(directories.requestsDir)} ${shellQuote(directories.responsesDir)} ${shellQuote(directories.logsDir)}`,
        `rm -f ${shellQuote(directories.readyFile)} ${shellQuote(directories.pidFile)}`,
        `nohup env ${Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} ` +
          `${shellQuote(nodeCommand)} ${shellQuote(remoteEntrypoint)} ` +
          `>> ${shellQuote(directories.logFile)} 2>&1 < /dev/null &`,
        "pid=$!",
        `printf '%s\\n' \"$pid\" > ${shellQuote(directories.pidFile)}`,
        "printf '{\"pid\":%s}\\n' \"$pid\"",
      ].join("\n"),
    ),
    cwd: input.remoteCwd,
    timeoutMs,
  });
  requireSuccessfulResult("start sandbox callback bridge", startResult);

  const readyResult = await runShell(
    input.runner,
    input.remoteCwd,
    [
      "i=0",
      `while [ \"$i\" -lt 200 ]; do`,
      `  if [ -s ${shellQuote(directories.readyFile)} ]; then`,
      `    cat ${shellQuote(directories.readyFile)}`,
      "    exit 0",
      "  fi",
      `  if [ -s ${shellQuote(directories.logFile)} ] && ! kill -0 \"$(cat ${shellQuote(directories.pidFile)} 2>/dev/null)\" 2>/dev/null; then`,
      `    cat ${shellQuote(directories.logFile)} >&2`,
      "    exit 1",
      "  fi",
      "  i=$((i + 1))",
      "  sleep 0.05",
      "done",
      `echo "Timed out waiting for bridge readiness." >&2`,
      `if [ -s ${shellQuote(directories.logFile)} ]; then cat ${shellQuote(directories.logFile)} >&2; fi`,
      "exit 1",
    ].join("\n"),
    timeoutMs,
    shellCommand,
  );
  requireSuccessfulResult("wait for sandbox callback bridge readiness", readyResult);

  let readyData: { host?: string; port?: number; baseUrl?: string; pid?: number };
  try {
    readyData = JSON.parse(readyResult.stdout.trim()) as { host?: string; port?: number; baseUrl?: string; pid?: number };
  } catch (error) {
    throw new Error(
      `Sandbox callback bridge wrote invalid readiness JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const host = typeof readyData.host === "string" && readyData.host.trim().length > 0
    ? readyData.host.trim()
    : "127.0.0.1";
  const port = typeof readyData.port === "number" && Number.isFinite(readyData.port) ? readyData.port : 0;
  if (!port) {
    throw new Error("Sandbox callback bridge did not report a listening port.");
  }
  const baseUrl =
    typeof readyData.baseUrl === "string" && readyData.baseUrl.trim().length > 0
      ? readyData.baseUrl.trim()
      : `http://${host}:${port}`;

  return {
    baseUrl,
    host,
    port,
    pid: typeof readyData.pid === "number" && Number.isFinite(readyData.pid) ? readyData.pid : 0,
    directories,
    stop: async () => {
      const stopResult = await input.runner.execute({
        command: shellCommand,
        args: shellCommandArgs(
          [
            `if [ -s ${shellQuote(directories.pidFile)} ]; then`,
            `  pid="$(cat ${shellQuote(directories.pidFile)})"`,
            "  kill \"$pid\" 2>/dev/null || true",
            "  i=0",
            "  while kill -0 \"$pid\" 2>/dev/null && [ \"$i\" -lt 40 ]; do",
            "    i=$((i + 1))",
            "    sleep 0.05",
            "  done",
            "fi",
            `rm -f ${shellQuote(directories.pidFile)} ${shellQuote(directories.readyFile)}`,
          ].join("\n"),
        ),
        cwd: input.remoteCwd,
        timeoutMs,
      });
      if (stopResult.timedOut) {
        throw new Error(buildRunnerFailureMessage("stop sandbox callback bridge", stopResult));
      }
    },
  };
}

function getSandboxCallbackBridgeServerSource(): string {
  return `import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

const queueDir = process.env.PAPERCLIP_BRIDGE_QUEUE_DIR;
const bridgeToken = process.env.PAPERCLIP_BRIDGE_TOKEN;
const host = process.env.PAPERCLIP_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.PAPERCLIP_BRIDGE_PORT || "0");
const pollIntervalMs = Number(process.env.PAPERCLIP_BRIDGE_POLL_INTERVAL_MS || "100");
const responseTimeoutMs = Number(process.env.PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS || "30000");
const maxQueueDepth = Number(process.env.PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH || "${DEFAULT_BRIDGE_MAX_QUEUE_DEPTH}");
const maxBodyBytes = Number(process.env.PAPERCLIP_BRIDGE_MAX_BODY_BYTES || "${DEFAULT_BRIDGE_MAX_BODY_BYTES}");
const allowedHeaders = new Set(${JSON.stringify([...DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST])});

if (!queueDir || !bridgeToken) {
  throw new Error("PAPERCLIP_BRIDGE_QUEUE_DIR and PAPERCLIP_BRIDGE_TOKEN are required.");
}

const requestsDir = path.posix.join(queueDir, "requests");
const responsesDir = path.posix.join(queueDir, "responses");
const logsDir = path.posix.join(queueDir, "logs");
const readyFile = path.posix.join(queueDir, "ready.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    const normalizedKey = key.toLowerCase();
    if (!allowedHeaders.has(normalizedKey)) {
      continue;
    }
    out[normalizedKey] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(nextChunk);
    totalBytes += nextChunk.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new Error("Bridge request body exceeded the configured size limit.");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function queueDepth() {
  const entries = await fs.readdir(requestsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
}

function tokensMatch(received) {
  const expected = Buffer.from(bridgeToken, "utf8");
  const actual = Buffer.from(typeof received === "string" ? received : "", "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

async function waitForResponse(requestId) {
  const responsePath = path.posix.join(responsesDir, \`\${requestId}.json\`);
  const deadline = Date.now() + responseTimeoutMs;
  while (Date.now() < deadline) {
    const body = await fs.readFile(responsePath, "utf8").catch(() => null);
    if (body != null) {
      await fs.rm(responsePath, { force: true }).catch(() => undefined);
      return JSON.parse(body);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error("Timed out waiting for host bridge response.");
}

const server = createServer(async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const receivedToken = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!tokensMatch(receivedToken)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Invalid bridge token." }));
      return;
    }

    if (await queueDepth() >= maxQueueDepth) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Bridge request queue is full." }));
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
    if (req.method && req.method !== "GET" && req.method !== "HEAD" && !/json/i.test(contentType)) {
      res.statusCode = 415;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Bridge only accepts JSON request bodies." }));
      return;
    }
    const requestId = randomUUID();
    const requestBody = await readBody(req);
    const payload = {
      id: requestId,
      method: req.method || "GET",
      path: url.pathname,
      query: url.search,
      headers: normalizeHeaders(req.headers),
      body: requestBody,
      createdAt: new Date().toISOString(),
    };
    const requestPath = path.posix.join(requestsDir, \`\${requestId}.json\`);
    const tempPath = \`\${requestPath}.tmp\`;
    await fs.writeFile(tempPath, \`\${JSON.stringify(payload)}\\n\`, "utf8");
    await fs.rename(tempPath, requestPath);

    const response = await waitForResponse(requestId);
    res.statusCode = typeof response.status === "number" ? response.status : 200;
    for (const [key, value] of Object.entries(response.headers || {})) {
      if (typeof value !== "string" || key.toLowerCase() === "content-length") continue;
      res.setHeader(key, value);
    }
    res.end(typeof response.body === "string" ? response.body : "");
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

async function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await fs.mkdir(requestsDir, { recursive: true });
await fs.mkdir(responsesDir, { recursive: true });
await fs.mkdir(logsDir, { recursive: true });

server.listen(port, host, async () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Bridge server did not expose a TCP address.");
  }
  const ready = {
    pid: process.pid,
    host,
    port: address.port,
    baseUrl: \`http://\${host}:\${address.port}\`,
    startedAt: new Date().toISOString(),
  };
  const tempReadyFile = \`\${readyFile}.tmp\`;
  await fs.writeFile(tempReadyFile, JSON.stringify(ready), "utf8");
  await fs.rename(tempReadyFile, readyFile);
});`;
}
