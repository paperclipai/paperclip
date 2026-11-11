import type { EndpointRow, DbTransaction, LifecycleRuntimeFence } from "../runtime-types.js";

import { PROVIDER_EFFECT_STALE_MS, dueChatAction } from "../../chat-action-work.js";
import { notifyChatActionWork } from "../../chat-work-notifications.js";

import type { chatCredentialMutationLease, CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatEndpoints,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import {
  telegramStopSubscriptionPlan,
  telegramStopSubscriptionConfirmed,
} from "../../chat-telegram-stop-subscription.js";

import {
  notFound,
} from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";

import {
  logActivity,
} from "../../activity-log.js";

import { classifyChatPublicationError } from "../../chat-publication-errors.js";

import type { EndpointRecord } from "../runtime-types.js";

export const TELEGRAM_COMMANDS = [
  { command: "task", description: "Start or continue a Paperclip task" },
  { command: "status", description: "Show the active Paperclip task" },
  { command: "new", description: "Start a new task after the current one" },
  { command: "close", description: "Close the active chat conversation" },
] as const;

export type TelegramMaintenancePayload = {
  version: 1;
  operation: "register_commands" | "remove_endpoint" | "stop_subscription";
  runtimeGeneration: number;
  credentialFingerprint: string;
  webhookUrlSha256?: string;
  botUserId?: string;
};

export function telegramMaintenancePayload(
  payload: Record<string, unknown>,
): TelegramMaintenancePayload | null {
  if (
    payload.version !== 1 ||
    (payload.operation !== "register_commands" &&
      payload.operation !== "remove_endpoint" &&
      payload.operation !== "stop_subscription") ||
    typeof payload.runtimeGeneration !== "number" ||
    !Number.isSafeInteger(payload.runtimeGeneration) ||
    typeof payload.credentialFingerprint !== "string" ||
    (payload.operation === "stop_subscription" &&
      (typeof payload.webhookUrlSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(payload.webhookUrlSha256) ||
        typeof payload.botUserId !== "string" ||
        !/^[1-9][0-9]{0,15}$/.test(payload.botUserId)))
  ) {
    return null;
  }
  return payload as TelegramMaintenancePayload;
}
type TelegramMaintenanceOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runtimeContextForRecord: (record: EndpointRecord) => LifecycleRuntimeFence;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  resolveCredentials: (endpoint: EndpointRow) => Promise<Record<string, string>>;
  clearCredentials: (endpoint: EndpointRow, lease: CredentialMutationLeaseGuard) => Promise<void>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  getWebhookPublicBaseUrl: () => string | null;
  fetchImpl: typeof fetch;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  redactError: (error: unknown) => string;
  credentialCheckTimeoutMs: number;
};

