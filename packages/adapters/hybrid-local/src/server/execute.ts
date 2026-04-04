import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  renderTemplate,
  joinPromptSections,
  buildPaperclipEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import { execute as claudeExecute } from "@paperclipai/adapter-claude-local/server";
import { execute as codexExecute } from "@paperclipai/adapter-codex-local/server";
import { isClaudeModel } from "../index.js";
import { executeLocalModel, resolveBaseUrl } from "./openai-compat.js";
import { getQuotaWindows } from "./quota.js";
import { readFile } from "node:fs/promises";

// --- Helpers ---

const DEFAULT_QUOTA_THRESHOLD_PERCENT = 80;
const HANDOFF_REGEX = /^\s*HANDOFF:\s*true\b.*$/im;
const HANDOFF_INSTRUCTION =
  "If you need to write code, run tests, or use shell tools, end your response with a new line: HANDOFF: true.";

/**
 * Proactive Claude quota check. Returns true if any quota window exceeds
 * the threshold, meaning Claude is likely to reject the request.
 * Threshold is configurable via adapterConfig.quotaThresholdPercent (default: 80).
 * Set to 0 to disable proactive quota checking.
 */
async function isClaudeQuotaNearExhausted(
  threshold: number,
  opts: {
    allowExtraCredit: boolean;
  },
  onLog: AdapterExecutionContext["onLog"],
): Promise<boolean> {
  if (threshold <= 0) return false;
  const { allowExtraCredit } = opts;
  try {
    const quota = await getQuotaWindows();

    // Quota check unavailable:
    // - allowExtraCredit=false => fail closed (policy)
    // - otherwise fail open
    if (!quota.ok || quota.windows.length === 0) {
      if (!allowExtraCredit) {
        const mode = "policy fail-closed";
        await onLog(
          "stdout",
          `[hybrid] Claude quota pre-check unavailable (${quota.error ?? "no windows"}) — ${mode}\n`,
        );
        return true;
      }
      return false;
    }

    const exhausted = quota.windows.find(
      (w) => w.usedPercent != null && w.usedPercent >= threshold,
    );
    if (exhausted) {
      await onLog(
        "stdout",
        `[hybrid] Claude quota pre-check: "${exhausted.label}" at ${exhausted.usedPercent}% (threshold: ${threshold}%)\n`,
      );
      return true;
    }
    return false;
  } catch (error) {
    if (!allowExtraCredit) {
      const message = error instanceof Error ? error.message : String(error);
      const mode = "policy fail-closed";
      await onLog("stdout", `[hybrid] Claude quota pre-check error: ${message} — ${mode}\n`);
      return true;
    }
    // No fallback and extra credit allowed: fail-open
    return false;
  }
}

// Strip <think>...</think> blocks (reasoning tokens from models like qwen3).
// We only want to detect HANDOFF: true in the actual visible output, not in
// reasoning tokens where the model may mention it as part of its thought process.
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractHandoffMarker(text: string): { requested: boolean; cleaned: string } {
  if (!text) return { requested: false, cleaned: text };
  const visibleText = stripThinkBlocks(text);
  const requested = HANDOFF_REGEX.test(visibleText);
  if (!requested) return { requested: false, cleaned: visibleText || text };
  const cleaned = visibleText
    .split(/\r?\n/)
    .filter((line) => !HANDOFF_REGEX.test(line))
    .join("\n")
    .trim();
  return { requested: true, cleaned };
}

// --- Routing metadata ---

interface RoutingMeta {
  planningModel: string;
  planningBackend: "openai_compatible";
  codingModel: string | null;
  codingBackend: "claude_cli" | "codex_cli" | null;
  localToolsEnabled: boolean;
  handoffRequested: boolean;
  handoffReason: string | null;
}

