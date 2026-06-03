import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  joinPromptSections,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  readPaperclipIssueWorkModeFromContext,
  parseObject,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_GEMINI_API_MODEL } from "../index.js";
import { checkGeminiModelHealth } from "./health-check.js";
import { isModelQuarantined, quarantineModel } from "./quarantine.js";
import {
  checkRequestsPerHour,
  checkTokensPerRun,
  checkDailyBudget,
  recordRequest,
  recordSpend,
  DEFAULT_MAX_REQUESTS_PER_AGENT_PER_HOUR,
  DEFAULT_MAX_TOKENS_PER_RUN,
  DEFAULT_MAX_DAILY_BUDGET_USD,
} from "./cost-guard.js";
import { parseGeminiApiJsonl, detectGeminiApiQuotaExhausted } from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";

// ---------------------------------------------------------------------------
// Risk-tier fallback model selection
// ---------------------------------------------------------------------------

type RiskTier = "low" | "medium" | "high";

const FLASH_LITE = "gemini-2.5-flash-lite";
const FLASH = "gemini-2.5-flash";

/**
 * Returns an ordered list of models to try for the given risk tier.
 * - low: requested model → flash-lite
 * - medium: requested model → flash → flash-lite
 * - high: requested model only (refuse on failure)
 */
export function resolveFallbackChain(model: string, tier: RiskTier): string[] {
  switch (tier) {
    case "low":
      return model === FLASH_LITE ? [model] : [model, FLASH_LITE];
    case "medium":
      if (model === FLASH_LITE) return [model];
      if (model === FLASH) return [model, FLASH_LITE];
      return [model, FLASH, FLASH_LITE];
    case "high":
      return [model];
  }
}

// ---------------------------------------------------------------------------
// API key validation (name/length only — never log the value)
// ---------------------------------------------------------------------------

function readApiKey(env: Record<string, string | undefined>): string | null {
  const key = env.GEMINI_API_KEY ?? "";
  return key.trim().length > 0 ? key.trim() : null;
}

// ---------------------------------------------------------------------------
// Error result helper
// ---------------------------------------------------------------------------

