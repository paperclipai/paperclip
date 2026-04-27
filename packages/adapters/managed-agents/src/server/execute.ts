import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  DelegationRequest,
} from "@paperclipai/adapter-utils";
import {
  buildCornerstoneToolSpecs,
  isCornerstoneToolName,
} from "./cornerstone-tool-specs.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  createAgent,
  createEnvironment,
  createSession,
  getSession,
  listEvents,
  postUserMessage,
  postCustomToolResult,
  fetchCornerstoneContext,
  cookbookGetSkill,
  cookbookListSkills,
  type MaEvent,
  type MaCustomToolSpec,
  type CookbookSkillDetail,
} from "./client.js";
import { renderSystemPrompt, renderUserTurn } from "./prompt.js";
import { calcRuntimeCostUsd, calcTokenCostUsd } from "./cost.js";
import { cacheGet, cachePut } from "./cache.js";

// Structured stdout logger. Single-line JSON so Cloud Run's logging agent
// promotes `severity` and other fields into the log entry. Intentionally
// bypasses ctx.onLog because ctx.onLog writes to the per-run local_file log
// store (ephemeral — gone when the container scales down). console.log hits
// Cloud Run stdout which Cloud Logging captures durably. Added 2026-04-24
// after Ada's synthesis failure (run 5fc47c80) could not be diagnosed because
// every adapter-level event was trapped in a local_file log we couldn't read.
function maDbg(
  event: string,
  fields: Record<string, unknown> = {},
  severity: "DEBUG" | "INFO" | "WARNING" | "ERROR" = "INFO",
): void {
  try {
    console.log(
      JSON.stringify({
        severity,
        adapter: "managed_agents",
        event,
        ts: new Date().toISOString(),
        ...fields,
      }),
    );
  } catch {
    // Never let a logging failure break the adapter.
  }
}

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

// Paperclip injects desired skills in two shapes at runtime:
//   (a) cfg.paperclipRuntimeSkills — object array from companySkills.listRuntimeSkillEntries
//       (keys: key, runtimeName, required, source, …). Only non-empty when the
//       skill exists in the company_skills table.
//   (b) cfg.paperclipSkillSync.desiredSkills — plain string array, written by
//       POST /agents/:id/skills/sync via writePaperclipSkillSyncPreference.
// We union both so a skill can be injected without a company_skills row
// (spike mock path) and the normal runtime-entries path still works.
function collectRequestedSkillNames(cfg: Record<string, unknown>): string[] {
  const names: string[] = [];
  const runtime = cfg.paperclipRuntimeSkills;
  if (Array.isArray(runtime)) {
    for (const entry of runtime) {
      if (typeof entry === "string" && entry.trim()) {
        names.push(entry.trim());
      } else if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        const key = typeof rec.key === "string" ? rec.key.trim() : "";
        const runtimeName = typeof rec.runtimeName === "string" ? rec.runtimeName.trim() : "";
        if (key) names.push(key);
        else if (runtimeName) names.push(runtimeName);
      }
    }
  }
  const sync = cfg.paperclipSkillSync;
  if (sync && typeof sync === "object" && !Array.isArray(sync)) {
    const desired = (sync as Record<string, unknown>).desiredSkills;
    if (Array.isArray(desired)) {
      for (const value of desired) {
        if (typeof value === "string" && value.trim()) names.push(value.trim());
      }
    }
  }
  return Array.from(new Set(names));
}

async function getCornerstoneContextCached(
  memoryKey: string,
  namespace: string,
  query: string,
): Promise<string> {
  const hit = cacheGet<string>(namespace, query);
  if (hit !== null) return hit;
  try {
    const res = await fetchCornerstoneContext(memoryKey, {
      query,
      namespace,
      detailLevel: "minimal",
      maxTokens: 2000,
    });
    const out = res.context ?? "";
    cachePut(namespace, query, out);
    return out;
  } catch (err) {
    // Non-fatal — memory is optional, log and continue.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[managed_agents] Cornerstone fetch failed: ${msg}`);
    return "";
  }
}

