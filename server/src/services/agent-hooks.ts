import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import {
  agentHooksConfigSchema,
  normalizeAgentUrlKey,
  type AgentHookAction,
  type AgentHookAssignIssueAction,
  type AgentHookCommandAction,
  type AgentHookEventType,
  type AgentHookRule,
  type AgentHookWebhookAction,
  type AgentHookWakeAgentAction,
  type IssueStatus,
} from "@paperclipai/shared";
import { buildPaperclipEnv, renderTemplate } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";

const execFile = promisify(execFileCallback);
const MAX_ACTIVITY_EXCERPT_CHARS = 500;
const DEFAULT_COMMAND_TIMEOUT_SEC = 60;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

type SourceAgent = typeof agents.$inferSelect;
type WakeAgentFn = (
  agentId: string,
  opts: {
    source: "automation";
    triggerDetail: "system" | "callback";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown>;

export interface AgentHookDispatchEvent {
  eventType: AgentHookEventType;
  companyId: string;
  sourceAgentId: string;
  occurredAt?: Date | string | null;
  issueId?: string | null;
  projectId?: string | null;
  run: {
    id: string;
    status: string;
    invocationSource: string;
    triggerDetail: string | null;
    error?: string | null;
    errorCode?: string | null;
    startedAt?: Date | string | null;
    finishedAt?: Date | string | null;
    contextSnapshot?: Record<string, unknown> | null;
    usageJson?: Record<string, unknown> | null;
    resultJson?: Record<string, unknown> | null;
  };
}

interface RunAgentHooksOptions {
  wakeAgent: WakeAgentFn;
}

interface AgentDirectoryEntry {
  id: string;
  companyId: string;
  name: string;
  status: string;
  urlKey: string;
}

interface AgentDirectory {
  byId: Map<string, AgentDirectoryEntry>;
  byReference: Map<string, AgentDirectoryEntry>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function coerceText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return null;
}

function truncateForActivity(value: unknown): string | null {
  const text = coerceText(value);
  if (!text) return null;
  return text.length > MAX_ACTIVITY_EXCERPT_CHARS ? text.slice(0, MAX_ACTIVITY_EXCERPT_CHARS) : text;
}

function coerceIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function resolvePathValue(input: unknown, dottedPath: string): unknown {
  if (!dottedPath) return input;
  const parts = dottedPath.split(".");
  let cursor: unknown = input;

  for (const part of parts) {
    if (!isPlainRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }

  return cursor;
}

function primitiveComparable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function matchExpectedValue(actual: unknown, expected: string | number | boolean): boolean {
  if (Array.isArray(actual)) {
    return actual.some((entry) => matchExpectedValue(entry, expected));
  }
  return primitiveComparable(actual) === primitiveComparable(expected);
}

function ruleMatchesTemplateData(rule: AgentHookRule, templateData: Record<string, unknown>): boolean {
  const ruleEvents = Array.isArray(rule.event) ? rule.event : [rule.event];
  const eventName = readNonEmptyString(resolvePathValue(templateData, "event.name"));
  if (!eventName || !ruleEvents.includes(eventName as AgentHookEventType)) return false;

  const conditions = (rule.match ?? {}) as Record<string, string | number | boolean | Array<string | number | boolean>>;
  for (const [path, expected] of Object.entries(conditions)) {
    const actual = resolvePathValue(templateData, path);
    const matches = Array.isArray(expected)
      ? expected.some((value) => matchExpectedValue(actual, value))
      : matchExpectedValue(actual, expected);
    if (!matches) return false;
  }

  return true;
}

function renderTemplateValue<T>(value: T, data: Record<string, unknown>): T {
  if (typeof value === "string") {
    return renderTemplate(value, data) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplateValue(entry, data)) as T;
  }
  if (isPlainRecord(value)) {
    const rendered: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      rendered[key] = renderTemplateValue(entry, data);
    }
    return rendered as T;
  }
  return value;
}

function buildTemplateData(
  sourceAgent: SourceAgent,
  event: AgentHookDispatchEvent,
  rule: AgentHookRule,
): Record<string, unknown> {
  const contextSnapshot = isPlainRecord(event.run.contextSnapshot) ? event.run.contextSnapshot : {};
  const issueId = event.issueId ?? readNonEmptyString(contextSnapshot.issueId);
  const projectId = event.projectId ?? readNonEmptyString(contextSnapshot.projectId);

  return {
    event: {
      name: event.eventType,
      occurredAt: coerceIsoString(event.occurredAt) ?? new Date().toISOString(),
      companyId: event.companyId,
      sourceAgentId: sourceAgent.id,
      issueId,
      projectId,
    },
    agent: {
      id: sourceAgent.id,
      name: sourceAgent.name,
      urlKey: normalizeAgentUrlKey(sourceAgent.name) ?? sourceAgent.id,
      role: sourceAgent.role,
      title: sourceAgent.title,
      status: sourceAgent.status,
    },
    run: {
      id: event.run.id,
      status: event.run.status,
      invocationSource: event.run.invocationSource,
      triggerDetail: event.run.triggerDetail,
      error: event.run.error ?? null,
      errorCode: event.run.errorCode ?? null,
      startedAt: coerceIsoString(event.run.startedAt),
      finishedAt: coerceIsoString(event.run.finishedAt),
      contextSnapshot,
      context: contextSnapshot,
      usageJson: event.run.usageJson ?? null,
      resultJson: event.run.resultJson ?? null,
      issueId,
      projectId,
    },
    hook: {
      ruleId: rule.id,
    },
  };
}

function buildHookRequestedById(sourceAgentId: string, ruleId: string, actionIndex: number) {
  return `agent_hook:${sourceAgentId}:${ruleId}:${actionIndex}`;
}

async function loadSourceAgent(
  db: Db,
  input: Pick<AgentHookDispatchEvent, "companyId" | "sourceAgentId">,
): Promise<SourceAgent | null> {
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.sourceAgentId), eq(agents.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
}

async function loadAgentDirectory(db: Db, companyId: string): Promise<AgentDirectory> {
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const byId = new Map<string, AgentDirectoryEntry>();
  const byReference = new Map<string, AgentDirectoryEntry>();

  for (const row of rows) {
    const entry: AgentDirectoryEntry = {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
    byId.set(entry.id, entry);
    byReference.set(entry.id, entry);
    byReference.set(entry.name.toLowerCase(), entry);
    byReference.set(entry.urlKey, entry);
  }

  return { byId, byReference };
}

function resolveAgentReference(directory: AgentDirectory, reference: string): AgentDirectoryEntry | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;
  return directory.byReference.get(trimmed) ?? directory.byReference.get(trimmed.toLowerCase()) ?? null;
}

async function logPermissionDenied(
  db: Db,
  sourceAgent: SourceAgent,
  event: AgentHookDispatchEvent,
  ruleId: string,
  actionType: AgentHookAction["type"],
  detail: Record<string, unknown>,
) {
  await logActivity(db, {
    companyId: event.companyId,
    actorType: "system",
    actorId: "agent_hook",
    agentId: sourceAgent.id,
    runId: event.run.id,
    action: "agent_hook.permission_denied",
    entityType: "agent",
    entityId: sourceAgent.id,
    details: {
      hookEventType: event.eventType,
      ruleId,
      actionType,
      ...detail,
    },
  });
}

async function executeCommandAction(
  db: Db,
  sourceAgent: SourceAgent,
  event: AgentHookDispatchEvent,
  rule: AgentHookRule,
  action: AgentHookCommandAction,
  templateData: Record<string, unknown>,
) {
  const rendered: AgentHookCommandAction = renderTemplateValue(action, templateData);
  const env = {
    ...buildPaperclipEnv({ id: sourceAgent.id, companyId: sourceAgent.companyId }),
    PAPERCLIP_HOOK_EVENT: event.eventType,
    PAPERCLIP_HOOK_RUN_ID: event.run.id,
    ...(rendered.env ?? {}),
  };

  try {
    const result = await execFile(rendered.command, rendered.args ?? [], {
      cwd: rendered.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      timeout: Math.max(1, rendered.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC) * 1000,
      maxBuffer: 1024 * 1024,
    });

    await logActivity(db, {
      companyId: event.companyId,
      actorType: "system",
      actorId: "agent_hook",
      agentId: sourceAgent.id,
      runId: event.run.id,
      action: "agent_hook.command_succeeded",
      entityType: "agent",
      entityId: sourceAgent.id,
      details: {
        hookEventType: event.eventType,
        ruleId: rule.id,
        actionType: rendered.type,
        command: rendered.command,
        args: rendered.args ?? [],
        cwd: rendered.cwd ?? process.cwd(),
        stdoutExcerpt: truncateForActivity(result.stdout),
        stderrExcerpt: truncateForActivity(result.stderr),
      },
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    await logActivity(db, {
      companyId: event.companyId,
      actorType: "system",
      actorId: "agent_hook",
      agentId: sourceAgent.id,
      runId: event.run.id,
      action: "agent_hook.command_failed",
      entityType: "agent",
      entityId: sourceAgent.id,
      details: {
        hookEventType: event.eventType,
        ruleId: rule.id,
        actionType: rendered.type,
        command: rendered.command,
        args: rendered.args ?? [],
        cwd: rendered.cwd ?? process.cwd(),
        error: err.message,
        stdoutExcerpt: truncateForActivity(err.stdout),
        stderrExcerpt: truncateForActivity(err.stderr),
      },
    });
  }
}

async function executeWebhookAction(
  db: Db,
  sourceAgent: SourceAgent,
  event: AgentHookDispatchEvent,
  rule: AgentHookRule,
  action: AgentHookWebhookAction,
  templateData: Record<string, unknown>,
) {
  const rendered: AgentHookWebhookAction = renderTemplateValue(action, templateData);
  const method = (rendered.method ?? "POST").toUpperCase();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, rendered.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS),
  );

  try {
    const response = await fetch(rendered.url, {
      method,
      headers: {
        "content-type": "application/json",
        ...(rendered.headers ?? {}),
      },
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : JSON.stringify(rendered.body ?? {}),
      signal: controller.signal,
    });
    const responseText = truncateForActivity(await response.text().catch(() => ""));

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`);
    }

    await logActivity(db, {
      companyId: event.companyId,
      actorType: "system",
      actorId: "agent_hook",
      agentId: sourceAgent.id,
      runId: event.run.id,
      action: "agent_hook.webhook_succeeded",
      entityType: "agent",
      entityId: sourceAgent.id,
      details: {
        hookEventType: event.eventType,
        ruleId: rule.id,
        actionType: rendered.type,
        url: rendered.url,
        method,
        statusCode: response.status,
        responseExcerpt: responseText,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logActivity(db, {
      companyId: event.companyId,
      actorType: "system",
      actorId: "agent_hook",
      agentId: sourceAgent.id,
      runId: event.run.id,
      action: "agent_hook.webhook_failed",
      entityType: "agent",
      entityId: sourceAgent.id,
      details: {
        hookEventType: event.eventType,
        ruleId: rule.id,
        actionType: rendered.type,
        url: rendered.url,
        method,
        error: message,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function executeWakeAgentAction(
  db: Db,
  sourceAgent: SourceAgent,
  event: AgentHookDispatchEvent,
  rule: AgentHookRule,
  action: AgentHookWakeAgentAction,
  templateData: Record<string, unknown>,
  directory: AgentDirectory,
  allowedTargetIds: Set<string>,
  wakeAgent: WakeAgentFn,
  actionIndex: number,
) {
  const rendered: AgentHookWakeAgentAction = renderTemplateValue(action, templateData);
  const renderedAgentRefs = Array.isArray(rendered.agentRefs)
    ? rendered.agentRefs.map((value) => String(value))
    : [];
  const uniqueAgentRefs = [...new Set(renderedAgentRefs.map((value) => value.trim()).filter((value) => value.length > 0))];
  const processedTargetAgentIds = new Set<string>();

  for (const agentRef of uniqueAgentRefs) {
    const targetAgent = resolveAgentReference(directory, agentRef);
    if (!targetAgent) {
      await logActivity(db, {
        companyId: event.companyId,
        actorType: "system",
        actorId: "agent_hook",
        agentId: sourceAgent.id,
        runId: event.run.id,
        action: "agent_hook.wake_failed",
        entityType: "agent",
        entityId: sourceAgent.id,
        details: {
          hookEventType: event.eventType,
          ruleId: rule.id,
          actionType: rendered.type,
          agentRef,
          error: "Target agent not found in company",
        },
      });
      continue;
    }

    if (targetAgent.id === sourceAgent.id) {
      await logPermissionDenied(db, sourceAgent, event, rule.id, rendered.type, {
        agentRef,
        reason: "Hooks cannot wake the originating agent",
      });
      continue;
    }

    if (!allowedTargetIds.has(targetAgent.id)) {
      await logPermissionDenied(db, sourceAgent, event, rule.id, rendered.type, {
        agentRef,
        targetAgentId: targetAgent.id,
        reason: "Target agent is not allow-listed for hooks.permissions.allowedAgentRefs",
      });
      continue;
    }

    if (processedTargetAgentIds.has(targetAgent.id)) {
      continue;
    }
    processedTargetAgentIds.add(targetAgent.id);

    try {
      const contextSnapshot = isPlainRecord(rendered.contextSnapshot)
        ? { ...rendered.contextSnapshot }
        : {};
      if (rendered.forceFreshSession) {
        contextSnapshot.forceFreshSession = true;
      }

      await wakeAgent(targetAgent.id, {
        source: "automation",
        triggerDetail: "callback",
        reason: rendered.reason ?? event.eventType,
        payload: isPlainRecord(rendered.payload) ? rendered.payload : null,
        contextSnapshot,
        requestedByActorType: "system",
        requestedByActorId: buildHookRequestedById(sourceAgent.id, rule.id, actionIndex),
        idempotencyKey: `hook:${event.run.id}:${rule.id}:${actionIndex}:${targetAgent.id}`,
      });

      await logActivity(db, {
        companyId: event.companyId,
        actorType: "system",
        actorId: "agent_hook",
        agentId: sourceAgent.id,
        runId: event.run.id,
        action: "agent_hook.wake_requested",
        entityType: "agent",
        entityId: targetAgent.id,
        details: {
          hookEventType: event.eventType,
          ruleId: rule.id,
          actionType: rendered.type,
          targetAgentId: targetAgent.id,
          targetAgentName: targetAgent.name,
          reason: rendered.reason ?? event.eventType,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logActivity(db, {
        companyId: event.companyId,
        actorType: "system",
        actorId: "agent_hook",
        agentId: sourceAgent.id,
        runId: event.run.id,
        action: "agent_hook.wake_failed",
        entityType: "agent",
        entityId: targetAgent.id,
        details: {
          hookEventType: event.eventType,
          ruleId: rule.id,
          actionType: rendered.type,
          targetAgentId: targetAgent.id,
          targetAgentName: targetAgent.name,
          error: message,
        },
      });
    }
  }
}

async function executeAssignIssueAction(
  db: Db,
  sourceAgent: SourceAgent,
  event: AgentHookDispatchEvent,
  rule: AgentHookRule,
  action: AgentHookAssignIssueAction,
  templateData: Record<string, unknown>,
  directory: AgentDirectory,
  allowedTargetIds: Set<string>,
  wakeAgent: WakeAgentFn,
  actionIndex: number,
) {
  const rendered: AgentHookAssignIssueAction = renderTemplateValue(action, templateData);
  const renderedAgentRef = readNonEmptyString(rendered.agentRef);
  if (!renderedAgentRef) {
    await logActivity(db, {
      companyId: event.companyId,
      actorType: "system",
      actorId: "agent_hook",
      agentId: sourceAgent.id,
      runId: event.run.id,
      action: "agent_hook.issue_assignment_failed",
      entityType: "agent",
      entityId: sourceAgent.id,
      details: {
        hookEventType: event.eventType,
        ruleId: rule.id,
        actionType: rendered.type,
        error: "assign_issue rendered an empty agentRef",
      },
    });
    return;
  }

  const targetAgent = resolveAgentReference(directory, renderedAgentRef);
  if (!targetAgent) {
    await logActivity(db, {
      companyId: event.companyId,
      actorType: "system",
      actorId: "agent_hook",
      agentId: sourceAgent.id,
      runId: event.run.id,
      action: "agent_hook.issue_assignment_failed",
      entityType: "agent",
      entityId: sourceAgent.id,
      details: {
        hookEventType: event.eventType,
        ruleId: rule.id,
        actionType: rendered.type,
        agentRef: renderedAgentRef,
        error: "Target agent not found in company",
      },
    });
    return;
  }

  if (targetAgent.id === sourceAgent.id) {
    await logPermissionDenied(db, sourceAgent, event, rule.id, rendered.type, {
      agentRef: renderedAgentRef,
      reason: "Hooks cannot assign issues back to the originating agent",
    });
    return;
  }

  if (!allowedTargetIds.has(targetAgent.id)) {
    await logPermissionDenied(db, sourceAgent, event, rule.id, rendered.type, {
      agentRef: renderedAgentRef,
      targetAgentId: targetAgent.id,
      reason: "Target agent is not allow-listed for hooks.permissions.allowedAgentRefs",
    });
    return;
  }

  const eventIssueId = readNonEmptyString(resolvePathValue(templateData, "event.issueId"));
  const issueId = readNonEmptyString(rendered.issueId) ?? eventIssueId;
  if (!issueId) {
    await logActivity(db, {
      companyId: event.companyId,
      actorType: "system",
      actorId: "agent_hook",
      agentId: sourceAgent.id,
      runId: event.run.id,
      action: "agent_hook.issue_assignment_failed",
      entityType: "agent",
      entityId: sourceAgent.id,
      details: {
        hookEventType: event.eventType,
        ruleId: rule.id,
        actionType: rendered.type,
        targetAgentId: targetAgent.id,
        error: "No issueId available for assign_issue action",
      },
    });
    return;
  }

  const issuesSvc = issueService(db);
  let updatedIssue: Awaited<ReturnType<typeof issuesSvc.update>> | null = null;

  try {
    const issueRow = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issueRow || issueRow.companyId !== event.companyId) {
      throw new Error("Issue not found in company");
    }

    updatedIssue = await issuesSvc.update(issueId, {
      assigneeAgentId: targetAgent.id,
      ...(rendered.status ? { status: rendered.status as IssueStatus } : {}),
    });

    if (!updatedIssue || updatedIssue.companyId !== event.companyId) {
      throw new Error("Issue not found in company");
    }

    await logActivity(db, {
      companyId: event.companyId,
      actorType: "system",
      actorId: "agent_hook",
      agentId: sourceAgent.id,
      runId: event.run.id,
      action: "agent_hook.issue_assigned",
      entityType: "issue",
      entityId: updatedIssue.id,
      details: {
        hookEventType: event.eventType,
        ruleId: rule.id,
        actionType: rendered.type,
        issueId: updatedIssue.id,
        targetAgentId: targetAgent.id,
        targetAgentName: targetAgent.name,
        status: rendered.status ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logActivity(db, {
      companyId: event.companyId,
      actorType: "system",
      actorId: "agent_hook",
      agentId: sourceAgent.id,
      runId: event.run.id,
      action: "agent_hook.issue_assignment_failed",
      entityType: "issue",
      entityId: issueId,
      details: {
        hookEventType: event.eventType,
        ruleId: rule.id,
        actionType: rendered.type,
        targetAgentId: targetAgent.id,
        targetAgentName: targetAgent.name,
        error: message,
      },
    });
    return;
  }

  if (!rendered.wakeAssignee || !updatedIssue) {
    return;
  }

  try {
    await wakeAgent(targetAgent.id, {
      source: "automation",
      triggerDetail: "callback",
      reason: "issue_assigned_by_hook",
      payload: { issueId: updatedIssue.id, mutation: "hook.assign_issue" },
      contextSnapshot: {
        issueId: updatedIssue.id,
        source: "agent_hook.assign_issue",
        wakeReason: "issue_assigned_by_hook",
      },
      requestedByActorType: "system",
      requestedByActorId: buildHookRequestedById(sourceAgent.id, rule.id, actionIndex),
      idempotencyKey: `hook:${event.run.id}:${rule.id}:${actionIndex}:${updatedIssue.id}:${targetAgent.id}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logActivity(db, {
      companyId: event.companyId,
      actorType: "system",
      actorId: "agent_hook",
      agentId: sourceAgent.id,
      runId: event.run.id,
      action: "agent_hook.wake_failed",
      entityType: "agent",
      entityId: targetAgent.id,
      details: {
        hookEventType: event.eventType,
        ruleId: rule.id,
        actionType: rendered.type,
        issueId: updatedIssue.id,
        targetAgentId: targetAgent.id,
        targetAgentName: targetAgent.name,
        error: message,
      },
    });
  }
}

export async function runAgentHooksForEvent(
  db: Db,
  event: AgentHookDispatchEvent,
  options: RunAgentHooksOptions,
): Promise<void> {
  const sourceAgent = await loadSourceAgent(db, event);
  if (!sourceAgent) return;

  const runtimeConfig = isPlainRecord(sourceAgent.runtimeConfig) ? sourceAgent.runtimeConfig : {};
  const hooksRaw = runtimeConfig.hooks;
  if (!hooksRaw) return;

  const parsedHooks = agentHooksConfigSchema.safeParse(hooksRaw);
  if (!parsedHooks.success) {
    logger.warn(
      { companyId: event.companyId, sourceAgentId: event.sourceAgentId, issues: parsedHooks.error.issues },
      "agent hook config is invalid at dispatch time",
    );
    return;
  }

  const hooks = parsedHooks.data;
  if (!hooks.enabled || hooks.rules.length === 0) return;

  let directoryPromise: Promise<AgentDirectory> | null = null;
  let allowedTargetIdsPromise: Promise<Set<string>> | null = null;

  const getDirectory = () => {
    if (!directoryPromise) directoryPromise = loadAgentDirectory(db, event.companyId);
    return directoryPromise;
  };

  const getAllowedTargetIds = async () => {
    if (!allowedTargetIdsPromise) {
      allowedTargetIdsPromise = (async () => {
        const directory = await getDirectory();
        const ids = new Set<string>();
        for (const reference of hooks.permissions.allowedAgentRefs) {
          const targetAgent = resolveAgentReference(directory, reference);
          if (targetAgent) ids.add(targetAgent.id);
        }
        return ids;
      })();
    }
    return allowedTargetIdsPromise;
  };

  for (const rule of hooks.rules) {
    if (!rule.enabled) continue;

    const templateData = buildTemplateData(sourceAgent, event, rule);
    if (!ruleMatchesTemplateData(rule, templateData)) continue;

    for (const [actionIndex, action] of rule.actions.entries()) {
      try {
        if (action.type === "command") {
          if (!hooks.permissions.allowCommand) {
            await logPermissionDenied(db, sourceAgent, event, rule.id, action.type, {
              reason: "hooks.permissions.allowCommand is false",
            });
            continue;
          }
          await executeCommandAction(db, sourceAgent, event, rule, action, templateData);
          continue;
        }

        if (action.type === "webhook") {
          if (!hooks.permissions.allowWebhook) {
            await logPermissionDenied(db, sourceAgent, event, rule.id, action.type, {
              reason: "hooks.permissions.allowWebhook is false",
            });
            continue;
          }
          await executeWebhookAction(db, sourceAgent, event, rule, action, templateData);
          continue;
        }

        const directory = await getDirectory();
        const allowedTargetIds = await getAllowedTargetIds();

        if (action.type === "wake_agent") {
          await executeWakeAgentAction(
            db,
            sourceAgent,
            event,
            rule,
            action,
            templateData,
            directory,
            allowedTargetIds,
            options.wakeAgent,
            actionIndex,
          );
          continue;
        }

        if (!hooks.permissions.allowIssueAssignment) {
          await logPermissionDenied(db, sourceAgent, event, rule.id, action.type, {
            reason: "hooks.permissions.allowIssueAssignment is false",
          });
          continue;
        }

        await executeAssignIssueAction(
          db,
          sourceAgent,
          event,
          rule,
          action,
          templateData,
          directory,
          allowedTargetIds,
          options.wakeAgent,
          actionIndex,
        );
      } catch (error) {
        logger.warn(
          {
            err: error,
            companyId: event.companyId,
            sourceAgentId: event.sourceAgentId,
            runId: event.run.id,
            hookEventType: event.eventType,
            ruleId: rule.id,
            actionType: action.type,
          },
          "agent hook action failed unexpectedly",
        );
      }
    }
  }
}