function attachRoutingMeta(
  result: AdapterExecutionResult,
  meta: RoutingMeta,
): AdapterExecutionResult {
  return {
    ...result,
    resultJson: {
      ...(result.resultJson ?? {}),
      _hybrid: meta,
    },
  };
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, max = 1200): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function buildCodingHandoffSummary(
  context: AdapterExecutionContext["context"] | null | undefined,
  planningSummary: string,
): string {
  const ctx = (context ?? {}) as Record<string, unknown>;
  const issueRaw = ctx.paperclipIssue;
  const issue =
    typeof issueRaw === "object" && issueRaw !== null && !Array.isArray(issueRaw)
      ? (issueRaw as Record<string, unknown>)
      : null;
  const issueId = issue ? readNonEmptyString(issue.id) : null;
  const issueIdentifier = issue ? readNonEmptyString(issue.identifier) : null;
  const issueTitle = issue ? readNonEmptyString(issue.title) : null;
  const issueDescription = issue ? readNonEmptyString(issue.description) : null;
  const issueLabel = issueIdentifier && issueTitle
    ? `${issueIdentifier} ${issueTitle}`
    : issueTitle ?? issueIdentifier ?? issueId;

  const priorSession = readNonEmptyString(ctx.paperclipSessionHandoffMarkdown);
  const planning = readNonEmptyString(planningSummary);

  const lines = ["Paperclip coding handoff:"];
  if (issueLabel) lines.push(`- Task: ${issueLabel}`);
  if (issueDescription) lines.push(`- Task details: ${truncateText(issueDescription)}`);
  if (priorSession) lines.push(`- Prior session notes: ${truncateText(priorSession)}`);
  if (planning) lines.push(`- Planning summary: ${truncateText(planning)}`);
  lines.push("Proceed to implement the task and report progress.");
  return lines.join("\n");
}

