#!/usr/bin/env node
//
// A script-based proof of the Codex device-login path inside a Daytona sandbox.
// The script wires the real Daytona SDK to the injected SandboxLoginDriver, runs
// the device login, installs the credential into a run-scoped proof home, and
// proves the saved credential authenticates in a second sandbox. A live
// validation step runs this script; the unit-tested logic lives in the parser,
// the runner, and the export modules.
//
// This is a development-only proof tool. It is not part of the shipped adapter
// runtime. The environment lookup uses the workspace database client, a
// devDependency. The Daytona SDK loads at run time through a dynamic import
// (see loadDaytonaClient), so the adapter never declares the heavy Daytona SDK
// dependency. To run the proof, install `@daytonaio/sdk` (version `0.203.0`) so
// the default module specifier resolves, or set `PAPERCLIP_DAYTONA_SDK_MODULE`
// to a resolvable module path.
//
// Security (Control 1): the script treats all sandbox output as secret-bearing.
// It streams the login output to the runner in memory only, through a Daytona
// exec path that does not persist the raw output to a durable session log. It
// writes the login URL and the one-time code only to the controlling terminal,
// and it exits non-zero, before any sandbox provisioning, when no controlling
// terminal exists. It never writes the URL, the code, or a token to standard
// output, standard error, or an artifact.
//
// Security (Control 2): the script never reads the Codex home from an argument.
// It calls deriveProofHome() for a unique, run-scoped home under a
// company-scoped root. It deletes the proof home and every sandbox in a finally
// block on success, timeout, cancellation, and error.

import { closeSync, openSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, environments } from "@paperclipai/db";
import { codexHomeHasUsableAuth } from "../server/codex-home.js";
import {
  deriveProofHome,
  installDeviceLoginCredential,
  removeProofHome,
} from "../server/device-login-export.js";
import {
  runDeviceLogin,
  type DeviceLoginPromptSink,
  type SandboxLoginDriver,
} from "../server/device-login-runner.js";
import { type DeviceLoginPrompt } from "../server/device-login-parse.js";

// A minimal, local view of the Daytona SDK. These interfaces mirror the exact
// method signatures the proof uses in `@daytonaio/sdk` version `0.203.0`. The
// script binds to them so the adapter never declares the SDK as a build-time
// dependency; the concrete SDK loads at run time in loadDaytonaClient.
interface DaytonaCommandStatus {
  exitCode?: number;
}
interface DaytonaExecuteResponse {
  cmdId?: string;
}
interface DaytonaSandboxProcess {
  createSession(sessionId: string): Promise<void>;
  executeSessionCommand(
    sessionId: string,
    request: { command: string; runAsync?: boolean },
    timeout?: number,
  ): Promise<DaytonaExecuteResponse>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void>;
  getSessionCommand(sessionId: string, commandId: string): Promise<DaytonaCommandStatus>;
  deleteSession(sessionId: string): Promise<void>;
}
interface DaytonaSandboxFs {
  downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
  uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
}
interface DaytonaSandbox {
  readonly process: DaytonaSandboxProcess;
  readonly fs: DaytonaSandboxFs;
  delete(timeout?: number): Promise<void>;
}
interface DaytonaClientConfig {
  apiKey: string;
  apiUrl?: string;
  target?: string;
}
interface DaytonaResources {
  cpu?: number;
  memory?: number;
  disk?: number;
  gpu?: number;
}
interface DaytonaCreateParams {
  labels?: Record<string, string>;
  image?: string;
  snapshot?: string;
  resources?: DaytonaResources;
}
interface DaytonaClient {
  create(params: DaytonaCreateParams, options?: { timeout?: number }): Promise<DaytonaSandbox>;
}
interface DaytonaModule {
  Daytona: new (config: DaytonaClientConfig) => DaytonaClient;
}

// A fixed sandbox Codex home. The login command sets CODEX_HOME to this path, so
// the script reads the credential back from one known location.
const SANDBOX_CODEX_HOME = "/tmp/paperclip-codex-device-login";
const AUTH_PATH_IN_SANDBOX = `${SANDBOX_CODEX_HOME}/auth.json`;
// The host-side timeout for the whole login. It exceeds the sandbox-side bound.
const LOGIN_TIMEOUT_MS = 180_000;
// The Daytona SDK timeout for one create, exec, read, or delete, in seconds.
const SANDBOX_OP_TIMEOUT_SECONDS = 180;
// The sandbox-side bound on the login command, in seconds. It stays below the
// SDK operation timeout so the command ends first.
const SANDBOX_LOGIN_BOUND_SECONDS = 150;

function fail(message: string): never {
  process.stderr.write(`device-login-proof: ${message}\n`);
  process.exit(1);
}

function status(line: string): void {
  process.stdout.write(`device-login-proof: ${line}\n`);
}

/**
 * Opens the controlling terminal for writing. Exits non-zero when no controlling
 * terminal exists, so the login URL and the code never reach standard output,
 * standard error, or a log (Control 1).
 */
function openControllingTerminal(): number {
  try {
    return openSync("/dev/tty", "w");
  } catch {
    return fail(
      "no controlling terminal; refusing to run so the login URL and code never reach a log.",
    );
  }
}

