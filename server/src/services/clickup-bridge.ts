import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { buildClickUpContextBody, buildCommentPayload } from "@paperclipai/adapter-clickup-agent-ref/server";
import { agents, clickupBridges, clickupOutboundEvents } from "@paperclipai/db";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { issueService } from "./issues.js";
import { agentThreadService } from "./agent-threads.js";
import { logActivity } from "./activity-log.js";

type BridgeSource = { sourceType: "issue" | "agent_thread"; sourceId: string; taskKey: string };
type TriggerMode = "api_comment_only" | "automation_trigger";

const MAX_OUTBOUND_ATTEMPTS = 5;
const MAX_POLL_FAILURES = 10;
const MAX_IMPORTED_IDS = 1000;
const MIN_POLL_CLAIM_MS = 45_000;
const STALE_OUTBOUND_PROCESSING_MS = 2 * 60 * 1000;

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asScalarString(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Number(n) : fallback;
}

export function resolveBridgeSource(context: Record<string, unknown>): BridgeSource {
  const wake = parseObject(context.paperclipWake);
  const wakeIssue = parseObject(wake.issue);
  const issueId = asString(wakeIssue.id);
  if (issueId) return { sourceType: "issue", sourceId: issueId, taskKey: `issue:${issueId}` };
  const agentThreadId = asString(context.agentThreadId);
  if (agentThreadId) return { sourceType: "agent_thread", sourceId: agentThreadId, taskKey: `agent-thread:${agentThreadId}` };
  throw new Error("clickup_agent_ref requires paperclipWake.issue.id or agentThreadId");
}

function resolveConfig(config: Record<string, unknown>): {
  listId: string;
  apiBaseUrl: string;
  authToken: string;
  bridgeBotUserId: string | null;
  clickupAgentName?: string;
  clickupAgentUserId: number | null;
  clickupAgentUrl?: string;
  automationTags: string[];
  includeContextJson: boolean;
  mode: TriggerMode;
  statusToTriggerAgent: string | null;
  timeoutSec: number;
} {
  const parsed = parseObject(config);
  const listId = asString(parsed.listId);
  const apiBaseUrl = asString(parsed.apiBaseUrl) || "https://api.clickup.com/api/v2";
  const authToken = asString(parsed.authToken);
  const bridgeBotUserId = asScalarString(parsed.bridgeBotUserId) || null;
  const clickupAgentName = asString(parsed.clickupAgentName) || undefined;
  const clickupAgentUserId = (() => {
    const value = parsed.clickupAgentUserId;
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string" && value.trim().length > 0) {
      const parsedId = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsedId)) return parsedId;
    }
    return null;
  })();
  const clickupAgentUrl = asString(parsed.clickupAgentUrl) || undefined;
  const automationTags = (() => {
    const value = parsed.automationTags;
    if (Array.isArray(value)) {
      return value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
    return [];
  })();
  const includeContextJson = parsed.includeContextJson !== false;
  const mode: TriggerMode = asString(parsed.triggerMode) === "automation_trigger" ? "automation_trigger" : "api_comment_only";
  const statusToTriggerAgent = asString(parsed.statusToTriggerAgent) || asString(parsed.automationStatus) || null;
  const timeoutSec = Math.min(30, Math.max(10, asNumber(parsed.timeoutSec, 20)));
  if (!listId || !authToken) {
    throw new Error("clickup_agent_ref requires listId and authToken");
  }
  return {
    listId,
    apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
    authToken,
    bridgeBotUserId,
    clickupAgentName,
    clickupAgentUserId,
    clickupAgentUrl,
    automationTags,
    includeContextJson,
    mode,
    statusToTriggerAgent,
    timeoutSec,
  };
}

function nextPollAt(now = Date.now(), lastOutboundAt?: Date | null, lastImportedAt?: Date | null): Date {
  const activityAt = Math.max(lastOutboundAt?.getTime() ?? 0, lastImportedAt?.getTime() ?? 0);
  const ageMs = activityAt > 0 ? now - activityAt : 0;
  if (ageMs <= 10 * 60_000) return new Date(now + 5_000);
  if (ageMs <= 60 * 60_000) return new Date(now + 15_000);
  return new Date(now + 60_000);
}

