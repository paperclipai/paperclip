/**
 * Agent direct-chat — Anthropic SDK + bash tool.
 * Fast SDK streaming (~0.8s) with full local tool access via bash.
 * No CLI spawn, no board pollution, no heartbeat.
 */
import { Router } from "express";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { parse as parseYaml } from "yaml";
import { logger } from "../middleware/logger.js";

const execAsync = promisify(exec);

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface AgentChatState {
  messages: ChatMessage[];
  apiMessages: Anthropic.MessageParam[];
  systemPrompt: string | null; // loaded once, cached
  cwd: string | null;          // loaded once, cached
}

// ── In-memory state ───────────────────────────────────────────────────────────
const chatState = new Map<string, AgentChatState>();

function getState(agentId: string): AgentChatState {
  if (!chatState.has(agentId)) {
    chatState.set(agentId, { messages: [], apiMessages: [], systemPrompt: null, cwd: null });
  }
  return chatState.get(agentId)!;
}

// ── Ecosystem / CWD ───────────────────────────────────────────────────────────
interface Ecosystem {
  orgs: Record<string, { name: string; paperclip_id: string; prefix: string }>;
  projects: { id: string; org: string; local: string }[];
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p === "~" ? os.homedir() : p;
}

async function resolveOrgRoot(companyId: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), ".gsai", "ecosystem.yaml"), "utf-8");
    const eco = parseYaml(raw) as Ecosystem;
    const orgKey = Object.keys(eco.orgs ?? {}).find((k) => eco.orgs[k]?.paperclip_id === companyId);
    if (!orgKey) return null;
    const locals = (eco.projects ?? [])
      .filter((p) => p.org === orgKey && typeof p.local === "string")
      .map((p) => expandHome(p.local));
    if (!locals.length) return null;
    const split = locals.map((p) => path.normalize(p).split(path.sep));
    const n = Math.min(...split.map((p) => p.length));
    const common: string[] = [];
    for (let i = 0; i < n; i++) {
      if (split.every((p) => p[i] === split[0][i])) common.push(split[0][i]);
      else break;
    }
    const dir = common.join(path.sep);
    if (!dir || dir === "/") return null;
    await fs.access(dir);
    return dir;
  } catch { return null; }
}

async function resolveCwd(adapterConfig: Record<string, unknown>, companyId: string): Promise<string> {
  if (typeof adapterConfig.cwd === "string" && adapterConfig.cwd.trim()) {
    return adapterConfig.cwd.trim();
  }
  return (await resolveOrgRoot(companyId)) ?? os.homedir();
}

// ── Instructions file resolution ─────────────────────────────────────────────
async function resolveSystemPrompt(adapterConfig: Record<string, unknown>): Promise<string> {
  const bundle =
    typeof adapterConfig.instructionsRootPath === "string" && adapterConfig.instructionsRootPath.trim()
      ? adapterConfig.instructionsRootPath.trim()
      : null;
  if (!bundle) return "";
  // Load all instruction files and concatenate — gives agent full operating context
  const candidates = ["SOUL.md", "AGENTS.md", "HEARTBEAT.md", "Specific-Instructions.md", "TOOLS.md"];
  const parts: string[] = [];
  for (const name of candidates) {
    try {
      const content = await fs.readFile(path.join(bundle, name), "utf-8");
      parts.push(`# ${name}\n\n${content}`);
    } catch { /* not present */ }
  }
  return parts.join("\n\n---\n\n");
}

// ── Bash tool execution ───────────────────────────────────────────────────────
const BASH_TIMEOUT_MS = 30_000;

async function runBash(command: string, cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: BASH_TIMEOUT_MS,
      env: { ...process.env, HOME: os.homedir() },
    });
    const out = stdout.trim();
    const err = stderr.trim();
    if (!out && err) return `stderr: ${err}`;
    if (out && err) return `${out}\n(stderr: ${err})`;
    return out || "(no output)";
  } catch (e: unknown) {
    const err = e as { message?: string; stdout?: string; stderr?: string };
    const detail = err.stderr?.trim() || err.stdout?.trim() || err.message || "unknown error";
    return `error: ${detail}`;
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: `Run a bash command in the agent's working directory.
Use this to query the Paperclip API (curl http://localhost:3100/...), read files, check git, etc.
Rules: no 'find /' or full-filesystem scans; no interactive commands; timeout is 30s.
Prefer targeted paths. For the Paperclip API see HEARTBEAT.md — use the documented endpoints.`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
      },
      required: ["command"],
    },
  },
];