export function createTelegramMaintenance(db: Db, options: TelegramMaintenanceOptions) {
  const { endpointRecord, runtimeContextForRecord, withCredentialMutationLease, resolveCredentials, clearCredentials, runtimeCallbackEndpoint, getWebhookPublicBaseUrl, fetchImpl, runtimeGeneration, credentialFingerprint, redactError, credentialCheckTimeoutMs: PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS } = options;

  let telegramSubscriptionScanAfter: string | null = null;
  let startupDiscoveryPending = true;
  let startupDiscoveryAfter: string | null = null;
  const pendingDiscovery = new Map<string, { after: string | null }>();

  function withMaintenanceWrite<T>(write: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return db.transaction(async tx => {
      await notifyChatActionWork(tx, "telegram_maintenance");
      return write(tx);
    });
  }

  async function stageTelegramMaintenance(
    endpoint: EndpointRow,
    operation: TelegramMaintenancePayload["operation"],
  ) {
    const record = await endpointRecord(endpoint.id);
    if (!record) throw notFound("Chat endpoint not found");
    const context = runtimeContextForRecord(record);
    const subscriptionScope =
      operation === "stop_subscription"
        ? telegramStopSubscriptionScope(record.endpoint, context)
        : null;
    if (operation === "stop_subscription" && !subscriptionScope) return null;
    const operationGeneration = subscriptionScope
      ? `${context.generation}:${context.credentialFingerprint}:${subscriptionScope.botUserId}:${subscriptionScope.webhookUrlSha256}`
      : operation === "register_commands"
        ? `${context.generation}:${record.endpoint.setup.testStartedAt ?? record.endpoint.updatedAt.toISOString()}`
        : String(context.generation);
    const providerActionId = `telegram_maintenance:${operation}:${operationGeneration}`;
    const [inserted] = await withMaintenanceWrite(tx => tx
      .insert(chatActions)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        kind: "telegram_maintenance",
        providerActionId,
        payload: {
          version: 1,
          operation,
          runtimeGeneration: context.generation,
          credentialFingerprint: context.credentialFingerprint,
          ...(subscriptionScope
            ? {
                webhookUrlSha256: subscriptionScope.webhookUrlSha256,
                botUserId: subscriptionScope.botUserId,
              }
            : {}),
        } satisfies TelegramMaintenancePayload,
        status: "received",
      })
      .onConflictDoNothing()
      .returning());
    return (
      inserted ??
      (await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpoint.id),
            eq(chatActions.providerActionId, providerActionId),
          ),
        )
        .then((rows) => rows[0] ?? null))
    );
  }

  async function telegramMaintenanceRequest(
    botToken: string,
    method: "deleteWebhook" | "deleteMyCommands" | "setMyCommands",
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/${method}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const result = (await response.json()) as {
      ok?: boolean;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (response.ok && result.ok) return;
    throw Object.assign(
      new Error(
        `Telegram ${method} failed: ${result.description ?? response.status}`,
      ),
      response.status === 429
        ? {
            adapter: "telegram",
            code: "RATE_LIMITED",
            name: "AdapterRateLimitError",
            retryAfter: result.parameters?.retry_after,
            response: { status: response.status, headers: response.headers },
          }
        : {
            adapter: "telegram",
            status: response.status,
            response: { status: response.status, headers: response.headers },
          },
    );
  }

  async function processTelegramMaintenance(
    actionId: string,
    force = false,
    credentialLease?: CredentialMutationLeaseGuard,
  ): Promise<"processed" | "pending" | "failed"> {
    if (!credentialLease) {
      const initialAction = await db
        .select({ endpointId: chatActions.endpointId })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.id, actionId),
            eq(chatActions.kind, "telegram_maintenance"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!initialAction) return "failed";
      const initialEndpoint = await endpointRecord(initialAction.endpointId);
      if (!initialEndpoint) return "failed";
      // Recovery sweeps run independently from endpoint configuration. Hold
      // the same durable credential lease as reconnect, pause, and removal so
      // a stale bot token cannot mutate Telegram after its final runtime fence
      // but before transport.
      return withCredentialMutationLease(initialEndpoint.endpoint, (lease) =>
        processTelegramMaintenance(actionId, force, lease),
      );
    }
    let action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "telegram_maintenance"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!action) return "failed";
    if (action.status === "processed") return "processed";
    const payload = telegramMaintenancePayload(action.payload);
    if (!payload) {
      await withMaintenanceWrite(tx => tx
        .update(chatActions)
        .set({
          status: "failed",
          result: {
            code: "telegram_maintenance_payload_invalid",
            retryable: false,
          },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, action!.id)));
      return "failed";
    }
    if (action.status === "processing") {
      if (action.updatedAt > new Date(Date.now() - PROVIDER_EFFECT_STALE_MS))
        return "pending";
      await withMaintenanceWrite(tx => tx
        .update(chatActions)
        .set({
          status: "failed",
          result: {
            ...(action!.result ?? {}),
            retryable: true,
            retryAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action!.id),
            eq(chatActions.status, "processing"),
            eq(chatActions.updatedAt, action!.updatedAt),
          ),
        ));
      action = await db
        .select()
        .from(chatActions)
        .where(eq(chatActions.id, action.id))
        .then((rows) => rows[0] ?? null);
      if (!action) return "failed";
    }
    if (action.status === "failed") {
      if (action.result?.retryable !== true && !force) return "failed";
      const retryAt =
        typeof action.result?.retryAt === "string"
          ? new Date(action.result.retryAt)
          : null;
      if (!force && retryAt && retryAt > new Date()) return "pending";
    } else if (action.status !== "received") {
      return "failed";
    }
    const attempt =
      (typeof action.result?.attempts === "number"
        ? action.result.attempts
        : 0) + 1;
    let providerConfirmed = action.result?.providerConfirmed === true;
    const [claimed] = await withMaintenanceWrite(async (tx) => {
      await credentialLease.assertOwned(tx);
      const rows = await tx
        .update(chatActions)
        .set({
          status: "processing",
          result: { attempts: attempt, providerConfirmed },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action!.id),
            eq(chatActions.status, action!.status),
          ),
        )
        .returning();
      await credentialLease.assertOwned(tx);
      return rows;
    });
    if (!claimed) return "pending";

    try {
      const record = await endpointRecord(action.endpointId);
      if (!record || record.endpoint.provider !== "telegram") {
        throw Object.assign(new Error("Telegram endpoint is unavailable"), {
          code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
        });
      }
      if (
        payload.operation === "remove_endpoint" &&
        record.credentialSecretRefs.length === 0
      ) {
        // Recovery may observe the narrow crash window after provider cleanup
        // and credential clearing but before the action receipt was committed.
        // Empty refs prove removal cleanup crossed its final local boundary;
        // settle the idempotent action instead of misclassifying it as a
        // credential rotation.
        await withMaintenanceWrite(async (tx) => {
          await credentialLease.assertOwned(tx);
          await tx
            .update(chatActions)
            .set({
              status: "processed",
              result: { attempts: attempt, providerConfirmed: true },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, action!.id),
                eq(chatActions.status, "processing"),
                sql`(${chatActions.result}->>'attempts')::int = ${attempt}`,
              ),
            );
          await credentialLease.assertOwned(tx);
        });
        return "processed";
      }
      if (
        credentialFingerprint(record.credentialSecretRefs) !==
          payload.credentialFingerprint ||
        (payload.operation !== "remove_endpoint" &&
          runtimeGeneration(record.endpoint.setup) !==
            payload.runtimeGeneration)
      ) {
        await withMaintenanceWrite(async (tx) => {
          await credentialLease.assertOwned(tx);
          await tx
            .update(chatActions)
            .set({
              status: "cancelled",
              result: {
                attempts: attempt,
                code: "telegram_maintenance_credentials_superseded",
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, action!.id),
                eq(chatActions.status, "processing"),
                sql`(${chatActions.result}->>'attempts')::int = ${attempt}`,
              ),
            );
          await credentialLease.assertOwned(tx);
        });
        return "failed";
      }
      if (!providerConfirmed || payload.operation === "stop_subscription") {
        const credentials = await resolveCredentials(record.endpoint);
        if (!credentials.botToken) {
          throw Object.assign(new Error("Telegram bot token is unavailable"), {
            code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
          });
        }
        if (payload.operation === "stop_subscription") {
          await repairTelegramStopSubscription(
            record.endpoint,
            payload,
            credentialLease,
          );
          providerConfirmed = true;
        } else if (payload.operation === "register_commands") {
          await credentialLease.assertOwned();
          await telegramMaintenanceRequest(
            credentials.botToken,
            "setMyCommands",
            { commands: TELEGRAM_COMMANDS },
          );
          providerConfirmed = true;
        } else {
          await credentialLease.assertOwned();
          await telegramMaintenanceRequest(
            credentials.botToken,
            "deleteWebhook",
            { drop_pending_updates: false },
          );
          await credentialLease.assertOwned();
          await telegramMaintenanceRequest(
            credentials.botToken,
            "deleteMyCommands",
            {},
          );
          providerConfirmed = true;
        }
        await credentialLease.assertOwned();
        await withMaintenanceWrite(async (tx) => {
          await credentialLease.assertOwned(tx);
          const confirmed = await tx
            .update(chatActions)
            .set({
              result: { attempts: attempt, providerConfirmed: true },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, action.id),
                eq(chatActions.status, "processing"),
                sql`(${chatActions.result}->>'attempts')::int = ${attempt}`,
              ),
            )
            .returning({ id: chatActions.id });
          if (!confirmed.length) {
            throw new Error(
              "Telegram maintenance ownership changed before provider confirmation",
            );
          }
          await credentialLease.assertOwned(tx);
        });
      }
      if (payload.operation === "remove_endpoint") {
        await credentialLease.assertOwned();
        await clearCredentials(record.endpoint, credentialLease);
      }
      await withMaintenanceWrite(async (tx) => {
        await credentialLease.assertOwned(tx);
        const processed = await tx
          .update(chatActions)
          .set({
            status: "processed",
            result: { attempts: attempt, providerConfirmed: true },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "processing"),
              sql`(${chatActions.result}->>'attempts')::int = ${attempt}`,
            ),
          )
          .returning({ id: chatActions.id });
        if (!processed.length) {
          throw new Error(
            "Telegram maintenance ownership changed before success settlement",
          );
        }
        await credentialLease.assertOwned(tx);
      });
      await logActivity(db, {
        companyId: record.endpoint.companyId,
        actorType: "system",
        actorId: "chat-maintenance",
        action: `chat_endpoint.telegram_${payload.operation}_completed`,
        entityType: "tool_connection",
        entityId: record.endpoint.connectionId,
        details: { endpointId: record.endpoint.id, attempt },
      });
      return "processed";
    } catch (error) {
      const disposition = classifyChatPublicationError(error, attempt);
      // Webhook/menu mutations are idempotent provider operations. A lost
      // response is safe to retry, and an explicit provider Retry-After must
      // remain durable rather than occupying an in-memory timer.
      const retryable =
        disposition.kind === "retry" || disposition.kind === "delivery_unknown";
      const retryAfterMs =
        disposition.kind === "retry"
          ? disposition.retryAfterMs
          : Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
      const retryAt = retryable
        ? new Date(Date.now() + retryAfterMs).toISOString()
        : null;
      const diagnostic = redactError(error);
      await withMaintenanceWrite(tx => tx
        .update(chatActions)
        .set({
          status: "failed",
          result: {
            attempts: attempt,
            code: `telegram_maintenance_${disposition.kind}`,
            providerConfirmed:
              providerConfirmed || action!.result?.providerConfirmed === true,
            redactedError: diagnostic,
            retryable,
            retryAt,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action!.id),
            eq(chatActions.status, "processing"),
            sql`(${chatActions.result}->>'attempts')::int = ${attempt}`,
          ),
        ));
      await logActivity(db, {
        companyId: action.companyId,
        actorType: "system",
        actorId: "chat-maintenance",
        action: `chat_endpoint.telegram_${payload.operation}_deferred`,
        entityType: "tool_connection",
        entityId:
          (await endpointRecord(action.endpointId))?.endpoint.connectionId ??
          action.endpointId,
        details: {
          endpointId: action.endpointId,
          attempt,
          disposition: disposition.kind,
          retryAt,
        },
      }).catch((auditError) => {
        logger.error(
          { endpointId: action!.endpointId, error: redactError(auditError) },
          "could not persist Telegram maintenance deferral audit",
        );
      });
      logger.warn(
        {
          endpointId: action.endpointId,
          operation: payload.operation,
          retryAt,
        },
        "Telegram maintenance was deferred",
      );
      return retryable ? "pending" : "failed";
    }
  }

  async function discoverTelegramSubscriptions(limit: number, after: string | null, connectionId?: string, signal?: AbortSignal) {
    // Keyset scanning bounds each sweep without starving endpoints behind a
    // page whose subscriptions were already confirmed. No provider I/O here.
    const candidates = await db
      .select({ endpoint: chatEndpoints })
      .from(chatEndpoints)
      .innerJoin(
        toolConnections,
        and(
          eq(toolConnections.id, chatEndpoints.connectionId),
          eq(toolConnections.companyId, chatEndpoints.companyId),
        ),
      )
      .where(
        and(
          eq(chatEndpoints.provider, "telegram"),
          eq(chatEndpoints.status, "active"),
          eq(toolConnections.status, "active"),
          eq(toolConnections.enabled, true),
          connectionId !== undefined ? eq(chatEndpoints.connectionId, connectionId) : undefined,
          after
            ? gt(chatEndpoints.id, after)
            : undefined,
        ),
      )
      .orderBy(asc(chatEndpoints.id))
      .limit(Math.max(1, Math.min(limit, 100)));
    for (const { endpoint } of candidates) {
      signal?.throwIfAborted();
      try {
        const record = await endpointRecord(endpoint.id);
        if (
          record &&
          !(await hasTelegramStopSubscription(
            record.endpoint,
            runtimeContextForRecord(record),
          ))
        )
          await stageTelegramMaintenance(record.endpoint, "stop_subscription");
      } catch (error) {
        logger.warn(
          { endpointId: endpoint.id },
          "Telegram subscription maintenance could not be staged",
        );
        // Keep the pass recoverable. Earlier staged rows are idempotent, and
        // failed discovery must not become invisible until the next restart.
        throw error;
      }
    }
    return candidates.length >= Math.max(1, Math.min(limit, 100))
      ? candidates.at(-1)!.endpoint.id : null;
  }

  async function processTelegramSubscriptionDiscovery(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const scoped = pendingDiscovery.entries().next().value;
    if (scoped) {
      const [connectionId, request] = scoped;
      const after = await discoverTelegramSubscriptions(100, request.after, connectionId, signal);
      // A commit during this page replaces the request and requires a fresh
      // scoped pass, including changes behind its cursor.
      if (pendingDiscovery.get(connectionId) === request) {
        if (after === null) pendingDiscovery.delete(connectionId);
        else request.after = after;
      }
    } else if (startupDiscoveryPending) {
      startupDiscoveryAfter = await discoverTelegramSubscriptions(100, startupDiscoveryAfter, undefined, signal);
      startupDiscoveryPending = startupDiscoveryAfter !== null;
    }
  }

  function scheduleTelegramSubscriptionDiscovery(connectionId: string) {
    pendingDiscovery.set(connectionId, { after: null });
  }

  function hasPendingTelegramSubscriptionDiscovery() {
    return startupDiscoveryPending || pendingDiscovery.size > 0;
  }

  async function processPendingTelegramMaintenance(limit = 25) {
    // Preserve the explicit bounded recovery helper. The app's periodic
    // reconciliation no longer calls it; registered workers own both lanes.
    telegramSubscriptionScanAfter = await discoverTelegramSubscriptions(limit, telegramSubscriptionScanAfter);
    return processPendingTelegramActions(limit);
  }

  async function processPendingTelegramActions(limit = 25) {
    const actions = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(dueChatAction("telegram_maintenance"))
      .orderBy(asc(chatActions.createdAt))
      .limit(limit);
    for (const action of actions) await processTelegramMaintenance(action.id);
    return actions.length;
  }

  function telegramStopSubscriptionScope(
    endpoint: EndpointRow,
    context: LifecycleRuntimeFence,
  ) {
    if (
      endpoint.provider !== "telegram" ||
      !endpoint.botExternalId ||
      !getWebhookPublicBaseUrl()
    )
      return null;
    const webhookUrlSha256 = createHash("sha256")
      .update(
        `${getWebhookPublicBaseUrl()}/api/chat-webhooks/${endpoint.publicId}/telegram`,
      )
      .digest("hex");
    return {
      version: 1,
      botUserId: endpoint.botExternalId,
      runtimeGeneration: context.generation,
      credentialFingerprint: context.credentialFingerprint,
      webhookUrlSha256,
    };
  }

  async function hasTelegramStopSubscription(
    endpoint: EndpointRow,
    context: LifecycleRuntimeFence,
  ): Promise<boolean> {
    const scope = telegramStopSubscriptionScope(endpoint, context);
    if (!scope) return false;
    const [receipt] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, endpoint.companyId),
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.kind, "telegram_stop_subscription"),
          eq(
            chatActions.providerActionId,
            `telegram-stop-subscription:${scope.runtimeGeneration}:${scope.credentialFingerprint}:${scope.webhookUrlSha256}`,
          ),
          eq(chatActions.status, "processed"),
        ),
      )
      .limit(1);
    return (
      !!receipt &&
      receipt.result?.code === "telegram_stop_subscription_confirmed" &&
      Object.keys(receipt.payload).length === Object.keys(scope).length &&
      Object.entries(scope).every(
        ([key, value]) => receipt.payload[key] === value,
      )
    );
  }

  async function recordTelegramStopSubscription(
    endpoint: EndpointRow,
    context: LifecycleRuntimeFence,
    lease: CredentialMutationLeaseGuard,
  ): Promise<void> {
    const scope = telegramStopSubscriptionScope(endpoint, context);
    if (!scope)
      throw new Error("Telegram Stop subscription scope is unavailable");
    await db.transaction(async (tx) => {
      await lease.assertOwned(tx);
      const current = await runtimeCallbackEndpoint(tx, endpoint.id, context, [
        "verifying",
        "active",
      ]);
      if (
        !current ||
        current.botExternalId !== scope.botUserId ||
        current.publicId !== endpoint.publicId
      )
        throw new Error("Telegram Stop subscription ownership changed");
      const [connection] = await tx
        .select()
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.id, current.connectionId),
            eq(toolConnections.companyId, current.companyId),
          ),
        )
        .for("share");
      if (
        !connection?.enabled ||
        connection.status !== "active" ||
        credentialFingerprint(connection.credentialSecretRefs) !==
          context.credentialFingerprint
      )
        throw new Error(
          "Telegram Stop subscription credential ownership changed",
        );
      await tx
        .insert(chatActions)
        .values({
          companyId: endpoint.companyId,
          endpointId: endpoint.id,
          kind: "telegram_stop_subscription",
          providerActionId: `telegram-stop-subscription:${scope.runtimeGeneration}:${scope.credentialFingerprint}:${scope.webhookUrlSha256}`,
          payload: scope,
          status: "processed",
          result: { code: "telegram_stop_subscription_confirmed" },
        })
        .onConflictDoUpdate({
          target: [chatActions.endpointId, chatActions.providerActionId],
          set: {
            payload: scope,
            status: "processed",
            result: { code: "telegram_stop_subscription_confirmed" },
            updatedAt: new Date(),
          },
        });
      await lease.assertOwned(tx);
    });
  }

  async function repairTelegramStopSubscription(
    endpoint: EndpointRow,
    payload: TelegramMaintenancePayload,
    lease: CredentialMutationLeaseGuard,
  ): Promise<void> {
    const plainObject = (value: unknown): Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const context = {
      generation: payload.runtimeGeneration,
      credentialFingerprint: payload.credentialFingerprint,
    };
    const scope = telegramStopSubscriptionScope(endpoint, context);
    const reject = () =>
      Object.assign(
        new Error(
          "Telegram subscription cannot be safely upgraded under current ownership",
        ),
        {
          code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
        },
      );
    if (
      !scope ||
      scope.webhookUrlSha256 !== payload.webhookUrlSha256 ||
      scope.botUserId !== payload.botUserId
    )
      throw reject();
    const assertCurrent = async () =>
      db.transaction(async (tx) => {
        await lease.assertOwned(tx);
        const current = await runtimeCallbackEndpoint(
          tx,
          endpoint.id,
          context,
          ["active"],
        );
        if (
          !current ||
          current.companyId !== endpoint.companyId ||
          current.botExternalId !== scope.botUserId ||
          current.publicId !== endpoint.publicId
        )
          throw reject();
        const [connection] = await tx
          .select()
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.id, current.connectionId),
              eq(toolConnections.companyId, current.companyId),
            ),
          )
          .for("share");
        if (
          !connection?.enabled ||
          connection.status !== "active" ||
          credentialFingerprint(connection.credentialSecretRefs) !==
            context.credentialFingerprint
        )
          throw reject();
        await lease.assertOwned(tx);
      });
    await assertCurrent();
    // A recovered providerConfirmed flag is not a subscription capability.
    // Only the separately committed exact current receipt can avoid fresh I/O.
    if (await hasTelegramStopSubscription(endpoint, context)) return;
    const credentials = await resolveCredentials(endpoint);
    if (
      !credentials.botToken ||
      typeof credentials.webhookSecret !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(credentials.webhookSecret)
    )
      throw reject();
    const request = async (
      method: "getMe" | "getWebhookInfo" | "setWebhook",
      body: Record<string, unknown> = {},
    ) => {
      await assertCurrent();
      let response: Response;
      try {
        response = await fetchImpl(
          `https://api.telegram.org/bot${encodeURIComponent(credentials.botToken!)}/${method}`,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
      } catch {
        // Network errors can embed a token-bearing URL. Keep maintenance
        // diagnostics closed rather than forwarding provider/transport prose.
        throw new Error(
          "Telegram subscription transport did not confirm completion",
        );
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error("Telegram subscription returned an invalid response");
      }
      const result = plainObject(value);
      if (!response.ok || result.ok !== true) {
        const retryAfter = plainObject(result.parameters).retry_after;
        throw Object.assign(
          new Error("Telegram subscription request was not confirmed"),
          response.status === 429
            ? {
                adapter: "telegram",
                code: "RATE_LIMITED",
                name: "AdapterRateLimitError",
                retryAfter:
                  typeof retryAfter === "number" && Number.isFinite(retryAfter)
                    ? retryAfter
                    : undefined,
                response: {
                  status: response.status,
                  headers: response.headers,
                },
              }
            : {
                adapter: "telegram",
                status: response.status,
                response: {
                  status: response.status,
                  headers: response.headers,
                },
              },
        );
      }
      return result.result;
    };
    const identity = plainObject(await request("getMe"));
    if (
      identity.is_bot !== true ||
      !Number.isSafeInteger(identity.id) ||
      String(identity.id) !== scope.botUserId
    )
      throw reject();
    const url = `${getWebhookPublicBaseUrl()}/api/chat-webhooks/${endpoint.publicId}/telegram`;
    const plan = telegramStopSubscriptionPlan(
      await request("getWebhookInfo"),
      url,
    );
    if (!plan) throw reject();
    // No URL repoint, credential rotation, certificate guess, IP pin, or queue
    // dropping. A successful SET proves the stored secret; GET cannot do so.
    if (
      (await request("setWebhook", {
        url,
        secret_token: credentials.webhookSecret,
        ...plan,
        drop_pending_updates: false,
      })) !== true
    )
      throw new Error("Telegram subscription mutation was not confirmed");
    if (
      !telegramStopSubscriptionConfirmed(
        await request("getWebhookInfo"),
        url,
        plan,
      )
    )
      throw new Error("Telegram subscription verification changed");
    await assertCurrent();
    await recordTelegramStopSubscription(endpoint, context, lease);
  }
  return { stageTelegramMaintenance, processTelegramMaintenance, processPendingTelegramMaintenance, processPendingTelegramActions, processTelegramSubscriptionDiscovery, scheduleTelegramSubscriptionDiscovery, hasPendingTelegramSubscriptionDiscovery, hasTelegramStopSubscription, recordTelegramStopSubscription };
}
