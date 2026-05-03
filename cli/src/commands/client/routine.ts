import { Command } from "commander";
import {
  createRoutineSchema,
  createRoutineTriggerSchema,
  rotateRoutineTriggerSecretSchema,
  runRoutineSchema,
  updateRoutineSchema,
  updateRoutineTriggerSchema,
  type Routine,
  type RoutineDetail,
  type RoutineRun,
  type RoutineTrigger,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface RoutineListOptions extends BaseClientOptions {
  companyId?: string;
  projectId?: string;
}

interface RoutineCreateOptions extends BaseClientOptions {
  companyId?: string;
  title: string;
  description?: string;
  projectId?: string;
  goalId?: string;
  parentIssueId?: string;
  assigneeAgentId?: string;
  priority?: string;
  status?: string;
  concurrencyPolicy?: string;
  catchUpPolicy?: string;
  variables?: string;
}

interface RoutineUpdateOptions extends BaseClientOptions {
  title?: string;
  description?: string;
  projectId?: string;
  goalId?: string;
  parentIssueId?: string;
  assigneeAgentId?: string;
  priority?: string;
  status?: string;
  concurrencyPolicy?: string;
  catchUpPolicy?: string;
  variables?: string;
}

interface RoutineRunsOptions extends BaseClientOptions {
  limit?: string;
}

interface RoutineRunOptions extends BaseClientOptions {
  triggerId?: string;
  payload?: string;
  variables?: string;
  projectId?: string;
  assigneeAgentId?: string;
  idempotencyKey?: string;
  source?: string;
  executionWorkspaceId?: string;
  executionWorkspacePreference?: string;
  executionWorkspaceSettings?: string;
}

interface TriggerCreateOptions extends BaseClientOptions {
  kind: string;
  label?: string;
  enabled?: string;
  cronExpression?: string;
  timezone?: string;
  signingMode?: string;
  replayWindowSec?: string;
}

interface TriggerUpdateOptions extends BaseClientOptions {
  label?: string;
  enabled?: string;
  cronExpression?: string;
  timezone?: string;
  signingMode?: string;
  replayWindowSec?: string;
}

interface TriggerDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

function parseJson(raw: string | undefined, name: string): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--${name} must be valid JSON: ${(err as Error).message}`);
  }
}

function parseJsonObject(
  raw: string | undefined,
  name: string,
): Record<string, unknown> | undefined {
  const value = parseJson(raw, name);
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`--${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseJsonArray(raw: string | undefined, name: string): unknown[] | undefined {
  const value = parseJson(raw, name);
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`--${name} must be a JSON array`);
  }
  return value;
}

function parseBool(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`--${name} must be true or false`);
}

function parseIntOpt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`--${name} must be an integer`);
  }
  return n;
}

async function confirmAction(message: string): Promise<boolean> {
  const { confirm } = await import("@clack/prompts");
  const answer = await confirm({ message, initialValue: false });
  return answer === true;
}

