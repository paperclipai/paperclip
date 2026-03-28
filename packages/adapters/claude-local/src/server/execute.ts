import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  buildPaperclipEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../skills"),         // published: <pkg>/dist/server/ -> <pkg>/skills/
  path.resolve(__moduleDir, "../../../../../skills"), // dev: src/server/ -> repo root/skills/
];

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of PAPERCLIP_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Skill tag system — agent title → default tag sets (OR-match against skill tags)
// ---------------------------------------------------------------------------

const ROLE_TAG_MAP: Record<string, string[]> = {
  "Chief Executive Officer": ["core", "management", "meta", "planning"],
  "CEO":                     ["core", "management", "meta", "planning"],
  "Chief Technology Officer": ["core", "management", "planning", "development", "backend", "review", "devops", "docs"],
  "CTO":                     ["core", "management", "planning", "development", "backend", "review", "devops", "docs"],
  "Frontend Engineer":       ["core", "planning", "frontend", "design", "development", "testing", "review"],
  "Backend Engineer":        ["core", "planning", "backend", "development", "testing", "review"],
  "Full Stack Engineer":     ["core", "planning", "frontend", "backend", "design", "development", "testing", "review"],
  "UX Designer":             ["core", "planning", "frontend", "design", "docs"],
  "DevOps Engineer":         ["core", "planning", "devops", "development", "review"],
  "QA Engineer":             ["core", "planning", "testing", "review", "development"],
};
const DEFAULT_TAGS = ["core", "planning", "development"];

/**
 * Parse YAML frontmatter from a SKILL.md to extract name, description, and tags.
 * Only reads the first ~2KB to avoid loading huge files.
 */
async function parseSkillFrontmatter(
  skillMdPath: string,
): Promise<{ name: string; description: string; tags: string[] } | null> {
  let content: string;
  try {
    const handle = await fs.open(skillMdPath, "r");
    const buf = Buffer.alloc(2048);
    const { bytesRead } = await handle.read(buf, 0, 2048, 0);
    await handle.close();
    content = buf.toString("utf-8", 0, bytesRead);
  } catch {
    return null;
  }
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : "";

  // description may be single-line or multi-line (using >)
  const descMatch = fm.match(/^description:\s*>?\s*\n?([\s\S]*?)(?=\n\w|\n---)/m);
  const descSingle = fm.match(/^description:\s*(?!>)(.+)$/m);
  const description = descSingle
    ? descSingle[1].trim()
    : descMatch
      ? descMatch[1].replace(/\n\s*/g, " ").trim()
      : "";

  // tags: [core, development] or tags:\n  - core\n  - development
  const tagsInline = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  const tags: string[] = [];
  if (tagsInline) {
    for (const t of tagsInline[1].split(",")) {
      const trimmed = t.trim();
      if (trimmed) tags.push(trimmed);
    }
  }

  return { name: name || path.basename(path.dirname(skillMdPath)), description, tags };
}

interface SkillsResult {
  /** Temp dir to pass as --add-dir */
  dir: string;
  /** Path to the generated skills-index.json */
  indexPath: string;
}

/**
 * Create a tmpdir with `.claude/skills/` containing symlinks to skills
 * filtered by the agent's role tags. Also generates a skills-index.json
 * listing ALL available skills for on-demand discovery.
 */
