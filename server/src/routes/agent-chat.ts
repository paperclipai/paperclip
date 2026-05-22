/**
 * Agent direct-chat — Claude Agent SDK (subscription auth).
 *
 * Uses @anthropic-ai/claude-agent-sdk `query()`, which drives the local Claude
 * Code runtime and authenticates the same way the `claude` CLI does — the user's
 * Max-plan subscription (macOS keychain) when ANTHROPIC_API_KEY is unset, or a
 * CLAUDE_CODE_OAUTH_TOKEN if provided. No per-token API billing, no separate key.
 *
 * Streams token-level deltas + tool calls over SSE. Multi-turn continuity is via
 * the SDK session id (resume), not a hand-maintained message array.
 */
import { Router } from "express";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { parse as parseYaml } from "yaml";
import { logger } from "../middleware/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface AgentChatState {
  messages: ChatMessage[];
  systemPrompt: string | null; // loaded once, cached
  cwd: string | null; // loaded once, cached
  sessionId: string | null; // Agent SDK session — drives multi-turn resume
}

// ── In-memory state ───────────────────────────────────────────────────────────
const chatState = new Map<string, AgentChatState>();

function getState(agentId: string): AgentChatState {
  if (!chatState.has(agentId)) {
    chatState.set(agentId, { messages: [], systemPrompt: null, cwd: null, sessionId: null });
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
  // Load all instruction files and concatenate — gives the agent its full persona
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

// ── Stream-event shape (minimal; avoids cross-version Beta type coupling) ───────
interface RawStreamEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string };
  content_block?: { type?: string; name?: string };
}