export function registerRoutineClientCommands(program: Command): void {
  const routine = program
    .command("routine")
    .description("Routine (recurring task) operations");

  addCommonClientOptions(
    routine
      .command("list")
      .description("List routines for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--project-id <id>", "Filter by project ID")
      .action(async (opts: RoutineListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.projectId) params.set("projectId", opts.projectId);
          const query = params.toString() ? `?${params.toString()}` : "";
          const rows = (await ctx.api.get<Routine[]>(
            `/api/companies/${ctx.companyId}/routines${query}`,
          )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                title: row.title,
                status: row.status,
                priority: row.priority,
                assigneeAgentId: row.assigneeAgentId ?? null,
                projectId: row.projectId ?? null,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    routine
      .command("get")
      .description("Get one routine with triggers and recent runs")
      .argument("<routineId>", "Routine ID")
      .action(async (routineId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<RoutineDetail>(
            `/api/routines/${encodeURIComponent(routineId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    routine
      .command("create")
      .description("Create a new routine")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--title <text>", "Routine title")
      .option("--description <text>", "Routine description")
      .option("--project-id <id>", "Project UUID")
      .option("--goal-id <id>", "Goal UUID")
      .option("--parent-issue-id <id>", "Parent issue UUID")
      .option("--assignee-agent-id <id>", "Assignee agent UUID")
      .option("--priority <priority>", "Issue priority (e.g. low, medium, high)")
      .option("--status <status>", "Routine status (e.g. active, paused)")
      .option(
        "--concurrency-policy <policy>",
        "e.g. coalesce_if_active, queue, drop_if_active",
      )
      .option("--catch-up-policy <policy>", "e.g. skip_missed, run_one_per_window")
      .option("--variables <json>", "Variables as JSON array")
      .action(async (opts: RoutineCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });

          const payload: Record<string, unknown> = { title: opts.title };
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.projectId !== undefined) payload.projectId = opts.projectId;
          if (opts.goalId !== undefined) payload.goalId = opts.goalId;
          if (opts.parentIssueId !== undefined) payload.parentIssueId = opts.parentIssueId;
          if (opts.assigneeAgentId !== undefined) payload.assigneeAgentId = opts.assigneeAgentId;
          if (opts.priority !== undefined) payload.priority = opts.priority;
          if (opts.status !== undefined) payload.status = opts.status;
          if (opts.concurrencyPolicy !== undefined) payload.concurrencyPolicy = opts.concurrencyPolicy;
          if (opts.catchUpPolicy !== undefined) payload.catchUpPolicy = opts.catchUpPolicy;
          const variables = parseJsonArray(opts.variables, "variables");
          if (variables !== undefined) payload.variables = variables;

          const parsed = createRoutineSchema.parse(payload);
          const row = await ctx.api.post<Routine>(
            `/api/companies/${ctx.companyId}/routines`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    routine
      .command("update")
      .description("Update a routine")
      .argument("<routineId>", "Routine ID")
      .option("--title <text>", "New title")
      .option("--description <text>", "New description")
      .option("--project-id <id>", "New project UUID")
      .option("--goal-id <id>", "New goal UUID")
      .option("--parent-issue-id <id>", "New parent issue UUID")
      .option("--assignee-agent-id <id>", "New assignee agent UUID")
      .option("--priority <priority>", "New priority")
      .option("--status <status>", "New status")
      .option("--concurrency-policy <policy>", "New concurrency policy")
      .option("--catch-up-policy <policy>", "New catch-up policy")
      .option("--variables <json>", "Replacement variables as JSON array")
      .action(async (routineId: string, opts: RoutineUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = {};
          if (opts.title !== undefined) payload.title = opts.title;
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.projectId !== undefined) payload.projectId = opts.projectId;
          if (opts.goalId !== undefined) payload.goalId = opts.goalId;
          if (opts.parentIssueId !== undefined) payload.parentIssueId = opts.parentIssueId;
          if (opts.assigneeAgentId !== undefined) payload.assigneeAgentId = opts.assigneeAgentId;
          if (opts.priority !== undefined) payload.priority = opts.priority;
          if (opts.status !== undefined) payload.status = opts.status;
          if (opts.concurrencyPolicy !== undefined) payload.concurrencyPolicy = opts.concurrencyPolicy;
          if (opts.catchUpPolicy !== undefined) payload.catchUpPolicy = opts.catchUpPolicy;
          const variables = parseJsonArray(opts.variables, "variables");
          if (variables !== undefined) payload.variables = variables;

          const parsed = updateRoutineSchema.parse(payload);
          const row = await ctx.api.patch<Routine>(
            `/api/routines/${encodeURIComponent(routineId)}`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    routine
      .command("runs")
      .description("List historical runs for a routine")
      .argument("<routineId>", "Routine ID")
      .option("--limit <n>", "Max runs (default 50)")
      .action(async (routineId: string, opts: RoutineRunsOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.limit) params.set("limit", opts.limit);
          const query = params.toString() ? `?${params.toString()}` : "";
          const rows = (await ctx.api.get<RoutineRun[]>(
            `/api/routines/${encodeURIComponent(routineId)}/runs${query}`,
          )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                status: row.status,
                source: row.source,
                triggeredAt: row.triggeredAt instanceof Date
                  ? row.triggeredAt.toISOString()
                  : (row.triggeredAt as unknown as string),
                completedAt: row.completedAt instanceof Date
                  ? row.completedAt.toISOString()
                  : (row.completedAt as unknown as string | null),
                linkedIssueId: row.linkedIssueId ?? null,
                failureReason: row.failureReason ?? null,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    routine
      .command("run")
      .description("Manually trigger a routine run")
      .argument("<routineId>", "Routine ID")
      .option("--trigger-id <id>", "Optional trigger UUID")
      .option("--payload <json>", "Trigger payload as JSON object")
      .option("--variables <json>", "Variable values as JSON object")
      .option("--project-id <id>", "Project UUID override")
      .option("--assignee-agent-id <id>", "Assignee agent UUID override")
      .option("--idempotency-key <key>", "Idempotency key (max 255 chars)")
      .option("--source <source>", "Source (manual or api, default manual)")
      .option("--execution-workspace-id <id>", "Execution workspace UUID")
      .option("--execution-workspace-preference <pref>", "Execution workspace preference")
      .option("--execution-workspace-settings <json>", "Execution workspace settings as JSON object")
      .action(async (routineId: string, opts: RoutineRunOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = {};
          if (opts.triggerId !== undefined) payload.triggerId = opts.triggerId;
          const wakePayload = parseJsonObject(opts.payload, "payload");
          if (wakePayload !== undefined) payload.payload = wakePayload;
          const variables = parseJsonObject(opts.variables, "variables");
          if (variables !== undefined) payload.variables = variables;
          if (opts.projectId !== undefined) payload.projectId = opts.projectId;
          if (opts.assigneeAgentId !== undefined) payload.assigneeAgentId = opts.assigneeAgentId;
          if (opts.idempotencyKey !== undefined) payload.idempotencyKey = opts.idempotencyKey;
          if (opts.source !== undefined) payload.source = opts.source;
          if (opts.executionWorkspaceId !== undefined)
            payload.executionWorkspaceId = opts.executionWorkspaceId;
          if (opts.executionWorkspacePreference !== undefined)
            payload.executionWorkspacePreference = opts.executionWorkspacePreference;
          const settings = parseJsonObject(
            opts.executionWorkspaceSettings,
            "execution-workspace-settings",
          );
          if (settings !== undefined) payload.executionWorkspaceSettings = settings;

          const parsed = runRoutineSchema.parse(payload);
          const row = await ctx.api.post<RoutineRun>(
            `/api/routines/${encodeURIComponent(routineId)}/run`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const trigger = routine.command("trigger").description("Routine trigger operations");

  addCommonClientOptions(
    trigger
      .command("create")
      .description("Create a new trigger for a routine")
      .argument("<routineId>", "Routine ID")
      .requiredOption("--kind <kind>", "Trigger kind: schedule, webhook, or api")
      .option("--label <text>", "Trigger label (max 120 chars)")
      .option("--enabled <bool>", "Enable trigger (true/false, default true)")
      .option("--cron-expression <expr>", "Cron expression (required for kind=schedule)")
      .option("--timezone <tz>", "Timezone for schedule (default UTC)")
      .option("--signing-mode <mode>", "Webhook signing mode (default bearer)")
      .option(
        "--replay-window-sec <n>",
        "Webhook replay window in seconds (30-86400, default 300)",
      )
      .action(async (routineId: string, opts: TriggerCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = { kind: opts.kind };
          if (opts.label !== undefined) payload.label = opts.label;
          const enabled = parseBool(opts.enabled, "enabled");
          if (enabled !== undefined) payload.enabled = enabled;

          if (opts.kind === "schedule") {
            if (opts.cronExpression === undefined) {
              throw new Error("--cron-expression is required when --kind is schedule");
            }
            payload.cronExpression = opts.cronExpression;
            if (opts.timezone !== undefined) payload.timezone = opts.timezone;
          } else if (opts.kind === "webhook") {
            if (opts.signingMode !== undefined) payload.signingMode = opts.signingMode;
            const replay = parseIntOpt(opts.replayWindowSec, "replay-window-sec");
            if (replay !== undefined) payload.replayWindowSec = replay;
          }

          const parsed = createRoutineTriggerSchema.parse(payload);
          const row = await ctx.api.post<unknown>(
            `/api/routines/${encodeURIComponent(routineId)}/triggers`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    trigger
      .command("update")
      .description("Update a routine trigger")
      .argument("<triggerId>", "Trigger ID")
      .option("--label <text>", "New label")
      .option("--enabled <bool>", "Enable/disable (true/false)")
      .option("--cron-expression <expr>", "New cron expression")
      .option("--timezone <tz>", "New timezone")
      .option("--signing-mode <mode>", "New signing mode")
      .option("--replay-window-sec <n>", "New replay window seconds (30-86400)")
      .action(async (triggerId: string, opts: TriggerUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = {};
          if (opts.label !== undefined) payload.label = opts.label;
          const enabled = parseBool(opts.enabled, "enabled");
          if (enabled !== undefined) payload.enabled = enabled;
          if (opts.cronExpression !== undefined) payload.cronExpression = opts.cronExpression;
          if (opts.timezone !== undefined) payload.timezone = opts.timezone;
          if (opts.signingMode !== undefined) payload.signingMode = opts.signingMode;
          const replay = parseIntOpt(opts.replayWindowSec, "replay-window-sec");
          if (replay !== undefined) payload.replayWindowSec = replay;

          const parsed = updateRoutineTriggerSchema.parse(payload);
          const row = await ctx.api.patch<RoutineTrigger>(
            `/api/routine-triggers/${encodeURIComponent(triggerId)}`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    trigger
      .command("delete")
      .description("Delete a routine trigger")
      .argument("<triggerId>", "Trigger ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (triggerId: string, opts: TriggerDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(`Delete trigger ${triggerId}?`);
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          await ctx.api.delete<void>(
            `/api/routine-triggers/${encodeURIComponent(triggerId)}`,
          );
          if (ctx.json) {
            printOutput({ ok: true }, { json: true });
          } else {
            console.log("deleted");
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    trigger
      .command("rotate-secret")
      .description(
        "Rotate a webhook trigger's signing secret (returned once, store immediately)",
      )
      .argument("<triggerId>", "Trigger ID")
      .action(async (triggerId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const parsed = rotateRoutineTriggerSecretSchema.parse({});
          const row = await ctx.api.post<unknown>(
            `/api/routine-triggers/${encodeURIComponent(triggerId)}/rotate-secret`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
