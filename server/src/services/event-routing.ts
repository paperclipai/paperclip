import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, eventRoutingRules, webhookEndpoints, webhookEvents } from "@paperclipai/db";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import { normalizeGitHubWebhookEvent } from "./event-providers/github.js";
import { logger } from "../middleware/logger.js";

type EndpointRow = typeof webhookEndpoints.$inferSelect;
type RuleRow = typeof eventRoutingRules.$inferSelect;
type EventRow = typeof webhookEvents.$inferSelect;

type RoutingSource = "webhook" | "internal";

interface NormalizedRoutingEvent {
  companyId: string;
  endpointId: string | null;
  source: RoutingSource;
  provider: string;
  eventType: string;
  payload: Record<string, unknown>;
  headers: Record<string, unknown> | null;
  chainDepth: number;
}

interface ActionDispatchResult {
  status: "matched" | "dispatched" | "ignored";
  actionType: string;
  wakeRunId?: string | null;
  createdIssueId?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getByPath(source: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return source[path];
  const chunks = path.split(".");
  let current: unknown = source;
  for (const chunk of chunks) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[chunk];
  }
  return current;
}

function renderTemplate(template: string, context: Record<string, unknown>) {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_all, path) => {
    const value = getByPath(context, String(path).trim());
    if (value === undefined || value === null) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(value);
  });
}

function normalizeHeaderMap(headers: Record<string, string | string[] | undefined>) {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (Array.isArray(value)) {
      normalized[lower] = value.join(",");
    } else if (typeof value === "string") {
      normalized[lower] = value;
    }
  }
  return normalized;
}

function parseWebhookSignature(signature: string | null) {
  if (!signature) return null;
  const parts = signature.split("=");
  if (parts.length !== 2) return null;
  return { algorithm: parts[0]!, digest: parts[1]! };
}

function toHexHmac(algorithm: string, secret: string, payloadRaw: string) {
  return createHmac(algorithm, secret).update(payloadRaw).digest("hex");
}

