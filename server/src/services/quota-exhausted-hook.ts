import { spawn } from "node:child_process";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";

// 60s gives `ccrotate next`'s pool-probe step room to finish under load —
// when Anthropic's per-org Usage API throttles, probing 10 accounts can
// take 30–45s. The earlier 30s ceiling was killing `next` mid-probe in
// ~85% of hook fires (observed 2026-05-09 00:11–00:48Z) so the active
// account never got switched and the agent's onSuccess wakeup never fired,
// leaving runs to self-recover only via the writeback's tier-cache
// candidate-skip on the NEXT heartbeat.
//
// 60s == DEBOUNCE_MS is intentional: the inFlight guard already coalesces
// concurrent hooks onto a single shared promise, so a hook that takes the
// full 60s simply holds the debounce window; we never get two snaps racing.
const HOOK_TIMEOUT_MS = 60_000;
const DEBOUNCE_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const LOCAL_CCROTATE_COMMAND_RE = /(^|[\s;&|()])ccrotate(?=\s|$)/;

interface RunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

interface HookState {
  lastRunStartedAt: number;
  inFlight: Promise<RunResult> | null;
}

const state: HookState = {
  lastRunStartedAt: 0,
  inFlight: null,
};

export function __resetQuotaExhaustedHookStateForTesting() {
  state.lastRunStartedAt = 0;
  state.inFlight = null;
}

function resolveCommand(configured: string | null): {
  command: string | null;
  source: "instance_settings" | "env" | null;
} {
  if (configured) {
    return {
      command: removeRetiredLocalCcrotateFragments(configured),
      source: "instance_settings",
    };
  }
  if (process.env.PAPERCLIP_QUOTA_HOOK_ALLOW_ENV !== "1") {
    return { command: null, source: null };
  }
  const envCmd = process.env.PAPERCLIP_QUOTA_EXHAUSTED_CMD?.trim();
  if (!envCmd) return { command: null, source: null };
  return { command: removeRetiredLocalCcrotateFragments(envCmd), source: "env" };
}

function removeRetiredLocalCcrotateFragments(command: string): string | null {
  if (!process.env.CCROTATE_STATE_URL?.trim()) return command;
  const kept = command
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !LOCAL_CCROTATE_COMMAND_RE.test(part));
  return kept.length > 0 ? kept.join("; ") : null;
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

export interface RunQuotaExhaustedHookInput {
  db: Db;
  agentId: string;
  companyId: string;
  runId: string | null;
  /** The adapter type that surfaced the quota exhaustion. Forwarded to the
   *  hook command as `PAPERCLIP_ADAPTER_TYPE` so e.g. ccrotate-relogin-trigger
   *  can map adapter → ccrotate target without an extra DB lookup. */
  adapterType: string;
  errorCode: string;
  onSuccess?: (() => void | Promise<void>) | null;
}

export async function runQuotaExhaustedHook(
  input: RunQuotaExhaustedHookInput,
): Promise<{ status: "skipped" | "debounced" | "ran"; result?: RunResult }> {
  const settings = await instanceSettingsService(input.db).getGeneral();
  const { command, source } = resolveCommand(settings.quotaExhaustedCmd);

  if (!command || !source) {
    return { status: "skipped" };
  }

  const now = Date.now();
  const sinceLast = now - state.lastRunStartedAt;

  if (state.inFlight) {
    const existing = await state.inFlight;
    if (existing.ok && input.onSuccess) {
      await Promise.resolve(input.onSuccess()).catch((err) => {
        logger.warn(
          { err, agentId: input.agentId },
          "quota-exhausted hook onSuccess callback failed",
        );
      });
    }
    return { status: "debounced", result: existing };
  }

  if (sinceLast < DEBOUNCE_MS && state.lastRunStartedAt > 0) {
    logger.info(
      {
        agentId: input.agentId,
        companyId: input.companyId,
        msSinceLast: sinceLast,
        debounceMs: DEBOUNCE_MS,
      },
      "quota-exhausted hook debounced",
    );
    if (input.onSuccess) {
      await Promise.resolve(input.onSuccess()).catch((err) => {
        logger.warn(
          { err, agentId: input.agentId },
          "quota-exhausted hook onSuccess callback failed",
        );
      });
    }
    return { status: "debounced" };
  }

  state.lastRunStartedAt = now;
  const runPromise = runCommand(command, {
    PAPERCLIP_HOOK_KIND: "quotaExhausted",
    PAPERCLIP_AGENT_ID: input.agentId,
    PAPERCLIP_COMPANY_ID: input.companyId,
    PAPERCLIP_RUN_ID: input.runId ?? "",
    PAPERCLIP_ADAPTER_TYPE: input.adapterType,
    PAPERCLIP_ERROR_CODE: input.errorCode,
  });
  state.inFlight = runPromise;

  let result: RunResult;
  try {
    result = await runPromise;
  } finally {
    state.inFlight = null;
  }

  logger.info(
    {
      agentId: input.agentId,
      companyId: input.companyId,
      runId: input.runId,
      source,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    result.ok ? "quota-exhausted hook fired" : "quota-exhausted hook failed",
  );

  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "quota-exhausted-hook",
    action: "instance.quota_exhausted_hook_fired",
    entityType: "agent",
    entityId: input.agentId,
    agentId: input.agentId,
    runId: input.runId ?? null,
    details: {
      errorCode: input.errorCode,
      source,
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
      { err, agentId: input.agentId },
      "failed to record quota-exhausted hook activity",
    );
  });

  if (result.ok && input.onSuccess) {
    await Promise.resolve(input.onSuccess()).catch((err) => {
      logger.warn(
        { err, agentId: input.agentId },
        "quota-exhausted hook onSuccess callback failed",
      );
    });
  }

  return { status: "ran", result };
}
