import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { routines, routineTriggers } from "@paperclipai/db";

export const RECOVERY_SWEEPER_ACTION_KEY = "recovery_sweeper_v1" as const;
export const RECOVERY_SWEEPER_ORIGIN_KIND = "internal_action" as const;
export const RECOVERY_SWEEPER_SCRIPT_PATH = fileURLToPath(
  new URL("../../../scripts/recovery_sweeper.py", import.meta.url),
);

const execFileAsync = promisify(execFileCallback);
const MAX_OUTPUT_BYTES = 256 * 1024;

type ExecFileOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  maxBuffer: number;
};

type ExecFileResult = {
  stdout: string;
  stderr: string;
  exitCode?: number;
};

export type RecoverySweeperMode = "dry" | "live";

export type RecoverySweeperSummary = {
  mode: string | null;
  errorAgentsCleared: string[];
  recoveryActionNudged: string[];
  surfacedOnly: string[];
  raw: Record<string, unknown>;
};

export type RecoverySweeperRunResult = {
  actionKey: typeof RECOVERY_SWEEPER_ACTION_KEY;
  mode: RecoverySweeperMode;
  exitStatus: number;
  stdoutSummary: string;
  stderrSummary: string;
  outcome: "completed" | "failed";
  summary: RecoverySweeperSummary | null;
};

export type RecoverySweeperExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<ExecFileResult>;

export function buildRecoverySweeperInvocation(mode: RecoverySweeperMode) {
  return {
    file: "python3",
    args: [RECOVERY_SWEEPER_SCRIPT_PATH, mode],
    options: {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: process.env,
      shell: false as const,
      maxBuffer: MAX_OUTPUT_BYTES,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function outputContainsUnsafeMutation(value: string) {
  return /\b(?:patch|put)\b[^\n]*\/api\/agents\/[^\n]*(?:active|status)/i.test(value);
}

function summarize(value: string) {
  return value.length <= MAX_OUTPUT_BYTES ? value : `${value.slice(0, MAX_OUTPUT_BYTES)}…`;
}

export function parseRecoverySweeperOutput(stdout: string): RecoverySweeperSummary {
  if (outputContainsUnsafeMutation(stdout)) {
    throw new Error("Recovery sweeper output contains an agent-status mutation path");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Recovery sweeper did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("Recovery sweeper output must be a JSON object");

  const errorAgentsCleared = stringArray(parsed.errorAgentsCleared);
  if (errorAgentsCleared.length > 0) {
    throw new Error("Recovery sweeper reported an agent error clear while the error->active gate is OFF");
  }

  return {
    mode: typeof parsed.mode === "string" ? parsed.mode : null,
    errorAgentsCleared,
    recoveryActionNudged: stringArray(parsed.recoveryActionNudged),
    surfacedOnly: stringArray(parsed.surfacedOnly),
    raw: parsed,
  };
}

export function createRecoverySweeperRunner(options: { execFile?: RecoverySweeperExecFile } = {}) {
  const execFile = options.execFile ?? (async (file, args, execOptions) => {
    try {
      const result = await execFileAsync(file, args, execOptions);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
      const exitCode = typeof processError.code === "number" ? processError.code : 1;
      return {
        stdout: processError.stdout ?? "",
        stderr: processError.stderr ?? (error instanceof Error ? error.message : String(error)),
        exitCode,
      };
    }
  });

  return {
    async run(input: { mode: RecoverySweeperMode; companyId: string; runId: string }): Promise<RecoverySweeperRunResult> {
      const invocation = buildRecoverySweeperInvocation(input.mode);
      const result = await execFile(invocation.file, invocation.args, {
        ...invocation.options,
        env: {
          ...process.env,
          PAPERCLIP_COMPANY_ID: input.companyId,
          PAPERCLIP_RUN_ID: input.runId,
        },
      });
      const exitStatus = result.exitCode ?? 1;
      let summary: RecoverySweeperSummary | null = null;
      let outcome: RecoverySweeperRunResult["outcome"] = exitStatus === 0 ? "completed" : "failed";
      try {
        summary = parseRecoverySweeperOutput(result.stdout);
      } catch (error) {
        outcome = "failed";
        const reason = error instanceof Error ? error.message : String(error);
        result.stderr = result.stderr ? `${result.stderr}\n${reason}` : reason;
      }
      return {
        actionKey: RECOVERY_SWEEPER_ACTION_KEY,
        mode: input.mode,
        exitStatus,
        stdoutSummary: summarize(result.stdout),
        stderrSummary: summarize(result.stderr),
        outcome,
        summary,
      };
    },
  };
}

export const recoverySweeperRunner = createRecoverySweeperRunner();

function nextHourlyUtcTick(after: Date) {
  const next = new Date(after.getTime());
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

/**
 * Server-only reconciliation seam. This intentionally is not part of the
 * routine mutation schema or an HTTP route: the board must complete the dry
 * run/live verification gate before the existing routine is switched here.
 */
export async function activateRecoverySweeperRoutine(
  db: Db,
  routineId: string,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const routine = await txDb
      .select()
      .from(routines)
      .where(eq(routines.id, routineId))
      .then((rows) => rows[0] ?? null);
    if (!routine) return null;

    const [updatedRoutine] = await txDb
      .update(routines)
      .set({
        originKind: RECOVERY_SWEEPER_ORIGIN_KIND,
        originId: RECOVERY_SWEEPER_ACTION_KEY,
        assigneeAgentId: null,
        status: "active",
        concurrencyPolicy: "skip_if_active",
        catchUpPolicy: "skip_missed",
        updatedAt: now,
      })
      .where(and(eq(routines.id, routineId), eq(routines.companyId, routine.companyId)))
      .returning();

    const trigger = await txDb
      .select()
      .from(routineTriggers)
      .where(and(eq(routineTriggers.routineId, routineId), eq(routineTriggers.kind, "schedule")))
      .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (trigger) {
      await txDb
        .update(routineTriggers)
        .set({
          enabled: true,
          cronExpression: "0 * * * *",
          timezone: "UTC",
          nextRunAt: nextHourlyUtcTick(now),
          updatedAt: now,
        })
        .where(eq(routineTriggers.id, trigger.id));
    }
    return { routine: updatedRoutine ?? routine, trigger };
  });
}