// --- Main execute ---

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, onLog } = ctx;
  const localModel = asString(config.model, "");
  const codingModel = asString(config.codingModel, "");
  const allowExtraCredit = asBoolean(config.allowExtraCredit, false);
  const allowLocalTools = asBoolean(config.allowLocalTools, false);
  const localToolMode = asString(config.localToolMode, "");
  const effectiveToolMode = (localToolMode || (allowLocalTools ? "full" : "off")) as "off" | "read_only" | "full";
  const toolsEnabled = effectiveToolMode !== "off";

  if (!localModel) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "No local planning model configured. Set adapterConfig.model.",
      errorCode: "missing_model",
    };
  }

  const quotaThreshold = asNumber(config.quotaThresholdPercent, DEFAULT_QUOTA_THRESHOLD_PERCENT);

  let planningOutcome: {
    result: AdapterExecutionResult;
    handoffRequested: boolean;
    handoffSummary: string;
  };

  try {
    planningOutcome = await executeLocal(ctx, localModel, toolsEnabled, effectiveToolMode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Local planning error: ${message}`,
      errorCode: "local_error",
      clearSession: true,
    };
  }

  if (!planningOutcome.handoffRequested) {
    await onLog("stdout", `[hybrid] Planning complete — no handoff requested, staying local (model=${localModel})\n`);
    return attachRoutingMeta(planningOutcome.result, {
      planningModel: localModel,
      planningBackend: "openai_compatible",
      codingModel: codingModel || null,
      codingBackend: codingModel
        ? (isClaudeModel(codingModel) ? "claude_cli" : "codex_cli")
        : null,
      localToolsEnabled: toolsEnabled,
      handoffRequested: false,
      handoffReason: null,
    });
  }

  if (!codingModel) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "Handoff requested, but no coding model is configured. Choose a coding model in agent settings, or edit the instructions to avoid requesting HANDOFF unless a coding model is set.",
      errorCode: "missing_coding_model",
    };
  }

  const handoffSummary = buildCodingHandoffSummary(
    ctx.context,
    planningOutcome.handoffSummary,
  );

  const codingBackend = isClaudeModel(codingModel) ? "claude_cli" : "codex_cli";
  if (codingBackend === "claude_cli" && !allowExtraCredit) {
    const blocked = await isClaudeQuotaNearExhausted(
      quotaThreshold,
      { allowExtraCredit },
      onLog,
    );
    if (blocked) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "extra_credit_disabled",
        errorMessage:
          `Claude quota pre-check indicates quota >= ${quotaThreshold}% (or unavailable), and extra credit is disabled.`,
        clearSession: false,
      };
    }
  }

  const codingCtx: AdapterExecutionContext = {
    ...ctx,
    context: {
      ...ctx.context,
      paperclipSessionHandoffMarkdown: handoffSummary,
    },
    config: { ...ctx.config, model: codingModel },
  };

  await onLog("stdout", `[hybrid] Handoff requested — switching to coding model: ${codingModel} (${codingBackend})\n`);
  const codingResult = codingBackend === "claude_cli"
    ? await claudeExecute(codingCtx)
    : await codexExecute(codingCtx);

  return attachRoutingMeta(codingResult, {
    planningModel: localModel,
    planningBackend: "openai_compatible",
    codingModel,
    codingBackend,
      localToolsEnabled: toolsEnabled,
    handoffRequested: true,
    handoffReason: "marker",
  });
}

// --- Local execution ---

async function executeLocal(
  ctx: AdapterExecutionContext,
  model: string,
  allowLocalTools: boolean,
  toolMode: "off" | "read_only" | "full",
): Promise<{ result: AdapterExecutionResult; handoffRequested: boolean; handoffSummary: string }> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;
  const workspaceContext = parseObject(context.paperclipWorkspace);

  const localBaseUrl = resolveBaseUrl(config.localBaseUrl);
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrap = bootstrapPromptTemplate.trim().length > 0
    ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
    : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const handoffInstruction = toolMode === "full" ? "" : HANDOFF_INSTRUCTION;
  const prompt = joinPromptSections([renderedBootstrap, sessionHandoffNote, renderedPrompt, handoffInstruction]);

  if (onMeta) {
    await onMeta({
      adapterType: "hybrid_local",
      command: `OpenAI-compatible @ ${localBaseUrl}`,
      cwd: asString(config.cwd, process.cwd()),
      commandArgs: [`model=${model}`],
      prompt,
      context,
    });
  }

  // Use explicitly configured cwd if set; otherwise fall back to the
  // paperclip workspace cwd passed in context, then process.cwd().
  // Tools are always enabled — agents need bash access to do real work.
  const explicitCwd = typeof config.cwd === "string" && (config.cwd as string).trim().length > 0
    ? (config.cwd as string).trim()
    : null;

  const workspaceCwd = asString(workspaceContext.cwd, "");
  const effectiveCwd = explicitCwd ?? (workspaceCwd || undefined) ?? process.cwd();

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  if (workspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = workspaceCwd;
  const workspaceSource = asString(workspaceContext.source, "");
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  if (workspaceStrategy) env.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  const workspaceId = asString(workspaceContext.workspaceId, "");
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  const workspaceBranch = asString(workspaceContext.branchName, "");
  if (workspaceBranch) env.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  if (workspaceWorktreePath) env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;

  // Read instructionsFilePath as system prompt if configured.
  // Gives local models the same architectural context that Claude agents get
  // from their instructions file (e.g. CLAUDE.md). Silently skipped if the
  // file is missing or unreadable — the run proceeds without it.
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let systemPrompt: string | undefined;
  if (instructionsFilePath) {
    try {
      systemPrompt = await readFile(instructionsFilePath, "utf-8");
      await onLog("stdout", `[hybrid] Loaded system prompt from ${instructionsFilePath} (${systemPrompt.length} chars)\n`);
    } catch {
      await onLog("stdout", `[hybrid] instructionsFilePath not found, skipping: ${instructionsFilePath}\n`);
    }
  }

  const result = await executeLocalModel({
    baseUrl: localBaseUrl,
    model,
    prompt,
    systemPrompt,
    cwd: effectiveCwd,
    env,
    enableTools: allowLocalTools,
    toolMode,
    timeoutMs: timeoutSec * 1000,
    maxTotalTokens: asNumber(config.maxTotalTokens, 300_000),
    onLog,
  });

  const handoff = extractHandoffMarker(result.summary ?? "");

  return {
    result: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: result.usage,
      provider: "openai_compatible",
      biller: "local",
      model: result.model,
      billingType: "subscription",
      costUsd: 0,
      summary: handoff.cleaned,
      resultJson: {
        result: handoff.cleaned,
        model: result.model,
        finish_reason: result.finishReason,
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        },
      },
      clearSession: true,
    },
    handoffRequested: handoff.requested,
    handoffSummary: handoff.cleaned,
  };
}
