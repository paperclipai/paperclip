import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterSessionCodec,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asBoolean,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  readPaperclipRuntimeSkillEntries,
  removeMaintainerOnlySkillSymlinks,
  resolveCommandForLogs,
  resolvePaperclipDesiredSkillNames,
  renderTemplate,
  renderPaperclipWakePrompt,
  joinPromptSections,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_GRACE_SEC = 20;

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function kimiSkillsHome(): string {
  return path.join(os.homedir(), ".kimi", "skills");
}

type EnsureKimiSkillsInjectedOptions = {
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  skillsHome?: string;
  linkSkill?: (source: string, target: string) => Promise<void>;
};

async function ensureKimiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureKimiSkillsInjectedOptions = {},
) {
  const skillsEntries = options.skillsEntries ?? await readPaperclipRuntimeSkillEntries({}, __moduleDir);
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? kimiSkillsHome();
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare Kimi skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Kimi skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  const linkSkill = options.linkSkill ?? ((source: string, target: string) => fs.symlink(source, target));
  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;

      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Kimi skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Kimi skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Session codec
// ---------------------------------------------------------------------------

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Kimi tracks sessions per cwd in ~/.kimi/kimi.json. Only pass --continue when
// a session actually exists, otherwise Kimi exits with "No previous session found".
async function kimiHasSessionForCwd(cwd: string): Promise<boolean> {
  try {
    const kimiJsonPath = path.join(os.homedir(), ".kimi", "kimi.json");
    const raw = await fs.readFile(kimiJsonPath, "utf-8");
    const data = JSON.parse(raw) as {
      work_dirs?: Array<{ path: string; last_session_id: string | null }>;
    };
    const resolved = path.resolve(cwd);
    return (data.work_dirs ?? []).some(
      (d) => path.resolve(d.path) === resolved && d.last_session_id != null,
    );
  } catch {
    return false;
  }
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    if (!cwd) return null;
    return { cwd };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || typeof params !== "object" || Array.isArray(params)) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    if (!cwd) return null;
    return { cwd };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params || typeof params !== "object") return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    if (!cwd) return null;
    return `kimi-${cwd}`;
  },
};

// ---------------------------------------------------------------------------
// Kimi stream-json message types
// ---------------------------------------------------------------------------

type KimiMessage =
  | {
      role: "assistant";
      content: string;
      tool_calls?: Array<{
        type: "function";
        id: string;
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string }
  | { role: "user"; content: string }
  | { role: "system"; content: string };

interface ParsedKimiOutput {
  messages: KimiMessage[];
  finalText: string;
  usage?: UsageSummary;
  model?: string;
  provider?: string;
}

function parseKimiStreamJson(stdout: string): ParsedKimiOutput {
  const messages: KimiMessage[] = [];
  let finalText = "";
  let model: string | undefined;
  let provider: string | undefined;
  let usage: UsageSummary | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as KimiMessage & {
        model?: string;
        provider?: string;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };
      if (msg.role && typeof msg.role === "string") {
        messages.push(msg as KimiMessage);
        if (msg.role === "assistant" && typeof msg.content === "string") {
          finalText = msg.content;
        }
      }
      if (msg.model && typeof msg.model === "string") {
        model = msg.model;
      }
      if (msg.provider && typeof msg.provider === "string") {
        provider = msg.provider;
      }
      if (msg.usage && typeof msg.usage === "object") {
        const u = msg.usage;
        usage = {
          inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
          outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
          cachedInputTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
        };
      }
    } catch {
      // Ignore non-JSON lines
    }
  }

  // If no structured messages were parsed, treat the whole stdout as text
  if (messages.length === 0 && stdout.trim().length > 0) {
    finalText = stdout.trim();
  }

  return { messages, finalText, usage, model, provider };
}

// ---------------------------------------------------------------------------
// Build runtime config
// ---------------------------------------------------------------------------

interface KimiRuntimeConfig {
  command: string;
  resolvedCommand: string;
  cwd: string;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}

