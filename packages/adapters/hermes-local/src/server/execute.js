
import path from 'node:path';
import { CLI_PROVIDER_FLAG_VALUES, DEFAULT_GRACE_SEC, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_REASONING_EFFORT, DEFAULT_TIMEOUT_SEC, HERMES_DEFAULT_COMMAND } from '../shared/constants.js';
import { asBoolean, asNumber, asRecord, asStringArray, asTrimmedString, joinPromptSections, mergeRuntimeEnv, normalizeEnvBindings, ensureDir, resolveHermesHome } from '../shared/utils.js';
import { detectModel, resolveProvider } from './detect-model.js';
import { buildPrompt } from './prompt.js';
import { isUnknownSessionError, parseHermesOutput } from './parse.js';
import { runChildProcess } from './runtime.js';

/**
 * Build the execution plan without side effects.
 *
 * Keeping this pure makes the adapter far easier to debug and unit-test than
 * burying everything inside execute().
 *
 * @param {any} ctx
 */
export async function createHermesExecutionPlan(ctx) {
  const config = asRecord(ctx.config);
  const explicitProvider = asTrimmedString(config.provider);
  const hermesConfigPath = path.join(resolveHermesHome(config), 'config.yaml');
  const detected = (!explicitProvider || !asTrimmedString(config.model))
    ? await detectModel(hermesConfigPath)
    : null;

  const command = asTrimmedString(config.hermesCommand) || asTrimmedString(config.command) || HERMES_DEFAULT_COMMAND;
  const model = asTrimmedString(config.model) || asTrimmedString(detected?.model) || DEFAULT_MODEL;
  const providerResolution = resolveProvider({
    explicitProvider,
    detectedProvider: detected?.provider,
    detectedModel: detected?.model,
    model,
  });

  const cwd = resolveExecutionCwd(ctx);
  const persistSession = asBoolean(config.persistSession, true);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const worktreeMode = asBoolean(config.worktreeMode, false);
  const checkpoints = asBoolean(config.checkpoints, false);
  const verbose = asBoolean(config.verbose, false);
  const quiet = asBoolean(config.quiet, false);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const toolsets = asTrimmedString(config.toolsets) || asStringArray(config.enabledToolsets).join(',');
  const extraArgs = asStringArray(config.extraArgs);
  const instructions = await buildInstructionsPrefix(config, cwd);

  const runtimeContext = getRuntimeContext(ctx);
  const workspace = asRecord(runtimeContext.context.paperclipWorkspace);
  const prompt = buildPrompt(
    {
      ...ctx,
      context: runtimeContext.context,
    },
    {
      ...config,
      injectedInstructions: instructions,
      paperclipApiUrl: normalizePaperclipApiUrl(
        asTrimmedString(config.paperclipApiUrl) ||
        asTrimmedString(process.env.PAPERCLIP_API_URL) ||
        'http://127.0.0.1:3100/api'
      ),
    }
  );

  const args = ['chat', '-q', prompt];
  if (quiet) args.push('-Q');
  if (model) args.push('-m', model);
  if (
    providerResolution.provider !== DEFAULT_PROVIDER &&
    CLI_PROVIDER_FLAG_VALUES.has(providerResolution.provider)
  ) {
    args.push('--provider', providerResolution.provider);
  }
  if (toolsets) args.push('-t', toolsets);
  if (maxTurns > 0) args.push('--max-turns', String(maxTurns));
  if (worktreeMode) args.push('-w');
  if (checkpoints) args.push('--checkpoints');
  if (verbose) args.push('-v');
  args.push('--source', 'tool');
  if (dangerouslySkipPermissions) args.push('--yolo');

  const resumeSession = runtimeContext.resumeSessionId;
  if (persistSession && resumeSession) args.push('--resume', resumeSession);
  if (extraArgs.length) args.push(...extraArgs);

  return {
    config,
    command,
    cwd,
    prompt,
    args,
    model,
    provider: providerResolution.provider,
    providerResolvedFrom: providerResolution.resolvedFrom,
    persistSession,
    timeoutSec,
    graceSec,
    resumeSession,
    workspaceId: asTrimmedString(workspace.workspaceId),
    repoUrl: asTrimmedString(workspace.repoUrl),
    repoRef: asTrimmedString(workspace.repoRef),
    env: buildExecutionEnv(ctx, config, cwd, runtimeContext.context, providerResolution),
  };
}

/**
 * Execute Hermes and translate the child result into a Paperclip-style
 * adapter result.
 *
 * @param {any} ctx
 */