/**
 * Returns a prompt sink that writes the login URL and the one-time code to the
 * controlling terminal only. It never writes them to standard output or standard
 * error.
 */
function createTerminalPromptSink(ttyFd: number): DeviceLoginPromptSink {
  return (prompt: DeviceLoginPrompt): void => {
    writeSync(
      ttyFd,
      `\nOpen this URL in a browser and sign in:\n  ${prompt.url}\n` +
        `Enter this one-time code:\n  ${prompt.code}\n\n`,
    );
  };
}

/**
 * Binds the injected {@link SandboxLoginDriver} to the confirmed non-persisting
 * Daytona exec path, the file read, and the sandbox delete.
 *
 * The exec path streams standard output to the runner through
 * `getSessionCommandLogs` in-memory callbacks. It never forwards the raw output
 * to the plugin host log sink, so the raw output never reaches a durable session
 * log. The sandbox delete in the caller's finally block removes the Daytona-side
 * session logs as well.
 */
class DaytonaLoginDriver implements SandboxLoginDriver {
  constructor(private readonly sandbox: DaytonaSandbox) {}

  async execStreaming(
    command: string,
    onStdout: (chunk: string) => void,
  ): Promise<{ exitCode: number | null }> {
    const sessionId = `paperclip-device-login-${randomUUID()}`;
    await this.sandbox.process.createSession(sessionId);
    try {
      const dispatched = await this.sandbox.process.executeSessionCommand(
        sessionId,
        { command, runAsync: true },
        SANDBOX_OP_TIMEOUT_SECONDS,
      );
      const commandId = dispatched.cmdId;
      if (!commandId) {
        throw new Error("the sandbox did not return a command id");
      }
      // In-memory stream only. Discard the stderr stream; never log either stream.
      await this.sandbox.process.getSessionCommandLogs(
        sessionId,
        commandId,
        (chunk: string) => onStdout(chunk),
        () => {},
      );
      const state = await this.sandbox.process.getSessionCommand(sessionId, commandId);
      return { exitCode: typeof state.exitCode === "number" ? state.exitCode : null };
    } finally {
      await this.sandbox.process.deleteSession(sessionId).catch(() => undefined);
    }
  }

  async readFile(path: string): Promise<Buffer> {
    return this.sandbox.fs.downloadFile(path, SANDBOX_OP_TIMEOUT_SECONDS);
  }

  async dispose(): Promise<void> {
    await this.sandbox.delete(SANDBOX_OP_TIMEOUT_SECONDS);
  }
}

interface ResolvedEnvironment {
  provider: string;
  config: Record<string, unknown>;
}

/**
 * Resolves the environment record by id and reads its provider. Fails loud when
 * the connection string is absent or no record exists.
 */
async function resolveEnvironment(id: string): Promise<ResolvedEnvironment> {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    fail("DATABASE_URL is not set; cannot resolve the environment record.");
  }
  const db = createDb(url);
  const rows = await db.select().from(environments).where(eq(environments.id, id));
  const row = rows[0];
  if (!row) {
    fail(`no environment record for id "${id}".`);
  }
  const config = (row.config ?? {}) as Record<string, unknown>;
  const provider = typeof config.provider === "string" ? config.provider : "";
  return { provider, config };
}

