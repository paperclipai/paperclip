import { Command } from "commander";
import type {
  HeartbeatRun,
  HeartbeatRunEvent,
  WorkspaceOperation,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface RunListOptions extends BaseClientOptions {
  companyId?: string;
  agentId?: string;
  limit?: string;
}

interface RunLiveOptions extends BaseClientOptions {
  companyId?: string;
  limit?: string;
  minCount?: string;
}

interface RunEventsOptions extends BaseClientOptions {
  afterSeq?: string;
  limit?: string;
}

interface RunLogOptions extends BaseClientOptions {
  offset?: string;
  limitBytes?: string;
}

interface RunWatchdogOptions extends BaseClientOptions {
  decision: string;
  reason?: string;
  evaluationIssueId?: string;
  snoozedUntil?: string;
}

interface WorkspaceOperationLogOptions extends BaseClientOptions {
  offset?: string;
  limitBytes?: string;
}

const WATCHDOG_DECISIONS = ["snooze", "continue", "dismissed_false_positive"] as const;

function isoOrThrow(value: string, name: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`--${name} must be a valid ISO 8601 datetime`);
  }
  return d.toISOString();
}

function printRunRow(row: HeartbeatRun & { agentName?: string | null }): void {
  console.log(
    formatInlineRecord({
      id: row.id,
      status: row.status,
      agentId: row.agentId,
      agentName: (row as { agentName?: string | null }).agentName ?? null,
      invocationSource: row.invocationSource,
      triggerDetail: row.triggerDetail ?? null,
      startedAt: row.startedAt instanceof Date
        ? row.startedAt.toISOString()
        : (row.startedAt as unknown as string | null),
      finishedAt: row.finishedAt instanceof Date
        ? row.finishedAt.toISOString()
        : (row.finishedAt as unknown as string | null),
    }),
  );
}