// ── Route factory ─────────────────────────────────────────────────────────────
export function agentChatRoutes(db: Db): Router {
  const router = Router();

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  router.get("/agents/:id/chat/messages", (req, res) => {
    res.json({ messages: getState(req.params.id).messages });
  });

  router.delete("/agents/:id/chat/messages", (req, res) => {
    chatState.delete(req.params.id);
    res.json({ ok: true });
  });

  router.post("/agents/:id/chat/messages", async (req, res) => {
    const { id } = req.params;
    const { message } = req.body as { message?: string };
    if (!message?.trim()) { res.status(400).json({ error: "message required" }); return; }

    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(503).json({ error: "ANTHROPIC_API_KEY not configured on server" });
      return;
    }

    const agentRow = await db
      .select({ id: agents.id, name: agents.name, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, id))
      .then((r) => r[0] ?? null)
      .catch(() => null);

    if (!agentRow) { res.status(404).json({ error: "agent not found" }); return; }

    // Open SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: string, data: object) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const state = getState(id);

    // Record user message
    const userMsg: ChatMessage = { id: `${Date.now()}-u`, role: "user", content: message.trim(), timestamp: Date.now() };
    state.messages.push(userMsg);
    send("user_message", userMsg);
    send("processing", { processing: true });

    try {
      const adapterConfig = agentRow.adapterConfig as Record<string, unknown>;

      // Load system prompt + cwd once per conversation, then cache
      if (state.systemPrompt === null) {
        state.systemPrompt = await resolveSystemPrompt(adapterConfig);
        state.cwd = await resolveCwd(adapterConfig, agentRow.companyId);
        logger.info({ agentId: id, cwd: state.cwd, promptLen: state.systemPrompt.length }, "agent chat init");
      }

      const cwd = state.cwd ?? os.homedir();

      // Append new user message to API history
      state.apiMessages.push({ role: "user", content: message.trim() });

      let fullText = "";

      // Agentic loop — runs until end_turn (no more tool calls)
      while (true) {
        let currentText = "";
        let stopReason: string | null = null;
        const toolUses: Array<{ id: string; name: string; inputJson: string }> = [];
        let activeToolIdx = -1;

        const stream = anthropic.messages.stream({
          model: "claude-sonnet-4-6",
          max_tokens: 8096,
          ...(state.systemPrompt ? { system: state.systemPrompt } : {}),
          tools: TOOLS,
          messages: state.apiMessages,
        });

        for await (const event of stream) {
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              activeToolIdx = toolUses.length;
              toolUses.push({ id: event.content_block.id, name: event.content_block.name, inputJson: "" });
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              currentText += event.delta.text;
              fullText += event.delta.text;
              send("delta", { text: event.delta.text });
            } else if (event.delta.type === "input_json_delta" && activeToolIdx >= 0) {
              toolUses[activeToolIdx].inputJson += event.delta.partial_json;
            }
          } else if (event.type === "message_delta") {
            stopReason = event.delta.stop_reason ?? null;
          }
        }

        if (stopReason !== "tool_use" || toolUses.length === 0) break;

        // Build assistant message with text + tool_use blocks
        const assistantContent: Anthropic.ContentBlock[] = [];
        if (currentText) assistantContent.push({ type: "text", text: currentText });
        for (const tu of toolUses) {
          let input: unknown = {};
          try { input = JSON.parse(tu.inputJson || "{}"); } catch { /* keep empty */ }
          assistantContent.push({ type: "tool_use", id: tu.id, name: tu.name, input });
        }
        state.apiMessages.push({ role: "assistant", content: assistantContent });

        // Execute tools and build tool_result message
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          let input: { command?: string } = {};
          try { input = JSON.parse(tu.inputJson || "{}"); } catch { /* keep empty */ }

          send("tool_call", { name: tu.name, command: input.command ?? "" });

          let result = "(unknown tool)";
          if (tu.name === "bash" && input.command) {
            result = await runBash(input.command, cwd);
          }
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
        }
        state.apiMessages.push({ role: "user", content: toolResults });
        // loop continues to get the assistant's follow-up response
      }

      // Push final assistant message to API history
      state.apiMessages.push({ role: "assistant", content: fullText || "(no response)" });

      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-a`,
        role: "assistant",
        content: fullText || "(no response)",
        timestamp: Date.now(),
      };
      state.messages.push(assistantMsg);
      send("assistant_message", assistantMsg);
    } catch (err) {
      logger.error({ err, agentId: id }, "agent chat error");
      send("error", { message: err instanceof Error ? err.message : "Unknown error" });
    }

    send("processing", { processing: false });
    res.end();
  });

  return router;
}