function safeHexCompare(a: string, b: string) {
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function evaluateComparator(actual: unknown, expected: unknown): boolean {
  const expectedRecord = asRecord(expected);
  if (!expectedRecord) return actual === expected;

  if ("exists" in expectedRecord) {
    const existsExpected = Boolean(expectedRecord.exists);
    const existsActual = actual !== null && actual !== undefined;
    if (existsExpected !== existsActual) return false;
  }
  if ("eq" in expectedRecord && actual !== expectedRecord.eq) return false;
  if ("neq" in expectedRecord && actual === expectedRecord.neq) return false;
  if ("in" in expectedRecord) {
    const candidates = Array.isArray(expectedRecord.in) ? expectedRecord.in : [];
    if (!candidates.includes(actual)) return false;
  }
  if ("contains" in expectedRecord) {
    const needle = expectedRecord.contains;
    if (typeof actual === "string" && typeof needle === "string") {
      if (!actual.includes(needle)) return false;
    } else if (Array.isArray(actual)) {
      if (!actual.includes(needle)) return false;
    } else {
      return false;
    }
  }
  if ("gte" in expectedRecord) {
    const min = Number(expectedRecord.gte);
    if (Number.isNaN(min) || typeof actual !== "number" || actual < min) return false;
  }
  if ("lte" in expectedRecord) {
    const max = Number(expectedRecord.lte);
    if (Number.isNaN(max) || typeof actual !== "number" || actual > max) return false;
  }

  return true;
}

function conditionMatches(event: NormalizedRoutingEvent, conditionRaw: Record<string, unknown>) {
  const condition = conditionRaw ?? {};
  for (const [key, expected] of Object.entries(condition)) {
    const actual =
      key === "event" ? event.eventType
        : key === "provider" ? event.provider
          : key === "source" ? event.source
            : getByPath(event.payload, key);
    if (!evaluateComparator(actual, expected)) return false;
  }
  return true;
}

function actionTemplateContext(event: NormalizedRoutingEvent) {
  return {
    ...event.payload,
    eventType: event.eventType,
    provider: event.provider,
    source: event.source,
  } satisfies Record<string, unknown>;
}

function buildReason(defaultEventType: string, requestedReason: unknown) {
  const explicit = asString(requestedReason);
  return explicit ?? defaultEventType;
}

function buildIssueTitle(context: Record<string, unknown>, action: Record<string, unknown>) {
  const explicit = asString(action.title);
  if (explicit) return renderTemplate(explicit, context);
  return `Automation: ${asString(context.eventType) ?? "event"}`;
}

function buildIssueDescription(context: Record<string, unknown>, action: Record<string, unknown>) {
  const explicit = asString(action.description);
  if (explicit) return renderTemplate(explicit, context);
  return `Triggered by \`${asString(context.eventType) ?? "event"}\` from \`${asString(context.provider) ?? "unknown"}\`.`;
}

function generateEndpointSecret() {
  return randomBytes(24).toString("hex");
}

export function eventRoutingService(db: Db) {
  const issues = issueService(db);
  const heartbeat = heartbeatService(db);

  async function listEndpoints(companyId: string) {
    return db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.companyId, companyId))
      .orderBy(asc(webhookEndpoints.createdAt));
  }

  async function getEndpointById(id: string) {
    return db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getEndpointBySlug(slug: string) {
    return db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.slug, slug))
      .then((rows) => rows[0] ?? null);
  }

  async function createEndpoint(
    companyId: string,
    input: {
      name: string;
      slug: string;
      provider: "github" | "slack" | "email" | "generic";
      secret?: string | null;
      status?: "active" | "paused" | "disabled";
      metadata?: Record<string, unknown> | null;
    },
  ) {
    const [row] = await db
      .insert(webhookEndpoints)
      .values({
        companyId,
        name: input.name,
        slug: input.slug,
        provider: input.provider,
        secret: input.secret && input.secret.trim().length > 0 ? input.secret.trim() : generateEndpointSecret(),
        status: input.status ?? "active",
        metadata: input.metadata ?? null,
      })
      .returning();
    return row!;
  }

  async function updateEndpoint(
    id: string,
    input: Partial<{
      name: string;
      slug: string;
      provider: "github" | "slack" | "email" | "generic";
      secret: string | null;
      status: "active" | "paused" | "disabled";
      metadata: Record<string, unknown> | null;
    }>,
  ) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.provider !== undefined) patch.provider = input.provider;
    if (input.secret !== undefined) patch.secret = input.secret && input.secret.trim().length > 0 ? input.secret : generateEndpointSecret();
    if (input.status !== undefined) patch.status = input.status;
    if (input.metadata !== undefined) patch.metadata = input.metadata;

    return db
      .update(webhookEndpoints)
      .set(patch)
      .where(eq(webhookEndpoints.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function deleteEndpoint(id: string) {
    return db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .returning()
      .then((rows) => rows.length > 0);
  }

  async function listRules(companyId: string, endpointId?: string | null) {
    const condition = endpointId
      ? and(eq(eventRoutingRules.companyId, companyId), eq(eventRoutingRules.endpointId, endpointId))
      : eq(eventRoutingRules.companyId, companyId);
    return db
      .select()
      .from(eventRoutingRules)
      .where(condition)
      .orderBy(asc(eventRoutingRules.priority), asc(eventRoutingRules.createdAt));
  }

  async function getRuleById(id: string) {
    return db
      .select()
      .from(eventRoutingRules)
      .where(eq(eventRoutingRules.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function createRule(
    companyId: string,
    input: {
      endpointId?: string | null;
      source?: "webhook" | "internal";
      name: string;
      priority?: number;
      condition: Record<string, unknown>;
      action: Record<string, unknown>;
      cooldownSec?: number;
      enabled?: boolean;
    },
  ) {
    const [row] = await db
      .insert(eventRoutingRules)
      .values({
        companyId,
        endpointId: input.endpointId ?? null,
        source: input.source ?? "webhook",
        name: input.name,
        priority: input.priority ?? 100,
        condition: input.condition,
        action: input.action,
        cooldownSec: input.cooldownSec ?? 0,
        enabled: input.enabled ?? true,
      })
      .returning();
    return row!;
  }

  async function updateRule(
    id: string,
    input: Partial<{
      endpointId: string | null;
      source: "webhook" | "internal";
      name: string;
      priority: number;
      condition: Record<string, unknown>;
      action: Record<string, unknown>;
      cooldownSec: number;
      enabled: boolean;
    }>,
  ) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.endpointId !== undefined) patch.endpointId = input.endpointId;
    if (input.source !== undefined) patch.source = input.source;
    if (input.name !== undefined) patch.name = input.name;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.condition !== undefined) patch.condition = input.condition;
    if (input.action !== undefined) patch.action = input.action;
    if (input.cooldownSec !== undefined) patch.cooldownSec = input.cooldownSec;
    if (input.enabled !== undefined) patch.enabled = input.enabled;

    return db
      .update(eventRoutingRules)
      .set(patch)
      .where(eq(eventRoutingRules.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function deleteRule(id: string) {
    return db
      .delete(eventRoutingRules)
      .where(eq(eventRoutingRules.id, id))
      .returning()
      .then((rows) => rows.length > 0);
  }

  async function listEvents(companyId: string, opts?: { endpointId?: string; limit?: number }) {
    const limit = Math.max(1, Math.min(500, opts?.limit ?? 100));
    const where = opts?.endpointId
      ? and(eq(webhookEvents.companyId, companyId), eq(webhookEvents.endpointId, opts.endpointId))
      : eq(webhookEvents.companyId, companyId);
    return db
      .select()
      .from(webhookEvents)
      .where(where)
      .orderBy(desc(webhookEvents.createdAt))
      .limit(limit);
  }

  async function verifyEndpointSignature(input: {
    endpoint: EndpointRow;
    headers: Record<string, string>;
    rawBody: string;
  }) {
    const { endpoint, headers, rawBody } = input;
    const secret = endpoint.secret;
    if (!secret) return false;

    if (endpoint.provider === "github") {
      const signatureHeader = parseWebhookSignature(headers["x-hub-signature-256"] ?? null);
      if (!signatureHeader || signatureHeader.algorithm !== "sha256") return false;
      const expectedDigest = toHexHmac("sha256", secret, rawBody);
      return safeHexCompare(signatureHeader.digest, expectedDigest);
    }

    if (endpoint.provider === "slack") {
      const ts = asString(headers["x-slack-request-timestamp"]);
      const signatureHeader = asString(headers["x-slack-signature"]);
      if (!ts || !signatureHeader) return false;
      const signature = parseWebhookSignature(signatureHeader);
      if (!signature || signature.algorithm !== "v0") return false;
      const basestring = `v0:${ts}:${rawBody}`;
      const expectedDigest = toHexHmac("sha256", secret, basestring);
      return safeHexCompare(signature.digest, expectedDigest);
    }

    const signatureHeader = asString(headers["x-paperclip-signature"]) ?? asString(headers["x-webhook-signature"]);
    if (!signatureHeader) return false;
    const parsed = parseWebhookSignature(signatureHeader);
    if (parsed?.algorithm === "sha256") {
      const expectedDigest = toHexHmac("sha256", secret, rawBody);
      return safeHexCompare(parsed.digest, expectedDigest);
    }
    const expectedDigest = toHexHmac("sha256", secret, rawBody);
    return safeHexCompare(signatureHeader, expectedDigest);
  }

  async function checkRuleCooldown(event: NormalizedRoutingEvent, rule: RuleRow) {
    if (rule.cooldownSec <= 0) return false;
    const cutoff = new Date(Date.now() - rule.cooldownSec * 1000);
    const existing = await db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.companyId, event.companyId),
          eq(webhookEvents.matchedRuleId, rule.id),
          gt(webhookEvents.createdAt, cutoff),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(existing);
  }

  async function dispatchAction(event: NormalizedRoutingEvent, rule: RuleRow): Promise<ActionDispatchResult> {
    const action = asRecord(rule.action) ?? {};
    const actionType = asString(action.type) ?? "noop";
    const context = actionTemplateContext(event);

    if (actionType === "wake_agent") {
      const agentId = asString(action.agentId);
      if (!agentId) {
        return { status: "ignored", actionType };
      }
      const wakePayload = asRecord(action.payload) ?? {};
      if (action.inheritIssueContext === true && !("issueId" in wakePayload)) {
        const inheritedIssueId = asString(getByPath(event.payload, "issueId")) ?? asString(getByPath(event.payload, "raw.issueId"));
        if (inheritedIssueId) wakePayload.issueId = inheritedIssueId;
      }
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "callback",
        reason: buildReason(event.eventType, action.reason),
        payload: {
          ...wakePayload,
          eventType: event.eventType,
          provider: event.provider,
          eventPayload: event.payload,
          chainDepth: event.chainDepth,
          routingRuleId: rule.id,
        },
        requestedByActorType: "system",
        requestedByActorId: `event_rule:${rule.id}`,
        contextSnapshot: {
          source: "event_router",
          wakeReason: buildReason(event.eventType, action.reason),
          eventType: event.eventType,
          eventPayload: event.payload,
          chainDepth: event.chainDepth,
          routingRuleId: rule.id,
          issueId: asString(getByPath(event.payload, "issueId")) ?? asString(getByPath(event.payload, "raw.issueId")) ?? null,
        },
      });
      return {
        status: run ? "dispatched" : "ignored",
        actionType,
        wakeRunId: run?.id ?? null,
      };
    }

    if (actionType === "create_issue" || actionType === "create_and_assign") {
      const assigneeAgentId =
        actionType === "create_and_assign"
          ? asString(action.agentId)
          : asString(action.assigneeAgentId);
      const issue = await issues.create(event.companyId, {
        title: buildIssueTitle(context, action),
        description: buildIssueDescription(context, action),
        status: asString(action.status) ?? "todo",
        priority: asString(action.priority) ?? "medium",
        projectId: asString(action.projectId),
        goalId: asString(action.goalId),
        parentId: asString(action.parentId),
        assigneeAgentId: assigneeAgentId ?? null,
        billingCode: asString(action.billingCode),
        requestDepth: 0,
        createdByAgentId: null,
        createdByUserId: null,
      });

      let wakeRunId: string | null = null;
      const shouldWake = actionType === "create_and_assign" || action.wakeAssignee === true;
      if (shouldWake && issue.assigneeAgentId) {
        const wake = await heartbeat.wakeup(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "callback",
          reason: buildReason(event.eventType, action.reason),
          payload: {
            issueId: issue.id,
            eventType: event.eventType,
            provider: event.provider,
            eventPayload: event.payload,
            chainDepth: event.chainDepth,
            routingRuleId: rule.id,
          },
          requestedByActorType: "system",
          requestedByActorId: `event_rule:${rule.id}`,
          contextSnapshot: {
            source: "event_router",
            issueId: issue.id,
            wakeReason: buildReason(event.eventType, action.reason),
            eventType: event.eventType,
            eventPayload: event.payload,
            chainDepth: event.chainDepth,
            routingRuleId: rule.id,
          },
        });
        wakeRunId = wake?.id ?? null;
      }

      return {
        status: "dispatched",
        actionType,
        wakeRunId,
        createdIssueId: issue.id,
      };
    }

    return { status: "ignored", actionType };
  }

  async function logEvent(input: {
    event: NormalizedRoutingEvent;
    matchedRuleId?: string | null;
    status: EventRow["status"];
    resultAction?: Record<string, unknown> | null;
    error?: string | null;
  }) {
    const [row] = await db
      .insert(webhookEvents)
      .values({
        companyId: input.event.companyId,
        endpointId: input.event.endpointId,
        matchedRuleId: input.matchedRuleId ?? null,
        source: input.event.source,
        provider: input.event.provider,
        eventType: input.event.eventType,
        payload: input.event.payload,
        headers: input.event.headers,
        status: input.status,
        resultAction: input.resultAction ?? null,
        error: input.error ?? null,
      })
      .returning();
    return row!;
  }

  async function updateEndpointCounters(endpointId: string) {
    await db
      .update(webhookEndpoints)
      .set({
        eventCount: sql`${webhookEndpoints.eventCount} + 1`,
        lastEventAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(webhookEndpoints.id, endpointId));
  }

  async function processEvent(event: NormalizedRoutingEvent) {
    if (event.chainDepth > 5) {
      const eventRow = await logEvent({
        event,
        status: "ignored",
        error: "routing.chain_depth_exceeded",
      });
      return { event: eventRow, status: "ignored" as const };
    }

    const baseCondition = and(
      eq(eventRoutingRules.companyId, event.companyId),
      eq(eventRoutingRules.enabled, true),
      eq(eventRoutingRules.source, event.source),
      event.endpointId ? eq(eventRoutingRules.endpointId, event.endpointId) : isNull(eventRoutingRules.endpointId),
    );
    const rules = await db
      .select()
      .from(eventRoutingRules)
      .where(baseCondition)
      .orderBy(asc(eventRoutingRules.priority), asc(eventRoutingRules.createdAt));

    for (const rule of rules) {
      const condition = asRecord(rule.condition) ?? {};
      if (!conditionMatches(event, condition)) continue;
      const cooldownHit = await checkRuleCooldown(event, rule);
      if (cooldownHit) continue;

      try {
        const dispatch = await dispatchAction(event, rule);
        const eventRow = await logEvent({
          event,
          matchedRuleId: rule.id,
          status: dispatch.status,
          resultAction: {
            actionType: dispatch.actionType,
            wakeRunId: dispatch.wakeRunId ?? null,
            createdIssueId: dispatch.createdIssueId ?? null,
          },
        });
        return { event: eventRow, status: dispatch.status };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const eventRow = await logEvent({
          event,
          matchedRuleId: rule.id,
          status: "error",
          error: message,
        });
        logger.warn(
          { err, ruleId: rule.id, companyId: event.companyId, endpointId: event.endpointId },
          "event routing action failed",
        );
        return { event: eventRow, status: "error" as const };
      }
    }

    const eventRow = await logEvent({ event, status: "ignored" });
    return { event: eventRow, status: "ignored" as const };
  }

  async function processIncomingWebhook(input: {
    slug: string;
    headers: Record<string, string | string[] | undefined>;
    payload: Record<string, unknown>;
    rawBody: string;
  }) {
    const endpoint = await getEndpointBySlug(input.slug);
    if (!endpoint) return { code: 404 as const, error: "Webhook endpoint not found" };
    if (endpoint.status !== "active") return { code: 202 as const, skipped: "endpoint_inactive" as const };

    const headerMap = normalizeHeaderMap(input.headers);
    const verified = await verifyEndpointSignature({
      endpoint,
      headers: headerMap,
      rawBody: input.rawBody,
    });
    if (!verified) return { code: 401 as const, error: "Invalid webhook signature" };

    const normalized =
      endpoint.provider === "github"
        ? normalizeGitHubWebhookEvent({
          event: asString(headerMap["x-github-event"]),
          payload: input.payload,
        })
        : {
          eventType:
            asString(headerMap["x-event-type"]) ??
            asString(input.payload.eventType) ??
            asString(input.payload.type) ??
            "unknown",
          payload: input.payload,
        };

    const result = await processEvent({
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
      source: "webhook",
      provider: endpoint.provider,
      eventType: normalized.eventType,
      payload: normalized.payload,
      headers: headerMap,
      chainDepth: 0,
    });

    await updateEndpointCounters(endpoint.id);
    return {
      code: 202 as const,
      status: result.status,
      eventId: result.event.id,
      matchedRuleId: result.event.matchedRuleId,
    };
  }

  async function processInternalEvent(input: {
    companyId: string;
    eventType: string;
    payload: Record<string, unknown>;
    chainDepth?: number;
  }) {
    return processEvent({
      companyId: input.companyId,
      endpointId: null,
      source: "internal",
      provider: "paperclip",
      eventType: input.eventType,
      payload: input.payload,
      headers: null,
      chainDepth: input.chainDepth ?? 0,
    });
  }

  async function endpointExistsInCompany(endpointId: string, companyId: string) {
    const row = await db
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function agentExistsInCompany(agentId: string, companyId: string) {
    const row = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  return {
    listEndpoints,
    getEndpointById,
    createEndpoint,
    updateEndpoint,
    deleteEndpoint,
    listRules,
    getRuleById,
    createRule,
    updateRule,
    deleteRule,
    listEvents,
    endpointExistsInCompany,
    agentExistsInCompany,
    processIncomingWebhook,
    processInternalEvent,
  };
}