export async function execute(ctx) {
  const plan = await createHermesExecutionPlan(ctx);
  await ensureDir(plan.cwd);

  const onMeta = ctx.onMeta || null;
  if (onMeta) {
    await onMeta({
      adapterType: 'hermes_local',
      command: plan.command,
      cwd: plan.cwd,
      commandArgs: [...plan.args.slice(0, -1), `<prompt ${plan.prompt.length} chars>`],
      env: redactEnvForLogs(plan.env),
      prompt: plan.prompt,
      promptMetrics: { promptChars: plan.prompt.length },
      context: asRecord(ctx.context),
    });
  }

  await Promise.resolve(ctx.onLog?.(
    'stdout',
    `[hermes] Starting Hermes Agent (model=${plan.model}, provider=${plan.provider} [${plan.providerResolvedFrom}], timeout=${plan.timeoutSec}s)\n`
  ));

  if (plan.resumeSession) {
    await Promise.resolve(ctx.onLog?.('stdout', `[hermes] Resuming session: ${plan.resumeSession}\n`));
  }

  const first = await runHermesChild(plan, ctx);
  const firstResult = parseHermesOutput(first.stdout || '', first.stderr || '');

  if (
    plan.resumeSession &&
    !first.timedOut &&
    ((first.exitCode ?? 0) !== 0 || firstResult.errorMessage) &&
    isUnknownSessionError(first.stdout || '', first.stderr || '')
  ) {
    await Promise.resolve(ctx.onLog?.(
      'stdout',
      `[paperclip] Hermes session "${plan.resumeSession}" is unavailable; retrying with a fresh session.\n`
    ));
    const retryPlan = { ...plan, args: plan.args.filter((value, index, array) => !(value === '--resume' || array[index - 1] === '--resume')), resumeSession: null };
    const retry = await runHermesChild(retryPlan, ctx);
    return buildExecutionResult(retryPlan, retry, parseHermesOutput(retry.stdout || '', retry.stderr || ''), true);
  }

  return buildExecutionResult(plan, first, firstResult, false);
}

async function runHermesChild(plan, ctx) {
  return await runChildProcess({
    runId: asTrimmedString(ctx.runId),
    command: plan.command,
    args: plan.args,
    cwd: plan.cwd,
    env: plan.env,
    timeoutSec: plan.timeoutSec,
    graceSec: plan.graceSec,
    onLog: async (stream, chunk) => {
      if (stream === 'stderr' && isBenignHermesStderr(chunk)) {
        return await Promise.resolve(ctx.onLog?.('stdout', chunk));
      }
      return await Promise.resolve(ctx.onLog?.(stream, chunk));
    },
    onSpawn: ctx.onSpawn,
  });
}

export function buildExecutionResult(plan, child, parsed, clearedSession) {
  const resolvedSessionId = parsed.sessionId || (clearedSession ? null : plan.resumeSession);
  return {
    exitCode: child.exitCode,
    signal: child.signal,
    timedOut: child.timedOut,
    errorMessage: child.timedOut ? `Timed out after ${plan.timeoutSec}s` : (parsed.errorMessage || ((child.exitCode ?? 0) === 0 ? null : `Hermes exited with code ${child.exitCode ?? -1}`)),
    usage: parsed.usage || undefined,
    sessionId: resolvedSessionId,
    sessionParams: resolvedSessionId ? {
      sessionId: resolvedSessionId,
      cwd: plan.cwd,
      ...(plan.workspaceId ? { workspaceId: plan.workspaceId } : {}),
      ...(plan.repoUrl ? { repoUrl: plan.repoUrl } : {}),
      ...(plan.repoRef ? { repoRef: plan.repoRef } : {}),
    } : null,
    sessionDisplayId: resolvedSessionId,
    provider: plan.provider,
    model: plan.model,
    costUsd: typeof parsed.costUsd === 'number' ? parsed.costUsd : undefined,
    summary: parsed.response ? parsed.response.slice(0, 2000) : null,
    resultJson: {
      result: parsed.response || '',
      session_id: parsed.sessionId || null,
      usage: parsed.usage || null,
      cost_usd: typeof parsed.costUsd === 'number' ? parsed.costUsd : null,
      stdout: child.stdout || '',
      stderr: child.stderr || '',
    },
    clearSession: Boolean(clearedSession && !parsed.sessionId),
  };
}

/**
 * Extract execution-relevant runtime context and keep the rest untouched.
 *
 * @param {any} ctx
 */
export function getRuntimeContext(ctx) {
  const context = asRecord(ctx.context);
  const runtime = asRecord(ctx.runtime);
  const sessionParams = asRecord(runtime.sessionParams);
  const cwd = resolveExecutionCwd(ctx);
  const runtimeSessionId = asTrimmedString(sessionParams.sessionId) || asTrimmedString(runtime.sessionId);
  const runtimeSessionCwd = asTrimmedString(sessionParams.cwd);
  const resumeSessionId =
    runtimeSessionId && (!runtimeSessionCwd || path.resolve(runtimeSessionCwd) === path.resolve(cwd))
      ? runtimeSessionId
      : null;

  return {
    context,
    resumeSessionId,
  };
}

/**
 * Working directory precedence:
 * 1. Paperclip workspace cwd
 * 2. adapterConfig.cwd
 * 3. process.cwd()
 *
 * We also export TERMINAL_CWD to help Hermes terminal sessions stay anchored.
 *
 * @param {any} ctx
 */
