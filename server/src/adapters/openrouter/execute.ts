import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  renderTemplate,
  joinPromptSections,
  ensureAbsoluteDirectory,
} from "@paperclipai/adapter-utils/server-utils";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";

const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v3.2";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function sanitize(text: string): string {
  return text.replace(/\x00/g, "");
}

const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "shell",
      description: "Execute a shell command in the agent workspace. Use for file ops, git, builds, etc.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents from the workspace. Supports offset/limit for reading portions of large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to workspace)" },
          offset: { type: "number", description: "Line number to start reading from (1-based, default: 1)" },
          limit: { type: "number", description: "Max number of lines to read (default: all)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file in the workspace. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Make a surgical edit to a file by replacing a specific text block. More efficient than write_file for small changes to large files. The old_text must match exactly (including whitespace/indentation).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to workspace)" },
          old_text: { type: "string", description: "Exact text to find and replace (must be unique in the file)" },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories in a path. Returns names with type indicators (/ for dirs). Use for exploring project structure.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (relative to workspace, default: '.')" },
          recursive: { type: "boolean", description: "List recursively (default: false, max depth 4)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web via DuckDuckGo.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL (web page or API).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          method: { type: "string", description: "HTTP method (default: GET)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_issue",
      description: "Create a Paperclip issue and optionally assign it to another agent. Use this to delegate work (e.g., email to Hermes).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          description: { type: "string", description: "Issue description with full details" },
          assignee_agent_name: { type: "string", description: "Agent name to assign to (e.g., 'Hermes' for email)" },
        },
        required: ["title", "description"],
      },
    },
  },
];

