import type { AdapterExecutionContext, AdapterExecutionResult, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  asNumber,
  asString,
  joinPromptSections,
  parseObject,
  hydrateFreshSessionHandoff,
  selectPaperclipPromptSections,
  selectInitialCommunicationGuidance,
  isPaperclipRecoveryWakePayload,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_QODER_API_BASE_URL, DEFAULT_QODER_CLOUD_AGENTS_MODEL } from "../index.js";
import {
  QoderApiError,
  createQoderClient,
  isHttpsUrl,
  normalizeQoderApiBaseUrl,
  type QoderClient,
  type QoderFetch,
  type QoderRecord,
} from "./client.js";
import { buildInstructionsPrefix } from "./instructions.js";
import { buildRunContextNote, buildRuntimeToolsNote, isLoopbackUrl, readRuntimeTools } from "./prompt-notes.js";
import { parseHttpRepoUrl } from "./repo-url.js";
import { buildSessionEnv, fingerprintEnv, fingerprintSecret } from "./session-env.js";
import { readSession, sessionMatches, type QoderCloudAgentsSession } from "./session-state.js";
import {
  BUSY_SESSION_STATUSES,
  REDACTED,
  asRecord,
  asStringEnvMap,
  defaultSleep,
  emitStatus,
  eventLine,
  firstNonEmptyLine,
  formatRunError,
  trimNullable,
  type QoderRepo,
  type QoderSleep,
} from "./shared.js";
import { probeSession, streamTurn, waitForIdle } from "./turn-stream.js";

export { buildSessionEnv } from "./session-env.js";

export type QoderCloudAgentsExecuteDeps = {
  fetchImpl?: QoderFetch;
  sleep?: QoderSleep;
};

const ADAPTER_TYPE = "qoder_cloud_agents";

const MANAGED_AGENT_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"];

const CANCEL_CONFIRM_TIMEOUT_MS = 30_000;

const CANCEL_CONFIRM_POLL_INTERVAL_MS = 1_000;

const CANCEL_CONFIRM_MAX_POLLS = CANCEL_CONFIRM_TIMEOUT_MS / CANCEL_CONFIRM_POLL_INTERVAL_MS;

function defaultMountPath(url: URL): string {
  const name = url.pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") || "repo";
  return `/data/workspace/${name}`;
}

function buildRepoResource(repo: QoderRepo, token: string | null): QoderRecord {
  const isGitHub = new URL(repo.url).hostname.toLowerCase() === "github.com";
  return {
    type: isGitHub ? "github_repository" : "git_repository",
    url: repo.url,
    mount_path: repo.mountPath,
    ...(repo.ref ? { checkout: { type: "branch", name: repo.ref } } : {}),
    ...(token ? (isGitHub ? { authorization_token: token } : { password: token }) : {}),
  };
}

function readModelId(value: unknown): string | null {
  return trimNullable(value) ?? trimNullable(asRecord(value)?.id);
}

async function resolveEnvironmentId(client: QoderClient, configured: string | null): Promise<string> {
  if (configured) return configured;
  // A self_hosted environment needs an external worker to return tool results,
  // so only a Qoder-hosted one is a safe default.
  const existing = (await client.listEnvironments())
    .filter((entry) => !entry.archived_at && asRecord(entry.config)?.type === "cloud")
    .map((entry) => trimNullable(entry.id))
    .find((id): id is string => Boolean(id));
  if (existing) return existing;
  const created = trimNullable((await client.createEnvironment({ name: "default" })).id);
  if (!created) throw new Error("Qoder did not return an environment ID.");
  return created;
}

async function resolveManagedAgentId(
  client: QoderClient,
  agent: AdapterExecutionContext["agent"],
  model: string,
): Promise<string> {
  const metadata = {
    managed_by: "paperclip",
    paperclip_agent_id: agent.id,
    paperclip_company_id: agent.companyId,
  };
  let existing: QoderRecord | null = null;
  try {
    existing = (await client.searchAgents({ managed_by: "paperclip", paperclip_agent_id: agent.id }))
      .find((entry) => trimNullable(entry.id) && !entry.archived_at) ?? null;
  } catch (err) {
    // Search is a beta endpoint; an auth failure will also fail the create below.
    if (err instanceof QoderApiError && err.status === 401) throw err;
  }
  const existingId = trimNullable(existing?.id);
  if (existing && existingId) {
    if (readModelId(existing.model) !== model && typeof existing.version === "number") {
      await client.updateAgent(existingId, { version: existing.version, model });
    }
    return existingId;
  }
  const created = trimNullable((await client.createAgent({
    name: `Paperclip ${agent.name}`.slice(0, 256),
    model,
    system: `You are ${agent.name}, an agent managed by Paperclip. Follow the instructions in each message.`,
    tools: [{
      type: "agent_toolset_20260401",
      enabled_tools: MANAGED_AGENT_TOOLS,
      configs: MANAGED_AGENT_TOOLS.map((name) => ({ name, permission_policy: { type: "always_allow" } })),
    }],
    metadata,
  })).id);
  if (!created) throw new Error("Qoder did not return an agent ID.");
  return created;
}