export function resolveExecutionCwd(ctx) {
  const context = asRecord(ctx.context);
  const workspace = asRecord(context.paperclipWorkspace);
  const workspaceCwd = asTrimmedString(workspace.cwd);
  const configured = asTrimmedString(asRecord(ctx.config).cwd);
  return path.resolve(workspaceCwd || configured || process.cwd());
}

/**
 * Read an optional instructions file and prepend it to the wake prompt.
 *
 * Hermes already knows how to load AGENTS.md / SOUL.md / .hermes.md by itself.
 * This feature is specifically for Paperclip-level operator instructions.
 *
 * @param {Record<string, unknown>} config
 * @param {string} cwd
 */
export async function buildInstructionsPrefix(config, cwd) {
  const instructionsFilePath = asTrimmedString(config.instructionsFilePath);
  if (!instructionsFilePath) return '';
  const resolved = path.resolve(cwd, instructionsFilePath);
  try {
    const fs = await import('node:fs/promises');
    const text = await fs.readFile(resolved, 'utf8');
    return joinPromptSections([
      text,
      `The previous instructions were loaded from ${resolved}. Resolve relative file references from ${path.dirname(resolved)}.`,
    ]);
  } catch {
    return '';
  }
}

/**
 * Build the child environment with explicit, testable behavior.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} config
 * @param {string} cwd
 * @param {Record<string, unknown>} context
 */
export function buildExecutionEnv(ctx, config, cwd, context, providerResolution = null) {
  const configEnv = {
    ...normalizeEnvBindings(config.envBindings),
    ...normalizeEnvBindings(config.env),
  };

  const env = {
    PAPERCLIP_AGENT_ID: asTrimmedString(ctx.agent?.id),
    PAPERCLIP_COMPANY_ID: asTrimmedString(ctx.agent?.companyId),
    PAPERCLIP_RUN_ID: asTrimmedString(ctx.runId),
    PAPERCLIP_API_KEY: asTrimmedString(ctx.authToken) || asTrimmedString(process.env.PAPERCLIP_API_KEY),
    PAPERCLIP_API_URL: normalizePaperclipApiUrl(
      asTrimmedString(config.paperclipApiUrl) ||
      asTrimmedString(process.env.PAPERCLIP_API_URL) ||
      'http://127.0.0.1:3100/api'
    ),
    TERMINAL_CWD: cwd,
    HERMES_SESSION_SOURCE: 'tool',
  };

  const taskId = asTrimmedString(context.taskId) || asTrimmedString(context.issueId);
  const wakeReason = asTrimmedString(context.wakeReason);
  const wakeCommentId = asTrimmedString(context.wakeCommentId) || asTrimmedString(context.commentId);
  const approvalId = asTrimmedString(context.approvalId);
  const approvalStatus = asTrimmedString(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value) => typeof value === 'string' && value.trim()).join(',')
    : '';

  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds;
  if (context.paperclipWake && typeof context.paperclipWake === 'object') {
    try {
      env.PAPERCLIP_WAKE_PAYLOAD_JSON = JSON.stringify(context.paperclipWake);
    } catch {
      // Ignore serialization failures for defensive robustness.
    }
  }

  const workspace = asRecord(context.paperclipWorkspace);
  const workspaceCwd = asTrimmedString(workspace.cwd);
  const workspaceId = asTrimmedString(workspace.workspaceId);
  const repoUrl = asTrimmedString(workspace.repoUrl);
  const repoRef = asTrimmedString(workspace.repoRef);
  if (workspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = workspaceCwd;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (repoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = repoUrl;
  if (repoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = repoRef;

  const explicitProvider = asTrimmedString(config.provider);
  const resolvedProvider = asTrimmedString(providerResolution?.provider);
  const effectiveProvider = explicitProvider || resolvedProvider;
  if (
    effectiveProvider &&
    effectiveProvider !== DEFAULT_PROVIDER &&
    !CLI_PROVIDER_FLAG_VALUES.has(effectiveProvider)
  ) {
    env.HERMES_INFERENCE_PROVIDER = effectiveProvider;
  }

  return mergeRuntimeEnv(process.env, { ...env, ...configEnv });
}

export function normalizePaperclipApiUrl(raw) {
  const trimmed = String(raw).replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

function redactEnvForLogs(env) {
  const redacted = {};
  for (const [key, value] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) {
      redacted[key] = value ? `${String(value).slice(0, 4)}…` : '';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function isBenignHermesStderr(chunk) {
  const trimmed = String(chunk).trim();
  return (
    /^\[\d{4}-\d{2}-\d{2}T/.test(trimmed) ||
    /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) ||
    /Successfully registered all tools/i.test(trimmed) ||
    /Application initialized/i.test(trimmed) ||
    /MCP server/i.test(trimmed)
  );
}