function errorResult(
  errorCode: string,
  summary: string,
): AdapterExecutionResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorCode,
    summary,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    costUsd: null,
    sessionId: null,
  };
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  // 1. API key validation — check env config override first, then process env
  const envConfig = parseObject(config.env) as Record<string, unknown>;
  const configApiKey = readApiKey(envConfig as Record<string, string | undefined>);
  const processApiKey = readApiKey(process.env as Record<string, string | undefined>);
  const apiKey = configApiKey ?? processApiKey;
  if (!apiKey) {
    return errorResult(
      "gemini_api_key_missing",
      "GEMINI_API_KEY is not set. Configure it as a Paperclip-managed secret.",
    );
  }

  // 2. Model + risk-tier resolution
  const requestedModel = asString(config.model, DEFAULT_GEMINI_API_MODEL).trim() || DEFAULT_GEMINI_API_MODEL;
  const rawTier = asString(config.riskTier, "medium").toLowerCase().trim();
  const tier: RiskTier = rawTier === "low" || rawTier === "high" ? rawTier : "medium";
  const fallbackChain = resolveFallbackChain(requestedModel, tier);
  const quarantineReleaseAfterMinutes = asNumber(config.quarantineReleaseAfterMinutes, 60);

  // 3. Cost guard limits
  const maxReqPerHour = asNumber(config.maxRequestsPerAgentPerHour, DEFAULT_MAX_REQUESTS_PER_AGENT_PER_HOUR);
  const maxTokensPerRun = asNumber(config.maxTokensPerRun, DEFAULT_MAX_TOKENS_PER_RUN);
  const maxDailyUsd = asNumber(config.maxDailyBudgetUsd, DEFAULT_MAX_DAILY_BUDGET_USD);

  // 4. Requests/hour guard
  const reqCheck = await checkRequestsPerHour(agent.id, maxReqPerHour);
  if (reqCheck.violation) {
    const v = reqCheck.violation;
    const msg = v.kind === "requests_per_hour"
      ? `Hourly request limit reached (${v.used}/${v.limit} requests this hour for agent ${agent.id}).`
      : "Hourly request limit reached.";
    return errorResult("gemini_api_cost_limit_requests_per_hour", msg);
  }

  // 5. Daily budget guard
  const budgetCheck = await checkDailyBudget(maxDailyUsd);
  if (budgetCheck.violation) {
    const v = budgetCheck.violation;
    const msg = v.kind === "daily_budget"
      ? `Daily budget limit reached ($${v.usedUsd.toFixed(4)} of $${v.limitUsd.toFixed(2)} used today).`
      : "Daily budget limit reached.";
    return errorResult("gemini_api_cost_limit_daily_budget", msg);
  }

  // 6. Model selection: health check + quarantine fallback
  let selectedModel: string | null = null;
  for (const candidate of fallbackChain) {
    const quarantined = await isModelQuarantined(candidate);
    if (quarantined) {
      await onLog("stderr", `[paperclip] Gemini API model "${candidate}" is quarantined (quota). Trying next fallback.\n`);
      continue;
    }

    await onLog("stderr", `[paperclip] Probing Gemini API model "${candidate}" health...\n`);
    const health = await checkGeminiModelHealth(candidate, apiKey);
    if (health.ok) {
      selectedModel = candidate;
      break;
    }

    if (health.quotaExhausted) {
      await onLog("stderr", `[paperclip] Gemini API model "${candidate}" quota exhausted — quarantining for ${quarantineReleaseAfterMinutes} min.\n`);
      await quarantineModel(candidate, health.body.slice(0, 200), quarantineReleaseAfterMinutes);
    } else {
      await onLog("stderr", `[paperclip] Gemini API model "${candidate}" health check failed (HTTP ${health.status}). Trying next fallback.\n`);
    }
  }

  if (!selectedModel) {
    const tierNote = tier === "high" ? " (high-risk tier refuses fallback)" : "";
    return errorResult(
      "gemini_api_no_available_model",
      `No available Gemini API model${tierNote}. All candidates are quarantined or unavailable.`,
    );
  }

  // 7. Build environment
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const configuredCwd = asString(config.cwd, "");
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  // Inject key by value into subprocess env — not printed/logged
  env.GEMINI_API_KEY = apiKey;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim()
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  // Merge additional env from config (skip re-injecting GEMINI_API_KEY from config object)
  for (const [k, v] of Object.entries(envConfig)) {
    if (k !== "GEMINI_API_KEY" && typeof v === "string" && v.trim().length > 0) {
      env[k] = v;
    }
  }

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  // 8. Build prompt
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake);
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const prompt = joinPromptSections([wakePrompt, renderedPrompt]);

  // 9. Build CLI args
  const command = asString(config.command, "gemini");
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    return fromExtraArgs.length > 0 ? fromExtraArgs : asStringArray(config.args);
  })();
  const sandbox = asBoolean(config.sandbox, false);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);

  const args: string[] = [
    "--model", selectedModel,
    "--output-format", "stream-json",
    "--no-update-check",
    "--approval-mode", "yolo",
  ];
  if (sandbox) {
    args.push("--sandbox");
  } else {
    args.push("--sandbox=none");
  }
  args.push(...extraArgs);
  args.push("--prompt", prompt);

  // 10. Record the request before running
  await recordRequest(agent.id);

  // 11. Log meta
  if (onMeta) {
    await onMeta({
      adapterType: "gemini_api",
      command,
      cwd,
      commandNotes: [
        "Prompt is passed to Gemini via --prompt for non-interactive execution.",
        `Selected model: ${selectedModel} (requested: ${requestedModel}, tier: ${tier})`,
        `API key: present, length=${apiKey.length}`,
      ],
      commandArgs: args.map((value, index) =>
        index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value,
      ),
      env: buildInvocationEnvForLogs(env, {
        runtimeEnv: effectiveEnv,
        includeRuntimeKeys: ["HOME"],
        resolvedCommand: command,
      }),
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        wakePromptChars: wakePrompt.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  await onLog("stderr", `[paperclip] Gemini API: model=${selectedModel} tier=${tier}\n`);

  // 12. Run the CLI process
  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env: effectiveEnv,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn,
  });

  // 13. Parse output
  const parsed = parseGeminiApiJsonl(proc.stdout);
  const totalTokens = parsed.usage.inputTokens + parsed.usage.outputTokens;

  // Token limit — informational warning post-run
  const tokenViolation = checkTokensPerRun(totalTokens, maxTokensPerRun);
  if (tokenViolation) {
    await onLog(
      "stderr",
      `[paperclip] Warning: run used ${totalTokens} tokens, exceeding the configured limit of ${maxTokensPerRun}.\n`,
    );
  }

  // 14. Post-run quota quarantine
  const quotaHit = detectGeminiApiQuotaExhausted({
    body: proc.stderr,
    errorCode: parsed.errorMessage ?? undefined,
  });
  if (quotaHit) {
    await onLog(
      "stderr",
      `[paperclip] Quota exhausted on model "${selectedModel}" — quarantining for ${quarantineReleaseAfterMinutes} min.\n`,
    );
    await quarantineModel(selectedModel, "quota exhausted during run", quarantineReleaseAfterMinutes);
  }

  // 15. Record spend
  if (parsed.costUsd != null && parsed.costUsd > 0) {
    await recordSpend(parsed.costUsd);
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    sessionId: parsed.sessionId,
    summary: parsed.summary || firstNonEmptyLine(proc.stdout),
    usage: parsed.usage,
    costUsd: parsed.costUsd,
    errorMessage: parsed.errorMessage,
    model: selectedModel,
    billingType: "api",
  };
}
