import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { OpenRouter, tool, stepCountIs } from "@openrouter/agent";
import { z } from "zod";
import { DEFAULT_OPENROUTER_MODEL, OPENROUTER_API_BASE } from "../index.js";

// ---------------------------------------------------------------------------
// Skills loader helpers
// ---------------------------------------------------------------------------

function getSkillsDir(config: Record<string, unknown>): string {
  const configured = asString(config.skillsDir, "").trim();
  if (configured) return configured;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/root";
  return path.join(home, ".paperclip", "skills");
}

function listAvailableSkills(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => existsSync(path.join(skillsDir, d.name, "SKILL.md")))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function loadSkillContent(skillsDir: string, skillName: string): string | null {
  const skillPath = path.join(skillsDir, skillName, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  try {
    return readFileSync(skillPath, "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Paperclip API helpers
// ---------------------------------------------------------------------------

function buildPaperclipHeaders(authToken: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${authToken}`,
    "Content-Type": "application/json",
  };
}

async function paperclipFetch(
  serverUrl: string,
  path: string,
  method: string,
  authToken: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${serverUrl.replace(/\/$/, "")}/api${path}`;
  const res = await fetch(url, {
    method,
    headers: buildPaperclipHeaders(authToken),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Paperclip API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Build tools
// ---------------------------------------------------------------------------

function buildPaperclipTools(
  companyId: string,
  authToken: string,
  serverUrl: string,
  skillsDir: string,
  onLog: AdapterExecutionContext["onLog"],
) {
  const availableSkills = listAvailableSkills(skillsDir);

  // ---- Skill loader --------------------------------------------------------
  const skillTool = tool({
    name: "load_skill",
    description: `Load a specialized skill to enhance capabilities for specific domains.
Available skills: ${availableSkills.length > 0 ? availableSkills.join(", ") : "none configured yet — create ~/.paperclip/skills/<name>/SKILL.md to add skills"}.
Call this at the start of a run when you need domain-specific instructions.`,
    inputSchema: z.object({
      skill: z.string().describe("The skill name to load (directory name under ~/.paperclip/skills/)"),
    }),
    outputSchema: z.string(),
    nextTurnParams: {
      input: (params, context) => {
        const marker = `[Skill: ${params.skill}]`;
        if (JSON.stringify(context.input).includes(marker)) return context.input;
        const content = loadSkillContent(skillsDir, params.skill);
        if (!content) return context.input;
        const current = Array.isArray(context.input) ? context.input : [context.input];
        return [
          ...current,
          {
            role: "user",
            content: `${marker}\nBase directory: ${path.join(skillsDir, params.skill)}\n\n${content}`,
          },
        ];
      },
    },
    execute: async (params) => {
      const marker = `[Skill: ${params.skill}]`;
      const content = loadSkillContent(skillsDir, params.skill);
      if (!content) {
        const available = listAvailableSkills(skillsDir);
        return `Skill "${params.skill}" not found. Available: ${available.join(", ") || "none"}`;
      }
      await onLog("stdout", `[tool:load_skill] Loaded skill: ${params.skill}\n`);
      return `Skill ${params.skill} loaded. ${marker}`;
    },
  });

  // ---- List agents ---------------------------------------------------------
  const listAgentsTool = tool({
    name: "list_agents",
    description: "List all agents in the company. Use to find existing agents before creating new ones.",
    inputSchema: z.object({
      status: z.enum(["idle", "running", "paused", "all"]).optional().default("all"),
    }),
    outputSchema: z.string(),
    execute: async (params) => {
      try {
        const agents = await paperclipFetch(serverUrl, `/companies/${companyId}/agents`, "GET", authToken) as unknown[];
        const filtered = params.status === "all"
          ? agents
          : (agents as Array<Record<string, unknown>>).filter((a) => a.status === params.status);
        await onLog("stdout", `[tool:list_agents] Found ${(filtered as unknown[]).length} agents\n`);
        return JSON.stringify(filtered, null, 2);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ---- Hire agent ----------------------------------------------------------
  const hireAgentTool = tool({
    name: "hire_agent",
    description: `Hire (create) a new agent. Always use adapterType "openrouter_local". 
Role must be one of: ceo, cto, cmo, coo, engineer, designer, qa, researcher, general.
CTOs, CMOs, COOs automatically get permission to create agents.
Do NOT set a model unless you have explicit owner permission to use a premium model.`,
    inputSchema: z.object({
      name: z.string().describe("Agent name"),
      role: z.enum(["ceo", "cto", "cmo", "coo", "engineer", "designer", "qa", "researcher", "general"]),
      title: z.string().optional().describe("Job title e.g. 'Senior Engineer'"),
      capabilities: z.string().optional().describe("Short description of what this agent can do"),
      reportsTo: z.string().uuid().optional().describe("UUID of the parent agent"),
      budgetMonthlyCents: z.number().int().nonnegative().optional().default(500),
    }),
    outputSchema: z.string(),
    execute: async (params) => {
      try {
        const body = {
          name: params.name,
          role: params.role,
          title: params.title ?? null,
          capabilities: params.capabilities ?? null,
          reportsTo: params.reportsTo ?? null,
          adapterType: "openrouter_local",
          adapterConfig: {},
          budgetMonthlyCents: params.budgetMonthlyCents ?? 500,
        };
        const result = await paperclipFetch(serverUrl, `/companies/${companyId}/agent-hires`, "POST", authToken, body);
        await onLog("stdout", `[tool:hire_agent] Created agent: ${params.name} (${params.role})\n`);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return `Error hiring agent: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ---- List issues ---------------------------------------------------------
  const listIssuesTool = tool({
    name: "list_issues",
    description: "List issues/tasks in the company. Use to find open tasks and understand what needs to be done.",
    inputSchema: z.object({
      status: z.enum(["open", "in_progress", "done", "cancelled", "all"]).optional().default("open"),
      assigneeAgentId: z.string().uuid().optional().describe("Filter by assigned agent UUID"),
    }),
    outputSchema: z.string(),
    execute: async (params) => {
      try {
        const qs = new URLSearchParams();
        if (params.status !== "all") qs.set("status", params.status);
        if (params.assigneeAgentId) qs.set("assigneeAgentId", params.assigneeAgentId);
        const queryString = qs.toString() ? `?${qs.toString()}` : "";
        const issues = await paperclipFetch(serverUrl, `/companies/${companyId}/issues${queryString}`, "GET", authToken);
        await onLog("stdout", `[tool:list_issues] Listed issues\n`);
        return JSON.stringify(issues, null, 2);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ---- Create issue --------------------------------------------------------
  const createIssueTool = tool({
    name: "create_issue",
    description: "Create a new task/issue and optionally assign it to an agent.",
    inputSchema: z.object({
      title: z.string().describe("Issue title"),
      body: z.string().optional().describe("Detailed description in markdown"),
      assigneeAgentId: z.string().uuid().optional().describe("UUID of the agent to assign this to"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().default("medium"),
    }),
    outputSchema: z.string(),
    execute: async (params) => {
      try {
        const body = {
          title: params.title,
          body: params.body ?? "",
          assigneeAgentId: params.assigneeAgentId ?? null,
          priority: params.priority ?? "medium",
        };
        const result = await paperclipFetch(serverUrl, `/companies/${companyId}/issues`, "POST", authToken, body);
        await onLog("stdout", `[tool:create_issue] Created issue: ${params.title}\n`);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return `Error creating issue: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ---- Update issue --------------------------------------------------------
  const updateIssueTool = tool({
    name: "update_issue",
    description: "Update an issue status or reassign it.",
    inputSchema: z.object({
      issueId: z.string().uuid(),
      status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
      assigneeAgentId: z.string().uuid().nullable().optional(),
      body: z.string().optional(),
    }),
    outputSchema: z.string(),
    execute: async (params) => {
      try {
        const { issueId, ...patch } = params;
        const result = await paperclipFetch(serverUrl, `/companies/${companyId}/issues/${issueId}`, "PATCH", authToken, patch);
        await onLog("stdout", `[tool:update_issue] Updated issue: ${issueId}\n`);
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return `Error updating issue: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  return [skillTool, listAgentsTool, hireAgentTool, listIssuesTool, createIssueTool, updateIssueTool];
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
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "No OPENROUTER_API_KEY configured.",
    };
  }

  const serverUrl = asString(configObj.serverUrl, process.env.PAPERCLIP_SERVER_URL ?? "http://localhost:3100").trim();
  const skillsDir = getSkillsDir(configObj);

  const systemPrompt = asString(configObj.systemPrompt, "").trim();
  const wakeReason = typeof context.wakeReason === "string" ? context.wakeReason.trim() : "";
  const taskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;

  const userPromptParts: string[] = [
    `You are agent "${agent.name}" (id: ${agent.id}) in company ${agent.companyId}.`,
    `Run ID: ${runId}`,
  ];
  if (taskId) userPromptParts.push(`Current task: ${taskId}`);
  if (wakeReason) userPromptParts.push(`Wake reason: ${wakeReason}`);

  const promptTemplate = asString(configObj.promptTemplate, "").trim();
  if (promptTemplate) userPromptParts.push(promptTemplate);

  const userPrompt = userPromptParts.join("\n");

  await onLog("stdout", `[paperclip] OpenRouter agent start: model=${model} maxSteps=${maxSteps}\n`);

  const openrouter = new OpenRouter({
    apiKey,
    baseURL: baseUrl,
    defaultHeaders: {
      "HTTP-Referer": "https://paperclip.ai",
      "X-Title": "Paperclip",
    },
  });

  const tools = authToken
    ? buildPaperclipTools(agent.companyId, authToken, serverUrl, skillsDir, onLog)
    : [];

  if (!authToken) {
    await onLog("stderr", "[paperclip] Warning: no authToken — Paperclip API tools disabled\n");
  }

  let responseText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let usedModel = model;

  const timeoutHandle = timeoutSec > 0
    ? setTimeout(() => { throw new Error(`TIMEOUT:${timeoutSec}`) }, timeoutSec * 1000)
    : null;

  try {
    const inputMessages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) inputMessages.push({ role: "system", content: systemPrompt });
    inputMessages.push({ role: "user", content: userPrompt });

    const result = openrouter.callModel({
      model,
      input: inputMessages,
      tools,
      stopWhen: stepCountIs(maxSteps),
      temperature,
      max_tokens: maxTokens,
    });

    // Stream tool calls to log
    (async () => {
      try {
        for await (const event of result.getToolStream()) {
          const name = (event as Record<string, unknown>).name ?? "tool";
          const input = (event as Record<string, unknown>).input;
          await onLog("stdout", `[tool:${name}] ${JSON.stringify(input)}\n`);
        }
      } catch {
        // tool stream may end before getText resolves, ignore
      }
    })();

    responseText = await result.getText();
    const response = await result.getResponse();
    inputTokens = (response as Record<string, unknown> & { usage?: { prompt_tokens?: number } }).usage?.prompt_tokens ?? 0;
    outputTokens = (response as Record<string, unknown> & { usage?: { completion_tokens?: number } }).usage?.completion_tokens ?? 0;
    usedModel = (response as Record<string, unknown> & { model?: string }).model ?? model;

    if (timeoutHandle) clearTimeout(timeoutHandle);

    await onLog("stdout", `${responseText}\n`);
    await onLog("stdout", `[paperclip] OpenRouter done: model=${usedModel} in=${inputTokens} out=${outputTokens}\n`);
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("TIMEOUT:")) {
      return { exitCode: null, signal: null, timedOut: true, errorMessage: `Timed out after ${timeoutSec}s` };
    }
    await onLog("stderr", `[paperclip] OpenRouter error: ${message}\n`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: message };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
    provider: "openrouter",
    biller: "openrouter",
    model: usedModel,
    summary: responseText.slice(0, 500),
  };
}
