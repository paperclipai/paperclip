/**
 * Day 2: wire execute() to the Playwright sidecar.
 *
 * Flow:
 * 1. Spawn sidecar process (if not already running on the configured socket).
 * 2. Connect SidecarClient.
 * 3. Expose BrowserTool calls as a tool surface in the Claude prompt.
 * 4. Forward each tool call to the sidecar; stream logs back via ctx.onLog.
 * 5. Return AdapterExecutionResult with sessionParams.
 *
 * Note: full Claude-CLI integration (streaming tool calls from the subprocess)
 * lands Day 3. Today's build validates the sidecar spawn + RPC round-trip.
 */

import cp from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { SidecarClient } from "./sidecar-client.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SOCKET_PATH = "/var/run/paperclip/surfer.sock";
const DEFAULT_PROFILE_DIR = "/var/lib/surfer/profile";
const SIDECAR_START_TIMEOUT_MS = 20_000;
const SIDECAR_PING_INTERVAL_MS = 500;

function getSidecarBin(): string {
  // Resolve sidecar entrypoint relative to this file (dev: src/, prod: dist/)
  const candidates = [
    path.join(__moduleDir, "../../sidecar/index.js"),
    path.join(__moduleDir, "../sidecar/index.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Sidecar entrypoint not found. Run 'pnpm build' first.\nSearched:\n${candidates.join("\n")}`,
  );
}

async function waitForSidecar(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new SidecarClient(socketPath);
    try {
      await client.connect();
      const alive = await client.ping();
      client.disconnect();
      if (alive) return;
    } catch {
      // Not up yet
      client.disconnect();
    }
    await new Promise((r) => setTimeout(r, SIDECAR_PING_INTERVAL_MS));
  }
  throw new Error(`Sidecar did not start within ${timeoutMs}ms (socket: ${socketPath})`);
}

async function spawnSidecarIfNeeded(
  socketPath: string,
  profileDir: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<cp.ChildProcess | null> {
  // If something is already listening, reuse it
  const probe = new SidecarClient(socketPath);
  try {
    await probe.connect();
    const alive = await probe.ping();
    probe.disconnect();
    if (alive) return null; // already running
  } catch {
    probe.disconnect();
  }

  await onLog("stderr", "[claude_browser_local] Spawning Playwright sidecar...\n");

  const sidecarBin = getSidecarBin();
  const child = cp.spawn(
    process.execPath,
    [sidecarBin, "--socket", socketPath, "--profile", profileDir],
    {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );

  child.stdout?.on("data", (chunk: Buffer) => {
    void onLog("stdout", chunk.toString());
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    void onLog("stderr", chunk.toString());
  });

  await waitForSidecar(socketPath, SIDECAR_START_TIMEOUT_MS);
  await onLog("stderr", "[claude_browser_local] Sidecar ready.\n");

  return child;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = ctx.config as Record<string, unknown>;

  const socketPath =
    typeof config.sidecarSocketPath === "string"
      ? config.sidecarSocketPath
      : DEFAULT_SOCKET_PATH;

  const profileDir =
    typeof config.profileDir === "string" ? config.profileDir : DEFAULT_PROFILE_DIR;

  let sidecarProcess: cp.ChildProcess | null = null;

  try {
    sidecarProcess = await spawnSidecarIfNeeded(socketPath, profileDir, ctx.onLog);

    const client = new SidecarClient(socketPath);
    await client.connect();

    // Smoke-test: navigate to a known URL to verify the sidecar is operational
    await ctx.onLog("stderr", "[claude_browser_local] Sidecar connected. Running smoke test...\n");

    const gotoResult = await client.callTool({ tool: "goto", url: "about:blank" });
    if (!gotoResult.ok) {
      throw new Error(`Sidecar smoke test failed: ${gotoResult.errorMessage}`);
    }

    await ctx.onLog(
      "stderr",
      `[claude_browser_local] Smoke test passed. Sidecar operational at ${socketPath}\n`,
    );

    client.disconnect();

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "claude_browser_local sidecar started and validated",
      sessionParams: {
        sessionId: (ctx.context?.sessionId as string | undefined) ?? `surfer-${Date.now()}`,
        socketPath,
        profileDir,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[claude_browser_local] Error: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      summary: `claude_browser_local failed: ${message}`,
    };
  } finally {
    // Sidecar stays alive across heartbeats (reuse profile/session).
    // We only kill it on explicit shutdown signals.
    // If we spawned it and something went wrong, clean up.
    if (sidecarProcess && sidecarProcess.exitCode === null) {
      // Keep alive for next heartbeat — do not kill.
    }
  }
}