export function registerRunCommands(program: Command): void {
  const run = program
    .command("heartbeat-run")
    .description("Heartbeat run observability");

  addCommonClientOptions(
    run
      .command("list")
      .description("List heartbeat runs for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--agent-id <id>", "Filter by agent ID")
      .option("--limit <n>", "Max results (1-1000, default 200)")
      .action(async (opts: RunListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.agentId) params.set("agentId", opts.agentId);
          if (opts.limit) params.set("limit", opts.limit);
          const query = params.toString() ? `?${params.toString()}` : "";
          const rows = (await ctx.api.get<HeartbeatRun[]>(
            `/api/companies/${ctx.companyId}/heartbeat-runs${query}`,
          )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) printRunRow(row);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    run
      .command("live")
      .description("List active (queued/running) runs, optionally padded with recent runs")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--limit <n>", "Max results (default 50)")
      .option("--min-count <n>", "Minimum row count (pads with recent runs, default 0)")
      .action(async (opts: RunLiveOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.limit) params.set("limit", opts.limit);
          if (opts.minCount) params.set("minCount", opts.minCount);
          const query = params.toString() ? `?${params.toString()}` : "";
          const rows = (await ctx.api.get<Array<HeartbeatRun & { agentName: string | null }>>(
            `/api/companies/${ctx.companyId}/live-runs${query}`,
          )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) printRunRow(row);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    run
      .command("get")
      .description("Get one heartbeat run")
      .argument("<runId>", "Run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<HeartbeatRun>(
            `/api/heartbeat-runs/${encodeURIComponent(runId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    run
      .command("cancel")
      .description("Cancel a heartbeat run")
      .argument("<runId>", "Run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<HeartbeatRun | null>(
            `/api/heartbeat-runs/${encodeURIComponent(runId)}/cancel`,
            {},
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    run
      .command("events")
      .description("List events for a run (paginate via --after-seq)")
      .argument("<runId>", "Run ID")
      .option("--after-seq <n>", "Return events after this sequence number")
      .option("--limit <n>", "Max events (default 200)")
      .action(async (runId: string, opts: RunEventsOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.afterSeq) params.set("afterSeq", opts.afterSeq);
          if (opts.limit) params.set("limit", opts.limit);
          const query = params.toString() ? `?${params.toString()}` : "";
          const rows = (await ctx.api.get<HeartbeatRunEvent[]>(
            `/api/heartbeat-runs/${encodeURIComponent(runId)}/events${query}`,
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
                seq: (row as { seq?: number }).seq ?? null,
                kind: (row as { kind?: string }).kind ?? null,
                createdAt: (row as { createdAt?: Date | string }).createdAt
                  ? String((row as { createdAt?: Date | string }).createdAt)
                  : null,
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
    run
      .command("log")
      .description("Read run log bytes (paginate via --offset)")
      .argument("<runId>", "Run ID")
      .option("--offset <n>", "Byte offset to start reading from")
      .option("--limit-bytes <n>", "Max bytes to return")
      .action(async (runId: string, opts: RunLogOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.offset) params.set("offset", opts.offset);
          if (opts.limitBytes) params.set("limitBytes", opts.limitBytes);
          const query = params.toString() ? `?${params.toString()}` : "";
          const row = await ctx.api.get<unknown>(
            `/api/heartbeat-runs/${encodeURIComponent(runId)}/log${query}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    run
      .command("workspace-operations")
      .description("List workspace operations triggered by a run")
      .argument("<runId>", "Run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<WorkspaceOperation[]>(
            `/api/heartbeat-runs/${encodeURIComponent(runId)}/workspace-operations`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    run
      .command("watchdog")
      .description("Record a watchdog decision for a run")
      .argument("<runId>", "Run ID")
      .requiredOption(
        "--decision <decision>",
        `One of: ${WATCHDOG_DECISIONS.join(", ")}`,
      )
      .option("--reason <text>", "Reason (max 4000 chars)")
      .option("--evaluation-issue-id <id>", "Evaluation issue UUID")
      .option(
        "--snoozed-until <iso>",
        "Future ISO 8601 datetime (required for --decision snooze)",
      )
      .action(async (runId: string, opts: RunWatchdogOptions) => {
        try {
          if (!WATCHDOG_DECISIONS.includes(opts.decision as (typeof WATCHDOG_DECISIONS)[number])) {
            throw new Error(`--decision must be one of: ${WATCHDOG_DECISIONS.join(", ")}`);
          }
          const payload: Record<string, unknown> = { decision: opts.decision };
          if (opts.reason !== undefined) payload.reason = opts.reason;
          if (opts.evaluationIssueId !== undefined) payload.evaluationIssueId = opts.evaluationIssueId;
          if (opts.decision === "snooze") {
            if (!opts.snoozedUntil) {
              throw new Error("--snoozed-until is required when --decision is snooze");
            }
            const iso = isoOrThrow(opts.snoozedUntil, "snoozed-until");
            if (new Date(iso) <= new Date()) {
              throw new Error("--snoozed-until must be in the future");
            }
            payload.snoozedUntil = iso;
          }

          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/heartbeat-runs/${encodeURIComponent(runId)}/watchdog-decisions`,
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    run
      .command("by-issue")
      .description("List active runs for an issue")
      .argument("<issueId>", "Issue ID or identifier (e.g. ENG-12)")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<Array<HeartbeatRun & { agentName: string | null }>>(
            `/api/issues/${encodeURIComponent(issueId)}/live-runs`,
          )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) printRunRow(row);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    run
      .command("active-for-issue")
      .description("Get the currently active run for an issue (if any)")
      .argument("<issueId>", "Issue ID or identifier (e.g. ENG-12)")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/active-run`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

export function registerWorkspaceOperationCommands(program: Command): void {
  const workspaceOp = program
    .command("workspace-operation")
    .description("Workspace operation observability");

  addCommonClientOptions(
    workspaceOp
      .command("log")
      .description("Read workspace operation log bytes")
      .argument("<operationId>", "Operation ID")
      .option("--offset <n>", "Byte offset")
      .option("--limit-bytes <n>", "Max bytes")
      .action(async (operationId: string, opts: WorkspaceOperationLogOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.offset) params.set("offset", opts.offset);
          if (opts.limitBytes) params.set("limitBytes", opts.limitBytes);
          const query = params.toString() ? `?${params.toString()}` : "";
          const row = await ctx.api.get<unknown>(
            `/api/workspace-operations/${encodeURIComponent(operationId)}/log${query}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
