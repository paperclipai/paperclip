import { Command } from "commander";
import WebSocket from "ws";
import type { HeartbeatRun, HeartbeatRunEvent, Issue, LiveEvent, WorkspaceOperation } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
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

interface RunWatchOptions extends BaseClientOptions {
  afterSeq?: string;
  includeLog?: boolean;
  timeout?: string;
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
      .option("--limit <n>", "Maximum runs to return")
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
      .command("watch")
      .description("Follow a heartbeat run live over the events websocket until it finishes")
      .argument("<runId>", "Heartbeat run ID")
      .option("-C, --company-id <id>", "Company ID (defaults to the run's company)")
      .option("--after-seq <n>", "Replay run events after this sequence before going live", "0")
      .option("--include-log", "Also stream raw log chunks (noisier)")
      .option("--timeout <seconds>", "Stop watching after this many seconds if the run has not finished")
      .action(async (runId: string, opts: RunWatchOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          process.exitCode = await watchRun(ctx, runId, opts);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
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

// Terminal heartbeat-run statuses (mirrors HEARTBEAT_RUN_TERMINAL_STATUSES in
// server/src/services/heartbeat.ts — kept local so the CLI does not import server code).
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);

async function watchRun(ctx: ResolvedClientContext, runId: string, opts: RunWatchOptions): Promise<number> {
  const run = await ctx.api.get<HeartbeatRun>(apiPath`/api/heartbeat-runs/${runId}`);
  if (!run) {
    console.error(`Run ${runId} not found.`);
    return 1;
  }

  const companyId = opts.companyId?.trim() || run.companyId || ctx.companyId;
  if (!companyId) {
    console.error("Could not determine the company for this run; pass --company-id.");
    return 1;
  }

  if (!ctx.json) {
    console.log(formatInlineRecord({ id: run.id, status: run.status, agentId: run.agentId }));
  }

  const afterSeqStart = Number.parseInt(opts.afterSeq ?? "0", 10) || 0;
  let lastSeq = afterSeqStart;

  const catchUp = async (): Promise<void> => {
    const backlog = (await ctx.api.get<HeartbeatRunEvent[]>(
      `${apiPath`/api/heartbeat-runs/${runId}/events`}?afterSeq=${afterSeqStart}&limit=1000`,
    )) ?? [];
    for (const event of backlog) {
      printCaughtUpEvent(event, ctx.json);
      if (typeof event.seq === "number" && event.seq > lastSeq) lastSeq = event.seq;
    }
  };

  // Already finished: replay its events and stop — no live socket needed.
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    await catchUp();
    if (!ctx.json) {
      console.log(formatInlineRecord({ event: "status", status: run.status, note: "already finished" }));
    }
    return 0;
  }

  const wsUrl = buildLiveEventsWsUrl(ctx.api.apiBase, companyId);
  const headers = ctx.api.apiKey ? { Authorization: `Bearer ${ctx.api.apiKey}` } : undefined;

  return await new Promise<number>((resolve) => {
    const socket = new WebSocket(wsUrl, { headers });
    let settled = false;
    let caughtUp = false;
    const pending: LiveEvent[] = [];
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      process.off("SIGINT", onSigint);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve(code);
    };

    function onSigint(): void {
      if (!ctx.json) console.error("\nStopped watching (the run continues on the server).");
      finish(0);
    }
    process.on("SIGINT", onSigint);

    const timeoutSeconds = Number.parseInt(opts.timeout ?? "", 10);
    if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
      timeoutHandle = setTimeout(() => {
        if (!ctx.json) {
          console.error(
            `Timed out after ${timeoutSeconds}s; run ${runId} has not finished. Resume with: paperclipai run watch ${runId} --after-seq ${lastSeq}`,
          );
        }
        finish(0);
      }, timeoutSeconds * 1000);
    }

    const processEvent = (event: LiveEvent): void => {
      if (typeof event.type !== "string" || !event.type.startsWith("heartbeat.run.")) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (payload.runId !== runId) return;

      const seq = typeof payload.seq === "number" ? payload.seq : undefined;
      if (event.type === "heartbeat.run.event" && seq !== undefined) {
        if (seq <= lastSeq) return; // already shown during catch-up
        lastSeq = seq;
      }
      if (event.type === "heartbeat.run.log" && !opts.includeLog) return;

      if (ctx.json) {
        console.log(JSON.stringify(event));
      } else {
        const line = formatLiveRunEvent(event.type, payload);
        if (line) console.log(line);
      }

      if (
        event.type === "heartbeat.run.status" &&
        typeof payload.status === "string" &&
        TERMINAL_RUN_STATUSES.has(payload.status)
      ) {
        finish(payload.status === "succeeded" ? 0 : 1);
      }
    };

    // Subscribe-then-replay: attach the socket before the REST catch-up so no
    // events emitted during the replay are lost (the live bus does not buffer).
    // Events arriving mid-replay queue in `pending` and flush once caught up.
    socket.on("open", () => {
      void catchUp()
        .then(() => {
          caughtUp = true;
          for (const event of pending) processEvent(event);
          pending.length = 0;
        })
        .catch((err: unknown) => {
          if (!ctx.json) {
            console.error(`Failed to load run history: ${err instanceof Error ? err.message : String(err)}`);
          }
          finish(1);
        });
    });

    socket.on("message", (data: WebSocket.RawData) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(data.toString()) as LiveEvent;
      } catch {
        return;
      }
      if (!caughtUp) {
        pending.push(event);
        return;
      }
      processEvent(event);
    });

    socket.on("error", (err: Error) => {
      if (!ctx.json) {
        const forbidden = /\b(401|403)\b/.test(err.message);
        console.error(
          forbidden
            ? `Live websocket rejected (${err.message}). It accepts local_trusted mode or an agent API key (--api-key), not board tokens. Fall back to: paperclipai run events ${runId} --after-seq ${lastSeq}`
            : `Live websocket error: ${err.message}. Fall back to: paperclipai run events ${runId} --after-seq ${lastSeq}`,
        );
      }
      finish(1);
    });

    socket.on("close", (code: number) => {
      if (settled) return;
      if (!ctx.json) {
        console.error(
          `Live websocket closed (${code}) before run ${runId} finished. Resume with: paperclipai run watch ${runId} --after-seq ${lastSeq}`,
        );
      }
      finish(1);
    });
  });
}

function printCaughtUpEvent(event: HeartbeatRunEvent, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(event));
    return;
  }
  console.log(
    formatInlineRecord({
      seq: event.seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      message: event.message,
    }),
  );
}

function formatLiveRunEvent(type: string, payload: Record<string, unknown>): string | null {
  switch (type) {
    case "heartbeat.run.queued":
      return formatInlineRecord({ event: "queued", agentId: payload.agentId });
    case "heartbeat.run.status":
      return formatInlineRecord({ event: "status", status: payload.status, error: payload.error, finalText: payload.finalText });
    case "heartbeat.run.progress":
      return formatInlineRecord({ event: "progress", phase: payload.phase, tool: payload.currentToolName, message: payload.message });
    case "heartbeat.run.event":
      return formatInlineRecord({ seq: payload.seq, eventType: payload.eventType, stream: payload.stream, level: payload.level, message: payload.message });
    case "heartbeat.run.log":
      return formatInlineRecord({ event: "log", stream: payload.stream, chunk: payload.chunk });
    default:
      return null;
  }
}

function buildLiveEventsWsUrl(apiBase: string, companyId: string): string {
  const url = new URL(apiPath`/api/companies/${companyId}/events/ws`, `${apiBase.replace(/\/+$/, "")}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
