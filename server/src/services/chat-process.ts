/**
 * Chat Process Manager — spawns independent Claude Code processes for chat sessions.
 *
 * Unlike heartbeat runs, chat processes do NOT occupy the agent's run slot.
 * They run in parallel with the heartbeat queue, allowing agents to chat
 * and work on tasks simultaneously.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import {
  buildPaperclipEnv,
  ensurePathInEnv,
  asString,
  asBoolean,
  asNumber,
  asStringArray,
  parseObject,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { publishLiveEvent } from "./live-events.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ── Types ──────────────────────────────────────────────────────────

export interface ChatProcess {
  id: string;
  agentId: string;
  companyId: string;
  sessionId: string;
  pid: number | null;
  startedAt: string;
  status: "running" | "exited";
  exitCode: number | null;
}

interface AgentInfo {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

// ── In-memory store ────────────────────────────────────────────────

/** agentId → running chat process */
const chatProcesses = new Map<string, { meta: ChatProcess; child: ChildProcess }>();

// ── Skills directory ───────────────────────────────────────────────

const PAPERCLIP_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../node_modules/@paperclipai/adapter-claude-local/dist/skills"),
  path.resolve(__moduleDir, "../../../skills"),
  path.resolve(__moduleDir, "../../../../skills"),
];

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of PAPERCLIP_SKILLS_CANDIDATES) {
    const isDir = await fs
      .stat(candidate)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

async function buildSkillsDir(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-chat-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const skillsDir = await resolvePaperclipSkillsDir();
  if (!skillsDir) return tmp;
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await fs.symlink(path.join(skillsDir, entry.name), path.join(target, entry.name));
    }
  }
  return tmp;
}

// ── Service ────────────────────────────────────────────────────────

