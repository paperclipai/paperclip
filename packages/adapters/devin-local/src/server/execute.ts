import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from '@paperclipai/adapter-utils';
import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
  renderPaperclipWakePrompt,
  redactEnvForLogs,
  joinPromptSections,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  readPaperclipIssueWorkModeFromContext,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
} from '@paperclipai/adapter-utils/server-utils';
import { readResumeBaseline, resolveRunUsageAndCost } from './usage.js';
import { devinCliEnv } from './env.js';
import { resolveDevinModelUid } from './models.js';
import {
  describeDevinFailure,
  extractDevinAnswer,
  isDevinUnknownSessionError,
} from './parse.js';
import { ensureDevinSkillsInjected } from './skills.js';

function hasNonEmptyEnvValue(
  env: Record<string, string>,
  key: string,
): boolean {
  const raw = env[key];
  return typeof raw === 'string' && raw.trim().length > 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

/**
 * List the PAPERCLIP_* env vars available to the run so the agent knows they are
 * present. Returns "" when no PAPERCLIP_* vars are set.
 */
function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith('PAPERCLIP_'))
    .sort();
  if (paperclipKeys.length === 0) return '';
  return [
    'Paperclip runtime note:',
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(', ')}`,
    'Do not assume these variables are missing without checking your shell environment.',
    '',
    '',
  ].join('\n');
}

/**
 * Teach the agent to drive its own Paperclip issue via the Paperclip API with
 * plain `curl` (Devin runs a normal shell). Returns "" when the API URL/key
 * are absent.
 */
function renderApiAccessNote(env: Record<string, string>): string {
  if (
    !hasNonEmptyEnvValue(env, 'PAPERCLIP_API_URL') ||
    !hasNonEmptyEnvValue(env, 'PAPERCLIP_API_KEY')
  )
    return '';
  return [
    'Paperclip API access note:',
    'Use curl to make Paperclip API requests.',
    'GET example:',
    '  curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/agents/me"',
    'POST/PATCH example:',
    `  curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H 'Content-Type: application/json' -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -d '{...}' "$PAPERCLIP_API_URL/api/issues/{id}/checkout"`,
    '',
    '',
  ].join('\n');
}

/**
 * Assemble the run prompt: an optional bootstrap preamble, wake context,
 * session handoff, runtime + API notes, and the rendered task template. Pure +
 * exported so it is unit-testable without spawning the Devin CLI.
 */
export function buildDevinPrompt(opts: {
  instructionsPrefix: string;
  promptTemplate: string;
  bootstrapPromptTemplate: string;
  templateData: Record<string, unknown>;
  wake: unknown;
  sessionHandoffMarkdown: string;
  env: Record<string, string>;
  resumeSessionId: string | null;
}): { prompt: string; promptMetrics: Record<string, number> } {
  const {
    instructionsPrefix,
    promptTemplate,
    bootstrapPromptTemplate,
    templateData,
    wake,
    sessionHandoffMarkdown,
    env,
    resumeSessionId,
  } = opts;

  const renderedBootstrapPrompt =
    bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : '';
  const wakePrompt = renderPaperclipWakePrompt(wake, {
    resumedSession: Boolean(resumeSessionId),
  });
  const shouldUseResumeDeltaPrompt =
    Boolean(resumeSessionId) && wakePrompt.length > 0;
  const renderedPrompt =
    shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(wake)
      ? ''
      : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = sessionHandoffMarkdown.trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    paperclipEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };
  return { prompt, promptMetrics };
}

/**
 * Inject the standard Paperclip wake context env vars so Devin runs receive
 * the same signal about why they woke (task, comment, approval, linked issues,
 * batched payload). Returns the resolved task/comment ids for reuse in prompt +
 * meta context.
 */
function injectWakeEnv(
  env: Record<string, string>,
  context: Record<string, unknown>,
): { issueId: string; wakeCommentId: string } {
  const str = (...vals: unknown[]): string => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    return '';
  };

  const issueId =
    str(context.taskId, context.issueId) || env.PAPERCLIP_TASK_ID || '';
  const wakeReason = str(context.wakeReason);
  const wakeCommentId =
    str(context.wakeCommentId, context.commentId) ||
    env.PAPERCLIP_WAKE_COMMENT_ID ||
    '';
  const approvalId = str(context.approvalId);
  const approvalStatus = str(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter(
        (v): v is string => typeof v === 'string' && v.trim().length > 0,
      )
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (issueId) env.PAPERCLIP_TASK_ID = issueId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0)
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(',');
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  return { issueId, wakeCommentId };
}

function parseAtifSessionId(atifPath: string): string | null {
  try {
    const raw = readFileSync(atifPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sessionId =
      typeof parsed.session_id === 'string' ? parsed.session_id : null;
    return sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, config, agent, runtime, context, onMeta, authToken } = ctx;
  const onLog = ctx.onLog ?? (async () => {});

  const command = asString(config.command, 'devin');
  const cwd = asString(config.cwd, homedir() || '/tmp');
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  await ensureDevinSkillsInjected(config, onLog);

  const modelSelection = asString(config.model, '');
  // Exactly the key the board writes (AgentConfigForm maps the native
  // thinking-effort control to adapterConfig.thinkingEffort for devin_local).
  // No aliases: unknown keys are ignored, never guessed (spec D-4).
  const thinkingEffort = asString(config.thinkingEffort, '') || 'auto';
  const contextSize = asString(config.contextSize, 'default');
  const fastMode = asBoolean(config.fastMode, false);
  const priority = asBoolean(config.priority, false);
  const sandbox = asBoolean(config.sandbox, false);
  const respectWorkspaceTrust = asBoolean(config.respectWorkspaceTrust, false);
  let clearSession = false;

  let model = '';
  if (modelSelection) {
    try {
      model = await resolveDevinModelUid(
        {
          model: modelSelection,
          effort: thinkingEffort,
          contextSize,
          fast: fastMode,
          priority,
        },
        command,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await onLog('stderr', `[adapter] ${message}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        provider: 'devin',
        biller: 'devin',
        billingType: null,
        model: null,
        usage: undefined,
        usageBasis: null,
        costUsd: null,
        resultJson: null,
        sessionParams: null,
        sessionDisplayId: null,
        summary: null,
        clearSession,
        errorMessage: message,
      };
    }
  }

  // Mirror the CLI instead of adjudicating it: pass the configured mode
  // through unchanged. The binary rejects genuinely invalid values with a
  // clear error and safely degrades rollout-gated modes (e.g. Smart falls
  // back to normal with a warning). When unset, --permission-mode is omitted
  // entirely so the CLI applies its own default (auto).
  const permissionMode = asString(config.permissionMode, '')
    .trim()
    .toLowerCase();

  const timeoutSec = clampNumber(asNumber(config.timeoutSec, 1800), 1, 86_400);
  const graceSec = clampNumber(asNumber(config.graceSec, 15), 0, 300);
  // The create path stores an array; the schema-driven edit path stores a
  // comma/space separated string. Accept both — a configured value must never
  // be silently dropped.
  const extraArgs = Array.isArray(config.extraArgs)
    ? asStringArray(config.extraArgs)
    : asString(config.extraArgs, '')
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, '');
  const exportPath = asString(config.exportPath, '');

  // Instructions bundle delivery. Devin auto-loads exactly <cwd>/AGENTS.md
  // (verified against the ATIF transcript), and there is no cross-directory
  // auto-load and no --add-dir flag. So when the effective entry file is
  // anything other than <cwd>/AGENTS.md (the common case for bundle-managed
  // agents), the adapter delivers it in the prompt: the entry content
  // prepended plus a directive naming the sibling files by directory. Devin
  // reads arbitrary absolute paths with its file tools, so no access flag is
  // needed (live-probe verified, 2026-08-28).
  const instructionsEntryFile = asString(config.instructionsEntryFile, '');
  const instructionsRootPath = asString(config.instructionsRootPath, '');
  // Mirror the platform's resolution (heartbeat.ts): an absolute entry file
  // wins outright; a relative one resolves against the root (or cwd).
  const instructionsEntry = instructionsEntryFile
    ? path.isAbsolute(instructionsEntryFile)
      ? path.resolve(instructionsEntryFile)
      : path.resolve(instructionsRootPath || cwd, instructionsEntryFile)
    : asString(config.instructionsFilePath, '');
  const autoLoadedInstructionsPath = path.join(cwd, 'AGENTS.md');
  let instructionsPrefix = '';
  if (
    instructionsEntry &&
    path.resolve(instructionsEntry) !== path.resolve(autoLoadedInstructionsPath)
  ) {
    try {
      const instructionsContents = await readFile(instructionsEntry, 'utf8');
      const instructionsDir = path.dirname(instructionsEntry);
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsEntry}. ` +
        `Resolve any relative file references from ${instructionsDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const message = `could not read configured instructions entry ${instructionsEntry}: ${reason}`;
      await onLog('stderr', `[adapter] ${message}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        provider: 'devin',
        biller: 'devin',
        billingType: null,
        model: null,
        usage: undefined,
        usageBasis: null,
        costUsd: null,
        resultJson: null,
        sessionParams: null,
        sessionDisplayId: null,
        summary: null,
        clearSession,
        errorMessage: message,
      };
    }
  }

  const env = buildPaperclipEnv({ id: agent.id, companyId: agent.companyId });
  env.PAPERCLIP_RUN_ID = runId;
  const cfgEnv =
    config.env && typeof config.env === 'object'
      ? (config.env as Record<string, unknown>)
      : {};
  for (const [k, v] of Object.entries(cfgEnv)) {
    if (v === undefined || v === null) continue;
    if (isForbiddenConfigEnvKey(k)) continue;
    if (isPaperclipRuntimeEnvKey(k) && k in env) continue;
    env[k] = String(v);
  }
  if (typeof authToken === 'string' && authToken.trim().length > 0) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const ctxBag = context as Record<string, unknown>;
  const { issueId, wakeCommentId } = injectWakeEnv(env, ctxBag);

  const resumeSessionParams =
    runtime.sessionParams && typeof runtime.sessionParams === 'object'
      ? runtime.sessionParams
      : ctxBag.resumeSessionParams &&
          typeof ctxBag.resumeSessionParams === 'object'
        ? ctxBag.resumeSessionParams
        : null;
  if (!runtime.sessionParams && ctxBag.resumeSessionParams) {
    await onLog(
      'stderr',
      '[adapter] runtime.sessionParams missing; using context.resumeSessionParams for resume\n',
    );
  }
  const storedSession = resumeSessionParams
    ? (resumeSessionParams as Record<string, unknown>)
    : null;
  const storedSessionId = storedSession
    ? asString(storedSession.sessionId, '')
    : '';
  // Resumed ATIFs are cumulative (verified live 2026-09-03): on a resume,
  // usage/cost must be computed as the delta against this baseline.
  const storedUsageBaseline = readResumeBaseline(storedSession?.resumeBaseline);
  const storedSessionCwd = storedSession ? asString(storedSession.cwd, '') : '';
  const canResume =
    storedSessionId.length > 0 &&
    (storedSessionCwd.length === 0 ||
      path.resolve(storedSessionCwd) === path.resolve(cwd));
  let resumeSessionId = canResume ? storedSessionId : null;

  const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
  if (resumeSessionId && !SESSION_ID_RE.test(resumeSessionId)) {
    await onLog(
      'stderr',
      `[adapter] invalid resume session id; clearing stale session params: ${resumeSessionId}\n`,
    );
    resumeSessionId = null;
    clearSession = true;
  }

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: 'on_demand' },
    context,
  };
  const { prompt, promptMetrics } = buildDevinPrompt({
    instructionsPrefix,
    promptTemplate,
    bootstrapPromptTemplate,
    templateData,
    wake: ctxBag.paperclipWake,
    sessionHandoffMarkdown: asString(
      context.paperclipSessionHandoffMarkdown,
      '',
    ),
    env,
    resumeSessionId,
  });

  const safeRunId = sanitizeFilename(runId);
  const promptFile = path.join(tmpdir(), `devin-prompt-${safeRunId}.txt`);
  // A configured exportPath is shared by every run of this agent; suffix it
  // with the run id so concurrent runs cannot overwrite each other's ATIF
  // (and cross-attribute session id, usage, and cost).
  const atifFile = exportPath
    ? path.join(
        path.dirname(exportPath),
        `${path.basename(exportPath, path.extname(exportPath))}-${safeRunId}${path.extname(exportPath)}`,
      )
    : path.join(tmpdir(), `devin-run-${safeRunId}.atif`);
  const atifIsTemp = !exportPath;

  try {
    // 0o600: the rendered prompt carries the instructions bundle and wake
    // payload; it must not be readable by every local account in /tmp.
    writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `failed to write prompt temp file: ${String(err).slice(0, 160)}`,
    };
  }

  // The CLI accepts --sandbox with any permission mode and coerces to
  // autonomous, printing its own warning. Always pass it when configured —
  // never silently drop containment — and log the coercion ourselves so the
  // run record shows it even if the CLI's warning changes.
  if (sandbox && permissionMode && permissionMode !== 'autonomous') {
    await onLog(
      'stderr',
      `[adapter] --sandbox always uses the autonomous permission mode; --permission-mode ${permissionMode} will be ignored by the CLI\n`,
    );
  }

  const buildArgs = (sessionId: string | null): string[] => {
    const args: string[] = [];
    args.push('--respect-workspace-trust', String(respectWorkspaceTrust));
    if (model) args.push('--model', model);
    if (sandbox) args.push('--sandbox');
    if (permissionMode) args.push('--permission-mode', permissionMode);
    args.push('--export', atifFile);
    if (sessionId) args.push('-r', sessionId);
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push('--prompt-file', promptFile, '-p');
    return args;
  };

  // Normalize PATH for the child the way every peer does, so a `devin`
  // installed in a user-local bin dir resolves under the server's sparse env.
  // devinCliEnv strips inherited session leakage (ACP_BACKEND) from the
  // server process; the run/env config overlays on top.
  const childEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...devinCliEnv(), ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );

  try {
    if (onMeta) {
      await onMeta({
        adapterType: agent.adapterType ?? 'devin_local',
        command,
        cwd,
        commandArgs: buildArgs(resumeSessionId),
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context: {
          issueId,
          wakeCommentId,
          resumedSession: Boolean(resumeSessionId),
        },
      });
    }

    const runAttempt = (sessionId: string | null, attemptTimeoutSec?: number) =>
      runChildProcess(runId, command, buildArgs(sessionId), {
        cwd,
        env: childEnv,
        timeoutSec: attemptTimeoutSec ?? timeoutSec,
        graceSec,
        onLog: (stream, chunk) => onLog(stream, chunk),
        onSpawn: ctx.onSpawn,
      });

    await ctx.onRuntimeProgress?.({
      phase: 'adapter_startup',
      message: `Starting ${command} in print mode`,
    });

    const startTimeMs = Date.now();
    const attemptedResumeId = resumeSessionId;
    let result = await runAttempt(resumeSessionId);

    if (
      resumeSessionId &&
      !result.timedOut &&
      (result.exitCode ?? 0) !== 0 &&
      isDevinUnknownSessionError(result.stdout ?? '', result.stderr ?? '')
    ) {
      await onLog(
        'stdout',
        `[adapter] resume session ${resumeSessionId} was unknown/stale; retrying fresh\n`,
      );
      const elapsedSec = Math.floor((Date.now() - startTimeMs) / 1000);
      const remainingTimeoutSec = Math.max(1, timeoutSec - elapsedSec);
      result = await runAttempt(null, remainingTimeoutSec);
      clearSession = true;
      // The fresh attempt replaces the dead id: never backfill it below.
      resumeSessionId = null;
    }

    const answer = extractDevinAnswer(result.stdout ?? '');

    // parseAtifSessionId swallows all errors internally (missing/invalid ATIF
    // yields null); no outer guard needed.
    let sessionId = parseAtifSessionId(atifFile);
    if (sessionId) {
      await onLog('stdout', `[adapter] devin session ${sessionId}\n`);
    }

    let usageAndCost: Awaited<
      ReturnType<typeof resolveRunUsageAndCost>
    > | null = null;
    try {
      usageAndCost = await resolveRunUsageAndCost({
        atifPath: atifFile,
        requestedModel: model,
        command,
        // A failed resume falls over to a fresh session (clearSession is set
        // and resumeSessionId is null above) — the baseline must not apply.
        resumeBaseline:
          attemptedResumeId && !clearSession ? storedUsageBaseline : null,
      });
      if (usageAndCost?.sessionId && usageAndCost.sessionId !== sessionId) {
        sessionId = usageAndCost.sessionId;
      }
    } catch (e) {
      await onLog(
        'stderr',
        `[adapter] usage/cost resolution error: ${String(e).slice(0, 160)}\n`,
      );
    }

    if (!sessionId && resumeSessionId) {
      // Retry may have re-used the existing session id, or the ATIF may be absent.
      sessionId = resumeSessionId;
    }

    const failed = result.exitCode !== 0 || result.timedOut;
    const failureDetail = failed
      ? describeDevinFailure(result.stdout ?? '', result.stderr ?? '')
      : null;

    // The unknown-session retry establishes a NEW session before setting
    // clearSession. Only tell the platform to forget when no usable id
    // exists; otherwise persist the replacement so the next run resumes it.
    const finalSessionId = usageAndCost?.sessionId ?? sessionId;
    const effectiveClearSession = clearSession && !finalSessionId;

    return {
      exitCode: failed ? (result.exitCode ?? 1) : 0,
      signal: result.signal,
      timedOut: result.timedOut,
      provider: 'devin',
      biller: usageAndCost?.biller ?? 'devin',
      billingType: usageAndCost?.billingType ?? null,
      model: usageAndCost?.model ?? (model || null),
      usage: usageAndCost?.usage,
      usageBasis: usageAndCost?.usageBasis ?? null,
      costUsd: usageAndCost?.costUsd ?? null,
      cacheAdjustedCostUsd: usageAndCost?.cacheAdjustedCostUsd ?? null,
      resultJson: usageAndCost?.resultJson ? usageAndCost.resultJson : null,
      // Persist the cumulative transcript totals so the NEXT resume on this
      // session can bill only its own delta (resumed ATIFs are cumulative).
      sessionParams: (() => {
        if (!finalSessionId) return null;
        const cumulative = (
          usageAndCost?.resultJson as Record<string, unknown> | undefined
        )?.devinCumulative;
        const resumeBaseline = readResumeBaseline(cumulative);
        return {
          sessionId: finalSessionId,
          cwd,
          ...(resumeBaseline ? { resumeBaseline } : {}),
        };
      })(),
      sessionDisplayId: finalSessionId,
      summary: answer ? answer.slice(0, 2000) : null,
      clearSession: effectiveClearSession,
      errorMessage: failed
        ? `devin ${result.signal ? `killed by ${result.signal}` : `exited ${result.exitCode ?? '?'}`}${result.timedOut ? ' (timed out)' : ''}${failureDetail ? `: ${failureDetail}` : ''}`
        : null,
    };
  } finally {
    // Temp-file hygiene holds even when the run throws mid-flight: the prompt
    // file contains the full rendered prompt and the temp ATIF the transcript.
    try {
      rmSync(promptFile, { force: true });
    } catch {
      // ignore cleanup failure
    }
    if (atifIsTemp) {
      try {
        rmSync(atifFile, { force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  }
}