async function buildKimiRuntimeConfig(
  ctx: AdapterExecutionContext,
): Promise<KimiRuntimeConfig> {
  const { runId, agent, config, context, authToken } = ctx;

  const command = asString(config.command, "kimi");
  const configuredCwd = asString(config.cwd, "");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const effectiveCwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(effectiveCwd, { createIfMissing: true });

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.KIMI_API_KEY === "string" && envConfig.KIMI_API_KEY.trim().length > 0;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.KIMI_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, effectiveCwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, effectiveCwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);

  return {
    command,
    resolvedCommand,
    cwd: effectiveCwd,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
  };
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn } = ctx;

  const runtimeConfig = await buildKimiRuntimeConfig(ctx);
  const { command, resolvedCommand, cwd, env, loggedEnv, timeoutSec, graceSec } = runtimeConfig;

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const resolvedCwd = path.resolve(cwd);
  const paperclipHasSession =
    Boolean(runtime.sessionId) &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === resolvedCwd);
  const canResumeSession = paperclipHasSession && (await kimiHasSessionForCwd(resolvedCwd));

  // Agent preset selection — this is the "what powers the agent" field
  const agentPreset = asString(config.agentPreset, "default");
  const customAgentFile = asString(config.customAgentFile, "").trim();
  const model = asString(config.model, "").trim();
  const thinking = asBoolean(config.thinking, false);
  const noThinking = asBoolean(config.noThinking, false);

  if (agentPreset === "custom" && !customAgentFile) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "kimi_local: agentPreset is 'custom' but customAgentFile is empty. Provide an absolute path to a Kimi agent YAML file.",
    };
  }

  const promptTemplate = asString(
    config.promptTemplate,
    `You are agent {{agent.id}} ({{agent.name}}) operating inside a Paperclip heartbeat.

## Paperclip Heartbeat Startup Protocol

Your env has: PAPERCLIP_AGENT_ID={{agent.id}}, PAPERCLIP_COMPANY_ID={{agent.companyId}}, PAPERCLIP_RUN_ID={{runId}}

**Step 0 — Check your task:**
\`\`\`bash
echo "TASK_ID=$PAPERCLIP_TASK_ID"
\`\`\`

- **If PAPERCLIP_TASK_ID is set** → checkout the issue, read its description, read the project's AGENTS.md, then do the work.
- **If PAPERCLIP_TASK_ID is EMPTY** → do NOT wander. Do NOT read random files. Find your work:
  \`\`\`bash
  curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=todo,in_progress" \\
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
    | python3 -c 'import sys,json; data=json.load(sys.stdin); assigned=[i for i in data if i.get("assigneeAgentId")=="'"$PAPERCLIP_AGENT_ID"'"]; prio={"critical":0,"high":1,"medium":2,"low":3}; assigned.sort(key=lambda x: prio.get(x.get("priority"),4)); [print("%s | %s | %s | %s" % (i.get("priority",""), i.get("status",""), i.get("identifier",""), i.get("title",""))) for i in assigned]'
  \`\`\`
  Pick the highest-priority issue with status todo or in_progress. If none assigned, report clearly and STOP.

**Forbidden without a specific assigned issue:** reading JETZT.md, browsing handoffs, running git log out of curiosity, exploring files randomly.

When working: read the issue description completely first, then the project's AGENTS.md, then implement exactly what the issue asks.`,
  );

  const kimiSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredKimiSkillNames = resolvePaperclipDesiredSkillNames(config, kimiSkillEntries);
  await ensureKimiSkillsInjected(onLog, {
    skillsEntries: kimiSkillEntries.filter((entry) => desiredKimiSkillNames.includes(entry.key)),
  });

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake);
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  const prompt = joinPromptSections([wakePrompt, sessionHandoffNote, renderedPrompt]);

  // Build Kimi CLI arguments
  const args = [
    "--print",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--verbose",
    "--work-dir",
    cwd,
  ];

  if (canResumeSession) {
    args.push("--continue");
    await onLog("stdout", `[paperclip] Continuing previous Kimi session for ${resolvedCwd}\n`);
  }

  // Agent selection: the core "what powers the agent" configuration
  if (agentPreset === "custom" && customAgentFile) {
    args.push("--agent-file", customAgentFile);
  } else if (agentPreset === "okabe") {
    args.push("--agent", "okabe");
  } else {
    args.push("--agent", "default");
  }

  if (model) {
    args.push("--model", model);
  }

  if (thinking) {
    args.push("--thinking");
  } else if (noThinking) {
    args.push("--no-thinking");
  }

  const extraArgs = asString(config.extraArgs, "").trim();
  if (extraArgs) {
    args.push(...extraArgs.split(/\s+/).filter(Boolean));
  }

  if (onMeta) {
    await onMeta({
      adapterType: "kimi_local",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
      prompt,
      context,
    });
  }

  await onLog("stdout", `[kimi] Starting Kimi Code CLI with ${agentPreset} agent preset\n`);

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    stdin: prompt,
    timeoutSec,
    graceSec,
    onSpawn,
    onLog,
  });

  const parsed = parseKimiStreamJson(proc.stdout);

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
      summary: parsed.finalText || undefined,
    };
  }

  // Extract the first meaningful stderr line for error reporting
  const stderrLine =
    proc.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";

  const hasErrors = (proc.exitCode ?? 0) !== 0;

  // Build session state for Paperclip to resume on the next heartbeat
  const sessionParams = { cwd: resolvedCwd };
  const sessionDisplayId = `kimi-${resolvedCwd}`;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage: hasErrors
      ? (stderrLine
        ? `Kimi exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
        : `Kimi exited with code ${proc.exitCode ?? -1}`)
      : null,
    summary: parsed.finalText || "(no output from Kimi)",
    provider: parsed.provider || "kimi",
    model: parsed.model || model || "default",
    usage: parsed.usage,
    sessionId: sessionDisplayId,
    sessionParams,
    sessionDisplayId,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
