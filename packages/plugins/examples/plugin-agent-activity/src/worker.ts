import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DATA_KEYS, TOOL_NAMES } from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LiveRun = {
  id: string;
  status: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  issueId: string | null;
  startedAt: string | null;
  createdAt: string;
};

type RunTurn = {
  kind: "tool_call" | "text" | "tool_result";
  /** Tool name for tool_call, summary for text/result */
  label: string;
  /** Truncated preview */
  preview: string;
  ts: string;
};

type AgentStatusEntry = {
  runId: string;
  agentId: string;
  agentName: string;
  status: "queued" | "running" | string;
  taskId: string | null;
  taskTitle: string | null;
  elapsedMs: number | null;
  recentTurns: RunTurn[];
  lastActionAt: string | null;
};

type AgentStatusResult = {
  agents: AgentStatusEntry[];
  fetchedAt: string;
};

type RunSummaryResult = {
  runId: string;
  agentId: string;
  agentName: string;
  status: string;
  taskId: string | null;
  turns: RunTurn[];
  toolCallCount: number;
  commentCount: number;
  totalTurns: number;
  fetchedAt: string;
};

// ---------------------------------------------------------------------------
// Log parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse NDJSON run log content into meaningful turns.
 * Skips: system/init, injected skill content, raw user prompt injection.
 * Includes: assistant tool_use calls, assistant text, tool results.
 */
function parseRunLog(logContent: string, maxTurns = 8): RunTurn[] {
  const turns: RunTurn[] = [];

  for (const line of logContent.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const chunk = entry["chunk"];
    if (typeof chunk !== "string") continue;

    // Each chunk is itself a JSON object (Claude Code stream-json format)
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(chunk) as Record<string, unknown>;
    } catch {
      continue;
    }

    const msgType = msg["type"] as string | undefined;

    // Skip system messages (init, injected context, skill loading)
    if (msgType === "system") continue;

    // Skip user messages that are just long injected context blocks
    if (msgType === "user") {
      const content = msg["message"] as Record<string, unknown> | undefined;
      if (!content) continue;
      const msgContent = content["content"] as unknown[] | undefined;
      // Only include tool_result turns (these are real action results)
      if (Array.isArray(msgContent)) {
        for (const item of msgContent) {
          const it = item as Record<string, unknown>;
          if (it["type"] === "tool_result") {
            const resultContent = it["content"];
            const preview = typeof resultContent === "string"
              ? resultContent.slice(0, 120)
              : JSON.stringify(resultContent).slice(0, 120);
            turns.push({
              kind: "tool_result",
              label: "tool_result",
              preview,
              ts: (entry["ts"] as string) ?? "",
            });
          }
        }
      }
      continue;
    }

    // Process assistant messages
    if (msgType === "assistant") {
      const msgData = msg["message"] as Record<string, unknown> | undefined;
      if (!msgData) continue;
      const content = msgData["content"] as unknown[] | undefined;
      if (!Array.isArray(content)) continue;

      for (const item of content) {
        const it = item as Record<string, unknown>;
        if (it["type"] === "thinking") continue; // skip thinking blocks

        if (it["type"] === "tool_use") {
          const toolName = (it["name"] as string) ?? "unknown_tool";
          const input = it["input"] as Record<string, unknown> | undefined;
          const preview = input ? JSON.stringify(input).slice(0, 120) : "";
          turns.push({
            kind: "tool_call",
            label: toolName,
            preview,
            ts: (entry["ts"] as string) ?? "",
          });
        } else if (it["type"] === "text") {
          const text = (it["text"] as string) ?? "";
          if (text.trim().length > 0) {
            turns.push({
              kind: "text",
              label: "text",
              preview: text.slice(0, 120),
              ts: (entry["ts"] as string) ?? "",
            });
          }
        }
      }
    }

    if (turns.length >= maxTurns * 3) break; // read enough, we'll slice later
  }

  // Return the most recent maxTurns
  return turns.slice(-maxTurns);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchLiveRuns(
  ctx: PluginContext,
  companyId: string,
  apiUrl: string,
  apiKey: string,
): Promise<LiveRun[]> {
  try {
    const res = await ctx.http.fetch(
      `${apiUrl}/api/companies/${companyId}/live-runs`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) return [];
    return (await res.json()) as LiveRun[];
  } catch {
    return [];
  }
}

async function fetchRunLog(
  ctx: PluginContext,
  runId: string,
  apiUrl: string,
  apiKey: string,
  limitBytes = 32768,
): Promise<string> {
  try {
    const res = await ctx.http.fetch(
      `${apiUrl}/api/heartbeat-runs/${runId}/log?limitBytes=${limitBytes}`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) return "";
    const data = (await res.json()) as { content?: string };
    return data.content ?? "";
  } catch {
    return "";
  }
}