export function chatProcessService() {
  /**
   * Spawn a chat process for an agent, independent of the heartbeat queue.
   * Returns the chat process metadata, or the existing one if already running.
   */
  async function spawnChatProcess(opts: {
    agent: AgentInfo;
    sessionId: string;
    initialMessage?: string;
  }): Promise<ChatProcess> {
    const existing = chatProcesses.get(opts.agent.id);
    if (existing && existing.meta.status === "running") {
      return existing.meta;
    }

    const chatId = randomUUID();
    const config = parseObject(opts.agent.adapterConfig);
    const command = asString(config.command, "claude");
    const cwd = asString(config.cwd, process.cwd());
    const model = asString(config.model, "");
    const maxTurns = asNumber(config.maxTurnsPerRun, 0);
    const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();

    // Build environment
    const env: Record<string, string> = { ...buildPaperclipEnv(opts.agent) };
    env.PAPERCLIP_RUN_ID = chatId;
    env.PAPERCLIP_WAKE_REASON = "chat";

    // Create auth token
    const authToken = createLocalAgentJwt(opts.agent.id, opts.agent.companyId, opts.agent.adapterType, chatId);
    if (authToken) {
      env.PAPERCLIP_API_KEY = authToken;
    }

    const effectiveEnv = ensurePathInEnv({ ...process.env, ...env }) as Record<string, string>;

    // Strip nesting-guard vars
    for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_PARENT_SESSION"]) {
      delete effectiveEnv[key];
    }

    // Build skills dir
    const skillsDir = await buildSkillsDir();

    // Handle instructions file — combine with path directive if configured
    let effectiveInstructionsFilePath = instructionsFilePath;
    if (instructionsFilePath) {
      try {
        const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
        const instructionsFileDir = `${path.dirname(instructionsFilePath)}/`;
        const pathDirective = `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}.`;
        const combinedPath = path.join(skillsDir, "agent-instructions.md");
        await fs.writeFile(combinedPath, instructionsContent + pathDirective, "utf-8");
        effectiveInstructionsFilePath = combinedPath;
      } catch {
        // If instructions file not found, proceed without it
        effectiveInstructionsFilePath = "";
      }
    }

    // Build CLI args — use chat-specific prompt instead of heartbeat template
    const chatPrompt = [
      `You are agent ${opts.agent.id} (${opts.agent.name}).`,
      ``,
      `You are in CHAT MODE — a board user has opened a direct conversation with you.`,
      `Do NOT run any heartbeat procedure. Do NOT check assignments or work on issues.`,
      ``,
      `## Chat session: ${opts.sessionId}`,
      ``,
      `The user's message:`,
      `> ${(opts.initialMessage ?? "").replace(/\n/g, "\n> ")}`,
      ``,
      `## How to respond`,
      ``,
      `1. Process the user's message. Use your tools freely (search code, read files, create issues, etc).`,
      `2. Send your response via the Paperclip API (use the paperclip skill if available, or curl):`,
      `   POST $PAPERCLIP_API_URL/api/agents/${opts.agent.id}/chat-response`,
      `   Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: ${chatId}`,
      `   Body: { "content": "Your response in markdown" }`,
      `3. After responding, poll for follow-up messages:`,
      `   GET $PAPERCLIP_API_URL/api/agents/${opts.agent.id}/chat-messages?after={lastMessageId}`,
      `   Poll every ~2 seconds. If no new messages for 60 seconds, check if the session still exists`,
      `   via GET $PAPERCLIP_API_URL/api/agents/${opts.agent.id}/chat-session — if gone, exit cleanly.`,
      `4. Repeat for each new user message.`,
      ``,
      `Stay conversational and concise. One response per user message.`,
    ].join("\n");
    const prompt = joinPromptSections([chatPrompt]);

    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (model) args.push("--model", model);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (effectiveInstructionsFilePath) {
      args.push("--append-system-prompt-file", effectiveInstructionsFilePath);
    }
    args.push("--add-dir", skillsDir);
    if (extraArgs.length > 0) args.push(...extraArgs);

    // Spawn the process
    const child = spawn(command, args, {
      cwd,
      env: effectiveEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (child.stdin && prompt) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    const meta: ChatProcess = {
      id: chatId,
      agentId: opts.agent.id,
      companyId: opts.agent.companyId,
      sessionId: opts.sessionId,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
    };

    chatProcesses.set(opts.agent.id, { meta, child });

    // Stream stdout/stderr as live events for the UI
    const streamToLiveEvents = (stream: "stdout" | "stderr", data: Buffer) => {
      const chunk = data.toString("utf-8");
      publishLiveEvent({
        companyId: opts.agent.companyId,
        type: "heartbeat.run.log" as any,
        payload: {
          runId: chatId,
          agentId: opts.agent.id,
          stream,
          chunk,
          ts: new Date().toISOString(),
        },
      });
    };

    child.stdout?.on("data", (data: Buffer) => streamToLiveEvents("stdout", data));
    child.stderr?.on("data", (data: Buffer) => streamToLiveEvents("stderr", data));

    child.on("exit", (code) => {
      meta.status = "exited";
      meta.exitCode = code;
      chatProcesses.delete(opts.agent.id);

      publishLiveEvent({
        companyId: opts.agent.companyId,
        type: "heartbeat.run.status" as any,
        payload: {
          runId: chatId,
          agentId: opts.agent.id,
          status: code === 0 ? "succeeded" : "failed",
          finishedAt: new Date().toISOString(),
        },
      });

      // Clean up skills dir
      fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
    });

    publishLiveEvent({
      companyId: opts.agent.companyId,
      type: "heartbeat.run.status" as any,
      payload: {
        runId: chatId,
        agentId: opts.agent.id,
        status: "running",
      },
    });

    return meta;
  }

  /**
   * Get the active chat process for an agent.
   */
  function getProcess(agentId: string): ChatProcess | null {
    const entry = chatProcesses.get(agentId);
    if (!entry || entry.meta.status !== "running") return null;
    return entry.meta;
  }

  /**
   * Kill the chat process for an agent.
   */
  function killProcess(agentId: string): boolean {
    const entry = chatProcesses.get(agentId);
    if (!entry) return false;
    try {
      entry.child.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }
    chatProcesses.delete(agentId);
    return true;
  }

  return {
    spawnChatProcess,
    getProcess,
    killProcess,
  };
}