function buildBridgeCommentPayload(
  body: string,
  cfg: ReturnType<typeof resolveConfig>,
): Record<string, unknown> {
  const adapterConfig: Parameters<typeof buildCommentPayload>[1] = {
    apiBaseUrl: cfg.apiBaseUrl,
    authToken: cfg.authToken,
    workspaceId: "bridge",
    listId: cfg.listId,
    channelId: undefined,
    clickupAgentName: cfg.clickupAgentName,
    clickupAgentUserId: cfg.clickupAgentUserId ?? undefined,
    clickupAgentUrl: cfg.clickupAgentUrl,
    triggerMode: cfg.mode,
    automationStatus: cfg.statusToTriggerAgent ?? undefined,
    automationTags: cfg.automationTags,
    includeContextJson: cfg.includeContextJson,
    timeoutSec: cfg.timeoutSec,
  };
  return buildCommentPayload(body, adapterConfig);
}

function appendImportedId(existing: unknown, id: string): string[] {
  const items = Array.isArray(existing) ? existing.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
  if (!items.includes(id)) items.push(id);
  return items.slice(-MAX_IMPORTED_IDS);
}

function extractCommentIdFromCreateResponse(rawText: string): string | null {
  try {
    const json = parseObject(JSON.parse(rawText));
    const id = asScalarString(json.id);
    return id || null;
  } catch {
    return null;
  }
}

function nextRetryAt(attempt: number, now = Date.now()): Date {
  const seq = [5, 10, 20, 40, 80];
  const sec = seq[Math.min(Math.max(attempt - 1, 0), seq.length - 1)] ?? 80;
  return new Date(now + sec * 1000);
}

function computePollClaimMs(timeoutSec: number): number {
  return Math.max(MIN_POLL_CLAIM_MS, timeoutSec * 2 * 1000);
}

function parseCreatedTaskResponse(rawText: string): { taskId: string; taskUrl: string | null } {
  try {
    const json = parseObject(JSON.parse(rawText));
    const taskId = asString(json.id);
    if (!taskId) {
      throw new Error("clickup create task missing id");
    }
    return {
      taskId,
      taskUrl: asString(json.url) || null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`clickup create task response parse failed: ${message}`);
  }
}

