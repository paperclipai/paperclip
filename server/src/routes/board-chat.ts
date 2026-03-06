import { Router } from "express";
import { spawn } from "node:child_process";
import type { Db } from "@paperclipai/db";
import { assertBoard } from "./authz.js";
import { logActivity } from "../services/index.js";
import { logger } from "../middleware/logger.js";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_TIMEOUT_MS = 60_000;

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const TOOL_RESULT_OPEN = "<tool_result>";
const TOOL_RESULT_CLOSE = "</tool_result>";

interface DisplayMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result";
  content?: string;
  method?: string;
  path?: string;
  body?: unknown;
  isError?: boolean;
}

function buildPrompt(
  userMessage: string,
  history: DisplayMessage[],
): string {
  const systemBlock = `You are a Paperclip board control agent. Paperclip is an AI company orchestration platform running on this server.

You can make REST API calls to control everything: companies, agents, tasks (issues), goals, projects, budgets, and governance.

To make an API call, output exactly this format (one per call):
${TOOL_CALL_OPEN}{"method":"GET","path":"/api/companies"}${TOOL_CALL_CLOSE}

For POST/PATCH, include a body:
${TOOL_CALL_OPEN}{"method":"POST","path":"/api/companies/abc/issues","body":{"title":"Fix bug","description":"Details here"}}${TOOL_CALL_CLOSE}

After each tool call block, STOP and wait. The system will execute the call and provide results in ${TOOL_RESULT_OPEN}...${TOOL_RESULT_CLOSE} blocks, then you continue.

Available endpoints:
- GET  /api/health → health check
- GET  /api/companies → list companies
- POST /api/companies → create company {name, mission}
- GET  /api/companies/:id/dashboard → company dashboard
- GET  /api/companies/:id/agents → list agents
- POST /api/companies/:id/agents → create agent
- GET  /api/agents/:agentId → get agent details
- PATCH /api/agents/:agentId → update agent
- POST /api/agents/:agentId/wakeup → trigger heartbeat
- POST /api/agents/:agentId/heartbeat/invoke → invoke heartbeat
- POST /api/agents/:agentId/pause → pause agent
- POST /api/agents/:agentId/resume → resume agent
- POST /api/agents/:agentId/terminate → terminate agent (irreversible)
- GET  /api/companies/:id/heartbeat-runs → list runs
- GET  /api/companies/:id/issues → list issues/tasks
- POST /api/companies/:id/issues → create issue {title, description, assignee_id, project_id, goal_id}
- PATCH /api/companies/:id/issues/:issueId → update issue {status, comment, assignee_id}
- GET  /api/companies/:id/goals → list goals
- POST /api/companies/:id/goals → create goal {title, description, parent_id}
- GET  /api/companies/:id/projects → list projects
- POST /api/companies/:id/projects → create project {name, goal_id}
- GET  /api/companies/:id/costs → cost data

Always start by fetching /api/health then /api/companies. Be proactive — fetch data rather than asking the user. Format output clearly.`;

  let prompt = systemBlock + "\n\n";

  // Append conversation history
  for (const msg of history) {
    if (msg.role === "user") {
      prompt += `User: ${msg.content}\n\n`;
    } else if (msg.role === "assistant") {
      prompt += `Assistant: ${msg.content}\n\n`;
    } else if (msg.role === "tool_call") {
      prompt += `${TOOL_CALL_OPEN}{"method":"${msg.method}","path":"${msg.path}"${msg.body ? `,"body":${JSON.stringify(msg.body)}` : ""}}${TOOL_CALL_CLOSE}\n\n`;
    } else if (msg.role === "tool_result") {
      prompt += `${TOOL_RESULT_OPEN}${msg.content}${TOOL_RESULT_CLOSE}\n\n`;
    }
  }

  prompt += `User: ${userMessage}\n\nAssistant:`;
  return prompt;
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ["-p", "--output-format", "text"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("claude -p timed out"));
    }, CLAUDE_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseToolCalls(
  text: string,
): { segments: Array<{ type: "text"; content: string } | { type: "tool_call"; method: string; path: string; body?: unknown }> } {
  const segments: Array<{ type: "text"; content: string } | { type: "tool_call"; method: string; path: string; body?: unknown }> = [];
  let remaining = text;

  while (remaining.length > 0) {
    const openIdx = remaining.indexOf(TOOL_CALL_OPEN);
    if (openIdx === -1) {
      const trimmed = remaining.trim();
      if (trimmed) segments.push({ type: "text", content: trimmed });
      break;
    }

    const before = remaining.slice(0, openIdx).trim();
    if (before) segments.push({ type: "text", content: before });

    const closeIdx = remaining.indexOf(TOOL_CALL_CLOSE, openIdx);
    if (closeIdx === -1) {
      const rest = remaining.slice(openIdx).trim();
      if (rest) segments.push({ type: "text", content: rest });
      break;
    }

    const jsonStr = remaining.slice(openIdx + TOOL_CALL_OPEN.length, closeIdx);
    try {
      const parsed = JSON.parse(jsonStr);
      segments.push({ type: "tool_call", method: parsed.method, path: parsed.path, body: parsed.body });
    } catch {
      segments.push({ type: "text", content: jsonStr });
    }

    remaining = remaining.slice(closeIdx + TOOL_CALL_CLOSE.length);
  }

  return { segments };
}