function readUsage(session: QoderRecord | null): Record<string, number> | null {
  const usage = asRecord(session?.usage);
  if (!usage) return null;
  const result: Record<string, number> = {};
  for (const key of ["model_credits", "sandbox_runtime_credits", "total_credits"]) {
    if (typeof usage[key] === "number") result[key] = usage[key];
  }
  return Object.keys(result).length > 0 ? result : null;
}

export async function execute(
  ctx: AdapterExecutionContext,
  deps: QoderCloudAgentsExecuteDeps = {},
): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onDispatch } = ctx;
  const sleep = deps.sleep ?? defaultSleep;
  const billing = { provider: "qoder", biller: "qoder", billingType: "api" as const };
  const configError = (errorMessage: string): AdapterExecutionResult => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage,
    ...billing,
    clearSession: false,
  });

  const rawEnv = asStringEnvMap(config.env);
  const token = asString(rawEnv.QODER_ACCESS_TOKEN, "").trim() || asString(rawEnv.QODER_PAT, "").trim();
  if (!token) return configError("QODER_ACCESS_TOKEN is required for qoder_cloud_agents.");
  const repoToken = trimNullable(rawEnv.QODER_REPO_TOKEN);

  const workspace = parseObject(context.paperclipWorkspace);
  const repoUrlRaw = asString(config.repoUrl, "").trim() || asString(workspace.repoUrl, "").trim();
  let repo: QoderRepo | null = null;
  if (repoUrlRaw) {
    const parsed = parseHttpRepoUrl(repoUrlRaw);
    if (!parsed) {
      return configError(`qoder_cloud_agents requires an http(s) repoUrl; Qoder cannot clone "${repoUrlRaw}".`);
    }
    repo = {
      url: repoUrlRaw,
      ref: trimNullable(config.repoStartingRef) ?? trimNullable(workspace.repoRef),
      mountPath: trimNullable(config.repoMountPath) ?? defaultMountPath(parsed),
    };
  }

  const apiBaseUrl = normalizeQoderApiBaseUrl(asString(config.apiBaseUrl, ""), DEFAULT_QODER_API_BASE_URL);
  if (!isHttpsUrl(apiBaseUrl)) {
    return configError(
      `qoder_cloud_agents requires an https apiBaseUrl; refusing to send QODER_ACCESS_TOKEN to "${apiBaseUrl}".`,
    );
  }
  const configuredAgentId = trimNullable(config.qoderAgentId);
  const configuredEnvironmentId = trimNullable(config.environmentId);
  const model = asString(config.model, "").trim() || DEFAULT_QODER_CLOUD_AGENTS_MODEL;
  const timeoutSec = Math.max(0, asNumber(config.timeoutSec, 0));
  const { env: sessionEnv, dropped: droppedEnvKeys } = buildSessionEnv(ctx, rawEnv);
  const envFingerprint = fingerprintEnv(sessionEnv);
  const repoTokenFingerprint = fingerprintSecret(repoToken);

  const storedSession = readSession(runtime.sessionParams);
  const candidateSession = sessionMatches(storedSession, {
    apiBaseUrl,
    configuredAgentId,
    configuredEnvironmentId,
    model,
    repo,
    envFingerprint,
    repoTokenFingerprint,
  }) ? storedSession : null;

  const abort = new AbortController();
  let stopKind: "cancelled" | "timeout" | null = null;
  const onRunCancelled = () => {
    stopKind ??= "cancelled";
    abort.abort(new Error("Qoder Cloud Agents run was cancelled"));
  };
  const timeoutTimer = timeoutSec > 0
    ? setTimeout(() => {
        stopKind ??= "timeout";
        abort.abort(new Error(`Qoder Cloud Agents run timed out after ${timeoutSec}s`));
      }, timeoutSec * 1000)
    : null;
  const client = createQoderClient({ apiBaseUrl, token, fetchImpl: deps.fetchImpl, signal: abort.signal });

  let session: QoderCloudAgentsSession | null = candidateSession;
  let turnStarted = false;
  // Set before the send: Qoder can accept the message even when the request is
  // aborted before its response arrives.
  let turnPossiblyAccepted = false;
  const failure = (errorMessage: string, extra: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage,
    sessionId: session?.qoderSessionId ?? null,
    sessionDisplayId: session?.qoderSessionId ?? null,
    sessionParams: session,
    ...billing,
    costUsd: null,
    clearSession: false,
    ...extra,
    resultJson: {
      status: "error",
      ...(session ? { qoderSessionId: session.qoderSessionId, qoderAgentId: session.qoderAgentId } : {}),
      error: errorMessage,
      ...extra.resultJson,
    },
  });
  /** Resolves true only once Qoder reports that no turn is running on the session. */
  const cancelRemoteTurn = async (): Promise<boolean> => {
    if (!session || !turnPossiblyAccepted) return true;
    const sessionId = session.qoderSessionId;
    // The run signal is already aborted here, so confirmation needs its own deadline.
    const confirmSignal = AbortSignal.timeout(CANCEL_CONFIRM_TIMEOUT_MS);
    try {
      await client.cancelSession(sessionId);
      for (let poll = 0; poll < CANCEL_CONFIRM_MAX_POLLS; poll += 1) {
        const status = trimNullable((await client.getSession(sessionId, confirmSignal)).status);
        if (!status || !BUSY_SESSION_STATUSES.has(status)) return true;
        await sleep(CANCEL_CONFIRM_POLL_INTERVAL_MS, confirmSignal);
      }
      throw new Error("the session still reports a running turn");
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Warning: could not confirm that the turn on Qoder session ${sessionId} stopped: ${formatRunError(err)}\n`,
      );
      return false;
    }
  };

  try {
    if (ctx.signal) {
      await ctx.onCancellationReady?.();
      if (ctx.signal.aborted) onRunCancelled();
      else ctx.signal.addEventListener("abort", onRunCancelled, { once: true });
    }
    abort.signal.throwIfAborted();

    // This adapter has no local child process, so crossing into the first
    // Qoder request is its dispatch boundary.
    onDispatch?.();
    // A stored session decides resumed-versus-fresh prompt content, so confirm
    // Qoder still has it before rendering the prompt.
    const liveStatus = candidateSession ? await probeSession(client, candidateSession.qoderSessionId) : null;
    const canReuseSession = Boolean(candidateSession && liveStatus);
    if (!canReuseSession) session = null;

    const promptTemplate = asString(config.promptTemplate, context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
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
    const instructions = await buildInstructionsPrefix(config, onLog);
    await hydrateFreshSessionHandoff(ctx, { resumedSession: canReuseSession });
    const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
      resumedSession: canReuseSession,
      includeCommunicationGuidance: false,
    });
    const renderedBootstrapPrompt =
      !canReuseSession && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const renderedPrompt =
      (canReuseSession && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : renderTemplate(promptTemplate, templateData).trim();
    const runtimeTools = readRuntimeTools(ctx);
    // A loopback Paperclip URL is unreachable from Qoder, so the token would be exposed for nothing.
    const runtimeToolsReachable = Boolean(runtimeTools && !isLoopbackUrl(runtimeTools.rest.connectionsSearch));
    const prompt = joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession: canReuseSession }),
      instructions.prefix,
      renderedBootstrapPrompt,
      wakePrompt,
      taskContextNote,
      buildRunContextNote(ctx, sessionEnv, repo),
      runtimeTools && runtimeToolsReachable ? buildRuntimeToolsNote(runtimeTools) : "",
      renderedPrompt,
    ]);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const finalPrompt = joinPromptSections([prompt, sessionHandoffNote]);

    if (droppedEnvKeys.length > 0) {
      await onLog(
        "stderr",
        `[paperclip] Warning: Qoder session env limits rejected these variables; they were not forwarded: ${droppedEnvKeys.join(", ")}\n`,
      );
    }
    if (onMeta) {
      const meta: AdapterInvocationMeta = {
        adapterType: ADAPTER_TYPE,
        command: "qoder-cloud-agents-api",
        commandNotes: [
          ...instructions.notes,
          canReuseSession
            ? `Reusing Qoder session ${candidateSession?.qoderSessionId ?? "unknown"}`
            : "Creating a new Qoder session",
          `Qoder API: ${apiBaseUrl}`,
          repo ? `Repository: ${repo.url}${repo.ref ? ` @ ${repo.ref}` : ""} -> ${repo.mountPath}` : "Repository: none",
          ...(droppedEnvKeys.length > 0 ? [`Env vars not forwarded: ${droppedEnvKeys.join(", ")}`] : []),
          ...(runtimeTools
            ? [runtimeToolsReachable
                ? "Paperclip connection tools: sent in the prompt for this run"
                : "Paperclip connection tools: not sent, because the Paperclip API URL is a loopback address Qoder cannot reach"]
            : []),
        ],
        // The run log must not keep the run-scoped connection token.
        prompt: runtimeTools ? finalPrompt.split(runtimeTools.bearerToken).join(REDACTED) : finalPrompt,
        promptMetrics: {
          promptChars: finalPrompt.length,
          instructionsChars: instructions.chars,
          bootstrapPromptChars: renderedBootstrapPrompt.length,
          wakePromptChars: wakePrompt.length,
          taskContextChars: taskContextNote.length,
          heartbeatPromptChars: renderedPrompt.length,
        },
        context: {
          qoderCloudAgents: {
            apiBaseUrl,
            qoderAgentId: configuredAgentId,
            environmentId: configuredEnvironmentId,
            repoUrl: repo?.url ?? null,
            repoRef: repo?.ref ?? null,
            canReuseSession,
          },
        },
      };
      await onMeta(meta);
    }

    if (session && liveStatus && BUSY_SESSION_STATUSES.has(liveStatus)) {
      // Qoder rejects a new user.message with 409 while a turn is in flight.
      await emitStatus(onLog, "running", `Waiting for the prior turn on Qoder session ${session.qoderSessionId} to finish.`);
      await waitForIdle(client, session.qoderSessionId, sleep, abort.signal);
    }

    if (!session) {
      const environmentId = await resolveEnvironmentId(client, configuredEnvironmentId);
      const qoderAgentId = configuredAgentId ?? await resolveManagedAgentId(client, agent, model);
      const created = await client.createSession({
        agent: qoderAgentId,
        environment_id: environmentId,
        title: `Paperclip ${agent.name}`.slice(0, 256),
        metadata: { paperclip_agent_id: agent.id, paperclip_company_id: agent.companyId },
        ...(Object.keys(sessionEnv).length > 0 ? { environment_variables: sessionEnv } : {}),
        ...(repo ? { resources: [buildRepoResource(repo, repoToken)] } : {}),
      });
      const qoderSessionId = trimNullable(created.id);
      if (!qoderSessionId) throw new Error("Qoder did not return a session ID.");
      session = {
        qoderSessionId,
        qoderAgentId,
        managedAgent: !configuredAgentId,
        environmentId,
        environmentAutoSelected: !configuredEnvironmentId,
        apiBaseUrl,
        ...(configuredAgentId ? {} : { model }),
        ...(repo ? { repoUrl: repo.url, repoMountPath: repo.mountPath, ...(repo.ref ? { repoRef: repo.ref } : {}) } : {}),
        envFingerprint,
        ...(repo && repoTokenFingerprint ? { repoTokenFingerprint } : {}),
      };
    }
    const activeSession = session;
    const reportedModel = activeSession.managedAgent ? model : null;

    const userMessage = { type: "user.message", content: [{ type: "text", text: finalPrompt }] };
    let sent: QoderRecord[];
    turnPossiblyAccepted = true;
    try {
      sent = await client.sendEvents(activeSession.qoderSessionId, [userMessage]);
    } catch (err) {
      if (!(err instanceof QoderApiError) || err.status !== 409) throw err;
      // Another turn started between the probe and the send.
      await waitForIdle(client, activeSession.qoderSessionId, sleep, abort.signal);
      sent = await client.sendEvents(activeSession.qoderSessionId, [userMessage]);
    }
    turnStarted = true;
    await onLog("stdout", eventLine({
      type: "qoder_cloud_agents.init",
      sessionId: activeSession.qoderSessionId,
      agentId: activeSession.qoderAgentId,
      ...(reportedModel ? { model: reportedModel } : {}),
    }));
    await emitStatus(onLog, "running", `Started a turn on Qoder session ${activeSession.qoderSessionId}.`);

    const outcome = await streamTurn({
      client,
      sessionId: activeSession.qoderSessionId,
      turnEventId: sent.map((event) => trimNullable(event.id)).filter(Boolean).pop() ?? null,
      onLog,
      sleep,
      signal: abort.signal,
    });

    const succeeded = outcome.kind === "idle" && outcome.stopReason === "end_turn";
    if (outcome.kind === "idle" && outcome.stopReason === "requires_action") {
      // A pending action never times out, so clear it or the session stays blocked.
      await cancelRemoteTurn();
    }
    let usage: Record<string, number> | null = null;
    try {
      usage = readUsage(await client.getSession(activeSession.qoderSessionId));
    } catch {
      // Usage is informational; the turn outcome is already known.
    }

    const errorMessage = succeeded
      ? null
      : outcome.kind === "terminated"
        ? `Qoder session ${activeSession.qoderSessionId} was terminated.`
        : outcome.awaitingToolWorker
          ? `Qoder allowed a tool call but nothing executed it: environment ${activeSession.environmentId} appears to be self-hosted with no worker returning tool results. Set environmentId to a Qoder-hosted (cloud) environment.`
          : outcome.stopReason === "requires_action"
            ? "Qoder turn stopped waiting for tool confirmation, which Paperclip cannot answer. Set the Qoder agent's tool permission policies to always_allow."
            : outcome.lastError ?? `Qoder turn ended with stop reason "${outcome.stopReason ?? "unknown"}".`;
    await onLog("stdout", eventLine({
      type: "qoder_cloud_agents.result",
      status: succeeded ? "finished" : "error",
      ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
      ...(outcome.lastMessage ? { result: outcome.lastMessage } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(usage ? { usage } : {}),
    }));

    const terminated = outcome.kind === "terminated";
    return {
      exitCode: succeeded ? 0 : 1,
      signal: null,
      timedOut: false,
      errorMessage,
      sessionId: terminated ? null : activeSession.qoderSessionId,
      sessionDisplayId: terminated ? null : activeSession.qoderSessionId,
      sessionParams: terminated ? null : activeSession,
      ...billing,
      model: reportedModel,
      costUsd: null,
      summary: outcome.lastMessage ? firstNonEmptyLine(outcome.lastMessage) : null,
      resultJson: {
        status: succeeded ? "finished" : "error",
        qoderSessionId: activeSession.qoderSessionId,
        qoderAgentId: activeSession.qoderAgentId,
        environmentId: activeSession.environmentId,
        ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
        ...(outcome.lastMessage ? { result: outcome.lastMessage } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
        // Session-cumulative credits snapshot, not this run's delta.
        ...(usage ? { qoderSessionUsage: usage } : {}),
      },
      clearSession: terminated,
    };
  } catch (err) {
    if (stopKind) {
      const remoteStopped = await cancelRemoteTurn();
      const timedOut = stopKind === "timeout";
      const message = `${timedOut
        ? `Qoder Cloud Agents run timed out after ${timeoutSec}s`
        : "Qoder Cloud Agents run was cancelled"}${remoteStopped
        ? ""
        : `, but Paperclip could not confirm that the turn on Qoder session ${session?.qoderSessionId ?? "unknown"} stopped`}`;
      if (turnStarted) {
        await onLog("stdout", eventLine({ type: "qoder_cloud_agents.result", status: "error", error: message }));
      }
      return failure(message, {
        timedOut,
        ...(timedOut ? {} : { exitCode: null, errorCode: "cancelled" }),
        resultJson: {
          qoderTurnStopped: remoteStopped,
          // Only a confirmed stop may release the run for continuation.
          ...(!timedOut && remoteStopped
            ? { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } }
            : {}),
        },
      });
    }
    const error = formatRunError(err);
    const reason = err instanceof QoderApiError && err.status === 401
      ? `${error} Check that QODER_ACCESS_TOKEN is valid for ${apiBaseUrl}; service account tokens expire after at most 12 hours.`
      : error;
    // Paperclip stops collecting here, so the remote turn must not keep running
    // tools and spending credits. An auth or missing-session error cannot be cancelled.
    const cancellable = !(err instanceof QoderApiError && [401, 403, 404].includes(err.status));
    const remoteStopped = turnPossiblyAccepted && cancellable ? await cancelRemoteTurn() : true;
    const message = remoteStopped
      ? reason
      : `${reason} Paperclip could not confirm that the turn on Qoder session ${session?.qoderSessionId ?? "unknown"} stopped.`;
    if (turnStarted) {
      await onLog("stdout", eventLine({ type: "qoder_cloud_agents.result", status: "error", error: message }));
    }
    return failure(message, turnPossiblyAccepted && cancellable ? { resultJson: { qoderTurnStopped: remoteStopped } } : {});
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    ctx.signal?.removeEventListener("abort", onRunCancelled);
  }
}