function parseCommentCollection(rawText: string, errorPrefix: string): unknown[] {
  try {
    const payload = parseObject(JSON.parse(rawText));
    if (Array.isArray(payload.comments)) return payload.comments;
    if (Array.isArray(payload.replies)) return payload.replies;
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${errorPrefix}: ${message}`);
  }
}

function buildTaskName(context: Record<string, unknown>, taskKey: string): string {
  const issue = parseObject(context.issue);
  const wake = parseObject(context.paperclipWake);
  const wakeIssue = parseObject(wake.issue);
  const title =
    asString(issue.title)
    || asString(wakeIssue.title)
    || asString(context.issueTitle);
  const identifier =
    asString(issue.identifier)
    || asString(wakeIssue.identifier);
  if (title && identifier) return `${identifier} - ${title}`;
  return title || identifier || taskKey;
}

function buildTaskFields(body: string, cfg: ReturnType<typeof resolveConfig>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    description: body,
  };
  if (cfg.mode !== "automation_trigger") return fields;
  if (cfg.statusToTriggerAgent) fields.status = cfg.statusToTriggerAgent;
  if (cfg.automationTags.length > 0) fields.tags = cfg.automationTags;
  return fields;
}

function renderCommentRichText(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const row = part as Record<string, unknown>;
      const directText = typeof row.text === "string" ? row.text : "";
      if (directText) return directText;
      const user = row.user && typeof row.user === "object" ? (row.user as Record<string, unknown>) : null;
      const username = user ? asString(user.username) : "";
      if (row.type === "tag") return username ? `@${username}` : "@user";
      return "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function isUserCommentForImport(raw: unknown, bridgeBotUserId: string | null, clickupAgentUserId: number | null = null): { id: string; text: string; createdAt: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = asScalarString(row.id);
  const text = asString(row.comment_text) || renderCommentRichText(row.comment);
  const author = row.user && typeof row.user === "object" ? (row.user as Record<string, unknown>) : null;
  const authorId = author ? asScalarString(author.id) : "";
  const isSystem = typeof row.comment === "object" && row.comment !== null && !Array.isArray(row.comment);
  const createdAt = Number(asScalarString(row.date) || 0);
  if (!id || !text || !authorId) return null;
  if (bridgeBotUserId && authorId === bridgeBotUserId) return null;
  if (clickupAgentUserId != null && authorId !== String(clickupAgentUserId)) return null;
  if (isSystem) return null;
  return { id, text, createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now() };
}

async function clickupRequest(url: string, init: RequestInit, timeoutSec: number): Promise<{ ok: boolean; status: number; text: string }> {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(url, { ...init, signal: c.signal });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

export function clickupBridgeService(db: Db) {
  const issuesSvc = issueService(db);
  const agentThreadsSvc = agentThreadService(db);

  return {
    async closeActiveBridges(reason: string, companyId?: string) {
      const filters = [
        or(
          eq(clickupBridges.status, "waiting_for_agent_reply"),
          eq(clickupBridges.status, "pending_clickup_task"),
        ),
        ...(companyId ? [eq(clickupBridges.companyId, companyId)] : []),
      ];
      return db
        .update(clickupBridges)
        .set({
          status: "closed",
          nextPollAt: null,
          lastError: reason,
          updatedAt: new Date(),
        })
        .where(and(...filters))
        .returning({ id: clickupBridges.id });
    },

    async enqueueFromWake(input: { companyId: string; agentId: string; context: Record<string, unknown>; config: Record<string, unknown> }) {
      const source = resolveBridgeSource(input.context);
      const cfg = resolveConfig(input.config);
      const taskName = buildTaskName(input.context, source.taskKey);
      const body = buildClickUpContextBody(input.context, {
        clickupAgentName: cfg.clickupAgentName,
        clickupAgentUrl: cfg.clickupAgentUrl,
        includeContextJson: cfg.includeContextJson,
      });
      const now = new Date();
      const [upsertedBridge] = await db
        .insert(clickupBridges)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          taskKey: source.taskKey,
          clickupListId: cfg.listId,
          mode: cfg.mode,
          status: "pending_clickup_task",
          nextPollAt: now,
        })
        .onConflictDoUpdate({
          target: [clickupBridges.companyId, clickupBridges.sourceType, clickupBridges.sourceId, clickupBridges.clickupListId],
          set: {
            agentId: input.agentId,
            mode: cfg.mode,
            updatedAt: now,
            lastError: null,
          },
        })
        // Postgres RETURNING yields post-upsert row, including existing status.
        .returning();

      let bridge = upsertedBridge!;

      if (bridge.status === "failed") {
        throw new Error("clickup bridge failed; manual retry required");
      }

      if (bridge.status === "closed") {
        const [reopened] = await db
          .update(clickupBridges)
          .set({
            status: bridge.clickupTaskId ? "waiting_for_agent_reply" : "pending_clickup_task",
            nextPollAt: now,
            lastError: null,
            updatedAt: now,
          })
          .where(eq(clickupBridges.id, bridge.id))
          .returning();
        bridge = reopened ?? bridge;
      }

      const eventKind = bridge.clickupTaskId ? "append_comment" : "create_task";
      if (eventKind === "create_task") {
        const existingCreateEvent = await db
          .select({ id: clickupOutboundEvents.id })
          .from(clickupOutboundEvents)
          .where(
            and(
              eq(clickupOutboundEvents.bridgeId, bridge.id),
              eq(clickupOutboundEvents.kind, "create_task"),
              or(eq(clickupOutboundEvents.status, "pending"), eq(clickupOutboundEvents.status, "processing")),
            ),
          )
          .limit(1);
        if (existingCreateEvent.length === 0) {
          await db.insert(clickupOutboundEvents).values({
            bridgeId: bridge.id,
            kind: eventKind,
            status: "pending",
            payload: {
              body,
              taskName,
            },
          });
        }
      } else {
        await db.insert(clickupOutboundEvents).values({
          bridgeId: bridge.id,
          kind: eventKind,
          status: "pending",
          payload: {
            body,
            taskName,
          },
        });
      }

      return { bridgeId: bridge.id, clickupTaskId: bridge.clickupTaskId ?? null };
    },

    async processOutbound(limit = 20) {
      const now = new Date();
      await db
        .update(clickupOutboundEvents)
        .set({
          status: "pending",
          updatedAt: now,
        })
        .where(
          and(
            eq(clickupOutboundEvents.status, "processing"),
            lt(clickupOutboundEvents.updatedAt, new Date(now.getTime() - STALE_OUTBOUND_PROCESSING_MS)),
          ),
        );

      const events = await db
        .select()
        .from(clickupOutboundEvents)
        .where(
          and(
            or(eq(clickupOutboundEvents.status, "pending"), eq(clickupOutboundEvents.status, "failed")),
            lt(clickupOutboundEvents.attempts, MAX_OUTBOUND_ATTEMPTS),
            or(isNull(clickupOutboundEvents.nextAttemptAt), lte(clickupOutboundEvents.nextAttemptAt, now)),
          ),
        )
        .limit(limit);

      for (const event of events) {
        if (event.attempts >= MAX_OUTBOUND_ATTEMPTS) continue;
        const [claimedEvent] = await db
          .update(clickupOutboundEvents)
          .set({ status: "processing", updatedAt: new Date() })
          .where(
            and(
              eq(clickupOutboundEvents.id, event.id),
              or(eq(clickupOutboundEvents.status, "pending"), eq(clickupOutboundEvents.status, "failed")),
            ),
          )
          .returning({ id: clickupOutboundEvents.id });
        if (!claimedEvent) continue;

        let bridge = await db.select().from(clickupBridges).where(eq(clickupBridges.id, event.bridgeId)).then((rows) => rows[0] ?? null);

        try {
          if (!bridge) {
            throw new Error("clickup bridge missing");
          }
          if (bridge.status === "failed" || bridge.status === "closed") {
            throw new Error(`clickup bridge not runnable: ${bridge.status}`);
          }

          const agent = await db.select().from(agents).where(eq(agents.id, bridge.agentId)).then((rows) => rows[0] ?? null);
          const cfg = resolveConfig(parseObject(agent?.adapterConfig));
          const headers = { "Content-Type": "application/json", Authorization: cfg.authToken };
          const payload = parseObject(event.payload);
          const body = asString(payload.body);
          const taskName = asString(payload.taskName) || bridge.taskKey;

          if (!bridge.clickupTaskId) {
            const res = await clickupRequest(
              `${cfg.apiBaseUrl}/list/${cfg.listId}/task`,
              {
                method: "POST",
                headers,
                body: JSON.stringify({
                  name: taskName,
                  notify_all: false,
                  ...(cfg.clickupAgentUserId != null ? { assignees: [cfg.clickupAgentUserId] } : {}),
                  ...buildTaskFields(body, cfg),
                }),
              },
              cfg.timeoutSec,
            );
            if (!res.ok) throw new Error(`clickup create task failed: ${res.status}`);
            const createdTask = parseCreatedTaskResponse(res.text);
            const taskId = createdTask.taskId;
            await db.update(clickupBridges).set({
              clickupTaskId: taskId,
              clickupTaskUrl: createdTask.taskUrl,
              lastError: null,
              updatedAt: new Date(),
            }).where(eq(clickupBridges.id, bridge.id));
            bridge = {
              ...bridge,
              clickupTaskId: taskId,
              clickupTaskUrl: createdTask.taskUrl,
            };

            const firstComment = await clickupRequest(
              `${cfg.apiBaseUrl}/task/${taskId}/comment`,
              { method: "POST", headers, body: JSON.stringify(buildBridgeCommentPayload(body, cfg)) },
              cfg.timeoutSec,
            );
            if (!firstComment.ok) throw new Error(`clickup first comment failed: ${firstComment.status}`);
            const firstCommentId = extractCommentIdFromCreateResponse(firstComment.text);

            await db.update(clickupBridges).set({
              clickupTaskId: taskId,
              clickupTaskUrl: createdTask.taskUrl,
              status: "waiting_for_agent_reply",
              importedCommentIds: firstCommentId ? appendImportedId(bridge.importedCommentIds, firstCommentId) : bridge.importedCommentIds,
              lastOutboundAt: new Date(),
              nextPollAt: new Date(Date.now() + 2_000),
              lastError: null,
              updatedAt: new Date(),
            }).where(eq(clickupBridges.id, bridge.id));
          } else {
            const post = await clickupRequest(
              `${cfg.apiBaseUrl}/task/${bridge.clickupTaskId}/comment`,
              { method: "POST", headers, body: JSON.stringify(buildBridgeCommentPayload(body, cfg)) },
              cfg.timeoutSec,
            );
            if (!post.ok) throw new Error(`clickup append comment failed: ${post.status}`);
            const postedCommentId = extractCommentIdFromCreateResponse(post.text);
            await db.update(clickupBridges).set({
              status: "waiting_for_agent_reply",
              importedCommentIds: postedCommentId ? appendImportedId(bridge.importedCommentIds, postedCommentId) : bridge.importedCommentIds,
              lastOutboundAt: new Date(),
              nextPollAt: new Date(Date.now() + 2_000),
              lastError: null,
              updatedAt: new Date(),
            }).where(eq(clickupBridges.id, bridge.id));
            if (bridge.mode === "automation_trigger" && cfg.statusToTriggerAgent) {
              try {
                await clickupRequest(
                  `${cfg.apiBaseUrl}/task/${bridge.clickupTaskId}`,
                  { method: "PUT", headers, body: JSON.stringify({ status: cfg.statusToTriggerAgent }) },
                  cfg.timeoutSec,
                );
              } catch {
                // Best-effort automation trigger. Comment already persisted above.
              }
            }
          }

          await db.update(clickupOutboundEvents).set({
            status: "succeeded",
            attempts: event.attempts + 1,
            lastError: null,
            updatedAt: new Date(),
          }).where(eq(clickupOutboundEvents.id, event.id));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const nonRetriableCreateParseFailure = msg.startsWith("clickup create task response parse failed:");
          const attempts = nonRetriableCreateParseFailure
            ? MAX_OUTBOUND_ATTEMPTS
            : event.attempts + 1;
          const terminal = attempts >= MAX_OUTBOUND_ATTEMPTS;
          await db.update(clickupOutboundEvents).set({
            status: terminal ? "failed" : "pending",
            attempts,
            lastError: msg,
            nextAttemptAt: terminal ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : nextRetryAt(attempts),
            updatedAt: new Date(),
          }).where(eq(clickupOutboundEvents.id, event.id));
          if (bridge) {
            const nextBridgeStatus = bridge.status === "closed"
              ? "closed"
              : terminal
                ? "failed"
                : bridge.status;
            await db.update(clickupBridges).set({
              status: nextBridgeStatus,
              lastError: msg,
              updatedAt: new Date(),
            }).where(eq(clickupBridges.id, bridge.id));
          }
        }
      }
    },

    async pollInbound(limit = 50) {
      const now = new Date();
      const bridges = await db
        .select()
        .from(clickupBridges)
        .where(
          and(
            eq(clickupBridges.status, "waiting_for_agent_reply"),
            or(isNull(clickupBridges.nextPollAt), lte(clickupBridges.nextPollAt, now)),
          ),
        )
        .limit(limit);

      for (const bridge of bridges) {
        if (!bridge.clickupTaskId) continue;
        const [claimedBridge] = await db
          .update(clickupBridges)
          .set({
            nextPollAt: new Date(Date.now() + MIN_POLL_CLAIM_MS),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(clickupBridges.id, bridge.id),
              eq(clickupBridges.status, "waiting_for_agent_reply"),
              or(isNull(clickupBridges.nextPollAt), lte(clickupBridges.nextPollAt, now)),
            ),
          )
          .returning({ id: clickupBridges.id });
        if (!claimedBridge) continue;

        try {
          const agent = await db.select().from(agents).where(eq(agents.id, bridge.agentId)).then((rows) => rows[0] ?? null);
          const cfg = resolveConfig(parseObject(agent?.adapterConfig));
          const claimMs = computePollClaimMs(cfg.timeoutSec);
          await db.update(clickupBridges).set({
            nextPollAt: new Date(Date.now() + claimMs),
            updatedAt: new Date(),
          }).where(eq(clickupBridges.id, bridge.id));
          const headers = { "Content-Type": "application/json", Authorization: cfg.authToken };
          const res = await clickupRequest(`${cfg.apiBaseUrl}/task/${bridge.clickupTaskId}/comment`, { method: "GET", headers }, cfg.timeoutSec);
          if (!res.ok) throw new Error(`clickup poll failed: ${res.status}`);

          let comments: unknown[] = [];
          try {
            comments = parseCommentCollection(res.text, "clickup task comments parse failed");
          } catch {
            comments = [];
          }
          const imported = new Set(Array.isArray(bridge.importedCommentIds) ? bridge.importedCommentIds : []);

          const replyRows: unknown[] = [];
          for (const top of comments) {
            await db.update(clickupBridges).set({
              nextPollAt: new Date(Date.now() + claimMs),
              updatedAt: new Date(),
            }).where(eq(clickupBridges.id, bridge.id));
            const topRecord = top && typeof top === "object" ? (top as Record<string, unknown>) : null;
            const topId = asScalarString(topRecord?.id);
            if (!topId) continue;
            const replyRes = await clickupRequest(`${cfg.apiBaseUrl}/comment/${topId}/reply`, { method: "GET", headers }, cfg.timeoutSec);
            if (!replyRes.ok) continue;
            try {
              const rows = parseCommentCollection(replyRes.text, `clickup reply comments parse failed for ${topId}`);
              replyRows.push(...rows);
            } catch {
              continue;
            }
          }

          const candidatesById = new Map<string, { id: string; text: string; createdAt: number }>();
          for (const item of [...comments, ...replyRows]
            .map((c) => isUserCommentForImport(c, cfg.bridgeBotUserId, cfg.clickupAgentUserId))
            .filter((c): c is { id: string; text: string; createdAt: number } => c !== null)
            .filter((c) => !imported.has(c.id))) {
            const existing = candidatesById.get(item.id);
            if (!existing || item.createdAt < existing.createdAt) {
              candidatesById.set(item.id, item);
            }
          }
          const candidates = [...candidatesById.values()]
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

          for (const item of candidates) {
            await db.update(clickupBridges).set({
              nextPollAt: new Date(Date.now() + claimMs),
              updatedAt: new Date(),
            }).where(eq(clickupBridges.id, bridge.id));
            if (bridge.sourceType === "issue") {
              const comment = await issuesSvc.addComment(bridge.sourceId, item.text, { agentId: bridge.agentId });
              const issue = await issuesSvc.getById(bridge.sourceId);
              if (issue) {
                await logActivity(db, {
                  companyId: bridge.companyId,
                  actorType: "agent",
                  actorId: bridge.agentId,
                  agentId: bridge.agentId,
                  action: "issue.comment_added",
                  entityType: "issue",
                  entityId: bridge.sourceId,
                  details: {
                    commentId: comment.id,
                    bodySnippet: comment.body.slice(0, 120),
                    identifier: issue.identifier,
                    issueTitle: issue.title,
                    source: "clickup_bridge",
                    clickupCommentId: item.id,
                    clickupTaskId: bridge.clickupTaskId,
                  },
                });
              }
            } else {
              await agentThreadsSvc.postAssistantMessage({
                companyId: bridge.companyId,
                threadId: bridge.sourceId,
                authorAgentId: bridge.agentId,
                body: item.text,
              });
            }
            imported.add(item.id);
          }

          await db.update(clickupBridges).set({
            importedCommentIds: Array.from(imported).slice(-MAX_IMPORTED_IDS),
            lastImportedCommentId: candidates[candidates.length - 1]?.id ?? bridge.lastImportedCommentId,
            lastPolledAt: new Date(),
            nextPollAt: nextPollAt(Date.now(), bridge.lastOutboundAt, bridge.lastPolledAt),
            consecutivePollFailures: 0,
            status: "waiting_for_agent_reply",
            lastError: null,
            updatedAt: new Date(),
          }).where(eq(clickupBridges.id, bridge.id));
        } catch (err) {
          const failures = (bridge.consecutivePollFailures ?? 0) + 1;
          await db.update(clickupBridges).set({
            consecutivePollFailures: failures,
            status: failures >= MAX_POLL_FAILURES ? "failed" : bridge.status,
            lastError: err instanceof Error ? err.message : String(err),
            lastPolledAt: new Date(),
            nextPollAt: nextRetryAt(Math.min(failures, 5)),
            updatedAt: new Date(),
          }).where(eq(clickupBridges.id, bridge.id));
        }
      }
    },

    async retryBridge(bridgeId: string) {
      const [bridge] = await db.select().from(clickupBridges).where(eq(clickupBridges.id, bridgeId));
      if (!bridge) return null;
      const status = bridge.clickupTaskId ? "waiting_for_agent_reply" : "pending_clickup_task";
      await db.update(clickupBridges).set({
        status,
        lastError: null,
        consecutivePollFailures: 0,
        nextPollAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(clickupBridges.id, bridgeId));
      return { id: bridgeId, status };
    },
  };
}