async function fetchSkillBodies(
  memoryKey: string,
  names: string[],
): Promise<CookbookSkillDetail[]> {
  if (names.length === 0) return [];
  // Use allSettled — a missing/forbidden skill should not drop the ones that
  // DID resolve (e.g. spike-fixture under COOKBOOK_MOCK_MODE alongside other
  // runtime-entry names the mock doesn't know about).
  const results = await Promise.all(
    names.map(async (n): Promise<CookbookSkillDetail | null> => {
      try {
        const detail = await cookbookGetSkill(memoryKey, n);
        // Cookbook MCP responds 200 with an empty payload for unknown skills
        // rather than erroring; drop anything without usable content so
        // renderSystemPrompt doesn't blow up on undefined fields.
        if (!detail || typeof detail.content !== "string" || detail.content.trim().length === 0) {
          return null;
        }
        if (typeof detail.name !== "string" || detail.name.length === 0) {
          return null;
        }
        return detail;
      } catch (err) {
        console.warn(
          `[managed_agents] Cookbook get_skill("${n}") failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }),
  );
  return results.filter((s): s is CookbookSkillDetail => s !== null);
}

// Wait for session to return to idle after posting a user.message.
// Polls GET /v1/sessions/{id}/events every 500ms up to timeoutMs.
// Streams new events to ctx.onLog as they appear.
// When a custom tool use is detected and a handler is provided, the tool is
// dispatched inline and its result is posted back to the session so the loop
// can continue past the next idle. Events already seen by an earlier cycle
// (e.g. a `session.status_idle` raised before the tool result was posted) are
// ignored via `seenIds` so they don't falsely terminate the outer loop.
type CustomToolHandler = (ev: MaEvent) => Promise<void>;

// Sentinel error class so callers can distinguish abort-driven exits from
// timeout-driven exits without parsing message strings.
export class WaitForIdleAbortedError extends Error {
  readonly code = "aborted";
  constructor(sessionId: string) {
    super(`Session ${sessionId} polling aborted`);
    this.name = "WaitForIdleAbortedError";
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function waitForIdle(
  apiKey: string,
  sessionId: string,
  seenIds: Set<string>,
  onEvent: (ev: MaEvent) => Promise<void>,
  timeoutMs: number,
  onCustomTool?: CustomToolHandler,
  abortSignal?: AbortSignal,
): Promise<MaEvent[]> {
  const start = Date.now();
  const allNew: MaEvent[] = [];
  let iter = 0;
  maDbg("waitForIdle_start", { sessionId, timeoutMs, seenIdsAtEntry: seenIds.size, hasAbortSignal: Boolean(abortSignal) });
  if (abortSignal?.aborted) {
    throw new WaitForIdleAbortedError(sessionId);
  }
  while (Date.now() - start < timeoutMs) {
    if (abortSignal?.aborted) {
      maDbg("waitForIdle_aborted", {
        sessionId,
        iter,
        totalNewEvents: allNew.length,
        elapsedMs: Date.now() - start,
      });
      throw new WaitForIdleAbortedError(sessionId);
    }
    iter += 1;
    const cycleStart = Date.now();
    const { data } = await listEvents(apiKey, sessionId);
    const beforeSeen = seenIds.size;
    let pendingCustomTool = false;
    let sawTerminalThisCycle = false;
    let sawStatusIdle = false;
    let sawStatusTerminated = false;
    let lastIdleStopReason: string | null = null;
    for (const ev of data) {
      if (seenIds.has(ev.id)) continue;
      seenIds.add(ev.id);
      allNew.push(ev);
      // Log every MA session state transition directly to Cloud Run stdout so
      // H1-class failures (session terminated before we post a tool_result)
      // are visible in logs. The ctx.onLog callback separately captures events
      // in the heartbeat_run's log_store, but that's local_file and ephemeral.
      if (ev.type === "session.status_idle") {
        sawStatusIdle = true;
        lastIdleStopReason = ev.stop_reason?.type ?? null;
        maDbg("ma_session_idle", {
          sessionId,
          evId: ev.id,
          stopReason: lastIdleStopReason,
          iter,
        });
      } else if (ev.type === "session.status_terminated") {
        sawStatusTerminated = true;
        maDbg(
          "ma_session_terminated",
          {
            sessionId,
            evId: ev.id,
            iter,
            processedAt: ev.processed_at ?? null,
            rawFields: Object.keys(ev),
          },
          "WARNING",
        );
      } else if (ev.type === "agent.stop") {
        maDbg("ma_agent_stop", {
          sessionId,
          evId: ev.id,
          iter,
          rawFields: Object.keys(ev),
        });
      } else if (ev.type === "agent.custom_tool_use") {
        maDbg("ma_custom_tool_use", {
          sessionId,
          evId: ev.id,
          iter,
          toolName: typeof ev.name === "string" ? ev.name : null,
        });
      }
      await onEvent(ev);
      if (ev.type === "agent.custom_tool_use" && onCustomTool) {
        await onCustomTool(ev);
        pendingCustomTool = true;
      }
      if (
        ev.type === "session.status_idle" ||
        ev.type === "session.status_terminated"
      ) {
        sawTerminalThisCycle = true;
      }
    }
    const newThisCycle = seenIds.size - beforeSeen;
    // `session.status_idle` with stop_reason="requires_action" is NOT terminal:
    // it means the model has emitted a tool_use block and is waiting for the
    // tool result. The next `agent.custom_tool_use` event may not be in the
    // stream yet (race between status emission and tool_use event write), so
    // we keep polling. Only end_turn / max_tokens / stop_sequence / tool-less
    // pauses are real terminal states. Verified empirically 2026-04-24 via
    // Ada session sesn_011CaPRJPSkKLhPzTo4i5q9R: get_context returned ok,
    // post_tool_result_ok 434ms, then status_idle{requires_action} fired
    // before the next custom_tool_use landed → adapter exited prematurely
    // with reason=terminal_no_pending_tool, h1Detected=true.
    const isHardTerminal =
      sawStatusTerminated ||
      (sawStatusIdle && lastIdleStopReason !== "requires_action");
    maDbg("waitForIdle_iter", {
      sessionId,
      iter,
      eventsReturned: data.length,
      newThisCycle,
      sawStatusIdle,
      sawStatusTerminated,
      lastIdleStopReason,
      pendingCustomTool,
      sawTerminalThisCycle,
      isHardTerminal,
      cycleMs: Date.now() - cycleStart,
      elapsedMs: Date.now() - start,
    });
    if (isHardTerminal && !pendingCustomTool) {
      maDbg("waitForIdle_return", {
        sessionId,
        reason: "terminal_no_pending_tool",
        iter,
        totalNewEvents: allNew.length,
        elapsedMs: Date.now() - start,
      });
      return allNew;
    }
    await abortableSleep(500, abortSignal);
  }
  maDbg(
    "waitForIdle_timeout",
    {
      sessionId,
      iter,
      totalNewEvents: allNew.length,
      elapsedMs: Date.now() - start,
      timeoutMs,
    },
    "ERROR",
  );
  throw new Error(`Session ${sessionId} did not reach idle within ${timeoutMs}ms`);
}

const DELEGATE_TASK_TOOL_NAME = "delegate_task";

function buildDelegateTaskToolSpec(): MaCustomToolSpec {
  return {
    name: DELEGATE_TASK_TOOL_NAME,
    description:
      "Delegate a unit of work to one of your direct reports. Creates an issue assigned to the named agent and (if wait=true) blocks until the child run finishes, returning its final output. Only direct reports can be assignees. Nested delegation requires the assignee to have canDelegate permission.",
    input_schema: {
      type: "object",
      properties: {
        assignee_agent_name: {
          type: "string",
          description: "Name of a direct-report agent (case-insensitive).",
        },
        title: {
          type: "string",
          description: "Short issue title for the delegated task (< 160 chars).",
        },
        description: {
          type: "string",
          description: "Full task description / prompt body for the assignee.",
        },
        wait: {
          type: "boolean",
          description: "If true (default), block until the child run completes or times out. Default true.",
        },
        timeout_seconds: {
          type: "integer",
          description: "Upper bound in seconds before returning status=timeout. Default 3600 (range 60-14400).",
        },
      },
      required: ["assignee_agent_name", "title", "description"],
    },
  };
}

function parseDelegateTaskInput(raw: unknown): DelegationRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "input must be an object" };
  const rec = raw as Record<string, unknown>;
  const assignee = rec.assignee_agent_name;
  const title = rec.title;
  const description = rec.description;
  if (typeof assignee !== "string" || assignee.trim().length === 0) {
    return { error: "assignee_agent_name is required" };
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    return { error: "title is required" };
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    return { error: "description is required" };
  }
  const wait = typeof rec.wait === "boolean" ? rec.wait : true;
  const timeout =
    typeof rec.timeout_seconds === "number" && rec.timeout_seconds > 0
      ? Math.floor(rec.timeout_seconds)
      : 3600;
  return {
    assigneeAgentName: assignee.trim(),
    title: title.trim().slice(0, 200),
    description,
    waitForCompletion: wait,
    timeoutSeconds: Math.min(Math.max(timeout, 60), 14400),
  };
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "ANTHROPIC_API_KEY_MISSING",
      errorMessage: "ANTHROPIC_API_KEY not set on the Paperclip server",
    };
  }
  const cornerstoneKey =
    process.env.CORNERSTONE_API_KEY ?? process.env.MEMORY_API_KEY ?? "";
  // Prefer the OAuth-minted bridge token (set post-spike). Fall back to the
  // legacy API key envs so the mock path and older deploys keep working.
  const cookbookKey =
    process.env.COOKBOOK_ACCESS_TOKEN ??
    process.env.COOKBOOK_API_KEY ??
    process.env.MEMORY_API_KEY ??
    "";

  const cfg = ctx.config as Record<string, unknown>;
  const role = readString(cfg.role) ?? "A helpful Paperclip workforce agent.";
  const model = readString(cfg.model) ?? "claude-haiku-4-5-20251001";
  const namespace = readString(cfg.cornerstoneNamespace) ?? "default";
  const outputFormat = readString(cfg.outputFormat) ?? undefined;
  // Default raised from 600s → 1800s on 2026-04-25 to support long-running
  // agent sessions (e.g. Grace's audit work). Cancellation is now handled via
  // ctx.abortSignal — heartbeat.cancelRunInternal aborts the controller so
  // operators can stop a run mid-flight without waiting for the natural cap.
  const timeoutSec =
    typeof cfg.timeoutSec === "number" && cfg.timeoutSec > 0 ? cfg.timeoutSec : 1800;
  const requestedSkillNames = collectRequestedSkillNames(cfg);
  await ctx.onLog(
    "stdout",
    JSON.stringify({
      managed_agents_debug: "skill_request",
      cfgKeys: Object.keys(cfg),
      hasPaperclipSkillSync: Boolean(cfg.paperclipSkillSync),
      hasPaperclipRuntimeSkills: Boolean(cfg.paperclipRuntimeSkills),
      requestedSkillNames,
      cookbookKeyPresent: Boolean(cookbookKey),
      cookbookMockMode: process.env.COOKBOOK_MOCK_MODE === "true",
    }) + "\n",
  );

  // Task body comes in via ctx.context.taskBody per paperclip convention.
  // For issue_assigned / comment-driven wakeups the harness does not populate
  // taskBody directly — it provides ctx.context.paperclipWake which every
  // other adapter renders via renderPaperclipWakePrompt. Fall back to that so
  // managed_agents runs on assignment wakeups behave like the others.
  const taskCtx = ctx.context as Record<string, unknown>;
  const explicitTaskBody =
    readString(taskCtx.taskBody) ??
    readString(taskCtx.body) ??
    readString(taskCtx.prompt);
  const wakePrompt = renderPaperclipWakePrompt(taskCtx.paperclipWake, {
    resumedSession: Boolean(readString((ctx.runtime.sessionParams ?? {}).sessionId)),
  });
  const taskBody = explicitTaskBody ?? (wakePrompt.trim().length > 0 ? wakePrompt : "");
  const taskKey = readString(taskCtx.taskKey) ?? ctx.runtime.taskKey ?? null;

  if (!taskBody) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "MISSING_TASK_BODY",
      errorMessage: "ctx.context did not include a taskBody / body / prompt / paperclipWake",
    };
  }

  const existing = ctx.runtime.sessionParams ?? {};
  let agentId = readString(existing.agentId) ?? readString(cfg.agentId);
  let agentVersion: number | undefined =
    typeof existing.agentVersion === "number" ? existing.agentVersion : undefined;
  let environmentId = readString(existing.environmentId) ?? readString(cfg.environmentId);
  let sessionId = readString(existing.sessionId);

  await ctx.onMeta?.({
    adapterType: "managed_agents",
    command: "managed-agents-api",
    context: {
      model,
      role,
      namespace,
      taskKey,
      reuseAgent: Boolean(agentId),
      reuseEnv: Boolean(environmentId),
    },
  });

  // ---------------------------------------------------------------
  // Parallel: (1) fetch Cornerstone memory context, (2) ensure agent + env exist
  // ---------------------------------------------------------------
  const cornerstoneQuery = `${role}: ${taskBody.slice(0, 200)}`;

  const [cornerstoneContext, skills, resolvedAgent, resolvedEnv] = await Promise.all([
    cornerstoneKey
      ? getCornerstoneContextCached(cornerstoneKey, namespace, cornerstoneQuery)
      : Promise.resolve(""),
    cookbookKey ? fetchSkillBodies(cookbookKey, requestedSkillNames) : Promise.resolve([]),
    agentId
      ? Promise.resolve({ id: agentId, version: agentVersion ?? 1 })
      : (async () => {
          const customToolsList: MaCustomToolSpec[] = [
            ...(ctx.delegateTask ? [buildDelegateTaskToolSpec()] : []),
            ...(ctx.cornerstoneTools ? buildCornerstoneToolSpecs() : []),
          ];
          const customTools = customToolsList.length > 0 ? customToolsList : undefined;
          const a = await createAgent(apiKey, {
            name: `paperclip-${ctx.agent.companyId.slice(0, 8)}-${ctx.agent.id.slice(0, 8)}`,
            model,
            system: "bootstrap",
            customTools,
          });
          return { id: a.id, version: a.version };
        })(),
    environmentId
      ? Promise.resolve({ id: environmentId })
      : (async () => {
          const e = await createEnvironment(apiKey, `paperclip-${ctx.agent.id.slice(0, 8)}`);
          return { id: e.id };
        })(),
  ]);

  agentId = resolvedAgent.id;
  agentVersion = resolvedAgent.version;
  environmentId = resolvedEnv.id;

  await ctx.onLog(
    "stdout",
    JSON.stringify({
      managed_agents_debug: "skill_fetch_result",
      requestedCount: requestedSkillNames.length,
      fetchedCount: skills.length,
      fetchedNames: skills.map((s) => s.name),
      fetchedContentLengths: skills.map((s) => s.content?.length ?? 0),
    }) + "\n",
  );

  // Render the system prompt & user turn. For the spike we don't update
  // the stored agent's system prompt on every run — we inject the fully
  // rendered prompt as the first message. POST /v1/agents/{id} should be
  // called once per real config change (role, skills) in a follow-up.
  const systemPrompt = renderSystemPrompt({
    role,
    outputFormat,
    cornerstoneContext,
    skills,
    task: { key: taskKey, body: taskBody },
  });
  const userTurn = renderUserTurn({
    role,
    outputFormat,
    cornerstoneContext,
    skills,
    task: { key: taskKey, body: taskBody },
  });

  // New session per run for the MVP. Resumable session continuation is a
  // follow-up: we'd reuse `sessionId` from runtime.sessionParams instead.
  const session = await createSession(apiKey, {
    agentId,
    environmentId,
    agentVersion,
  });
  sessionId = session.id;
  maDbg("session_created", {
    sessionId,
    agentId,
    environmentId,
    agentVersion,
    companyId: ctx.agent.companyId,
    paperclipAgentId: ctx.agent.id,
    hasDelegateTask: Boolean(ctx.delegateTask),
    hasCornerstoneTools: Boolean(ctx.cornerstoneTools),
    timeoutSec,
  });

  await ctx.onSpawn?.({
    pid: 0, // remote session — no local pid
    processGroupId: null,
    startedAt: new Date().toISOString(),
  });

  // Combine system+user into a single user.message for the first (and currently
  // only) turn. The Managed Agents system prompt was set at agent creation time;
  // we prefix it here as a reminder because we didn't rewrite the agent version.
  const firstMessage = `${systemPrompt}\n\n---\n\n${userTurn}`;
  await postUserMessage(apiKey, sessionId, firstMessage);

  const seen = new Set<string>();
  const onEvent = async (ev: MaEvent): Promise<void> => {
    // Stream to Paperclip's transcript via onLog. Adapter UI parser can
    // be added later (docs/adapters/adapter-ui-parser.md); for now we
    // just dump each event as a JSON line on stdout.
    await ctx.onLog("stdout", JSON.stringify({ managed_agents_event: ev.type, id: ev.id, ...(ev.content ? { content: ev.content } : {}), ...(ev.model_usage ? { model_usage: ev.model_usage } : {}) }) + "\n");
  };

  const delegateTask = ctx.delegateTask;
  const cornerstoneTools = ctx.cornerstoneTools;
  // Wrapper around postCustomToolResult that emits structured stdout logs
  // before/after the HTTP call. Used instead of calling postCustomToolResult
  // directly so every post is traceable in Cloud Logging with the tool_use_id,
  // context tag, timing, and response event count. On failure we log the HTTP
  // error before rethrowing so the tool handler's outer try/catch still runs.
  const postToolResultLogged = async (
    toolUseId: string,
    resultText: string,
    isError: boolean,
    context: string,
  ): Promise<{ data: MaEvent[] } | null> => {
    const t0 = Date.now();
    maDbg("post_tool_result_start", {
      sessionId,
      toolUseId,
      isError,
      context,
      resultLen: resultText.length,
    });
    try {
      const res = await postCustomToolResult(
        apiKey,
        sessionId,
        toolUseId,
        resultText,
        isError,
      );
      maDbg("post_tool_result_ok", {
        sessionId,
        toolUseId,
        context,
        durationMs: Date.now() - t0,
        responseEventCount: Array.isArray(res.data) ? res.data.length : 0,
      });
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      maDbg(
        "post_tool_result_error",
        {
          sessionId,
          toolUseId,
          context,
          durationMs: Date.now() - t0,
          error: msg,
        },
        "ERROR",
      );
      throw err;
    }
  };

  // Single onCustomTool dispatcher. Active whenever *any* callback-backed
  // custom tool is wired (delegate_task or the Cornerstone tools). Routes by
  // tool name: delegate_task → delegateTask callback; the 11 Cornerstone
  // tools → cornerstoneTools callback. Unknown tools post a structured error.
  // Keeping one path preserves the H1 invariant (spanCount >=
  // toolUseSpanCount + 1) across mixed tool use in a single session.
  const customToolBound = Boolean(delegateTask) || Boolean(cornerstoneTools);
  const onCustomTool: CustomToolHandler | undefined = customToolBound
    ? async (ev: MaEvent) => {
        // On agent.custom_tool_use, the event's own `id` is the tool_use_id
        // (no separate tool_use_id field exists). name/input are flat on the
        // event. Also tolerate the content-block shape
        // {type:"tool_use", id, name, input} for forward compat.
        const flatName = typeof ev.name === "string" ? ev.name : null;
        const flatInput = ev.input;
        const contentBlocks = Array.isArray(ev.content) ? ev.content : [];
        const toolBlock = contentBlocks.find(
          (c): c is { type: string; id?: string; name?: string; input?: unknown } =>
            !!c && typeof c === "object" && (c as { type?: unknown }).type === "tool_use",
        );
        const flatToolUseId =
          typeof ev.tool_use_id === "string"
            ? ev.tool_use_id
            : typeof ev.id === "string" && ev.type === "agent.custom_tool_use"
              ? ev.id
              : null;
        const toolUseId =
          flatToolUseId ?? (toolBlock && typeof toolBlock.id === "string" ? toolBlock.id : null);
        const name =
          flatName ?? (toolBlock && typeof toolBlock.name === "string" ? toolBlock.name : null);
        const input = flatInput ?? toolBlock?.input;
        await ctx.onLog(
          "stdout",
          JSON.stringify({
            managed_agents_debug: "custom_tool_use_received",
            evId: ev.id,
            toolUseId,
            name,
            hasInput: input !== undefined,
            rawEventKeys: Object.keys(ev),
          }) + "\n",
        );
        if (!toolUseId || !name) return;

        // Route: delegate_task
        if (name === DELEGATE_TASK_TOOL_NAME) {
          if (!delegateTask) {
            await postToolResultLogged(
              toolUseId,
              JSON.stringify({ error: `tool not bound: ${name}` }),
              true,
              "tool_not_bound",
            );
            return;
          }
          const parsed = parseDelegateTaskInput(input);
          if ("error" in parsed) {
            await postToolResultLogged(
              toolUseId,
              JSON.stringify({ error: parsed.error }),
              true,
              "parse_error",
            );
            return;
          }
          try {
            const result = await delegateTask(parsed);
            maDbg("delegate_task_result", {
              sessionId,
              toolUseId,
              status: result.status,
              childRunId: result.childRunId ?? null,
              childIssueId: result.childIssueId ?? null,
              errorCode: result.errorCode ?? null,
            });
            await postToolResultLogged(
              toolUseId,
              JSON.stringify(result),
              result.status === "failed" ||
                result.status === "rejected" ||
                result.status === "timeout",
              "delegate_task_result",
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            maDbg(
              "delegate_task_threw",
              { sessionId, toolUseId, error: msg },
              "ERROR",
            );
            await postToolResultLogged(
              toolUseId,
              JSON.stringify({ error: msg, status: "failed" }),
              true,
              "delegate_task_exception",
            );
          }
          return;
        }

        // Route: Cornerstone tools (get_context, search, list_facts, recall,
        // add_fact, save_conversation, steward_inspect, steward_advise,
        // steward_preview, steward_apply, steward_status).
        if (isCornerstoneToolName(name)) {
          if (!cornerstoneTools) {
            await postToolResultLogged(
              toolUseId,
              JSON.stringify({ error: `tool not bound: ${name}` }),
              true,
              "tool_not_bound",
            );
            return;
          }
          try {
            const result = await cornerstoneTools({ name, input });
            maDbg("cornerstone_tool_result", {
              sessionId,
              toolUseId,
              toolName: name,
              status: result.status,
              errorCode: result.errorCode ?? null,
            });
            await postToolResultLogged(
              toolUseId,
              JSON.stringify(result),
              result.status !== "ok",
              `cornerstone_${name}_result`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            maDbg(
              "cornerstone_tool_threw",
              { sessionId, toolUseId, toolName: name, error: msg },
              "ERROR",
            );
            await postToolResultLogged(
              toolUseId,
              JSON.stringify({ status: "error", errorMessage: msg }),
              true,
              `cornerstone_${name}_exception`,
            );
          }
          return;
        }

        // Unknown tool — mirrors prior behaviour.
        await postToolResultLogged(
          toolUseId,
          JSON.stringify({ error: `unknown tool: ${name}` }),
          true,
          "unknown_tool",
        );
      }
    : undefined;

  let newEvents: MaEvent[];
  try {
    newEvents = await waitForIdle(
      apiKey,
      sessionId,
      seen,
      onEvent,
      timeoutSec * 1000,
      onCustomTool,
      ctx.abortSignal,
    );
  } catch (err) {
    if (err instanceof WaitForIdleAbortedError) {
      maDbg(
        "execute_aborted",
        { sessionId, runId: ctx.runId, agentId: ctx.agent.id },
        "WARNING",
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorCode: "cancelled",
        errorMessage: "Run cancelled by control plane (abort signal fired)",
        sessionParams: ctx.runtime.sessionParams,
        sessionDisplayId: ctx.runtime.sessionDisplayId,
      };
    }
    throw err;
  }

  // Aggregate usage + final response
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let finalText = "";
  let isError = false;
  let stopReason: string | null = null;
  let spanCount = 0;
  let customToolUseCount = 0;
  // toolUseSpanCount counts distinct spans that emitted at least one
  // agent.custom_tool_use event. This is the right unit for the H1
  // invariant: parallel tool_use blocks land in a single model turn, so
  // counting events overcounts and produces false positives when the
  // model batches calls. See Bug 5 (2026-04-25).
  let toolUseSpanCount = 0;
  let toolUseInCurrentSpan = false;

  for (const ev of newEvents) {
    if (ev.type === "span.model_request_end" && ev.model_usage) {
      inputTokens += ev.model_usage.input_tokens;
      outputTokens += ev.model_usage.output_tokens;
      cacheReadTokens += ev.model_usage.cache_read_input_tokens;
      cacheCreateTokens += ev.model_usage.cache_creation_input_tokens;
      if (ev.is_error) isError = true;
      spanCount += 1;
      // If the just-ended span had any tool_use events attributed to it
      // (events streamed before the next span boundary), credit it once.
      if (toolUseInCurrentSpan) {
        toolUseSpanCount += 1;
        toolUseInCurrentSpan = false;
      }
    }
    if (ev.type === "agent.custom_tool_use") {
      customToolUseCount += 1;
      toolUseInCurrentSpan = true;
    }
    if (ev.type === "agent.message" && ev.content) {
      const text = ev.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      if (text) finalText = text;
    }
    if (ev.type === "session.status_idle" && ev.stop_reason) {
      stopReason = ev.stop_reason.type;
    }
  }
  // Tail handling: tool_use events emitted AFTER the last span boundary
  // (still associated with that span) — credit the trailing span once.
  if (toolUseInCurrentSpan) {
    toolUseSpanCount += 1;
  }

  // Pull final session state for runtime cost
  const finalSession = await getSession(apiKey, sessionId);
  const activeSeconds = finalSession.stats?.active_seconds ?? 0;

  // -------------------------------------------------------------------------
  // H1 detector — "session terminated before tool_result"
  //
  // Invariant: each span that emits at least one agent.custom_tool_use must
  // be followed by a subsequent span.model_request_end (the synthesis turn
  // where the model reads the posted tool_result(s) and produces its next
  // output). The total span count must be >= toolUseSpanCount + 1 (each
  // tool-emitting span plus one final synthesis span).
  //
  // We count distinct *tool-emitting spans*, not raw tool_use events. The
  // Anthropic Messages API permits a single assistant turn to emit multiple
  // tool_use blocks in parallel; counting events would over-count and
  // false-positive every parallel-call session (Bug 5, observed 2026-04-25
  // on Donald sessions sesn_011CaPWrMV9U4orvGSULHump etc — spanCount=3,
  // customToolUseCount=4, stopReason=end_turn, but old detector flagged H1).
  //
  // When spanCount < toolUseSpanCount + 1, MA emitted tool_use(s) but never
  // ran the synthesis turn — first observed in Ada's run 5fc47c80 on
  // 2026-04-24: cacheReadTokens=0 at run-end proved no second API call
  // happened. finalText stayed at her pre-delegation preamble. Prior to
  // this check, the adapter classified such runs as success (exitCode=0)
  // because no explicit API error fired — hiding the failure from every
  // downstream system.
  //
  // Classify as error so: (a) heartbeat_run is marked failed, (b) the
  // reconciler can retry with backoff instead of silently stalling, (c)
  // errorMeta lands the diagnostic fields as structured JSON in Cloud
  // Logging so operators can filter by errorCode without string-parsing.
  // -------------------------------------------------------------------------
  const expectedMinSpans = toolUseSpanCount + 1;
  const h1Detected = toolUseSpanCount > 0 && spanCount < expectedMinSpans;
  let h1ErrorCode: string | null = null;
  let h1ErrorMessage: string | null = null;
  let h1ErrorMeta: Record<string, unknown> | null = null;
  if (h1Detected) {
    isError = true;
    h1ErrorCode = "session_terminated_before_tool_result";
    h1ErrorMessage =
      `MA session did not resume after ${toolUseSpanCount} tool-emitting span(s) ` +
      `(${customToolUseCount} tool_use event(s)). ` +
      `Observed ${spanCount} model span(s), expected ≥ ${expectedMinSpans}.`;
    h1ErrorMeta = {
      sessionId,
      runId: ctx.runId,
      companyId: ctx.agent.companyId,
      paperclipAgentId: ctx.agent.id,
      customToolUseCount,
      toolUseSpanCount,
      spanCount,
      expectedMinSpans,
      cacheReadTokens,
      maSessionStatus: finalSession.status,
      stopReason,
    };
  }

  maDbg(
    "session_completed",
    {
      sessionId,
      companyId: ctx.agent.companyId,
      paperclipAgentId: ctx.agent.id,
      activeSeconds,
      stopReason,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      finalTextLen: finalText.length,
      newEventCount: newEvents.length,
      spanCount,
      customToolUseCount,
      toolUseSpanCount,
      h1Detected,
      isError,
      maSessionStatus: finalSession.status,
    },
    h1Detected ? "ERROR" : "INFO",
  );
  const tokenCost = calcTokenCostUsd(model, {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreateTokens,
    cacheReadInputTokens: cacheReadTokens,
  });
  const runtimeCost = calcRuntimeCostUsd(activeSeconds);
  const costUsd = tokenCost + runtimeCost;

  return {
    exitCode: isError ? 1 : 0,
    signal: null,
    timedOut: false,
    errorCode: h1ErrorCode,
    errorMessage: h1ErrorMessage,
    ...(h1ErrorMeta ? { errorMeta: h1ErrorMeta } : {}),
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: cacheReadTokens,
    },
    sessionParams: {
      sessionId,
      agentId,
      agentVersion,
      environmentId,
    },
    sessionDisplayId: sessionId,
    provider: "anthropic",
    biller: "anthropic",
    model,
    billingType: "api",
    costUsd,
    resultJson: {
      managedAgentsSessionId: sessionId,
      activeSeconds,
      tokenCostUsd: tokenCost,
      runtimeCostUsd: runtimeCost,
      stopReason,
      cacheReadTokens,
      cacheCreateTokens,
      finalText,
      spanCount,
      customToolUseCount,
      toolUseSpanCount,
      h1Detected,
    },
    summary: finalText.slice(0, 280) || null,
  };
}
