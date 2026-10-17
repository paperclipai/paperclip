import { Command } from "commander";
import type { HeartbeatRun, HeartbeatRunEvent, Issue, WorkspaceOperation } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface RunListOptions extends BaseClientOptions {
  agentId?: string;
  limit?: string;
  all?: boolean;
}

// `GET /companies/:companyId/heartbeat-runs` applies no LIMIT at all when the
// caller sends none, so a bare `paperclip run list` asks for the company's
// entire run corpus — tens of thousands of rows and tens of megabytes on a
// long-lived instance. Default to a bounded page and say so on stderr whenever
// the page is full, so the truncation is never silent; `--all` keeps the
// unbounded form available, since there is no `offset` on this route and the
// server clamps `limit` to 1000.
const RUN_LIST_DEFAULT_LIMIT = 200;

// The route also clamps `limit` down to 1000 without saying so, so a requested
// limit above this is not the number of rows the server can return. The notice
// below must compare against the EFFECTIVE limit: `rows.length >= 2000` can
// never be true against a 1000-row ceiling, so a notice keyed to the requested
// value would be unable to fire in exactly the truncated case it exists for.
// Mirroring the bound here is a second copy, and it fails in the loud direction
// if the server raises it (a notice when none was needed). It goes away once
// the route reports `X-Result-Truncated`.
const RUN_LIST_SERVER_MAX_LIMIT = 1000;