function readString(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildResources(config: Record<string, unknown>): DaytonaResources | undefined {
  const resources: DaytonaResources = {};
  const cpu = readNumber(config, "cpu");
  const memory = readNumber(config, "memory");
  const disk = readNumber(config, "disk");
  const gpu = readNumber(config, "gpu");
  if (cpu !== undefined) resources.cpu = cpu;
  if (memory !== undefined) resources.memory = memory;
  if (disk !== undefined) resources.disk = disk;
  if (gpu !== undefined) resources.gpu = gpu;
  return Object.keys(resources).length > 0 ? resources : undefined;
}

/**
 * Loads the Daytona SDK at run time and builds the client from the environment
 * config. It reads the API key from the config first, then from
 * `DAYTONA_API_KEY`. A secret-reference API key in the config is not resolved
 * here, so a live run relies on the `DAYTONA_API_KEY` fallback. The module
 * specifier is configurable, so the proof runs in an environment that installs
 * the SDK under any resolvable path.
 */
async function loadDaytonaClient(config: Record<string, unknown>): Promise<DaytonaClient> {
  const apiKey = readString(config, "apiKey") ?? process.env.DAYTONA_API_KEY?.trim();
  if (!apiKey) {
    fail("Daytona requires an API key in the environment config or DAYTONA_API_KEY.");
  }
  const clientConfig: DaytonaClientConfig = { apiKey };
  const apiUrl = readString(config, "apiUrl");
  if (apiUrl) clientConfig.apiUrl = apiUrl;
  const target = readString(config, "target");
  if (target) clientConfig.target = target;

  const specifier = process.env.PAPERCLIP_DAYTONA_SDK_MODULE ?? "@daytonaio/sdk";
  let sdk: DaytonaModule;
  try {
    sdk = (await import(specifier)) as DaytonaModule;
  } catch {
    return fail(
      `cannot load the Daytona SDK from "${specifier}"; install @daytonaio/sdk or set PAPERCLIP_DAYTONA_SDK_MODULE.`,
    );
  }
  return new sdk.Daytona(clientConfig);
}

/** Provisions one proof sandbox from the environment config (image or snapshot). */
async function createProofSandbox(
  client: DaytonaClient,
  config: Record<string, unknown>,
): Promise<DaytonaSandbox> {
  const labels = { "paperclip.purpose": "codex-device-login-proof" };
  const image = readString(config, "image");
  if (image) {
    const params: DaytonaCreateParams = { image, labels };
    const resources = buildResources(config);
    if (resources) params.resources = resources;
    return client.create(params, { timeout: SANDBOX_OP_TIMEOUT_SECONDS });
  }
  const snapshot = readString(config, "snapshot");
  if (snapshot) {
    return client.create({ snapshot, labels }, { timeout: SANDBOX_OP_TIMEOUT_SECONDS });
  }
  fail("the Daytona environment config has neither an image nor a snapshot.");
}

async function main(): Promise<void> {
  const envId = process.argv[2]?.trim();
  if (!envId) {
    fail("usage: device-login-proof <daytona-environment-id>");
  }

  // Control 1: fail closed before any provisioning when no controlling terminal.
  const ttyFd = openControllingTerminal();
  const promptSink = createTerminalPromptSink(ttyFd);

  const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim();
  if (!companyId) {
    fail("PAPERCLIP_COMPANY_ID is not set; cannot derive a company-scoped proof home.");
  }

  const { provider, config } = await resolveEnvironment(envId);
  if (provider !== "daytona") {
    fail(`environment "${envId}" has provider "${provider || "(none)"}", not "daytona".`);
  }

  const proofHome = deriveProofHome();
  const client = await loadDaytonaClient(config);

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // Every provisioned sandbox that the finally block must delete. The login
  // sandbox drops out of this set after the runner disposes it.
  const sandboxesToDelete: DaytonaSandbox[] = [];
  try {
    const loginSandbox = await createProofSandbox(client, config);
    sandboxesToDelete.push(loginSandbox);
    const driver = new DaytonaLoginDriver(loginSandbox);

    let capturedAuth: Buffer | null = null;
    const loginCommand =
      `mkdir -p ${SANDBOX_CODEX_HOME} && ` +
      `CODEX_HOME=${SANDBOX_CODEX_HOME} timeout ${SANDBOX_LOGIN_BOUND_SECONDS} codex login --device-auth`;

    const result = await runDeviceLogin(driver, {
      command: loginCommand,
      onPrompt: promptSink,
      onCredential: (bytes: Buffer) => {
        capturedAuth = bytes;
      },
      authPath: AUTH_PATH_IN_SANDBOX,
      timeoutMs: LOGIN_TIMEOUT_MS,
      signal: controller.signal,
    });
    // The runner always disposes the driver, which deleted the login sandbox.
    sandboxesToDelete.pop();

    if (result.outcome !== "success" || capturedAuth === null) {
      fail(`device login did not succeed (outcome: ${result.outcome}).`);
    }
    const authBytes: Buffer = capturedAuth;

    await installDeviceLoginCredential({
      sandboxAuthBytes: authBytes,
      proofHome,
      companyId,
      log: (line: string) => status(line),
    });

    const usable = await codexHomeHasUsableAuth(proofHome);
    status(`proof home has usable auth: ${usable ? "PASS" : "FAIL"}`);
    if (!usable) {
      fail("the proof home does not hold a usable credential.");
    }

    // Prove the saved credential authenticates in a fresh sandbox.
    const verifySandbox = await createProofSandbox(client, config);
    sandboxesToDelete.push(verifySandbox);
    await verifySandbox.fs.uploadFile(authBytes, AUTH_PATH_IN_SANDBOX, SANDBOX_OP_TIMEOUT_SECONDS);
    const verifyDriver = new DaytonaLoginDriver(verifySandbox);
    const verifyCommand = `CODEX_HOME=${SANDBOX_CODEX_HOME} codex login status`;
    // Discard the verify output in memory; it may carry identity detail.
    const verifyResult = await verifyDriver.execStreaming(verifyCommand, () => {});
    const verifyPass = verifyResult.exitCode === 0;
    status(
      `saved credential authenticates in a fresh sandbox: ${
        verifyPass ? "PASS" : `FAIL (exit ${verifyResult.exitCode})`
      }`,
    );
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    for (const sandbox of sandboxesToDelete) {
      await sandbox.delete(SANDBOX_OP_TIMEOUT_SECONDS).catch(() => undefined);
    }
    await removeProofHome(proofHome, { companyId }).catch(() => undefined);
    try {
      closeSync(ttyFd);
    } catch {
      // The terminal handle is already closed.
    }
  }
}

main().catch((error: unknown) => {
  // Never print the error object; it can embed streamed bytes. Print a fixed line.
  process.stderr.write("device-login-proof: the proof failed with an unexpected error.\n");
  void error;
  process.exit(1);
});
