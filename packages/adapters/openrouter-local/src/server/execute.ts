import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OPENROUTER_MODEL, OPENROUTER_API_BASE } from "../index.js";

// ---------------------------------------------------------------------------
// OpenRouter chat types (plain fetch, no SDK)
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  model?: string;
}

// ---------------------------------------------------------------------------
// Skills helpers
// ---------------------------------------------------------------------------

function getSkillsDir(config: Record<string, unknown>): string {
  const configured = asString(config.skillsDir, "").trim();
  if (configured) return configured;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/root";
  return nodePath.join(home, ".paperclip", "skills");
}

function listAvailableSkills(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => existsSync(nodePath.join(skillsDir, d.name, "SKILL.md")))
      .map((d) => d.name);
  } catch { return []; }
}

function loadSkillContent(skillsDir: string, skillName: string): string | null {
  const p = nodePath.join(skillsDir, skillName, "SKILL.md");
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf-8"); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Paperclip API helper
// ---------------------------------------------------------------------------

async function pcFetch(serverUrl: string, apiPath: string, method: string, token: string, body?: unknown): Promise<unknown> {
  const url = `${serverUrl.replace(/\/$/, "")}/api${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Paperclip ${method} ${apiPath} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

function buildToolDefs(skillsDir: string): ToolDef[] {
  const available = listAvailableSkills(skillsDir);
  return [
    {
      type: "function",
      function: {
        name: "load_skill",
        description: `Load a SKILL.md file to get domain-specific instructions. Available skills: ${available.join(", ") || "none — create ~/.paperclip/skills/<name>/SKILL.md"}.`,
        parameters: {
          type: "object",
          properties: { skill: { type: "string", description: "Skill directory name" } },
          required: ["skill"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_agents",
        description: "List all agents in the company.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "hire_agent",
        description: "Create a new agent. Always use adapterType openrouter_local. Do NOT set a premium model.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string", enum: ["ceo", "cto", "cmo", "coo", "engineer", "designer", "qa", "researcher", "general"] },
            title: { type: "string" },
            capabilities: { type: "string" },
            budgetMonthlyCents: { type: "integer", default: 500 },
          },
          required: ["name", "role"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_issues",
        description: "List issues/tasks. Use status='open' by default.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["open", "in_progress", "done", "cancelled", "all"], default: "open" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_issue",
        description: "Create a new task/issue.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            assigneeAgentId: { type: "string" },
            priority: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium" },
          },
          required: ["title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_issue",
        description: "Update an issue status or assignee.",
        parameters: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            status: { type: "string", enum: ["open", "in_progress", "done", "cancelled"] },
            assigneeAgentId: { type: "string" },
            body: { type: "string" },
          },
          required: ["issueId"],
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  companyId: string,
  token: string,
  serverUrl: string,
  skillsDir: string,
  onLog: AdapterExecutionContext["onLog"],
  messages: ChatMessage[],
): Promise<string> {
  await onLog("stdout", `[tool:${name}] ${JSON.stringify(args)}\n`);
  try {
    if (name === "load_skill") {
      const skillName = String(args.skill ?? "");
      const content = loadSkillContent(skillsDir, skillName);
      if (!content) {
        const available = listAvailableSkills(skillsDir);
        return `Skill "${skillName}" not found. Available: ${available.join(", ") || "none"}`;
      }
      // Inject skill content as system-style user message for next turn
      messages.push({
        role: "user",
        content: `[Skill: ${skillName}]\nBase directory: ${nodePath.join(skillsDir, skillName)}\n\n${content}`,
      });
      return `Skill "${skillName}" loaded successfully.`;
    }
    if (name === "list_agents") {
      const agents = await pcFetch(serverUrl, `/companies/${companyId}/agents`, "GET", token);
      return JSON.stringify(agents, null, 2);
    }
    if (name === "hire_agent") {
      const result = await pcFetch(serverUrl, `/companies/${companyId}/agent-hires`, "POST", token, {
        name: args.name,
        role: args.role,
        title: args.title ?? null,
        capabilities: args.capabilities ?? null,
        adapterType: "openrouter_local",
        adapterConfig: {},
        budgetMonthlyCents: args.budgetMonthlyCents ?? 500,
      });
      return JSON.stringify(result, null, 2);
    }
    if (name === "list_issues") {
      const status = String(args.status ?? "open");
      const qs = status !== "all" ? `?status=${status}` : "";
      const result = await pcFetch(serverUrl, `/companies/${companyId}/issues${qs}`, "GET", token);
      return JSON.stringify(result, null, 2);
    }
    if (name === "create_issue") {
      const result = await pcFetch(serverUrl, `/companies/${companyId}/issues`, "POST", token, {
        title: args.title,
        body: args.body ?? "",
        assigneeAgentId: args.assigneeAgentId ?? null,
        priority: args.priority ?? "medium",
      });
      return JSON.stringify(result, null, 2);
    }
    if (name === "update_issue") {
      const { issueId, ...patch } = args;
      const result = await pcFetch(serverUrl, `/companies/${companyId}/issues/${issueId}`, "PATCH", token, patch);
      return JSON.stringify(result, null, 2);
    }
    return `Unknown tool: ${name}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, authToken } = ctx;

  const configObj = parseObject(config);
  const model = asString(configObj.model, DEFAULT_OPENROUTER_MODEL).trim();
  const baseUrl = asString(configObj.baseUrl, OPENROUTER_API_BASE).replace(/\/$/, "");
  const timeoutSec = asNumber(configObj.timeoutSec, 300);
  const maxTokens = asNumber(configObj.maxTokens, 8192);
  const temperature = asNumber(configObj.temperature, 0.7);
  const maxSteps = asNumber(configObj.maxSteps, 20);

  const envConfig = parseObject(configObj.env);
  const configApiKey = asString(configObj.apiKey, "").trim() || asString(envConfig.OPENROUTER_API_KEY, "").trim();
  const apiKey = configApiKey || process.env.OPENROUTER_API_KEY || "";

  if (!apiKey) {
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: "No OPENROUTER_API_KEY configured." };
  }

  const serverUrl = asString(configObj.serverUrl, process.env.PAPERCLIP_SERVER_URL ?? "http://localhost:3100").trim();
  const skillsDir = getSkillsDir(configObj);
  const systemPrompt = asString(configObj.systemPrompt, "").trim();
  const wakeReason = typeof context.wakeReason === "string" ? context.wakeReason.trim() : "";
  const taskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const promptTemplate = asString(configObj.promptTemplate, "").trim();

  const userPromptParts = [
    `You are agent "${agent.name}" (id: ${agent.id}) in company ${agent.companyId}. Run ID: ${runId}.`,
    taskId ? `Current task: ${taskId}` : "",
    wakeReason ? `Wake reason: ${wakeReason}` : "",
    promptTemplate,
  ].filter(Boolean);

  const messages: ChatMessage[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPromptParts.join("\n") });

  const toolDefs = authToken ? buildToolDefs(skillsDir) : [];
  if (!authToken) await onLog("stderr", "[paperclip] Warning: no authToken — tools disabled\n");

  await onLog("stdout", `[paperclip] OpenRouter start: model=${model} maxSteps=${maxSteps}\n`);

  let responseText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let timedOut = false;

  const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Infinity;

  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() > deadline) { timedOut = true; break; }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };
    if (toolDefs.length > 0) body.tools = toolDefs;

    let resp: ChatResponse;
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://paperclip.ai",
          "X-Title": "Paperclip",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        await onLog("stderr", `[paperclip] OpenRouter error ${res.status}: ${text.slice(0, 300)}\n`);
        return { exitCode: 1, signal: null, timedOut: false, errorMessage: `OpenRouter ${res.status}: ${text.slice(0, 200)}` };
      }
      resp = JSON.parse(text) as ChatResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] fetch error: ${msg}\n`);
      return { exitCode: 1, signal: null, timedOut: false, errorMessage: msg };
    }

    inputTokens += resp.usage?.prompt_tokens ?? 0;
    outputTokens += resp.usage?.completion_tokens ?? 0;

    const choice = resp.choices?.[0];
    if (!choice) break;

    const assistantMsg = choice.message;
    messages.push({ role: "assistant", content: assistantMsg.content ?? null, tool_calls: assistantMsg.tool_calls });

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      for (const tc of assistantMsg.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
        const result = await executeTool(
          tc.function.name, args, agent.companyId,
          authToken ?? "", serverUrl, skillsDir, onLog, messages,
        );
        messages.push({ role: "tool", content: result, tool_call_id: tc.id });
      }
      continue;
    }

    responseText = assistantMsg.content ?? "";
    break;
  }

  if (timedOut) {
    return { exitCode: null, signal: null, timedOut: true, errorMessage: `Timed out after ${timeoutSec}s` };
  }

  await onLog("stdout", `${responseText}\n`);
  await onLog("stdout", `[paperclip] OpenRouter done: model=${model} in=${inputTokens} out=${outputTokens}\n`);

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
    provider: "openrouter",
    biller: "openrouter",
    model,
    summary: responseText.slice(0, 500),
  };
}
