#!/usr/bin/env bun
/**
 * Paperclip Channel Plugin for Claude Code
 *
 * Pushes Paperclip heartbeat tasks into a running Claude Code session.
 * Paperclip sends POST /heartbeat → this channel pushes it as a <channel> event
 * → Claude does the work → calls paperclip_update tool to report back.
 *
 * Runs alongside Telegram channel in the same session.
 *
 * Cost tracking (SHA-1865):
 *   claude+ writes a session JSONL at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *   with per-assistant-message `message.usage`. On each /heartbeat POST we record
 *   the current tail offset of the most recent JSONL; when claude+ calls a
 *   paperclip_* tool with a known run_id we read the delta, aggregate usage by
 *   model, price it, and POST a cost-event so HTTP-adapter agents show up in
 *   Paperclip's spend dashboards like claude_local agents do.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { open } from "fs/promises";
import { homedir } from "os";
import path from "path";

// Load /etc/default/paperclip if env vars are missing
const envFile = "/etc/default/paperclip";
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]?.trim()) {
      process.env[match[1]] = match[2];
    }
  }
}

const PORT = parseInt(process.env.PAPERCLIP_LISTENER_PORT || "8201");
const API_URL = process.env.PAPERCLIP_API_URL || "http://192.168.4.151:3100/api";
const API_KEY = process.env.PAPERCLIP_API_KEY || "";
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";

// --- Paperclip API helper ---------------------------------------------------
async function paperclipFetch(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// --- Cost tracking ----------------------------------------------------------
// Anthropic USD pricing per million tokens. Prefix match so dated model IDs
// (claude-opus-4-7-20260101) still resolve.
type Pricing = { input: number; output: number; cacheRead: number; cacheWrite: number };
const PRICING: Record<string, Pricing> = {
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};
function priceFor(model: string): Pricing {
  for (const [key, value] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return value;
  }
  if (model.includes("opus")) return PRICING["claude-opus-4"];
  if (model.includes("haiku")) return PRICING["claude-haiku-4"];
  return PRICING["claude-sonnet-4"];
}

const CLAUDE_PROJECTS_DIR = path.join(homedir(), ".claude", "projects");
function currentSessionJsonl(): string | null {
  const encoded = process.cwd().replace(/\//g, "-");
  const dir = path.join(CLAUDE_PROJECTS_DIR, encoded);
  if (!existsSync(dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(dir, name);
      try {
        const st = statSync(full);
        if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs };
      } catch {}
    }
  } catch {}
  return best?.path ?? null;
}

type PendingRun = {
  runId: string;
  taskId: string;
  jsonlPath: string | null;
  offset: number;
  startedAt: number;
  flushed: boolean;
};
const pendingRuns = new Map<string, PendingRun>();

function snapshotOffset(jsonlPath: string | null): number {
  if (!jsonlPath) return 0;
  try { return statSync(jsonlPath).size; } catch { return 0; }
}

async function flushUsageForRun(runId: string, opts: { final?: boolean } = {}) {
  if (!runId) return;
  const pending = pendingRuns.get(runId);
  if (!pending || pending.flushed) return;

  const jsonlPath = pending.jsonlPath;
  if (!jsonlPath || !existsSync(jsonlPath)) return;

  let size = 0;
  try { size = statSync(jsonlPath).size; } catch { return; }
  let start = pending.offset;
  if (size < start) start = 0;
  if (size <= start) return;

  let content: string;
  try {
    const fh = await open(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      content = buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return;
  }

  type Totals = { input: number; cacheWrite: number; cacheRead: number; output: number };
  const perModel = new Map<string, Totals>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed.type !== "assistant") continue;
    const msg = parsed.message;
    if (!msg?.usage || !msg?.model) continue;
    const u = msg.usage;
    const t = perModel.get(msg.model) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    t.input += u.input_tokens || 0;
    t.cacheWrite += u.cache_creation_input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.output += u.output_tokens || 0;
    perModel.set(msg.model, t);
  }

  pending.offset = size;
  if (opts.final) {
    pending.flushed = true;
    pendingRuns.delete(runId);
  }

  if (perModel.size === 0) return;

  const occurredAt = new Date().toISOString();
  for (const [model, t] of perModel) {
    const price = priceFor(model);
    const costUsd =
      (t.input * price.input +
        t.cacheWrite * price.cacheWrite +
        t.cacheRead * price.cacheRead +
        t.output * price.output) / 1_000_000;
    const costCents = Math.max(0, Math.round(costUsd * 100));
    const body: Record<string, unknown> = {
      agentId: AGENT_ID,
      heartbeatRunId: pending.runId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model,
      inputTokens: t.input,
      cachedInputTokens: t.cacheRead + t.cacheWrite,
      outputTokens: t.output,
      costCents,
      occurredAt,
    };
    if (pending.taskId) body.issueId = pending.taskId;
    try {
      await paperclipFetch("POST", `/companies/${COMPANY_ID}/cost-events`, body);
    } catch (err) {
      console.error(`[paperclip-channel] cost-event POST failed: ${(err as Error).message}`);
    }
  }
}

function flushFromToolCall(toolName: string, args: Record<string, string>) {
  const runId = args?.run_id;
  if (!runId) return;
  const final =
    toolName === "paperclip_update" &&
    ["done", "blocked", "in_review"].includes(args?.status);
  flushUsageForRun(runId, { final }).catch((err) =>
    console.error(`[paperclip-channel] flush failed: ${err?.message ?? err}`)
  );
}

// Best-effort cleanup of runs whose terminal paperclip_update never arrived.
setInterval(() => {
  const cutoffMs = 30 * 60_000;
  const now = Date.now();
  for (const [runId, p] of pendingRuns) {
    if (now - p.startedAt > cutoffMs) {
      flushUsageForRun(runId, { final: true }).catch(() => {});
    }
  }
}, 5 * 60_000);

// --- MCP Server with channel capability -------------------------------------
const mcp = new Server(
  { name: "paperclip", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `Paperclip heartbeat tasks arrive as <channel source="paperclip" run_id="..." task_id="..." wake_reason="...">.

When you receive a heartbeat:
1. Read the task description in the channel event
2. If task_id is set, use the paperclip_checkout tool to claim it
3. Do the actual work described in the task
4. Use the paperclip_update tool to update the task status and add a comment
5. If no task is assigned, use paperclip_inbox to check for assignments

Always include the run_id from the channel event when updating tasks.

For routine execution tasks: post your results as a comment using paperclip_comment, but do NOT mark the issue as done. Leave it in_progress so the next routine fire reuses the same issue.

If wake_reason is "message_approved", read the message_text from the meta and send it via crisp_reply, then post a confirmation comment.

Available tools:
- paperclip_inbox: Check your assigned tasks
- paperclip_checkout: Claim a task before working on it
- paperclip_update: Update task status and add a comment
- paperclip_comment: Add a comment without changing status
- paperclip_create_issue: Create a new issue for problems you discover. Always set assignee_agent_id to the Coordinator (4f525e83-7b23-47c2-884f-71b6bff440bd) for triage unless you are creating a message approval for yourself.`,
  }
);

// --- Tools ------------------------------------------------------------------
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "paperclip_inbox",
      description:
        "Check your Paperclip inbox for assigned tasks. Returns compact list of todo/in_progress/blocked issues.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "paperclip_checkout",
      description:
        "Claim a task before working on it. Must be called before doing any work. Returns 409 if another agent owns it.",
      inputSchema: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "The issue UUID to checkout" },
          run_id: { type: "string", description: "The heartbeat run_id from the channel event" },
        },
        required: ["issue_id", "run_id"],
      },
    },
    {
      name: "paperclip_update",
      description:
        "Update a task's status and add a comment. Use after completing or getting blocked on work.",
      inputSchema: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "The issue UUID to update" },
          run_id: { type: "string", description: "The heartbeat run_id" },
          status: {
            type: "string",
            enum: ["in_progress", "in_review", "done", "blocked"],
            description: "New status",
          },
          comment: { type: "string", description: "Markdown comment describing what was done" },
        },
        required: ["issue_id", "run_id", "status", "comment"],
      },
    },
    {
      name: "paperclip_comment",
      description: "Add a comment to a task without changing its status.",
      inputSchema: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "The issue UUID" },
          run_id: { type: "string", description: "The heartbeat run_id" },
          body: { type: "string", description: "Markdown comment" },
        },
        required: ["issue_id", "body"],
      },
    },
    {
      name: "paperclip_create_issue",
      description:
        "Create a new Paperclip issue for problems you discover during work.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          description: { type: "string", description: "Markdown description" },
          priority: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
            description: "Priority level",
          },
          status: {
            type: "string",
            enum: ["backlog", "todo", "in_progress", "in_review"],
            description: "Initial status (default: todo)",
          },
          label_ids: {
            type: "string",
            description: "JSON array of label UUIDs to attach, e.g. '[\"uuid1\"]'",
          },
          assignee_agent_id: {
            type: "string",
            description: "Agent UUID to assign the issue to",
          },
        },
        required: ["title", "description"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments || {}) as Record<string, string>;
  let response: unknown;

  switch (req.params.name) {
    case "paperclip_inbox": {
      response = await paperclipFetch("GET", `/agents/me/inbox-lite`);
      break;
    }

    case "paperclip_checkout": {
      response = await paperclipFetch(
        "POST",
        `/issues/${args.issue_id}/checkout`,
        { agentId: AGENT_ID, expectedStatuses: ["todo", "backlog", "blocked"] },
        { "X-Paperclip-Run-Id": args.run_id }
      );
      break;
    }

    case "paperclip_update": {
      const body: Record<string, unknown> = {
        status: args.status,
        comment: args.comment,
      };
      response = await paperclipFetch("PATCH", `/issues/${args.issue_id}`, body, {
        "X-Paperclip-Run-Id": args.run_id,
      });
      break;
    }

    case "paperclip_comment": {
      response = await paperclipFetch(
        "POST",
        `/issues/${args.issue_id}/comments`,
        { body: args.body },
        args.run_id ? { "X-Paperclip-Run-Id": args.run_id } : {}
      );
      break;
    }

    case "paperclip_create_issue": {
      const body: Record<string, unknown> = {
        title: args.title,
        description: args.description,
        priority: args.priority || "high",
        status: args.status || "todo",
      };
      if (args.assignee_agent_id) body.assigneeAgentId = args.assignee_agent_id;
      if (args.label_ids) {
        try { body.labelIds = JSON.parse(args.label_ids); } catch {}
      }
      response = await paperclipFetch(
        "POST",
        `/companies/${COMPANY_ID}/issues`,
        body
      );
      break;
    }

    default:
      throw new Error(`Unknown tool: ${req.params.name}`);
  }

  flushFromToolCall(req.params.name, args);
  return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
});

// --- Connect to Claude Code over stdio --------------------------------------
await mcp.connect(new StdioServerTransport());

// --- HTTP listener for Paperclip heartbeat webhooks -------------------------
Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", agentId: AGENT_ID, channel: true });
    }

    if (req.method === "POST" && url.pathname === "/heartbeat") {
      const body = await req.json() as Record<string, unknown>;
      const context = (body.context || {}) as Record<string, string>;

      const taskId = context.taskId || "";
      const runId = (body.runId || "") as string;
      const wakeReason = context.wakeReason || "manual";
      const commentId = context.wakeCommentId || "";

      // Snapshot the current JSONL tail so cost-tracking can diff on flush.
      if (runId) {
        const jsonlPath = currentSessionJsonl();
        pendingRuns.set(runId, {
          runId,
          taskId,
          jsonlPath,
          offset: snapshotOffset(jsonlPath),
          startedAt: Date.now(),
          flushed: false,
        });
      }

      // Build the task description for Claude
      let taskInfo = `Heartbeat received. Wake reason: ${wakeReason}.`;
      if (taskId) {
        // Fetch the actual task details
        try {
          const issue = (await paperclipFetch("GET", `/issues/${taskId}`)) as Record<string, unknown>;
          taskInfo = `Task: ${(issue as any).identifier || taskId}\nTitle: ${(issue as any).title}\nStatus: ${(issue as any).status}\n\nDescription:\n${(issue as any).description || "No description"}`;
        } catch {
          taskInfo = `Task ${taskId} assigned but could not fetch details.`;
        }
      }

      // If triggered by a comment mention, fetch the comment
      if (commentId && taskId) {
        try {
          const comment = (await paperclipFetch("GET", `/issues/${taskId}/comments/${commentId}`)) as Record<string, unknown>;
          taskInfo += `\n\n---\n\n**You were @-mentioned in this comment:**\n${(comment as any).body || ""}`;
        } catch {
          // Try fetching recent comments as fallback
          try {
            const comments = (await paperclipFetch("GET", `/issues/${taskId}/comments?order=desc&limit=3`)) as any[];
            if (comments?.length) {
              taskInfo += `\n\n---\n\n**Recent comments:**`;
              for (const c of comments.slice(0, 3)) {
                taskInfo += `\n\n> ${c.body?.slice(0, 500) || ""}`;
              }
            }
          } catch {}
        }
      }

      // Append approved message text for message_approved wakes
      const messageText = context.messageText || "";
      if (wakeReason === "message_approved" && messageText) {
        taskInfo += `\n\n---\n\n**Approved message text to send:**\n${messageText}`;
      }

      // Push into the running Claude session
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: taskInfo,
          meta: {
            run_id: runId,
            task_id: taskId,
            wake_reason: wakeReason,
            ...(commentId ? { comment_id: commentId } : {}),
            ...(messageText ? { message_text: messageText } : {}),
          },
        },
      });

      return Response.json({ status: "accepted", runId });
    }

    return new Response("not found", { status: 404 });
  },
});

console.error(`[paperclip-channel] listening on 0.0.0.0:${PORT}`);
