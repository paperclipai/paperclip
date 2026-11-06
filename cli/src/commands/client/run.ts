import { Command } from "commander";
import { HEARTBEAT_RUN_LIST_DEFAULT_LIMIT, HEARTBEAT_RUN_LIST_MAX_LIMIT } from "@paperclipai/shared";
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
      .option(
        "--limit <n>",
        `Maximum runs to return (server default ${HEARTBEAT_RUN_LIST_DEFAULT_LIMIT}, max ${HEARTBEAT_RUN_LIST_MAX_LIMIT})`,
      )
      .action(async (opts: RunListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.agentId) params.set("agentId", opts.agentId);
          if (opts.limit) params.set("limit", opts.limit);
          const query = params.toString();
          const rows = (await ctx.api.get<HeartbeatRun[]>(
            `${apiPath`/api/companies/${ctx.companyId}/heartbeat-runs`}${query ? `?${query}` : ""}`,
          )) ?? [];
          printRuns(rows, ctx.json);
          // The route returns one bounded page (200 by default, 1,000 at
          // most) with no offset and no truncation signal, so a full page
          // is the only sign that more runs may exist. Say so on stderr
          // instead of silently stopping; stdout stays clean for --json.
          // Real paging needs the offset/headers work in #14958.
          const requestedLimit = opts.limit ? Number.parseInt(opts.limit, 10) : Number.NaN;
          // Mirror the route's own clamp exactly: an unparsable or zero
          // limit falls back to the default, and any other value is
          // clamped into [1, MAX] (so a negative limit means one run).
          const effectiveLimit = Math.max(
            1,
            Math.min(
              requestedLimit || HEARTBEAT_RUN_LIST_DEFAULT_LIMIT,
              HEARTBEAT_RUN_LIST_MAX_LIMIT,
            ),
          );
          if (rows.length >= effectiveLimit) {
            console.error(
              effectiveLimit >= HEARTBEAT_RUN_LIST_MAX_LIMIT
                ? `Showing the newest ${rows.length} runs. The server caps this list at ${HEARTBEAT_RUN_LIST_MAX_LIMIT} runs per request, `
                  + "so more runs may exist, but this command cannot page past the cap yet."
                : `Showing the newest ${rows.length} runs. The server caps this list at ${effectiveLimit} runs per request `
                  + `(${HEARTBEAT_RUN_LIST_DEFAULT_LIMIT} by default, ${HEARTBEAT_RUN_LIST_MAX_LIMIT} max), so more runs may exist. `
                  + "Raise --limit to see more.",
            );
          }
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
