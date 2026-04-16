import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import nodePath from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  renderTemplate,
  renderPaperclipWakePrompt,
  joinPromptSections,
  buildPaperclipEnv,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
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
      .filter((d: Dirent) => d.isDirectory())
      .filter((d: Dirent) => existsSync(nodePath.join(skillsDir, d.name, "SKILL.md")))
      .map((d: Dirent) => d.name);
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
        description: `Load a SKILL.md file to get domain-specific instructions. Available skills: ${available.join(", ") || "none"}.`,
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
        description: "List all agents in the company with their roles, status, and capabilities.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "hire_agent",
        description: [
          "Hire (create) a new agent. You MUST provide systemPrompt and promptTemplate — never omit them.",
          "systemPrompt: full identity + role + responsibilities + behavioral rules (multi-paragraph, detailed).",
          "promptTemplate: heartbeat instructions telling the agent what to do each run, who to report to, and how to communicate results. Must reference {{agent.name}} and include 'Report progress by posting a comment on your assigned issue.'",
          "reportsTo: UUID of the manager agent this agent reports to (default: your own agent ID).",
          "Always set title and capabilities so the org chart is meaningful.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Agent's full name" },
            role: { type: "string", enum: ["ceo", "cto", "cmo", "coo", "engineer", "designer", "qa", "researcher", "general"] },
            title: { type: "string", description: "Job title, e.g. 'Lead Engineer'" },
            capabilities: { type: "string", description: "Comma-separated list of specializations" },
            systemPrompt: { type: "string", description: "REQUIRED. Full identity, responsibilities, behavioral rules and operating principles for this agent. Be thorough." },
            promptTemplate: { type: "string", description: "REQUIRED. What the agent does on each heartbeat run. Include: task approach, reporting instructions (post_comment on assigned issue), escalation path." },
            reportsTo: { type: "string", description: "UUID of the manager this agent reports to. Defaults to the creating agent." },
            budgetMonthlyCents: { type: "integer", description: "Monthly budget in cents, e.g. 500 = $5", default: 500 },
          },
          required: ["name", "role", "systemPrompt", "promptTemplate"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_issues",
        description: "List issues/tasks in the company. Filter by status to find work.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", description: "Filter by status. Use comma-separated values or 'all'.", default: "todo,in_progress,backlog" },
            assigneeAgentId: { type: "string", description: "Filter by agent ID" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_issue",
        description: "Get full details of a specific issue by ID or identifier (e.g. FUU-14).",
        parameters: {
          type: "object",
          properties: {
            issueId: { type: "string", description: "Issue UUID or identifier like FUU-14" },
          },
          required: ["issueId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_issue",
        description: "Create a new task/issue and optionally assign it to an agent.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string", description: "Detailed description in markdown" },
            assigneeAgentId: { type: "string", description: "Agent ID to assign to" },
            priority: { type: "string", enum: ["low", "medium", "high", "urgent"], default: "medium" },
          },
          required: ["title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_issue",
        description: "Update an issue's status, priority, assignee, or description.",
        parameters: {
          type: "object",
          properties: {
            issueId: { type: "string", description: "Issue UUID or identifier" },
            status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] },
            priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
            assigneeAgentId: { type: "string" },
            description: { type: "string" },
            title: { type: "string" },
          },
          required: ["issueId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkout_issue",
        description: "Check out an issue to claim it for the current run. Do this before starting work on a task.",
        parameters: {
          type: "object",
          properties: {
            issueId: { type: "string", description: "Issue UUID or identifier to check out" },
          },
          required: ["issueId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "post_comment",
        description: "Post a comment on an issue. Use to report progress, ask questions, or summarize findings.",
        parameters: {
          type: "object",
          properties: {
            issueId: { type: "string", description: "Issue UUID or identifier" },
            body: { type: "string", description: "Comment text in markdown" },
          },
          required: ["issueId", "body"],
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
  agentId: string,
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
      const adapterConfig: Record<string, unknown> = {};
      if (args.systemPrompt) adapterConfig.systemPrompt = args.systemPrompt;
      if (args.promptTemplate) adapterConfig.promptTemplate = args.promptTemplate;
      const managerRoles = new Set(["ceo", "cto", "cmo", "coo"]);
      const isManager = managerRoles.has(String(args.role ?? ""));
      const result = await pcFetch(serverUrl, `/companies/${companyId}/agent-hires`, "POST", token, {
        name: args.name,
        role: args.role,
        title: args.title ?? null,
        capabilities: args.capabilities ?? null,
        reportsTo: args.reportsTo ?? agentId,
        adapterType: "openrouter_local",
        adapterConfig,
        budgetMonthlyCents: args.budgetMonthlyCents ?? 500,
        permissions: { canCreateAgents: isManager },
      });
      return JSON.stringify(result, null, 2);
    }
    if (name === "list_issues") {
      const status = String(args.status ?? "todo,in_progress,backlog");
      const assigneeQs = args.assigneeAgentId ? `&assigneeAgentId=${encodeURIComponent(String(args.assigneeAgentId))}` : "";
      const qs = `?status=${encodeURIComponent(status)}${assigneeQs}`;
      const result = await pcFetch(serverUrl, `/companies/${companyId}/issues${qs}`, "GET", token);
      return JSON.stringify(result, null, 2);
    }
    if (name === "get_issue") {
      const issueId = encodeURIComponent(String(args.issueId ?? ""));
      const result = await pcFetch(serverUrl, `/companies/${companyId}/issues/${issueId}`, "GET", token);
      return JSON.stringify(result, null, 2);
    }
    if (name === "create_issue") {
      const result = await pcFetch(serverUrl, `/companies/${companyId}/issues`, "POST", token, {
        title: args.title,
        description: args.description ?? "",
        assigneeAgentId: args.assigneeAgentId ?? null,
        priority: args.priority ?? "medium",
      });
      return JSON.stringify(result, null, 2);
    }
    if (name === "update_issue") {
      const { issueId, ...patch } = args;
      const result = await pcFetch(serverUrl, `/companies/${companyId}/issues/${encodeURIComponent(String(issueId))}`, "PATCH", token, patch);
      return JSON.stringify(result, null, 2);
    }
    if (name === "checkout_issue") {
      const issueId = encodeURIComponent(String(args.issueId ?? ""));
      const result = await pcFetch(serverUrl, `/issues/${issueId}/checkout`, "POST", token, {});
      return JSON.stringify(result, null, 2);
    }
    if (name === "post_comment") {
      const issueId = encodeURIComponent(String(args.issueId ?? ""));
      const result = await pcFetch(serverUrl, `/issues/${issueId}/comments`, "POST", token, {
        body: args.body,
      });
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
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;

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

  // Build env context for logging (mirrors codex-local pattern)
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value: unknown): value is string => typeof value === "string" && (value as string).trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  // Prompt construction (mirrors codex-local: bootstrap + wake + handoff + heartbeat)
  const bootstrapPromptTemplate = asString(configObj.bootstrapPromptTemplate, "");
  const promptTemplate = asString(
    configObj.promptTemplate,
    "You are agent {{agent.name}} ({{agent.id}}) in company {{agent.companyId}}. Run ID: {{runId}}. Review your tasks and do your best work.",
  );

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const renderedBootstrapPrompt =
    bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake);
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  const userPrompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  const promptMetrics = {
    promptChars: userPrompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  if (onMeta) {
    await onMeta({
      adapterType: "openrouter_local",
      command: `fetch ${baseUrl}/chat/completions`,
      cwd: process.cwd(),
      commandArgs: [`model=${model}`, `maxSteps=${maxSteps}`, `maxTokens=${maxTokens}`],
      commandNotes: [`OpenRouter HTTP adapter — no local CLI required`],
      env: { OPENROUTER_API_KEY: apiKey ? "[set]" : "[missing]", ...env },
      prompt: userPrompt,
      promptMetrics,
      context,
    });
  }

  const messages: ChatMessage[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const toolDefs = authToken ? buildToolDefs(skillsDir) : [];
  if (!authToken) await onLog("stderr", "[paperclip] Warning: no authToken — tools disabled\n");

  const taskId =
    (typeof context.taskId === "string" && context.taskId.replace(/\s/g, "")) ||
    (typeof context.issueId === "string" && context.issueId.replace(/\s/g, "")) ||
    null;

  await onLog("stdout", `[paperclip] OpenRouter start: model=${model} maxSteps=${maxSteps} taskId=${taskId ?? "none"} auth=${authToken ? "yes" : "NO"}\n`);

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
          tc.function.name, args, agent.companyId, agent.id,
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
    return { exitCode: null, signal: null, timedOut: true, errorMessage: `Timed out after ${timeoutSec}s`, errorCode: "timeout" };
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
    billingType: "api",
    model,
    summary: responseText.slice(0, 500),
  };
}