async function buildSkillsDir(agentTags: string[]): Promise<SkillsResult> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const skillsDir = await resolvePaperclipSkillsDir();
  if (!skillsDir) return { dir: tmp, indexPath: "" };

  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const loaded: string[] = [];
  const available: Array<{ name: string; description: string; tags: string[]; path: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name);
    const skillMd = path.join(skillPath, "SKILL.md");
    const meta = await parseSkillFrontmatter(skillMd);

    if (!meta) {
      // No parseable frontmatter — include it (safe fallback)
      await fs.symlink(skillPath, path.join(target, entry.name));
      loaded.push(entry.name);
      continue;
    }

    // Check if any of the skill's tags match any of the agent's tags (OR-match)
    const shouldLoad =
      meta.tags.length === 0 ||
      meta.tags.some((t) => agentTags.includes(t));

    if (shouldLoad) {
      await fs.symlink(skillPath, path.join(target, entry.name));
      loaded.push(meta.name || entry.name);
    } else {
      available.push({
        name: meta.name || entry.name,
        description: meta.description,
        tags: meta.tags,
        path: skillMd,
      });
    }
  }

  // Write the skills index for on-demand discovery
  const indexPath = path.join(tmp, "skills-index.json");
  await fs.writeFile(
    indexPath,
    JSON.stringify({ loaded, available }, null, 2),
  );

  return { dir: tmp, indexPath };
}

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface ClaudeRuntimeConfig {
  command: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" {
  // Claude uses API-key auth when ANTHROPIC_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
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
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (effectiveWorkspaceCwd) {
    env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceId) {
    env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

async function injectTaskContext(
  skillsDir: string,
  env: Record<string, string>,
): Promise<void> {
  const apiUrl = env.PAPERCLIP_API_URL;
  const apiKey = env.PAPERCLIP_API_KEY;
  let resolvedTaskId = env.PAPERCLIP_TASK_ID;

  // When no explicit task ID, look up the agent's top assigned task
  if (!resolvedTaskId && apiUrl && apiKey) {
    const agentId = env.PAPERCLIP_AGENT_ID;
    const companyId = env.PAPERCLIP_COMPANY_ID;
    if (agentId && companyId) {
      try {
        const res = await fetch(
          `${apiUrl}/api/companies/${companyId}/issues?assigneeAgentId=${agentId}&status=todo,in_progress,blocked`,
          { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) },
        );
        if (res.ok) {
          const issues = await res.json();
          if (Array.isArray(issues) && issues.length > 0) {
            resolvedTaskId = issues[0].id;
            env.PAPERCLIP_TASK_ID = resolvedTaskId;
          }
        }
      } catch { /* non-fatal */ }
    }
  }
  if (!resolvedTaskId || !apiUrl || !apiKey) return;

  try {
    const headers = { authorization: `Bearer ${apiKey}` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    // Fetch task details + comments in parallel
    const [issueRes, commentsRes] = await Promise.all([
      fetch(`${apiUrl}/api/issues/${resolvedTaskId}`, { headers, signal: controller.signal }),
      fetch(`${apiUrl}/api/issues/${resolvedTaskId}/comments`, { headers, signal: controller.signal }),
    ]);
    clearTimeout(timer);

    if (!issueRes.ok) return;
    const issue = await issueRes.json();
    const comments = commentsRes.ok ? await commentsRes.json() : [];

    // Format as markdown reference
    const wakeReason = env.PAPERCLIP_WAKE_REASON ?? "unknown";
    const wakeCommentId = env.PAPERCLIP_WAKE_COMMENT_ID ?? "";
    const lines = [
      `# Pre-loaded Run Context`,
      ``,
      `This context was pre-fetched by the adapter. You can skip Steps 1, 3, 4, and 6 of the Heartbeat Procedure.`,
      `**Still do Step 5 (checkout) before working.**`,
      ``,
      `## Wake Info`,
      `- Reason: ${wakeReason}`,
      `- Task: ${issue.identifier ?? resolvedTaskId}`,
      wakeCommentId ? `- Trigger comment: ${wakeCommentId}` : ``,
      ``,
      `## Your Identity`,
      `- Agent ID: ${env.PAPERCLIP_AGENT_ID}`,
      `- Company ID: ${env.PAPERCLIP_COMPANY_ID}`,
      `- Run ID: ${env.PAPERCLIP_RUN_ID}`,
      ``,
      `## Task Details`,
      `- ID: ${issue.id}`,
      `- Identifier: ${issue.identifier}`,
      `- Title: ${issue.title}`,
      `- Status: ${issue.status}`,
      `- Priority: ${issue.priority}`,
      `- Assignee Agent ID: ${issue.assigneeAgentId}`,
      issue.parentId ? `- Parent ID: ${issue.parentId}` : ``,
      issue.projectId ? `- Project ID: ${issue.projectId}` : ``,
      issue.goalId ? `- Goal ID: ${issue.goalId}` : ``,
      ``,
      `### Description`,
      `${issue.description ?? "(none)"}`,
    ];

    // Add ancestor chain if present
    if (issue.ancestors?.length > 0) {
      lines.push(``, `### Ancestors (parent chain)`);
      for (const a of issue.ancestors) {
        lines.push(`- ${a.identifier}: ${a.title} (${a.status})`);
      }
    }

    // Add project info if present
    if (issue.project) {
      lines.push(``, `### Project`);
      lines.push(`- Name: ${issue.project.name}`);
      if (issue.project.description) lines.push(`- Description: ${issue.project.description}`);
    }

    // Add comments
    const hasDeerFlowResearch = Array.isArray(comments) && comments.some(
      (c: { body?: string }) => c.body?.includes("<!-- deerflow:research -->"),
    );
    if (Array.isArray(comments) && comments.length > 0) {
      lines.push(``, `## Comments (${comments.length})`);
      if (hasDeerFlowResearch) {
        lines.push(
          ``,
          `> **Note:** A DeerFlow pre-flight research brief is included below. Use it as your starting context — skip redundant exploration and focus on implementation.`,
        );
      }
      for (const c of comments.slice(-20)) { // last 20 comments
        const author = c.authorAgent?.name ?? c.authorUser?.name ?? "unknown";
        lines.push(``, `### ${author} (${c.createdAt})`);
        lines.push(c.body ?? "(empty)");
      }
    }

    const refDir = path.join(skillsDir, ".claude", "skills", "paperclip", "references");
    await fs.mkdir(refDir, { recursive: true });
    await fs.writeFile(path.join(refDir, "run-context.md"), lines.filter(Boolean).join("\n"), "utf-8");
  } catch {
    // Non-fatal — agent falls back to standard heartbeat procedure
  }
}

async function injectSharedMemories(
  skillsDir: string,
  env: Record<string, string>,
): Promise<void> {
  const apiUrl = env.PAPERCLIP_API_URL;
  const apiKey = env.PAPERCLIP_API_KEY;
  const companyId = env.PAPERCLIP_COMPANY_ID;
  if (!apiUrl || !apiKey || !companyId) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `${apiUrl}/api/companies/${companyId}/memories?limit=20`,
      {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!res.ok) return;

    const facts = (await res.json()) as Array<{ content: string; category: string; confidence: number }>;
    if (!Array.isArray(facts) || facts.length === 0) return;

    const lines = facts.map(
      (f) => `- [${f.category}] (${f.confidence}) ${f.content}`,
    );
    const content = `# Shared Agent Memory\n\nThese facts were stored by agents across previous sessions.\n\n${lines.join("\n")}\n`;

    const refDir = path.join(skillsDir, ".claude", "skills", "memory", "references");
    await fs.mkdir(refDir, { recursive: true });
    await fs.writeFile(path.join(refDir, "shared-memories.md"), content, "utf-8");
  } catch {
    // Non-fatal — agent runs without injected memories
  }
}

async function extractAndStoreMemories(
  summary: string,
  taskContext: string,
  env: Record<string, string>,
): Promise<void> {
  // Prefer VIBE_BACKEND_HOST (injected by Paperclip control plane) over the
  // legacy VLLM_API_URL.  This keeps the inference endpoint decision in
  // Paperclip while the actual LLM call stays in the agent container.
  const vllmUrl = process.env.VIBE_BACKEND_HOST ?? process.env.VLLM_API_URL;
  const apiUrl = env.PAPERCLIP_API_URL;
  const apiKey = env.PAPERCLIP_API_KEY;
  const companyId = env.PAPERCLIP_COMPANY_ID;
  if (!vllmUrl || !apiUrl || !apiKey || !companyId) return;
  if (!summary || summary.length < 100) return; // Skip trivial runs

  // Fetch existing memories to avoid duplicates
  let existingFacts = "";
  try {
    const existingRes = await fetch(
      `${apiUrl}/api/companies/${companyId}/memories?limit=50`,
      {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (existingRes.ok) {
      const existing = (await existingRes.json()) as Array<{ content: string }>;
      if (Array.isArray(existing) && existing.length > 0) {
        existingFacts =
          "\n\nExisting memories (do NOT duplicate these):\n" +
          existing.map((f) => `- ${f.content}`).join("\n");
      }
    }
  } catch {
    /* non-fatal */
  }

  // Build extraction prompt
  const userPrompt = [
    "Extract reusable factual information from this agent work session.",
    "",
    `Task: ${taskContext}`,
    "",
    `Result:\n${summary.slice(0, 3000)}`,
    existingFacts,
    "",
    'Return a JSON object: {"facts": [{"content": "...", "category": "preference|knowledge|context|behavior|goal", "confidence": 0.0-1.0}]}',
    "",
    "Rules:",
    "- Only extract clear, specific, reusable facts that benefit other agents",
    "- Skip session-specific details (file paths, line numbers, temporary state)",
    "- Focus on: project patterns, architecture decisions, tool preferences, conventions",
    "- Confidence 0.9+ for confirmed facts, 0.7-0.8 for inferred",
    "- Do NOT duplicate any existing memories listed above",
    '- If nothing worth storing, return {"facts": []}',
    "- Return ONLY valid JSON, no explanation",
  ].join("\n");

  // Call vLLM for extraction
  const llmRes = await fetch(`${vllmUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.VLLM_MODEL || "Qwen/Qwen3.5-9B",
      messages: [
        { role: "system", content: "You are a fact extraction assistant. Return ONLY valid JSON, no explanation." },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 1024,
      temperature: 0.1,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!llmRes.ok) return;

  const llmResult = (await llmRes.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = llmResult.choices?.[0]?.message?.content?.trim();
  if (!text) return;

  // Parse — handle markdown-wrapped JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return;
  let parsed: {
    facts?: Array<{ content: string; category?: string; confidence?: number }>;
  };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return;
  }
  if (!Array.isArray(parsed.facts) || parsed.facts.length === 0) return;

  // Store each fact in Paperclip
  for (const fact of parsed.facts) {
    if (!fact.content || fact.content.length < 10) continue;
    try {
      await fetch(`${apiUrl}/api/companies/${companyId}/memories`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: fact.content.slice(0, 4000),
          category: fact.category || "knowledge",
          confidence: fact.confidence ?? 0.9,
          scopeType: "company",
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* best-effort, continue */
    }
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). All PAPERCLIP_* env vars are already set in your process — never discover them via printenv/env/echo. Start by reading skills/paperclip/references/run-context.md for pre-loaded task context before making any API calls.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const commandNotes = instructionsFilePath
    ? [
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
      ]
    : [];

  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  const billingType = resolveClaudeBillingType(env);

  // Build secret-value set for log redaction
  const secretValues = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (/key|token|secret|password|passwd|authorization|cookie|jwt/i.test(key) && value && value.length > 8) {
      secretValues.add(value);
    }
  }
  const redactSecrets = (text: string): string => {
    let result = text;
    for (const secret of secretValues) {
      if (result.includes(secret)) {
        result = result.replaceAll(secret, "***REDACTED***");
      }
    }
    return result;
  };
  const safeOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    await onLog(stream, redactSecrets(chunk));
  };

  // Determine which skill tags this agent needs.
  // Explicit skillTags in adapterConfig take priority, then title-based lookup.
  const configSkillTags = asStringArray(config.skillTags);
  const agentTags =
    configSkillTags.length > 0
      ? configSkillTags
      : ROLE_TAG_MAP[(agent as unknown as Record<string, unknown>).title as string ?? ""] ??
        ROLE_TAG_MAP[agent.name] ??
        DEFAULT_TAGS;
  const skills = await buildSkillsDir(agentTags);
  const skillsDir = skills.dir;

  // Inject shared memories into the skills dir as a reference file
  await injectSharedMemories(skillsDir, env);

  // Pre-fetch triggering task context so agent can skip heartbeat steps 1-4,6
  await injectTaskContext(skillsDir, env);

  // Point agents to the skills index for on-demand discovery
  if (skills.indexPath) {
    env.PAPERCLIP_SKILLS_INDEX = skills.indexPath;
  }
  // Point to the OpenClaw community skills directory (if mounted)
  const openclawDir = "/app/skills/custom/openclaw";
  if (!env.PAPERCLIP_OPENCLAW_SKILLS_DIR) {
    env.PAPERCLIP_OPENCLAW_SKILLS_DIR = openclawDir;
  }

  // When instructionsFilePath is configured, create a combined temp file that
  // includes both the file content and the path directive, so we only need
  // --append-system-prompt-file (Claude CLI forbids using both flags together).
  let effectiveInstructionsFilePath = instructionsFilePath;
  if (instructionsFilePath) {
    const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
    const pathDirective = `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}.`;
    const combinedPath = path.join(skillsDir, "agent-instructions.md");
    await fs.writeFile(combinedPath, instructionsContent + pathDirective, "utf-8");
    effectiveInstructionsFilePath = combinedPath;
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await safeOnLog(
      "stderr",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  const prompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });

  const buildClaudeArgs = (resumeSessionId: string | null) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (!dangerouslySkipPermissions) {
      const permissionMode = asString(config.permissionMode, "acceptEdits");
      if (permissionMode) args.push("--permission-mode", permissionMode);
    }
    if (chrome) args.push("--chrome");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (effectiveInstructionsFilePath) {
      args.push("--append-system-prompt-file", effectiveInstructionsFilePath);
    }
    args.push("--add-dir", skillsDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildClaudeArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command,
        cwd,
        commandArgs: args,
        commandNotes,
        env: redactEnvForLogs(env),
        prompt,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onLog: safeOnLog,
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: parseFallbackErrorMessage(proc),
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      await safeOnLog(
        "stderr",
        `[paperclip] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      const retryResult = toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });

      // Fire-and-forget: extract memories from successful runs
      if (!retryResult.timedOut && (retryResult.exitCode ?? 0) === 0 && retryResult.summary) {
        const taskDesc = env.PAPERCLIP_WAKE_REASON ?? "";
        extractAndStoreMemories(retryResult.summary, taskDesc, env).catch(() => {});
      }

      return retryResult;
    }

    const result = toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });

    // Fire-and-forget: extract memories from successful runs
    if (!result.timedOut && (result.exitCode ?? 0) === 0 && result.summary) {
      const taskDesc = env.PAPERCLIP_WAKE_REASON ?? "";
      extractAndStoreMemories(result.summary, taskDesc, env).catch(() => {});
    }

    return result;
  } finally {
    fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
  }
}