// The route parses `limit` as `parseInt(limit, 10) || 200`, so a malformed
// value is silently served as 200 rows. Reject it here instead: otherwise the
// caller gets a bounded page it never asked for and no indication of it.
function parseRunListLimit(raw: string | undefined): number {
  if (raw === undefined) return RUN_LIST_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--limit must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

interface RunLiveOptions extends BaseClientOptions {
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
  text?: boolean;
}

interface RunWatchdogOptions extends BaseClientOptions {
  decision: string;
  reason?: string;
  snoozedUntil?: string;
  evaluationIssueId?: string;
}

interface RunIssueSummary extends Issue {
  runId?: string;
  runStatus?: string;
}

export function registerRunCommands(command: Command): void {
  addCommonClientOptions(
    command
      .command("list")
      .description("List heartbeat runs for a company")
      .option("-C, --company-id <id>", "Company ID")
      .option("--agent-id <id>", "Filter by agent ID")
      .option("--limit <n>", `Maximum runs to return (default ${RUN_LIST_DEFAULT_LIMIT})`)
      .option("--all", "Return every run for the company (unbounded response)")
      .action(async (opts: RunListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.agentId) params.set("agentId", opts.agentId);
          if (opts.all && opts.limit !== undefined) {
            throw new Error("--all and --limit cannot be combined");
          }
          const requested = opts.all ? null : parseRunListLimit(opts.limit);
          if (requested !== null) params.set("limit", String(requested));
          const query = params.toString();
          const rows = (await ctx.api.get<HeartbeatRun[]>(
            `${apiPath`/api/companies/${ctx.companyId}/heartbeat-runs`}${query ? `?${query}` : ""}`,
          )) ?? [];
          const effective =
            requested === null ? null : Math.min(requested, RUN_LIST_SERVER_MAX_LIMIT);
          if (effective !== null && rows.length >= effective) {
            // Do not advise raising a limit that is already clamped: that is
            // advice which cannot work in the one case it is printed.
            const remedy = requested !== null && requested > effective
              ? `--limit ${requested} is above the server maximum of ${RUN_LIST_SERVER_MAX_LIMIT},`
                + " so raising it does nothing. Pass --all for the whole corpus."
              : `Raise --limit (server max ${RUN_LIST_SERVER_MAX_LIMIT}) or pass --all.`;
            console.error(`Showing ${rows.length} run(s); more may exist. ${remedy}`);
          }
          printRuns(rows, ctx.json);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    command
      .command("live")
      .description("List queued and running heartbeat runs for a company")
      .option("-C, --company-id <id>", "Company ID")
      .option("--limit <n>", "Maximum runs to return")
      .option("--min-count <n>", "Pad with recent completed runs up to this count")
      .action(async (opts: RunLiveOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.limit) params.set("limit", opts.limit);
          if (opts.minCount) params.set("minCount", opts.minCount);
          const query = params.toString();
          const rows = (await ctx.api.get<HeartbeatRun[]>(
            `${apiPath`/api/companies/${ctx.companyId}/live-runs`}${query ? `?${query}` : ""}`,
          )) ?? [];
          printRuns(rows, ctx.json);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    command
      .command("get")
      .description("Get a heartbeat run")
      .argument("<runId>", "Heartbeat run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const run = await ctx.api.get<HeartbeatRun>(apiPath`/api/heartbeat-runs/${runId}`);
          printOutput(run, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    command
      .command("cancel")
      .description("Cancel a queued or running heartbeat run")
      .argument("<runId>", "Heartbeat run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const run = await ctx.api.post<HeartbeatRun | null>(apiPath`/api/heartbeat-runs/${runId}/cancel`, {});
          printOutput(run, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    command
      .command("events")
      .description("List heartbeat run events")
      .argument("<runId>", "Heartbeat run ID")
      .option("--after-seq <n>", "Only return events after this sequence", "0")
      .option("--limit <n>", "Maximum events to return", "200")
      .action(async (runId: string, opts: RunEventsOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.afterSeq) params.set("afterSeq", opts.afterSeq);
          if (opts.limit) params.set("limit", opts.limit);
          const events = (await ctx.api.get<HeartbeatRunEvent[]>(
            `${apiPath`/api/heartbeat-runs/${runId}/events`}?${params.toString()}`,
          )) ?? [];
          if (ctx.json) {
            printOutput(events, { json: true });
            return;
          }
          for (const event of events) {
            console.log(formatInlineRecord({
              seq: event.seq,
              eventType: event.eventType,
              stream: event.stream,
              level: event.level,
              message: event.message,
            }));
          }
          if (events.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    command
      .command("log")
      .description("Read heartbeat run log bytes")
      .argument("<runId>", "Heartbeat run ID")
      .option("--offset <bytes>", "Byte offset", "0")
      .option("--limit-bytes <bytes>", "Maximum bytes to read")
      .option("--text", "Print only the log text when the API returns a text field")
      .action(async (runId: string, opts: RunLogOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await fetchLog(ctx.api, apiPath`/api/heartbeat-runs/${runId}/log`, opts);
          printLogResult(result, { json: ctx.json, text: opts.text });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    command
      .command("issues")
      .description("List issues associated with a heartbeat run")
      .argument("<runId>", "Heartbeat run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<RunIssueSummary[]>(apiPath`/api/heartbeat-runs/${runId}/issues`)) ?? [];
          printOutput(rows.map((row) => ({
            identifier: row.identifier,
            id: row.id,
            status: row.status,
            priority: row.priority,
            title: row.title,
            runStatus: row.runStatus,
          })), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    command
      .command("workspace-operations")
      .description("List workspace operations for a heartbeat run")
      .argument("<runId>", "Heartbeat run ID")
      .action(async (runId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<WorkspaceOperation[]>(
            apiPath`/api/heartbeat-runs/${runId}/workspace-operations`,
          )) ?? [];
          printOutput(rows.map((row) => ({
            id: row.id,
            status: row.status,
            phase: row.phase,
            command: row.command,
            cwd: row.cwd,
            logBytes: row.logBytes,
          })), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    command
      .command("workspace-log")
      .description("Read a workspace operation log")
      .argument("<operationId>", "Workspace operation ID")
      .option("--offset <bytes>", "Byte offset", "0")
      .option("--limit-bytes <bytes>", "Maximum bytes to read")
      .option("--text", "Print only the log text when the API returns a text field")
      .action(async (operationId: string, opts: RunLogOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await fetchLog(ctx.api, apiPath`/api/workspace-operations/${operationId}/log`, opts);
          printLogResult(result, { json: ctx.json, text: opts.text });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    command
      .command("watchdog-decision")
      .description("Record a watchdog decision for a heartbeat run")
      .argument("<runId>", "Heartbeat run ID")
      .requiredOption("--decision <decision>", "snooze, continue, or dismissed_false_positive")
      .option("--reason <text>", "Decision reason")
      .option("--snoozed-until <iso8601>", "Required for snooze decisions")
      .option("--evaluation-issue-id <id>", "Related watchdog evaluation issue ID")
      .action(async (runId: string, opts: RunWatchdogOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const decision = await ctx.api.post(apiPath`/api/heartbeat-runs/${runId}/watchdog-decisions`, {
            decision: opts.decision,
            reason: opts.reason,
            snoozedUntil: opts.snoozedUntil,
            evaluationIssueId: opts.evaluationIssueId,
          });
          printOutput(decision, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

async function fetchLog(
  api: { get<T>(path: string): Promise<T | null> },
  path: string,
  opts: RunLogOptions,
): Promise<unknown> {
  const params = new URLSearchParams();
  if (opts.offset) params.set("offset", opts.offset);
  if (opts.limitBytes) params.set("limitBytes", opts.limitBytes);
  return api.get(`${path}?${params.toString()}`);
}

function printRuns(rows: HeartbeatRun[], json: boolean): void {
  if (json) {
    printOutput(rows, { json: true });
    return;
  }
  for (const row of rows) {
    console.log(formatInlineRecord({
      id: row.id,
      status: row.status,
      agentId: row.agentId,
      invocationSource: row.invocationSource,
      triggerDetail: row.triggerDetail,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      logBytes: row.logBytes,
    }));
  }
  if (rows.length === 0) printOutput([], { json: false });
}

function printLogResult(result: unknown, opts: { json: boolean; text?: boolean }): void {
  if (opts.json) {
    printOutput(result, { json: true });
    return;
  }

  if (opts.text && typeof result === "object" && result !== null && "text" in result) {
    const text = (result as { text?: unknown }).text;
    process.stdout.write(typeof text === "string" ? text : String(text ?? ""));
    return;
  }

  printOutput(result, { json: false });
}
