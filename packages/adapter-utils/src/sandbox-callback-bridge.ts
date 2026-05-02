import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
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

export const DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST: readonly SandboxCallbackBridgeRouteRule[] = [
  { method: "GET", path: /^\/api\/agents\/me$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/heartbeat-context$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/comments(?:\/[^/]+)?$/ },
  { method: "GET", path: /^\/api\/issues\/[^/]+\/documents(?:\/[^/]+)?$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/checkout$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/comments$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/interactions(?:\/[^/]+)?$/ },
  { method: "PATCH", path: /^\/api\/issues\/[^/]+$/ },
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
): Promise<RunProcessResult> {
  return await runner.execute({
    command: "sh",
    args: ["-lc", script],
    cwd,
    timeoutMs,
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
}): SandboxCallbackBridgeQueueClient {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const runChecked = async (action: string, script: string) =>
    requireSuccessfulResult(action, await runShell(input.runner, input.remoteCwd, script, timeoutMs));

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
  responsePath: string,
  response: SandboxCallbackBridgeResponse,
) {
  const tempPath = `${responsePath}.tmp`;
  await client.writeTextFile(tempPath, `${JSON.stringify(response)}\n`);
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

  const processRequestFile = async (fileName: string) => {
    const requestPath = path.posix.join(directories.requestsDir, fileName);
    const responsePath = path.posix.join(directories.responsesDir, fileName);
    const raw = await input.client.readTextFile(requestPath);
    let request: SandboxCallbackBridgeRequest;
    try {
      request = JSON.parse(raw) as SandboxCallbackBridgeRequest;
    } catch {
      const requestId = fileName.replace(/\.json$/i, "") || randomUUID();
      await writeBridgeResponse(input.client, responsePath, {
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
      await writeBridgeResponse(input.client, responsePath, {
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
      await writeBridgeResponse(input.client, responsePath, {
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
      await writeBridgeResponse(input.client, responsePath, {
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
        await writeBridgeResponse(input.client, responsePath, {
          id: typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : requestId,
          status: 503,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: message }),
          completedAt: new Date().toISOString(),
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
  maxQueueDepth?: number | null;
  maxBodyBytes?: number | null;
}): Promise<StartedSandboxCallbackBridgeServer> {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS);
  const directories = sandboxCallbackBridgeDirectories(input.queueDir);
  const remoteEntrypoint = path.posix.join(input.assetRemoteDir, SANDBOX_CALLBACK_BRIDGE_ENTRYPOINT);
  if (input.bridgeAsset) {
    const assetClient = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner: input.runner,
      remoteCwd: input.remoteCwd,
      timeoutMs,
    });
    await assetClient.makeDir(input.assetRemoteDir);
    const entrypointSource = await fs.readFile(input.bridgeAsset.entrypoint, "utf8");
    await assetClient.writeTextFile(remoteEntrypoint, entrypointSource);
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
    command: "sh",
    args: [
      "-lc",
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
    ],
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
        command: "sh",
        args: [
          "-lc",
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
        ],
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