async function executeToolCall(
  name: string,
  argsStr: string,
  cwd: string,
  onLog: AdapterExecutionContext["onLog"],
  apiContext?: { port: string; authHeader?: string; companyId: string },
): Promise<string> {
  let args: Record<string, string>;
  try {
    args = JSON.parse(argsStr);
  } catch {
    return `Error: Invalid JSON: ${argsStr.substring(0, 200)}`;
  }

  if (name === "shell") {
    const cmd = args.command || "";
    await onLog("stdout", `[openrouter] $ ${cmd}\n`);
    try {
      const output = sanitize(execSync(cmd, { cwd, encoding: "utf-8", timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }));
      if (output.trim()) await onLog("stdout", output.substring(0, 1000) + "\n");
      return output.substring(0, 50_000) || "(no output)";
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      return sanitize((e.stderr || e.stdout || e.message || "Command failed").substring(0, 5000));
    }
  }

  if (name === "read_file") {
    try {
      const content = sanitize(readFileSync(resolve(cwd, args.path || ""), "utf-8"));
      const lines = content.split("\n");
      const offset = Math.max(1, parseInt(args.offset as string) || 1);
      const limit = parseInt(args.limit as string) || 0;
      const sliced = limit > 0 ? lines.slice(offset - 1, offset - 1 + limit) : lines.slice(offset - 1);
      const numbered = sliced.map((line, i) => `${offset + i}\t${line}`).join("\n");
      const result = numbered.substring(0, 100_000);
      if (result.length < numbered.length) {
        return result + `\n... (truncated, ${lines.length} total lines — use offset/limit to read specific sections)`;
      }
      return result || "(empty file)";
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "write_file") {
    try {
      const fullPath = resolve(cwd, args.path || "");
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, args.content || "", "utf-8");
      return `Written: ${args.path}`;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "edit_file") {
    try {
      const fullPath = resolve(cwd, args.path || "");
      const content = readFileSync(fullPath, "utf-8");
      const oldText = args.old_text || "";
      const newText = args.new_text ?? "";
      if (!oldText) return "Error: old_text is required";
      const occurrences = content.split(oldText).length - 1;
      if (occurrences === 0) return `Error: old_text not found in ${args.path}. Make sure it matches exactly (including whitespace).`;
      if (occurrences > 1) return `Error: old_text found ${occurrences} times in ${args.path}. Provide a more unique text block to match exactly once.`;
      writeFileSync(fullPath, content.replace(oldText, newText), "utf-8");
      return `Edited: ${args.path} (replaced ${oldText.split("\n").length} lines)`;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "list_directory") {
    try {
      const dirPath = resolve(cwd, args.path || ".");
      const recursive = args.recursive === "true" || (args as Record<string, unknown>).recursive === true;
      const entries: string[] = [];
      function walk(dir: string, depth: number) {
        if (depth > 4) return;
        const items = readdirSync(dir);
        for (const item of items) {
          if (item.startsWith(".") && depth > 0) continue;
          const full = resolve(dir, item);
          const rel = relative(cwd, full);
          try {
            const st = statSync(full);
            if (st.isDirectory()) {
              entries.push(rel + "/");
              if (recursive) walk(full, depth + 1);
            } else {
              entries.push(rel);
            }
          } catch {}
          if (entries.length > 500) return;
        }
      }
      walk(dirPath, 0);
      return entries.length ? entries.join("\n") : "(empty directory)";
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "web_search") {
    try {
      const q = encodeURIComponent(args.query || "");
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        headers: { "User-Agent": "Paperclip-Agent/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      const html = sanitize(await res.text());
      const links: string[] = [];
      const re = /class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
      let m;
      while ((m = re.exec(html)) && links.length < 8) {
        links.push(`${m[2].replace(/<[^>]*>/g, "").trim()}: ${m[1]}`);
      }
      return links.length ? links.join("\n") : "No results found.";
    } catch (err: unknown) {
      return `Search error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "web_fetch") {
    try {
      const res = await fetch(args.url || "", {
        method: (args.method || "GET").toUpperCase(),
        headers: { "User-Agent": "Paperclip-Agent/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      return sanitize(`${res.status}\n\n${(await res.text()).substring(0, 20_000)}`);
    } catch (err: unknown) {
      return `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "create_issue" && apiContext) {
    const title = args.title || "Untitled";
    const description = args.description || "";
    const assigneeName = args.assignee_agent_name || "";
    await onLog("stdout", `[openrouter] Creating issue: ${title}${assigneeName ? ` (→ ${assigneeName})` : ""}\n`);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiContext.authHeader) headers["Authorization"] = apiContext.authHeader;

      // If assignee specified, find agent ID by name
      let assigneeAgentId: string | undefined;
      if (assigneeName) {
        const agentsRes = await fetch(`http://localhost:${apiContext.port}/api/companies/${apiContext.companyId}/agents`, { headers, signal: AbortSignal.timeout(5000) });
        if (agentsRes.ok) {
          const agents = await agentsRes.json() as Array<{ id: string; name: string }>;
          const match = agents.find(a => a.name.toLowerCase().includes(assigneeName.toLowerCase()));
          if (match) assigneeAgentId = match.id;
        }
      }

      const issueBody: Record<string, unknown> = { title, description, status: "todo" };
      if (assigneeAgentId) issueBody.assigneeAgentId = assigneeAgentId;

      const res = await fetch(`http://localhost:${apiContext.port}/api/companies/${apiContext.companyId}/issues`, {
        method: "POST", headers, body: JSON.stringify(issueBody), signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const issue = await res.json() as { identifier?: string; id?: string };
        return `Issue created: ${issue.identifier || issue.id}${assigneeAgentId ? ` (assigned to ${assigneeName})` : ""}`;
      }
      return `Failed to create issue: ${res.status}`;
    } catch (err: unknown) {
      return `Error creating issue: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return `Unknown tool: ${name}`;
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  timeoutMs: number,
) {
  const body: Record<string, unknown> = { model, messages, max_tokens: 16384, temperature: 0.2 };
  if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }

  const res = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://paperclip.ing",
      "X-Title": "Paperclip Agent",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).substring(0, 300)}`);

  const data = await res.json() as {
    choices: Array<{ message: ChatMessage }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
    model?: string;
  };

  return {
    message: data.choices?.[0]?.message || { role: "assistant" as const, content: "" },
    usage: data.usage,
    cost: parseFloat(res.headers.get("x-openrouter-cost") || "0") || 0,
    model: data.model,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;
  const startedAt = Date.now();
  const model = asString(config.model, DEFAULT_OPENROUTER_MODEL);
  const timeoutSec = asNumber(config.timeoutSec, 600);
  const maxTurns = asNumber(config.maxTurns, 30);

  // ── Resolve workspace CWD (same pattern as claude_local) ───
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || agentHome || configuredCwd || `/tmp/paperclip-agent-${agent.id}`;
  try { await ensureAbsoluteDirectory(cwd, { createIfMissing: true }); } catch {}

  // ── Resolve project workspace paths ────────────────────────
  const projectWorkspaces: string[] = [];
  const rawWorkspaces = context.paperclipWorkspaces;
  if (Array.isArray(rawWorkspaces)) {
    for (const ws of rawWorkspaces) {
      const wsCwd = asString((ws as Record<string, unknown>)?.cwd, "");
      if (wsCwd && wsCwd !== cwd) projectWorkspaces.push(wsCwd);
    }
  }

  // ── Resolve API key ────────────────────────────────────────
  const envConfig = parseObject(config.env);
  let apiKey = "";
  for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]) {
    const v = envConfig[k];
    if (typeof v === "string" && v) { apiKey = v; break; }
  }
  if (!apiKey) apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: "OPENROUTER_API_KEY not set", errorCode: "openrouter_no_api_key" };
  }

  // ── Load agent instructions ────────────────────────────────
  const instructionsFilePath = asString(config.instructionsFilePath, "");
  let agentInstructions = "";
  if (instructionsFilePath) {
    try { agentInstructions = sanitize(await readFile(instructionsFilePath, "utf-8")); } catch {}
  }

  // ── Build prompt ───────────────────────────────────────────
  const promptTemplate = asString(config.promptTemplate, "You are {{agent.name}}. Complete assigned tasks efficiently.");
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = { agentId: agent.id, companyId: agent.companyId, runId, agent, context, company: { id: agent.companyId }, run: { id: runId } };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrap = bootstrapPromptTemplate ? renderTemplate(bootstrapPromptTemplate, templateData) : "";

  // ── Extract issue context ──────────────────────────────────
  const issueId = asString(context.issueId || context.taskId, "");
  const wakeReason = asString(context.wakeReason, "");
  let issueBlock = "";
  let jwtAuthHeader = "";
  if (issueId || true) {  // Always generate JWT for issue creation tool
    // Try to get issue details — use internal JWT if available
    try {
      const port = process.env.PORT || "3100";
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      // Generate a minimal JWT for internal API access
      const jwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
      if (jwtSecret) {
        const { createHmac } = await import("node:crypto");
        const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({
          sub: agent.id,
          company_id: agent.companyId,
          adapter_type: "openrouter_local",
          run_id: runId,
          iss: "paperclip",
          aud: "paperclip-api",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
        })).toString("base64url");
        const sig = createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url");
        jwtAuthHeader = `Bearer ${header}.${payload}.${sig}`;
        headers["Authorization"] = jwtAuthHeader;
      }

      if (!issueId) { /* skip fetch but keep jwtAuthHeader */ }
      else {
      const res = await fetch(`http://localhost:${port}/api/issues/${issueId}`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const issue = await res.json() as { title?: string; description?: string; identifier?: string };
        issueBlock = `\n## ASSIGNED TASK: ${issue.identifier || ""} ${issue.title || ""}\n${issue.description || ""}`;
        await onLog("stdout", `[openrouter] Task: ${issue.identifier} ${issue.title}\n`);

        // ── Fetch related/referenced issues ──────────────────
        // Scan description for patterns like "Related: ANI-100, ANI-131" or "See: ANI-100" or "Context: ANI-100"
        const desc = issue.description || "";
        const refPattern = /(?:Related|See|Context|Reference|Ref|Background):\s*((?:[A-Z]+-\d+(?:\s*,\s*)?)+)/gi;
        const mentionPattern = /\[([A-Z]+-\d+)\]/g;
        const relatedIds = new Set<string>();
        let refMatch;
        while ((refMatch = refPattern.exec(desc))) {
          for (const id of refMatch[1].split(",").map(s => s.trim()).filter(Boolean)) {
            if (/^[A-Z]+-\d+$/.test(id)) relatedIds.add(id);
          }
        }
        while ((refMatch = mentionPattern.exec(desc))) {
          relatedIds.add(refMatch[1]);
        }
        // Remove self-reference
        if (issue.identifier) relatedIds.delete(issue.identifier);

        if (relatedIds.size > 0) {
          const relatedBlocks: string[] = [];
          for (const refId of relatedIds) {
            try {
              const refRes = await fetch(`http://localhost:${port}/api/issues/${refId}`, { headers, signal: AbortSignal.timeout(3000) });
              if (refRes.ok) {
                const refIssue = await refRes.json() as { title?: string; description?: string; identifier?: string; status?: string };
                relatedBlocks.push(`### ${refIssue.identifier} ${refIssue.title} [${refIssue.status}]\n${(refIssue.description || "").substring(0, 3000)}`);
                await onLog("stdout", `[openrouter] Related: ${refIssue.identifier} ${refIssue.title}\n`);
              }
            } catch {}
          }
          if (relatedBlocks.length > 0) {
            issueBlock += `\n\n## RELATED ISSUES (for context — do NOT work on these, just use them for background)\n${relatedBlocks.join("\n\n")}`;
          }
        }
      }
      }
    } catch {}
  }

  if (onMeta) {
    await onMeta({ adapterType: "openrouter_local", command: "openrouter-api", cwd, commandNotes: [`Model: ${model}`], prompt: renderedPrompt });
  }

  // ── Build system prompt ────────────────────────────────────
  const systemParts: string[] = [];
  if (agentInstructions) systemParts.push(agentInstructions);
  systemParts.push(
    `You are an AI agent in Paperclip. Your workspace directory is: ${cwd}`,
    ...(projectWorkspaces.length > 0
      ? [`Project source code directories: ${projectWorkspaces.join(", ")}. Use these paths when the task involves project code.`]
      : []),
    "You have tools: shell, read_file (with offset/limit for large files), write_file, edit_file (search/replace for surgical edits), list_directory, web_search, web_fetch, create_issue.",
    "PREFER edit_file over write_file when modifying existing files — it's faster and safer than rewriting entire files.",
    "",
    "",
    "GSD WORKFLOW: For coding/implementation tasks, create a .planning/ directory to track progress.",
    "1. Create .planning/STATE.md with YAML frontmatter: milestone, current_phase, status, progress (total_phases, completed_phases, percent)",
    "2. Create phase dirs under .planning/phases/: 1-context/, 2-implementation/, 3-verification/",
    "3. In each phase: {N}-CONTEXT.md, {N}-RESEARCH.md, {N}-{M}-PLAN.md (with <objective>...</objective>), {N}-{M}-SUMMARY.md when done, {N}-VERIFICATION.md (frontmatter status: passed/gaps_found)",
    "4. Update STATE.md as you progress. Skip GSD for heartbeats and simple status reports.",
    "",
    "RULES:",
    "- ONLY operate within your workspace directory. Do NOT explore /app or other system directories.",
    "- Stay focused on the assigned task. Do not start unrelated work.",
    "- Use minimal tool calls. When done, summarize what you accomplished and STOP.",
    "- For heartbeats without a task, report status briefly and stop.",
    "- To delegate work (e.g., sending email), create a sub-issue via create_issue and assign it to the appropriate agent.",
  );

  const userParts: string[] = [];
  if (renderedBootstrap) userParts.push(renderedBootstrap);
  userParts.push(renderedPrompt);
  if (issueBlock) userParts.push(issueBlock);
  if (!issueBlock && (wakeReason === "heartbeat_timer" || !wakeReason)) {
    userParts.push("\nThis is a routine heartbeat. Report status briefly and stop. Do NOT start new work.");
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemParts.join("\n") },
    { role: "user", content: userParts.join("\n\n") },
  ];

  await onLog("stdout", `[openrouter] Starting (model: ${model}, cwd: ${cwd})\n`);

  // ── Conversation loop ──────────────────────────────────────
  let totalIn = 0, totalOut = 0, totalCost = 0, lastMessage = "";
  let resolvedModel = model;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (Date.now() - startedAt > timeoutSec * 1000) {
      return { exitCode: null, signal: null, timedOut: true, errorMessage: `Timed out after ${timeoutSec}s`, usage: { inputTokens: totalIn, outputTokens: totalOut }, provider: "openrouter", biller: "openrouter", model: resolvedModel, billingType: "api", costUsd: totalCost || null, summary: lastMessage || null };
    }

    // On the last turn, force a text response (no tools) so the agent always summarizes
    const isLastTurn = turn === maxTurns - 1;
    let result;
    try {
      result = await callOpenRouter(apiKey, model, messages, isLastTurn ? undefined : AGENT_TOOLS, Math.max(30_000, (timeoutSec * 1000) - (Date.now() - startedAt)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "API call failed";
      await onLog("stderr", `[openrouter] ${msg}\n`);
      return { exitCode: 1, signal: null, timedOut: false, errorMessage: msg, usage: { inputTokens: totalIn, outputTokens: totalOut }, provider: "openrouter", biller: "openrouter", model: resolvedModel, billingType: "api", costUsd: totalCost || null, summary: lastMessage || null };
    }

    if (result.usage) { totalIn += result.usage.prompt_tokens || 0; totalOut += result.usage.completion_tokens || 0; }
    totalCost += result.cost;
    if (result.model) resolvedModel = result.model;

    messages.push(result.message);

    if (!result.message.tool_calls?.length) {
      lastMessage = result.message.content || "";
      if (!lastMessage.trim() && turn > 0) {
        lastMessage = `[Auto-summary] Agent completed ${turn + 1} turns using ${totalIn + totalOut} tokens ($${totalCost.toFixed(4)}). No explicit summary was provided by the model.`;
      }
      await onLog("stdout", `[openrouter] Response:\n${lastMessage.substring(0, 1000)}\n`);
      break;
    }

    // Warn agent when nearing the turn limit
    if (turn === maxTurns - 3) {
      messages.push({ role: "user", content: "SYSTEM: You have 2 tool calls remaining. You MUST stop using tools and write a final summary of what you accomplished, what you found, and any remaining work. Do NOT make any more tool calls." });
      await onLog("stdout", `[openrouter] Warning agent: nearing turn limit\n`);
    }

    for (const tc of result.message.tool_calls) {
      await onLog("stdout", `[openrouter] Tool: ${tc.function.name}\n`);
      const port = process.env.PORT || "3100";
      const toolResult = await executeToolCall(tc.function.name, tc.function.arguments, cwd, onLog, {
        port,
        authHeader: jwtAuthHeader,
        companyId: agent.companyId,
      });
      messages.push({ role: "tool", content: sanitize(toolResult).substring(0, 50_000), tool_call_id: tc.id });
    }
  }

  // Estimate cost if OpenRouter didn't return it
  if (totalCost === 0 && (totalIn + totalOut) > 0) {
    // DeepSeek V3.2 Speciale: $0.40/$1.20 per 1M tokens
    totalCost = (totalIn / 1_000_000) * 0.40 + (totalOut / 1_000_000) * 1.20;
  }

  await onLog("stdout", `[openrouter] Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s | ${totalIn}+${totalOut} tokens | $${totalCost.toFixed(4)}\n`);

  return { exitCode: 0, signal: null, timedOut: false, usage: { inputTokens: totalIn, outputTokens: totalOut }, provider: "openrouter", biller: "openrouter", model: resolvedModel, billingType: "api", costUsd: totalCost || null, summary: lastMessage || null };
}
