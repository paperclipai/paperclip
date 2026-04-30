import { spawn } from "node:child_process";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";

const HOOK_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

/**
 * Lifecycle hooks (pre-run, post-run) fired by the heartbeat scheduler around
 * every adapter run. Sibling to `quota-exhausted-hook.ts`, which fires
 * reactively after a 429 surfaces; these fire proactively at run boundaries.
 *
 * Pre-run is awaited (the run blocks until the command exits or times out) so
 * a `ccrotate next --yes` style refresh actually rotates credentials before
 * the agent process spawns. Post-run is fire-and-forget — it does not gate
 * run finalization, so a slow `ccrotate refresh-one` doesn't stall the queue.
 *
 * No debounce: every run fires its own hooks. The shell commands themselves
 * are responsible for cheap-no-op behavior on busy hosts (ccrotate's tier
 * cache + 1h API cooldown markers handle this naturally).
 */

export type LifecycleHookKind = "preRun" | "postRun";

interface RunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

function runCommand(command: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, HOOK_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return;
      stdoutBytes += chunk.length;
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return;
      stderrBytes += chunk.length;
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

export interface RunLifecycleHookInput {
  db: Db;
  kind: LifecycleHookKind;
  agentId: string;
  companyId: string;
  runId: string | null;
  adapterType: string;
  /**
   * For postRun: the agent process exit code so the hook command can branch.
   * Forwarded as `PAPERCLIP_HOOK_EXIT_CODE`. Null for preRun.
   */
  exitCode?: number | null;
}

/**
 * Fire a lifecycle hook synchronously (await result). Returns "skipped" if no
 * command is configured or the command resolves to whitespace.
 *
 * Callers decide whether to await this. Pre-run sites must await — they want
 * the rotation to land before spawning the agent. Post-run sites usually
 * don't await (fire-and-forget) so finalization isn't blocked.
 */
export async function runLifecycleHook(
  input: RunLifecycleHookInput,
): Promise<{ status: "skipped" | "ran"; result?: RunResult }> {
  const settings = await instanceSettingsService(input.db).getGeneral();
  const command = input.kind === "preRun" ? settings.preRunCmd : settings.postRunCmd;
  if (!command || command.trim().length === 0) {
    return { status: "skipped" };
  }

  const env: Record<string, string> = {
    PAPERCLIP_HOOK_KIND: input.kind,
    PAPERCLIP_AGENT_ID: input.agentId,
    PAPERCLIP_COMPANY_ID: input.companyId,
    PAPERCLIP_ADAPTER_TYPE: input.adapterType,
    PAPERCLIP_RUN_ID: input.runId ?? "",
  };
  if (input.kind === "postRun" && typeof input.exitCode === "number") {
    env.PAPERCLIP_HOOK_EXIT_CODE = String(input.exitCode);
  }

  const result = await runCommand(command, env);

  logger.info(
    {
      kind: input.kind,
      agentId: input.agentId,
      companyId: input.companyId,
      runId: input.runId,
      adapterType: input.adapterType,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    result.ok ? "lifecycle hook fired" : "lifecycle hook failed",
  );

  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: `lifecycle-hook-${input.kind}`,
    action: `instance.lifecycle_hook_${input.kind}_fired`,
    entityType: "agent",
    entityId: input.agentId,
    agentId: input.agentId,
    runId: input.runId ?? null,
    details: {
      kind: input.kind,
      adapterType: input.adapterType,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutPreview: result.stdout.slice(0, 1024),
      stderrPreview: result.stderr.slice(0, 1024),
      error: result.error ?? null,
    },
  }).catch((err) => {
    logger.warn(
      { err, agentId: input.agentId, kind: input.kind },
      "failed to record lifecycle hook activity",
    );
  });

  return { status: "ran", result };
}