async function executeApiCall(
  method: string,
  path: string,
  body: unknown,
  port: number,
  cookie?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `http://127.0.0.1:${port}${path.startsWith("/") ? path : "/" + path}`;
  try {
    const opts: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    };
    if (body && (method === "POST" || method === "PATCH")) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { ok: res.ok, status: res.status, data: parsed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, data: { error: message } };
  }
}

const VALID_ROLES = new Set(["user", "assistant", "tool_call", "tool_result"]);

function validateHistory(history: unknown): DisplayMessage[] {
  if (!Array.isArray(history)) return [];
  const validated: DisplayMessage[] = [];
  for (const entry of history) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (!VALID_ROLES.has(e.role as string)) continue;
    validated.push({
      role: e.role as DisplayMessage["role"],
      ...(typeof e.content === "string" ? { content: e.content } : {}),
      ...(typeof e.method === "string" ? { method: e.method } : {}),
      ...(typeof e.path === "string" ? { path: e.path } : {}),
      ...(e.body !== undefined ? { body: e.body } : {}),
      ...(typeof e.isError === "boolean" ? { isError: e.isError } : {}),
    });
  }
  return validated;
}

export function boardChatRoutes(db: Db) {
  const router = Router();

  router.post("/board/chat", async (req, res, next) => {
    try {
      assertBoard(req);

      const { message, history: rawHistory } = req.body as {
        message: string;
        history?: unknown;
      };

      if (!message?.trim()) {
        res.status(400).json({ error: "message is required" });
        return;
      }

      const port = Number(process.env.PORT) || 3100;
      const cookie = req.headers.cookie;
      const displayMessages: DisplayMessage[] = [];
      const fullHistory: DisplayMessage[] = validateHistory(rawHistory);
      let maxTurns = 10;

      while (maxTurns-- > 0) {
        const prompt = buildPrompt(message, fullHistory);
        let claudeOutput: string;
        try {
          claudeOutput = await runClaude(prompt);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error({ err: errMsg }, "claude -p failed");
          displayMessages.push({ role: "assistant", content: `Error running claude: ${errMsg}` });
          break;
        }

        const { segments } = parseToolCalls(claudeOutput);
        const toolCalls = segments.filter((s) => s.type === "tool_call");

        // Add text segments as assistant messages
        for (const seg of segments) {
          if (seg.type === "text") {
            displayMessages.push({ role: "assistant", content: seg.content });
            fullHistory.push({ role: "assistant", content: seg.content });
          }
        }

        if (toolCalls.length === 0) break;

        // Execute tool calls
        for (const call of toolCalls) {
          if (call.type !== "tool_call") continue;

          displayMessages.push({ role: "tool_call", method: call.method, path: call.path, body: call.body });
          fullHistory.push({ role: "tool_call", method: call.method, path: call.path, body: call.body });

          const result = await executeApiCall(call.method, call.path, call.body, port, cookie);
          const resultText = JSON.stringify(result.data, null, 2);
          const isError = !result.ok;

          displayMessages.push({ role: "tool_result", content: resultText, isError });
          fullHistory.push({ role: "tool_result", content: resultText, isError });

          // Log mutating API calls for audit trail
          if (call.method !== "GET" && result.ok) {
            const companyMatch = call.path.match(/\/api\/companies\/([^/]+)/);
            const companyId = companyMatch?.[1];
            if (companyId) {
              await logActivity(db, {
                companyId,
                actorType: "user",
                actorId: req.actor.userId ?? "board",
                action: "board_terminal.api_call",
                entityType: "board_terminal",
                entityId: "board_terminal",
                details: { method: call.method, path: call.path },
              }).catch((err) => {
                logger.warn({ err }, "Failed to log board terminal activity");
              });
            }
          }
        }
      }

      res.json({ messages: displayMessages });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