async function fetchIssueTitleHttp(
  ctx: PluginContext,
  issueId: string,
  apiUrl: string,
  apiKey: string,
): Promise<string | null> {
  try {
    const res = await ctx.http.fetch(
      `${apiUrl}/api/issues/${issueId}`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string };
    return data.title ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core: build agent status
// ---------------------------------------------------------------------------

async function buildAgentStatus(
  ctx: PluginContext,
  companyId: string,
  agentId: string | undefined,
  apiUrl: string,
  apiKey: string,
): Promise<AgentStatusResult> {
  const allRuns = await fetchLiveRuns(ctx, companyId, apiUrl, apiKey);
  const runs = agentId ? allRuns.filter((r) => r.agentId === agentId) : allRuns;

  const entries = await Promise.all(
    runs.map(async (run): Promise<AgentStatusEntry> => {
      const now = Date.now();
      const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
      const elapsedMs = startedAt ? now - startedAt : null;

      let recentTurns: RunTurn[] = [];
      let lastActionAt: string | null = null;

      if (run.status === "running") {
        const logContent = await fetchRunLog(ctx, run.id, apiUrl, apiKey);
        if (logContent) {
          recentTurns = parseRunLog(logContent, 5);
          lastActionAt = recentTurns.length > 0
            ? recentTurns[recentTurns.length - 1]!.ts
            : null;
        }
      }

      const taskTitle = run.issueId
        ? await fetchIssueTitleHttp(ctx, run.issueId, apiUrl, apiKey)
        : null;

      return {
        runId: run.id,
        agentId: run.agentId,
        agentName: run.agentName,
        status: run.status,
        taskId: run.issueId,
        taskTitle,
        elapsedMs,
        recentTurns,
        lastActionAt,
      };
    }),
  );

  const result: AgentStatusResult = { agents: entries, fetchedAt: new Date().toISOString() };
  await ctx.state.set({ scopeKind: "instance", stateKey: DATA_KEYS.LIVE }, result);
  return result;
}

// ---------------------------------------------------------------------------
// Core: build run summary
// ---------------------------------------------------------------------------

async function buildRunSummary(
  ctx: PluginContext,
  runId: string,
  apiUrl: string,
  apiKey: string,
): Promise<RunSummaryResult | null> {
  try {
    const runRes = await ctx.http.fetch(
      `${apiUrl}/api/heartbeat-runs/${runId}`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!runRes.ok) return null;
    const run = (await runRes.json()) as {
      id: string;
      agentId: string;
      status: string;
      contextSnapshot?: { issueId?: string };
    } & Record<string, unknown>;

    const agentRes = await ctx.http.fetch(
      `${apiUrl}/api/agents/${run.agentId}`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const agentName: string = agentRes.ok
      ? ((await agentRes.json()) as { name?: string }).name ?? run.agentId
      : run.agentId;

    const logContent = await fetchRunLog(ctx, runId, apiUrl, apiKey, 131072);
    const turns = parseRunLog(logContent, 50);

    const toolCallCount = turns.filter((t) => t.kind === "tool_call").length;
    const commentCount = turns.filter(
      (t) => t.kind === "tool_call" && (t.label === "post_comment" || t.label.includes("comment")),
    ).length;

    const taskId = run.contextSnapshot?.issueId ?? null;

    return {
      runId,
      agentId: run.agentId,
      agentName,
      status: run.status,
      taskId,
      turns,
      toolCallCount,
      commentCount,
      totalTurns: turns.length,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("agent-activity plugin setup");

    const apiUrl = process.env["PAPERCLIP_API_URL"] ?? "http://127.0.0.1:3100";
    const apiKey = process.env["PAPERCLIP_API_KEY"] ?? "";

    // ------------------------------------------------------------------
    // Agent tool: agent_status
    // ------------------------------------------------------------------
    ctx.tools.register(
      TOOL_NAMES.AGENT_STATUS,
      {
        displayName: "Agent Status",
        description:
          "Return a clean, noise-free view of what each agent is doing right now. Shows recent tool calls and current task without injected system context. Use to check if an agent is stuck or progressing.",
        parametersSchema: {
          type: "object",
          properties: {
            companyId: {
              type: "string",
              description: "Company to query. Omit to use context company.",
            },
            agentId: {
              type: "string",
              description: "Filter to a specific agent. Omit for all running agents.",
            },
          },
          required: [],
        },
      },
      async (params, runCtx) => {
        const cid = (params as { companyId?: string }).companyId ?? runCtx.companyId;
        const aid = (params as { agentId?: string }).agentId;
        if (!cid) return { content: "companyId is required", data: null };
        const result = await buildAgentStatus(ctx, cid, aid, apiUrl, apiKey);
        return { content: JSON.stringify(result, null, 2), data: result };
      },
    );

    // ------------------------------------------------------------------
    // Agent tool: run_summary
    // ------------------------------------------------------------------
    ctx.tools.register(
      TOOL_NAMES.RUN_SUMMARY,
      {
        displayName: "Run Summary",
        description:
          "Summarize the meaningful content of a heartbeat run — tool calls made, comments posted, decisions taken. Strips injected skill content and system prompts.",
        parametersSchema: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description: "UUID of the heartbeat run to summarize.",
            },
          },
          required: ["runId"],
        },
      },
      async (params) => {
        const { runId } = params as { runId: string };
        const result = await buildRunSummary(ctx, runId, apiUrl, apiKey);
        if (!result) return { content: `Run ${runId} not found or not accessible.`, data: null };
        return { content: JSON.stringify(result, null, 2), data: result };
      },
    );

    // ------------------------------------------------------------------
    // Data endpoint for UI widget / page
    // ------------------------------------------------------------------
    ctx.data.register(DATA_KEYS.LIVE, async (params) => {
      const companyId = (params as { companyId?: string } | undefined)?.companyId;
      if (!companyId) {
        return (
          (await ctx.state.get({ scopeKind: "instance", stateKey: DATA_KEYS.LIVE })) ?? {
            agents: [],
            fetchedAt: null,
          }
        );
      }
      return await buildAgentStatus(ctx, companyId, undefined, apiUrl, apiKey);
    });

    ctx.logger.info("agent-activity plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Agent Activity plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