// ── Route factory ─────────────────────────────────────────────────────────────
export function agentChatRoutes(db: Db): Router {
  const router = Router();

  router.get("/agents/:id/chat/messages", (req, res) => {
    res.json({ messages: getState(req.params.id).messages });
  });

  router.delete("/agents/:id/chat/messages", (req, res) => {
    chatState.delete(req.params.id);
    res.json({ ok: true });
  });

  router.post("/agents/:id/chat/messages", async (req, res) => {
    const { id } = req.params;
    const { message, images } = req.body as {
      message?: string;
      images?: { mediaType?: string; data?: string }[];
    };
    const text = message?.trim() ?? "";

    // Vision input: base64 image blocks. Only the formats Claude accepts.
    const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
    type ImageMediaType = (typeof ALLOWED_IMAGE_TYPES)[number];
    const validImages = (Array.isArray(images) ? images : [])
      .filter((im): im is { mediaType: ImageMediaType; data: string } =>
        !!im &&
        typeof im.data === "string" && im.data.length > 0 &&
        typeof im.mediaType === "string" &&
        (ALLOWED_IMAGE_TYPES as readonly string[]).includes(im.mediaType))
      .slice(0, 4); // cap attachments per message

    if (!text && validImages.length === 0) {
      res.status(400).json({ error: "message or image required" });
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

    // Record user message (history bubbles are text-only; note any attachments)
    const imageNote = validImages.length
      ? `${text ? "\n\n" : ""}🖼 ${validImages.length} image${validImages.length > 1 ? "s" : ""} attached`
      : "";
    const userMsg: ChatMessage = { id: `${Date.now()}-u`, role: "user", content: text + imageNote, timestamp: Date.now() };
    state.messages.push(userMsg);
    send("user_message", userMsg);
    send("processing", { processing: true });

    const tempFiles: string[] = [];
    try {
      const adapterConfig = agentRow.adapterConfig as Record<string, unknown>;

      // Load system prompt + cwd once per conversation, then cache
      if (state.systemPrompt === null) {
        state.systemPrompt = await resolveSystemPrompt(adapterConfig);
        state.cwd = await resolveCwd(adapterConfig, agentRow.companyId);
        logger.info({ agentId: id, cwd: state.cwd, promptLen: state.systemPrompt.length }, "agent chat init");
      }

      const cwd = state.cwd ?? os.homedir();

      // Images: write to temp files so the claude CLI can read them natively with
      // its Read tool (vision). The AsyncIterable<SDKUserMessage> approach crashes
      // the subprocess when image content blocks are piped via IPC.
      let prompt = text;
      if (validImages.length > 0) {
        const extMap: Record<string, string> = {
          "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
        };
        const tmpDir = os.tmpdir();
        const paths: string[] = [];
        for (const im of validImages) {
          const ext = extMap[im.mediaType] ?? "png";
          const p = path.join(tmpDir, `pchat-${randomUUID()}.${ext}`);
          await fs.writeFile(p, Buffer.from(im.data, "base64"));
          tempFiles.push(p);
          paths.push(p);
        }
        const fileList = paths.map((p, i) => `Image ${i + 1}: ${p}`).join("\n");
        prompt = `${text ? text + "\n\n" : ""}The following image file${paths.length > 1 ? "s have" : " has"} been saved for you to view:\n${fileList}\nPlease read and analyse ${paths.length > 1 ? "them" : "it"} to answer the user's request.`;
      }

      const q = query({
        prompt,
        options: {
          cwd,
          model: "claude-sonnet-4-6",
          // Plain-string systemPrompt replaces the default and carries the agent's persona.
          ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
          allowedTools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
          // Headless server — no human to approve. Matches the platform's heartbeat
          // posture (claude_local runs with --dangerously-skip-permissions).
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          maxTurns: 30,
          // Multi-turn continuity across messages in this chat.
          ...(state.sessionId ? { resume: state.sessionId } : {}),
        },
      });

      // Stop the agent if the client disconnects mid-stream.
      req.on("close", () => { void q.interrupt().catch(() => {}); });

      let fullText = "";
      let terminal = false;
      const toolBlocks = new Map<number, { name: string; json: string }>();

      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === "system" && msg.subtype === "init") {
          state.sessionId = msg.session_id;
          continue;
        }

        if (msg.type === "stream_event") {
          const ev = msg.event as unknown as RawStreamEvent;
          if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
            const name = ev.content_block.name ?? "tool";
            if (typeof ev.index === "number") toolBlocks.set(ev.index, { name, json: "" });
            send("tool_call", { name });
          } else if (ev.type === "content_block_delta") {
            if (ev.delta?.type === "text_delta" && ev.delta.text) {
              fullText += ev.delta.text;
              send("delta", { text: ev.delta.text });
            } else if (ev.delta?.type === "input_json_delta" && typeof ev.index === "number") {
              const t = toolBlocks.get(ev.index);
              if (t) t.json += ev.delta.partial_json ?? "";
            }
          } else if (ev.type === "content_block_stop" && typeof ev.index === "number") {
            const t = toolBlocks.get(ev.index);
            if (t) {
              try {
                const input = JSON.parse(t.json || "{}") as { command?: string };
                if (typeof input.command === "string") send("tool_call", { command: input.command });
              } catch { /* partial / non-bash input */ }
            }
          }
          continue;
        }

        // Auth/billing failures surface as an error on the assistant message.
        if (msg.type === "assistant" && msg.error) {
          const m =
            msg.error === "authentication_failed"
              ? "Subscription auth failed. Run `claude` to log in (Max plan), or set CLAUDE_CODE_OAUTH_TOKEN on the server."
              : `Agent error: ${msg.error}`;
          send("error", { message: m });
          terminal = true;
          break;
        }

        if (msg.type === "result") {
          if (msg.subtype === "success" && !msg.is_error) {
            const content = fullText || msg.result || "(no response)";
            const assistantMsg: ChatMessage = {
              id: `${Date.now()}-a`,
              role: "assistant",
              content,
              timestamp: Date.now(),
            };
            state.messages.push(assistantMsg);
            send("assistant_message", assistantMsg);
          } else {
            const reason =
              ("errors" in msg && msg.errors?.length ? msg.errors.join("; ") : null) ??
              `Agent stopped (${msg.subtype})`;
            send("error", { message: reason });
          }
          terminal = true;
          break;
        }
      }

      if (!terminal) {
        // Stream ended without a result — surface what we have, or a generic error.
        if (fullText) {
          const assistantMsg: ChatMessage = {
            id: `${Date.now()}-a`,
            role: "assistant",
            content: fullText,
            timestamp: Date.now(),
          };
          state.messages.push(assistantMsg);
          send("assistant_message", assistantMsg);
        } else {
          send("error", { message: "Agent ended without a response." });
        }
      }
    } catch (err) {
      logger.error({ err, agentId: id }, "agent chat error");
      send("error", { message: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      // Clean up any temp image files written for this turn.
      for (const p of tempFiles) { await fs.unlink(p).catch(() => {}); }
    }

    send("processing", { processing: false });
    res.end();
  });

  return router;
}
