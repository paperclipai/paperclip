import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { reserveRunnerE2EServerPort } from "./ports.js";
import { resolvePaperclipRunnerBinaryForHarness } from "./harness-env.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";
import { ConnectionBlock, ConnectionFailure, targetOrigin, type ConnectionConfig } from "./connection-config.js";
import type { MatrixExecution } from "./types.js";

export const connectionDelay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** No raw response bodies, callback URLs, headers, or Playwright diagnostics escape. */
export class ConnectionApi {
  constructor(readonly request: APIRequestContext, readonly origin: string) {}
  async response(route: string, method = "GET", data?: unknown) {
    if (!route.startsWith("/api/") || new URL(route, this.origin).origin !== this.origin) throw new ConnectionFailure("invalid_api_route");
    try {
      const response = await this.request.fetch(`${this.origin}${route}`, { method, ...(data === undefined ? {} : { data }), maxRedirects: 0, timeout: 30_000 });
      if (!response.ok()) throw new ConnectionFailure(`api_status_${response.status()}`);
      return response;
    } catch (error) {
      if (error instanceof Error && /^api_status_\d+$/.test(error.message)) throw error;
      throw new ConnectionFailure("api_request_failed");
    }
  }
  async get<T = any>(route: string): Promise<T> { return (await this.response(route)).json(); }
  async post<T = any>(route: string, data?: unknown): Promise<T> { return (await this.response(route, "POST", data)).json(); }
  async patch<T = any>(route: string, data: unknown): Promise<T> { return (await this.response(route, "PATCH", data)).json(); }
  async delete(route: string) { await this.response(route, "DELETE"); }
  async bytes(route: string) { return (await this.response(route)).body(); }
}

async function stopOwnedServer(child: ChildProcess) {
  if (!child.pid) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const kill = (signal: NodeJS.Signals) => {
    try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  kill("SIGTERM");
  const deadline = Date.now() + 45_000;
  while (!exited() && Date.now() < deadline) await connectionDelay(100);
  // The group is exclusively the server this function spawned, never an attached target.
  kill("SIGKILL");
}

export async function startConnectionTarget(config: ConnectionConfig, executions: readonly MatrixExecution[], repositoryRoot: string, signal?: AbortSignal) {
  const assertActive = () => { if (signal?.aborted) throw new ConnectionBlock("blocked_target", "test_interrupted"); };
  assertActive();
  if (config.target.mode === "attach") return { origin: targetOrigin(config.target.baseURL), stop: async () => {} };
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-connection-e2e-"));
  let child: ChildProcess | undefined;
  const stop = async () => { if (child) await stopOwnedServer(child); await rm(root, { recursive: true, force: true }); };
  try {
    assertActive();
    const home = path.join(root, "paperclip-home");
    const instance = `connection-${randomBytes(6).toString("hex")}`;
    const port = await reserveRunnerE2EServerPort();
    await mkdir(home, { mode: 0o700 });
    // Only bootstrap essentials are inherited. Selected provider keys enter via UI.
    const env: NodeJS.ProcessEnv = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    Object.assign(env, {
      PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: instance, PAPERCLIP_CONFIG: path.join(home, "instances", instance, "config.json"),
      PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root, PAPERCLIP_RUNNER_E2E_PORT: String(port), PAPERCLIP_RUNNER_E2E_SERVER_LOG: path.join(root, "server.log"),
      PAPERCLIP_RUNNER_BINARY: resolvePaperclipRunnerBinaryForHarness(executions, repositoryRoot),
      PAPERCLIP_VITE_CACHE_DIR: path.join(root, "vite-cache"), PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
      PAPERCLIP_AGENT_JWT_SECRET: randomBytes(48).toString("hex"), PAPERCLIP_DECISION_SIGNING_SECRET: randomBytes(48).toString("hex"),
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: randomBytes(48).toString("hex"), BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
    });
    assertActive();
    child = spawn(process.execPath, runnerE2ETypeScriptProcessArgs(repositoryRoot, path.join(repositoryRoot, "tests/runner-e2e/server.ts")), { cwd: repositoryRoot, env, detached: process.platform !== "win32", stdio: "ignore" });
    let failed = false;
    child.once("error", () => { failed = true; });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      assertActive();
      if (failed || child.exitCode !== null) throw new ConnectionBlock("blocked_target", "managed_server_start_failed");
      try {
        const response = await fetch(`${origin}/api/health`, { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) });
        if (response.ok) { assertActive(); return { origin, stop }; }
      } catch { assertActive(); /* Bounded startup. */ }
      await connectionDelay(500);
    }
    throw new ConnectionBlock("blocked_target", "managed_server_start_timeout");
  } catch (error) { await stop(); throw error; }
}

export async function verifyConnectionTarget(origin: string, config: ConnectionConfig, request?: Pick<APIRequestContext, "get">) {
  let health: any;
  try {
    const url = `${targetOrigin(origin)}/api/health`;
    if (request) {
      const response = await request.get(url, { maxRedirects: 0, timeout: 15_000 });
      if ([401, 403].includes(response.status())) throw new ConnectionBlock("awaiting_user", "board_login_required");
      if (!response.ok()) throw new ConnectionFailure();
      health = await response.json();
    } else {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new ConnectionFailure();
      health = await response.json();
    }
  } catch (error) {
    if (error instanceof ConnectionBlock) throw error;
    throw new ConnectionBlock("blocked_target", "target_health_unavailable_or_redirected");
  }
  if (typeof health.commit !== "string" || !/^[a-f0-9]{40}$/.test(health.commit)) throw new ConnectionBlock("blocked_target", "target_revision_unavailable");
  if (config.target.mode === "attach" && (health.commit !== config.target.expectedCommit || health.deploymentMode !== config.target.deploymentMode)) throw new ConnectionBlock("blocked_target", "target_identity_mismatch");
  return { commit: health.commit as string, deploymentMode: String(health.deploymentMode) };
}
