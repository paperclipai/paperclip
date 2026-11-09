import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence } from "../runtime-types.js";

import { githubRepositoryInventoryItemFromPayload } from "./resources.js";

import { dueChatAction, PROVIDER_EFFECT_STALE_MS } from "../../chat-action-work.js";

import { notifyChatDeliveryWork, notifyChatActionWork } from "../../chat-work-notifications.js";

import { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";

import {
  githubBodyMentionsBot,
} from "../../chat-github-events.js";

import { githubAppJwt } from "../../chat-github-client.js";

import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatSdkState,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import {
  conflict,
} from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";

import {
  type ChatSdkProvider,
} from "../../chat-sdk-runtime.js";

import type {
  ChatSdkStatePersistence,
} from "../../chat-sdk-state.js";

import {
  listGitHubAppWebhookDeliveries,
  getGitHubAppWebhookDelivery,
  readGitHubAppWebhookConfig,
  requestGitHubAppWebhookRedelivery,
  getGitHubRecoveryComment,
  type GitHubAppWebhookDelivery,
  type GitHubAppWebhookDeliveryDetail,
} from "../../chat-github-webhook-config.js";

import type { EndpointRecord } from "../runtime-types.js";

  export type GitHubIngressStageResult =
    | { kind: "invalid_signature" }
    | { kind: "ignored" }
    | { actionId: string; kind: "staged" };

export const GITHUB_RECOVERY_STATE_KEY = "paperclip:github-webhook-recovery:v1";
export const GITHUB_RECOVERY_INTERVAL_MS = 60_000;
export const GITHUB_RECOVERY_WINDOW_MS = 60 * 60_000;
export const GITHUB_RECOVERY_SCAN_LEASE_MS = 5 * 60_000;
export type GitHubRecoveryWindow = LifecycleRuntimeFence & {
  appId: string;
  webhookUrl: string;
  floor: string;
  nextScanAt: string;
};
export type GitHubRecoveryReceipt = GitHubRecoveryWindow & {
  original: GitHubAppWebhookDeliveryDetail;
};

export function githubRecoveryWindow(value: unknown): GitHubRecoveryWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as GitHubRecoveryWindow;
  return Number.isSafeInteger(item.generation) &&
    item.generation >= 0 &&
    typeof item.credentialFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(item.credentialFingerprint) &&
    typeof item.appId === "string" &&
    /^\d+$/.test(item.appId) &&
    typeof item.webhookUrl === "string" &&
    typeof item.floor === "string" &&
    Number.isFinite(Date.parse(item.floor)) &&
    typeof item.nextScanAt === "string" &&
    Number.isFinite(Date.parse(item.nextScanAt))
    ? item
    : null;
}

export type GitHubWebhookIngressPayload = {
  version: 1;
  body: string;
  bodySha256: string;
  contentType: string;
  deliveryId: string;
  eventType: string;
  runtimeGeneration: number;
  credentialFingerprint: string;
};

export type RedactedGitHubWebhookIngressPayload = Omit<
  GitHubWebhookIngressPayload,
  "body" | "contentType"
> & {
  redacted: true;
};

export function githubWebhookIngressPayload(
  payload: Record<string, unknown>,
): GitHubWebhookIngressPayload | null {
  if (
    payload.version !== 1 ||
    typeof payload.body !== "string" ||
    typeof payload.bodySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.bodySha256) ||
    typeof payload.contentType !== "string" ||
    typeof payload.deliveryId !== "string" ||
    !payload.deliveryId ||
    typeof payload.eventType !== "string" ||
    !payload.eventType ||
    typeof payload.runtimeGeneration !== "number" ||
    !Number.isSafeInteger(payload.runtimeGeneration) ||
    typeof payload.credentialFingerprint !== "string"
  ) {
    return null;
  }
  if (
    createHash("sha256").update(payload.body).digest("hex") !==
    payload.bodySha256
  ) {
    return null;
  }
  return payload as GitHubWebhookIngressPayload;
}

export function redactedGitHubWebhookIngressPayload(
  payload: GitHubWebhookIngressPayload,
): RedactedGitHubWebhookIngressPayload {
  return {
    version: 1,
    bodySha256: payload.bodySha256,
    deliveryId: payload.deliveryId,
    eventType: payload.eventType,
    runtimeGeneration: payload.runtimeGeneration,
    credentialFingerprint: payload.credentialFingerprint,
    redacted: true,
  };
}
type GitHubWebhookIngressOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runtimeContextForRecord: (record: EndpointRecord) => RuntimeContext;
  resolveCredentialRefs: (endpoint: EndpointRow, refs: ToolCredentialSecretRef[], database?: DbOrTransaction) => Promise<Record<string, string>>;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  getWebhookPublicBaseUrl: () => string | null;
  redactError: (error: unknown) => string;
  handleWebhook: (publicId: string, provider: ChatSdkProvider, request: Request, context?: { githubIngressActionId: string; githubIngressFence: LifecycleRuntimeFence; superseded?: boolean }) => Promise<Response>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  fetchImpl: typeof fetch;
  persistence: ChatSdkStatePersistence;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  isShuttingDown: () => boolean;
  githubWebhookReplayBarrier?: () => Promise<void>;
  supportedWebhookEvents: ReadonlySet<string>;
};

export function createGitHubWebhookIngress(db: Db, options: GitHubWebhookIngressOptions) {
  const { endpointRecord, runtimeContextForRecord, resolveCredentialRefs, runtimeGeneration, credentialFingerprint, getWebhookPublicBaseUrl, redactError, handleWebhook, runtimeCallbackEndpoint, fetchImpl, persistence, withCredentialMutationLease, isShuttingDown, supportedWebhookEvents: SUPPORTED_GITHUB_WEBHOOK_EVENTS } = options;


  function githubSignatureIsValid(
    body: string,
    signature: string | null,
    webhookSecret: string | undefined,
  ): boolean {
    if (!signature || !webhookSecret) return false;
    const expected = `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  function githubWebhookContainsUserContent(eventType: string): boolean {
    return (
      eventType === "issue_comment" ||
      eventType === "issues" ||
      eventType === "pull_request" ||
      eventType === "pull_request_review" ||
      eventType === "pull_request_review_comment"
    );
  }

  function githubWebhookAddressesBot(
    payload: unknown,
    botUsername: string | null,
  ): boolean {
    if (!botUsername || !payload || typeof payload !== "object") return false;
    const comment = (payload as { comment?: unknown }).comment;
    if (!comment || typeof comment !== "object") return false;
    const body = (comment as { body?: unknown }).body;
    if (typeof body !== "string") return false;
    return githubBodyMentionsBot(body, botUsername);
  }

  function githubIngressAllowedInEndpointState(
    status: EndpointRow["status"],
    eventType: string,
  ): boolean {
    if (status === "verifying" || status === "active") return true;
    if (eventType === "ping" && (status === "draft" || status === "attention"))
      return true;
    if (
      status === "attention" &&
      [
        "github_app_authorization",
        "installation",
        "installation_repositories",
      ].includes(eventType)
    )
      return true;
    return status === "revoked" && eventType === "installation";
  }

  async function stageGitHubWebhookIngress(
    endpoint: EndpointRow,
    request: Request,
  ): Promise<GitHubIngressStageResult> {
    const body = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    const eventType = request.headers.get("x-github-event")?.trim() ?? "";
    const providerDeliveryId =
      request.headers.get("x-github-delivery")?.trim() ||
      `body:${createHash("sha256").update(body).digest("hex")}`;
    if (!SUPPORTED_GITHUB_WEBHOOK_EVENTS.has(eventType))
      return { kind: "ignored" };

    let parsedPayload: unknown = null;
    try {
      parsedPayload = JSON.parse(body) as unknown;
    } catch {
      // A valid signature is still required before a malformed body may be
      // retained. The native adapter will settle the authenticated envelope.
    }

    // Resolve from a captured ref set, then prove that exact ref set and
    // generation are still authoritative in the insertion transaction. This
    // keeps webhook authentication outside the potentially long credential
    // mutation lease without letting an obsolete secret stage new work.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await endpointRecord(endpoint.id);
      if (!record || record.endpoint.provider !== "github")
        return { kind: "ignored" };
      if (
        !githubIngressAllowedInEndpointState(record.endpoint.status, eventType)
      ) {
        return { kind: "ignored" };
      }
      const context = runtimeContextForRecord(record);
      let credentials: Record<string, string>;
      try {
        credentials = await resolveCredentialRefs(
          record.endpoint,
          record.credentialSecretRefs,
        );
      } catch (error) {
        const latest = await endpointRecord(endpoint.id);
        if (
          latest &&
          (runtimeGeneration(latest.endpoint.setup) !== context.generation ||
            credentialFingerprint(latest.credentialSecretRefs) !==
              context.credentialFingerprint)
        ) {
          continue;
        }
        throw error;
      }
      if (!githubSignatureIsValid(body, signature, credentials.webhookSecret)) {
        const latest = await endpointRecord(endpoint.id);
        if (
          latest &&
          (runtimeGeneration(latest.endpoint.setup) !== context.generation ||
            credentialFingerprint(latest.credentialSecretRefs) !==
              context.credentialFingerprint)
        ) {
          continue;
        }
        return { kind: "invalid_signature" };
      }

      const incomingInstallationId =
        parsedPayload &&
        typeof parsedPayload === "object" &&
        !Array.isArray(parsedPayload)
          ? (parsedPayload as { installation?: { id?: unknown } }).installation
              ?.id
          : undefined;
      if (
        incomingInstallationId !== undefined &&
        String(incomingInstallationId) !== credentials.installationId &&
        eventType !== "installation"
      ) {
        return { kind: "ignored" };
      }

      const bodySha256 = createHash("sha256").update(body).digest("hex");
      const staged = await db.transaction(async (tx) => {
        const currentEndpoint = await tx
          .select()
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        const currentConnection = await tx
          .select({ refs: toolConnections.credentialSecretRefs })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, record.endpoint.companyId),
              eq(toolConnections.id, record.endpoint.connectionId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!currentEndpoint || !currentConnection) return "retry" as const;
        if (
          runtimeGeneration(currentEndpoint.setup) !== context.generation ||
          credentialFingerprint(currentConnection.refs) !==
            context.credentialFingerprint
        ) {
          return "retry" as const;
        }
        if (
          !githubIngressAllowedInEndpointState(
            currentEndpoint.status,
            eventType,
          )
        ) {
          return "ignored" as const;
        }

        // Recovery history is denial-only provenance. A genuine callback
        // queued by GitHub before pause/reconnect must not be authenticated
        // into a later generation, even if the provider signs with its current
        // secret. Include archived endpoints so reusing an App cannot move a
        // delayed callback into another endpoint/company.
        const recoveryReceipts = credentials.appId
          ? await tx
              .select({
                endpointId: chatActions.endpointId,
                payload: chatActions.payload,
                status: chatActions.status,
              })
              .from(chatActions)
              .innerJoin(
                chatEndpoints,
                eq(chatEndpoints.id, chatActions.endpointId),
              )
              .where(
                and(
                  eq(chatEndpoints.provider, "github"),
                  eq(chatEndpoints.botExternalId, credentials.appId),
                  eq(chatActions.kind, "github_webhook_recovery"),
                  eq(
                    chatActions.providerActionId,
                    `github_webhook_recovery:${providerDeliveryId}`,
                  ),
                ),
              )
          : [];
        for (const receipt of recoveryReceipts) {
          const fence = githubRecoveryWindow(receipt.payload);
          const original = (receipt.payload as GitHubRecoveryReceipt).original;
          const incoming = parsedPayload as {
            action?: unknown;
            installation?: { id?: unknown };
            repository?: { id?: unknown; full_name?: unknown };
            issue?: { id?: unknown; number?: unknown };
            pull_request?: { id?: unknown; number?: unknown };
            sender?: { id?: unknown };
            comment?: {
              id?: unknown;
              body?: unknown;
              user?: { id?: unknown };
              created_at?: unknown;
              updated_at?: unknown;
            };
          } | null;
          const comment = incoming?.comment;
          if (
            !fence ||
            receipt.status === "cancelled" ||
            receipt.endpointId !== currentEndpoint.id ||
            fence.generation !== context.generation ||
            fence.credentialFingerprint !== context.credentialFingerprint ||
            fence.webhookUrl !==
              `${getWebhookPublicBaseUrl()}/api/chat-webhooks/${currentEndpoint.publicId}/github` ||
            !original?.payload?.comment ||
            original.event !== eventType ||
            incoming?.action !== "created" ||
            String(incoming?.installation?.id) !==
              original.payload.installationId ||
            String(incoming?.repository?.id) !==
              original.payload.repositoryId ||
            incoming?.repository?.full_name !==
              original.payload.repositoryFullName ||
            String(incoming?.sender?.id) !== original.payload.senderId ||
            (eventType === "issue_comment"
              ? String(incoming?.issue?.id) !== original.payload.issueId ||
                String(incoming?.issue?.number) !== original.payload.issueNumber
              : String(incoming?.pull_request?.id) !==
                  original.payload.pullRequestId ||
                String(incoming?.pull_request?.number) !==
                  original.payload.pullRequestNumber) ||
            String(comment?.id) !== original.payload.comment.id ||
            String(comment?.user?.id) !== original.payload.comment.userId ||
            comment?.created_at !== original.payload.comment.createdAt ||
            comment?.updated_at !== original.payload.comment.updatedAt ||
            typeof comment?.body !== "string" ||
            createHash("sha256").update(comment.body).digest("hex") !==
              original.payload.comment.bodySha256
          ) {
            return "ignored" as const;
          }
        }

        // Signed App webhooks can cover every installed repository. Do not
        // retain comment bodies for destinations the operator did not enable.
        if (githubWebhookContainsUserContent(eventType)) {
          const item = githubRepositoryInventoryItemFromPayload(parsedPayload);
          if (!item) return "ignored" as const;
          const providerRepositoryId =
            typeof item.metadata?.providerRepositoryId === "string"
              ? item.metadata.providerRepositoryId
              : null;
          const matchingResource = await tx
            .select({
              enabled: chatEndpointResources.enabled,
              id: chatEndpointResources.id,
            })
            .from(chatEndpointResources)
            .where(
              and(
                eq(chatEndpointResources.companyId, currentEndpoint.companyId),
                eq(chatEndpointResources.endpointId, currentEndpoint.id),
                eq(chatEndpointResources.type, "repository"),
                eq(chatEndpointResources.availability, "available"),
                or(
                  eq(
                    chatEndpointResources.providerResourceId,
                    item.providerResourceId,
                  ),
                  providerRepositoryId
                    ? sql`${chatEndpointResources.metadata}->>'providerRepositoryId' = ${providerRepositoryId}`
                    : undefined,
                ),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!matchingResource) return "ignored" as const;
          if (!matchingResource.enabled) {
            const action =
              parsedPayload &&
              typeof parsedPayload === "object" &&
              !Array.isArray(parsedPayload)
                ? (parsedPayload as { action?: unknown }).action
                : null;
            const ignoreDisabledResource = async () => {
              // Record only an authenticated, content-free admission decision.
              // Do not make operators infer a working callback from silence,
              // or retain the comment/actor/thread from a disabled repository.
              const providerEventId = `github:filtered_ingress:${createHash(
                "sha256",
              )
                .update(providerDeliveryId)
                .digest("hex")}`;
              const eventKind =
                action === "edited"
                  ? "message_updated"
                  : action === "deleted"
                    ? "message_deleted"
                    : "message";
              await notifyChatDeliveryWork(tx);
              await tx
                .insert(chatDeliveries)
                .values({
                  companyId: currentEndpoint.companyId,
                  endpointId: currentEndpoint.id,
                  providerEventId,
                  deduplicationKey: providerEventId,
                  eventKind,
                  state: "filtered",
                  processedAt: new Date(),
                  redactedError: "Destination is not enabled in Paperclip",
                  normalizedEvent: {
                    providerEventId,
                    kind: eventKind,
                    filtering: {
                      contentRetained: false,
                      reason: "destination_not_enabled",
                      resourceId: matchingResource.id,
                    },
                  },
                })
                .onConflictDoNothing();
              return "ignored" as const;
            };
            if (
              currentEndpoint.status !== "verifying" ||
              action !== "created" ||
              !githubWebhookAddressesBot(
                parsedPayload,
                currentEndpoint.botUsername,
              )
            ) {
              return ignoreDisabledResource();
            }
            const enabledResourceCount = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.endpointId, currentEndpoint.id),
                  eq(chatEndpointResources.type, "repository"),
                  eq(chatEndpointResources.enabled, true),
                  eq(chatEndpointResources.availability, "available"),
                ),
              )
              .then((rows) => rows[0]?.count ?? 0);
            if (enabledResourceCount !== 0) return ignoreDisabledResource();
          }
        }

        const payload: GitHubWebhookIngressPayload = {
          version: 1,
          body,
          bodySha256,
          contentType:
            request.headers.get("content-type") ?? "application/json",
          deliveryId: providerDeliveryId,
          eventType,
          runtimeGeneration: context.generation,
          credentialFingerprint: context.credentialFingerprint,
        };
        await notifyChatActionWork(tx, "github_webhook_ingress");
        const inserted = await tx
          .insert(chatActions)
          .values({
            companyId: currentEndpoint.companyId,
            endpointId: currentEndpoint.id,
            kind: "github_webhook_ingress",
            providerActionId: `github_webhook_ingress:${providerDeliveryId}`,
            payload,
            status: "received",
          })
          .onConflictDoNothing()
          .returning({ id: chatActions.id });
        if (inserted[0]?.id) {
          return { actionId: inserted[0].id, kind: "staged" } as const;
        }

        // An automatic callback is never authorization to reset the local
        // worker's terminal retry budget. The original may have arrived in the
        // interval between our remote scan and GitHub's asynchronous callback.
        if (recoveryReceipts.length > 0) return "ignored" as const;

        // GitHub preserves X-GitHub-Delivery when an operator uses Recent
        // Deliveries to retry a failed callback. Re-arm only the exact same,
        // currently authenticated body after a terminal processing failure.
        // Successful, cancelled, retryable, and in-flight receipts remain
        // immutable deduplication fences.
        await notifyChatActionWork(tx, "github_webhook_ingress");
        const [rearmed] = await tx
          .update(chatActions)
          .set({
            payload,
            // Keep the lifetime attempt counter monotonic. Besides bounding
            // repeated manual redeliveries, this prevents a late settlement
            // from an older processing claim from matching a fresh claim
            // after re-arm (an attempts=1 ABA).
            result: sql`jsonb_build_object(
              'attempts',
              coalesce((${chatActions.result}->>'attempts')::int, 0)
            )`,
            status: "received",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.endpointId, currentEndpoint.id),
              eq(
                chatActions.providerActionId,
                `github_webhook_ingress:${providerDeliveryId}`,
              ),
              eq(chatActions.kind, "github_webhook_ingress"),
              eq(chatActions.status, "failed"),
              sql`coalesce(${chatActions.result}->>'retryable', 'false') = 'false'`,
              sql`${chatActions.payload}->>'bodySha256' = ${bodySha256}`,
              sql`${chatActions.payload}->>'eventType' = ${eventType}`,
            ),
          )
          .returning({ id: chatActions.id });
        const actionId =
          rearmed?.id ??
          (await tx
            .select({ id: chatActions.id })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, currentEndpoint.id),
                eq(
                  chatActions.providerActionId,
                  `github_webhook_ingress:${providerDeliveryId}`,
                ),
              ),
            )
            .then((rows) => rows[0]?.id ?? null));
        return actionId
          ? ({ actionId, kind: "staged" } as const)
          : ("retry" as const);
      });
      if (staged === "retry") continue;
      if (staged === "ignored") return { kind: "ignored" };
      return staged;
    }
    throw conflict("GitHub credentials changed during webhook authentication", {
      code: "chat_endpoint_credentials_changed",
    });
  }

  function githubIngressAcceptedResponse() {
    return new Response("accepted", { status: 202 });
  }

  async function settleGitHubWebhookIngress(
    actionId: string,
    input: {
      attempts: number;
      payload: GitHubWebhookIngressPayload;
      response?: Response;
      error?: unknown;
      cancelledCode?: string;
    },
  ): Promise<void> {
    const terminalResponse =
      input.response !== undefined && input.response.status < 500;
    const terminalFailure = input.attempts >= 5;
    const cancelled = Boolean(input.cancelledCode);
    const processed = Boolean(input.response?.ok);
    const terminal =
      processed || terminalResponse || terminalFailure || cancelled;
    const retryAt = new Date(
      Date.now() +
        Math.min(60_000, 1_000 * 2 ** Math.max(0, input.attempts - 1)),
    );
    await db.transaction(async (tx) => {
      await notifyChatActionWork(tx, "github_webhook_ingress");
      return tx
        .update(chatActions)
        .set({
          status: cancelled ? "cancelled" : processed ? "processed" : "failed",
          payload: terminal
            ? redactedGitHubWebhookIngressPayload(input.payload)
            : input.payload,
          result: {
            attempts: input.attempts,
            ...(input.cancelledCode ? { code: input.cancelledCode } : {}),
            ...(input.response
              ? { httpStatus: input.response.status }
              : { error: redactError(input.error) }),
            retryable: !terminal,
            ...(!terminal ? { retryAt: retryAt.toISOString() } : {}),
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, actionId),
            eq(chatActions.kind, "github_webhook_ingress"),
            eq(chatActions.status, "processing"),
            sql`(${chatActions.result}->>'attempts')::int = ${input.attempts}`,
          ),
        );
    });
  }

  async function processGitHubWebhookIngress(
    actionId: string,
    propagateProcessingFailure = false,
  ): Promise<Response | null> {
    let action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "github_webhook_ingress"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!action) return null;
    if (["processed", "cancelled"].includes(action.status))
      return githubIngressAcceptedResponse();
    if (action.status === "failed" && action.result?.retryable !== true)
      return githubIngressAcceptedResponse();
    const payload = githubWebhookIngressPayload(action.payload);
    if (!payload) {
      await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "github_webhook_ingress");
        return tx
          .update(chatActions)
          .set({
            status: "failed",
            payload: {},
            result: {
              code: "github_webhook_ingress_payload_invalid",
              retryable: false,
            },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, action.id));
      });
      return githubIngressAcceptedResponse();
    }
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROVIDER_EFFECT_STALE_MS);
    if (action.status === "processing" && action.updatedAt > staleBefore) {
      return null;
    }
    if (action.status === "failed") {
      const retryAt =
        typeof action.result?.retryAt === "string"
          ? new Date(action.result.retryAt)
          : null;
      if (retryAt && retryAt > now) return null;
    } else if (action.status !== "received" && action.status !== "processing") {
      return null;
    }
    const attempts =
      (typeof action.result?.attempts === "number"
        ? action.result.attempts
        : 0) + 1;
    const previousAttempts = attempts - 1;
    const claimGuard =
      action.status === "processing"
        ? and(
            eq(chatActions.status, "processing"),
            lte(chatActions.updatedAt, staleBefore),
            sql`coalesce((${chatActions.result}->>'attempts')::int, 0) = ${previousAttempts}`,
          )
        : action.status === "failed"
          ? and(
              eq(chatActions.status, "failed"),
              sql`coalesce((${chatActions.result}->>'attempts')::int, 0) = ${previousAttempts}`,
            )
          : eq(chatActions.status, "received");
    const [claimed] = await db.transaction(async (tx) => {
      await notifyChatActionWork(tx, "github_webhook_ingress");
      return tx
        .update(chatActions)
        .set({
          status: "processing",
          result: { attempts },
          updatedAt: now,
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.kind, "github_webhook_ingress"),
            claimGuard,
          ),
        )
        .returning();
    });
    if (!claimed) return null;
    action = claimed;

    const record = await endpointRecord(action.endpointId);
    if (
      !record ||
      record.endpoint.provider !== "github" ||
      !githubIngressAllowedInEndpointState(
        record.endpoint.status,
        payload.eventType,
      ) ||
      runtimeGeneration(record.endpoint.setup) !== payload.runtimeGeneration ||
      credentialFingerprint(record.credentialSecretRefs) !==
        payload.credentialFingerprint
    ) {
      await settleGitHubWebhookIngress(action.id, {
        attempts,
        payload,
        cancelledCode: "github_webhook_ingress_runtime_superseded",
      });
      return githubIngressAcceptedResponse();
    }

    try {
      const credentials = await resolveCredentialRefs(
        record.endpoint,
        record.credentialSecretRefs,
      );
      const recovery = await db
        .select({ payload: chatActions.payload, status: chatActions.status })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, record.endpoint.id),
            eq(chatActions.kind, "github_webhook_recovery"),
            eq(
              chatActions.providerActionId,
              `github_webhook_recovery:${payload.deliveryId}`,
            ),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (
        recovery &&
        (recovery.status === "cancelled" ||
          !(await githubRecoverySourceIsCurrent(
            (recovery.payload as GitHubRecoveryReceipt).original,
            credentials,
          )))
      ) {
        await settleGitHubWebhookIngress(action.id, {
          attempts,
          payload,
          cancelledCode: "github_webhook_recovery_source_changed",
        });
        return githubIngressAcceptedResponse();
      }
      const signature = `sha256=${createHmac(
        "sha256",
        credentials.webhookSecret,
      )
        .update(payload.body)
        .digest("hex")}`;
      await options.githubWebhookReplayBarrier?.();
      const replayContext = {
        githubIngressActionId: action.id,
        githubIngressFence: {
          generation: payload.runtimeGeneration,
          credentialFingerprint: payload.credentialFingerprint,
        },
        superseded: false,
      };
      const response = await handleWebhook(
        record.endpoint.publicId,
        "github",
        new Request(
          `https://paperclip.internal/api/chat-webhooks/${record.endpoint.publicId}/github`,
          {
            method: "POST",
            headers: {
              "content-type": payload.contentType,
              "x-github-delivery": payload.deliveryId,
              "x-github-event": payload.eventType,
              "x-hub-signature-256": signature,
            },
            body: payload.body,
          },
        ),
        replayContext,
      );
      if (replayContext.superseded) {
        await settleGitHubWebhookIngress(action.id, {
          attempts,
          payload,
          cancelledCode: "github_webhook_ingress_runtime_superseded",
        });
        return githubIngressAcceptedResponse();
      }
      if (response.status === 401) {
        const latest = await endpointRecord(action.endpointId);
        if (
          !latest ||
          runtimeGeneration(latest.endpoint.setup) !==
            payload.runtimeGeneration ||
          credentialFingerprint(latest.credentialSecretRefs) !==
            payload.credentialFingerprint
        ) {
          await settleGitHubWebhookIngress(action.id, {
            attempts,
            payload,
            cancelledCode: "github_webhook_ingress_runtime_superseded",
          });
          return githubIngressAcceptedResponse();
        }
      }
      await settleGitHubWebhookIngress(action.id, {
        attempts,
        payload,
        response,
      });
      return response.status >= 500 && !propagateProcessingFailure
        ? githubIngressAcceptedResponse()
        : response;
    } catch (error) {
      await settleGitHubWebhookIngress(action.id, {
        attempts,
        payload,
        error,
      });
      logger.warn(
        {
          actionId: action.id,
          endpointId: action.endpointId,
          error: redactError(error),
        },
        "durable GitHub webhook processing deferred",
      );
      if (propagateProcessingFailure) throw error;
      return githubIngressAcceptedResponse();
    }
  }

  async function githubRecoveryResource(
    database: DbOrTransaction,
    endpoint: EndpointRow,
    repositoryId: string,
    repositoryFullName?: string | null,
  ) {
    return database
      .select({ id: chatEndpointResources.id })
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.companyId, endpoint.companyId),
          eq(chatEndpointResources.endpointId, endpoint.id),
          eq(chatEndpointResources.type, "repository"),
          eq(chatEndpointResources.enabled, true),
          eq(chatEndpointResources.availability, "available"),
          sql`${chatEndpointResources.metadata}->>'providerRepositoryId' = ${repositoryId}`,
          repositoryFullName
            ? eq(
                chatEndpointResources.providerResourceId,
                repositoryFullName.toLowerCase(),
              )
            : undefined,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function githubRecoveryAlreadyReceived(
    database: DbOrTransaction,
    endpoint: EndpointRow,
    guid: string,
  ) {
    const action = await database
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, endpoint.companyId),
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.providerActionId, `github_webhook_ingress:${guid}`),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (action) return true;
    // Disabled destinations intentionally retain no ingress body. Their
    // content-free filtered receipt must also remain an admission fence.
    return database
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.companyId, endpoint.companyId),
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(
            chatDeliveries.providerEventId,
            `github:filtered_ingress:${createHash("sha256").update(guid).digest("hex")}`,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
  }

  async function rememberGitHubRecoverySkip(
    endpoint: EndpointRow,
    context: LifecycleRuntimeFence,
    window: GitHubRecoveryWindow,
    original: GitHubAppWebhookDelivery,
    code: string,
  ) {
    await db.transaction(async (tx) => {
      const current = await runtimeCallbackEndpoint(tx, endpoint.id, context, [
        "active",
      ]);
      if (
        !current ||
        !original.repositoryId ||
        !(await githubRecoveryResource(tx, current, original.repositoryId))
      )
        return;
      // Only the deny tombstone is needed, not the rejected detail or source
      // contents. Remembering it lets the next bounded scan reach older valid
      // messages instead of repeatedly inspecting the same five bot callbacks.
      await tx
        .insert(chatActions)
        .values({
          companyId: current.companyId,
          endpointId: current.id,
          kind: "github_webhook_recovery",
          providerActionId: `github_webhook_recovery:${original.guid}`,
          payload: {
            ...window,
            original: { id: original.id, guid: original.guid },
          },
          status: "cancelled",
          result: { attempts: 0, code },
        })
        .onConflictDoUpdate({
          target: [chatActions.endpointId, chatActions.providerActionId],
          set: {
            status: "cancelled",
            updatedAt: new Date(),
            result: sql`coalesce(${chatActions.result}, '{}'::jsonb) || jsonb_build_object('code', ${code}::text)`,
          },
          setWhere: and(
            eq(chatActions.kind, "github_webhook_recovery"),
            sql`(${chatActions.payload}->>'generation')::int = ${context.generation}`,
            sql`${chatActions.payload}->>'credentialFingerprint' = ${context.credentialFingerprint}`,
          ),
        });
    });
  }

  async function githubRecoverySourceIsCurrent(
    detail: GitHubAppWebhookDeliveryDetail,
    credentials: Record<string, string>,
  ): Promise<boolean> {
    const comment = detail?.payload?.comment;
    if (
      !comment ||
      !detail.payload.repositoryFullName ||
      !["issue_comment", "pull_request_review_comment"].includes(detail.event)
    )
      return false;
    const current = await getGitHubRecoveryComment({
      fetch: fetchImpl,
      appToken: githubAppJwt(credentials.appId, credentials.privateKey),
      installationId: credentials.installationId,
      repositoryFullName: detail.payload.repositoryFullName,
      event: detail.event as "issue_comment" | "pull_request_review_comment",
      commentId: comment.id,
    }).catch((error) => {
      if (error?.statusCode === 404 || error?.statusCode === 410) return null;
      throw error;
    });
    if (!current) return false;
    return (
      current.id === comment.id &&
      current.userId === comment.userId &&
      current.userType === "User" &&
      current.bodySha256 === comment.bodySha256 &&
      current.createdAt === comment.createdAt &&
      current.updatedAt === comment.updatedAt &&
      (detail.event === "issue_comment"
        ? current.issueNumber === detail.payload.issueNumber
        : current.pullRequestNumber === detail.payload.pullRequestNumber)
    );
  }

  /**
   * GitHub does not retry callbacks that fail before our durable inbox. Ask
   * GitHub to redeliver a bounded recent created-comment envelope, never turn
   * delivery-history JSON into a locally signed or directly admitted request.
   * A missing/changed epoch starts at now; historical messages are not adopted
   * into a new credential/generation merely because the App can still see them.
   */
  async function processFailedGitHubWebhookDeliveries(
    limit = 5,
    onlyEndpointId?: string,
  ) {
    if (isShuttingDown() || !getWebhookPublicBaseUrl()?.startsWith("https://")) return 0;
    const now = new Date();
    const rows = await db
      .select({ endpoint: chatEndpoints })
      .from(chatEndpoints)
      .innerJoin(
        toolConnections,
        and(
          eq(toolConnections.id, chatEndpoints.connectionId),
          eq(toolConnections.companyId, chatEndpoints.companyId),
        ),
      )
      .leftJoin(
        chatSdkState,
        and(
          eq(chatSdkState.endpointId, chatEndpoints.id),
          eq(chatSdkState.stateKey, GITHUB_RECOVERY_STATE_KEY),
        ),
      )
      .where(
        and(
          eq(chatEndpoints.provider, "github"),
          eq(chatEndpoints.status, "active"),
          // Cloud Apps target the durable Cloud relay, not the direct tenant
          // callback checked by this recovery worker. The Cloud inbox owns
          // transport retries for those registrations.
          sql`nullif(${chatEndpoints.setup}#>>'{github,cloudRegistrationId}', '') is null`,
          eq(toolConnections.enabled, true),
          eq(toolConnections.status, "active"),
          onlyEndpointId ? eq(chatEndpoints.id, onlyEndpointId) : undefined,
          or(
            isNull(chatSdkState.id),
            // Backoff belongs to one runtime epoch. Reconnect or callback
            // changes must establish a fresh floor immediately, even when
            // the superseded epoch was rate limited for several hours.
            sql`${chatSdkState.value}->>'generation' is distinct from coalesce(${chatEndpoints.setup}->>'runtimeGeneration', '0')`,
            sql`${chatSdkState.value}->>'appId' is distinct from ${chatEndpoints.botExternalId}`,
            sql`${chatSdkState.value}->>'webhookUrl' is distinct from (${getWebhookPublicBaseUrl()} || '/api/chat-webhooks/' || ${chatEndpoints.publicId} || '/github')`,
            sql`(${chatSdkState.value}->>'nextScanAt')::timestamptz <= ${now.toISOString()}::timestamptz`,
          ),
        ),
      )
      .orderBy(asc(chatSdkState.updatedAt), asc(chatEndpoints.id))
      .limit(Math.min(5, Math.max(1, limit)));
    for (const { endpoint } of rows) {
      const record = await endpointRecord(endpoint.id);
      if (!record || !record.endpoint.botExternalId) continue;
      const context = runtimeContextForRecord(record);
      const webhookUrl = `${getWebhookPublicBaseUrl()}/api/chat-webhooks/${endpoint.publicId}/github`;
      const scope = { companyId: endpoint.companyId, endpointId: endpoint.id };
      const stored = await persistence.read(scope, GITHUB_RECOVERY_STATE_KEY);
      const previous = githubRecoveryWindow(stored?.value);
      const epochMatches =
        previous &&
        previous.generation === context.generation &&
        previous.credentialFingerprint === context.credentialFingerprint &&
        previous.webhookUrl === webhookUrl &&
        previous.appId === record.endpoint.botExternalId;
      if (epochMatches && Date.parse(previous.nextScanAt) > now.getTime())
        continue;
      const window: GitHubRecoveryWindow = {
        generation: context.generation,
        credentialFingerprint: context.credentialFingerprint,
        appId: record.endpoint.botExternalId,
        webhookUrl,
        floor: epochMatches ? previous.floor : now.toISOString(),
        nextScanAt: new Date(
          now.getTime() + GITHUB_RECOVERY_SCAN_LEASE_MS,
        ).toISOString(),
      };
      if (
        !(await persistence.compareAndSet({
          ...scope,
          key: GITHUB_RECOVERY_STATE_KEY,
          expectedVersion: stored?.version ?? null,
          value: window,
          expiresAt: null,
        }))
      )
        continue;
      const claimedVersion = (stored?.version ?? 0) + 1;
      let nextDelay = GITHUB_RECOVERY_INTERVAL_MS;
      let outcome = "scanned";
      let requested = 0;
      let inspected = 0;
      try {
        if (!epochMatches) {
          outcome = "epoch_initialized";
          continue;
        }
        const credentials = await resolveCredentialRefs(
          record.endpoint,
          record.credentialSecretRefs,
        );
        if (credentials.appId !== window.appId || !credentials.installationId)
          continue;
        const appToken = githubAppJwt(
          credentials.appId,
          credentials.privateKey,
        );
        const config = await readGitHubAppWebhookConfig({
          fetch: fetchImpl,
          appToken,
        });
        if (
          config.url !== webhookUrl ||
          config.contentType !== "json" ||
          config.insecureSsl !== "0"
        ) {
          outcome = "callback_mismatch";
          nextDelay = 5 * 60_000;
          continue;
        }
        const attempts: GitHubAppWebhookDelivery[] = [];
        const floor = Math.max(
          Date.parse(window.floor),
          now.getTime() - GITHUB_RECOVERY_WINDOW_MS,
        );
        let cursor: string | undefined;
        let truncated = false;
        let previousTimestamp = Number.POSITIVE_INFINITY;
        for (let page = 0; page < 3; page += 1) {
          const result = await listGitHubAppWebhookDeliveries({
            fetch: fetchImpl,
            appToken,
            cursor,
          });
          // GitHub's official recovery recipe uses newest-first pagination
          // and stops at the age floor. Reject observed ordering drift rather
          // than assuming unseen pages cannot contain a successful sibling.
          for (const attempt of result.deliveries) {
            const timestamp = Date.parse(attempt.deliveredAt);
            if (timestamp > previousTimestamp)
              throw new Error("GitHub recovery history ordering changed");
            previousTimestamp = timestamp;
            if (timestamp >= floor) attempts.push(attempt);
          }
          if (previousTimestamp < floor) break;
          if (!result.nextCursor) break;
          if (result.nextCursor === cursor)
            throw new Error("GitHub recovery pagination did not advance");
          cursor = result.nextCursor;
          truncated = page === 2;
        }
        // All pages in this time window are needed to rule out a successful
        // sibling; do not act on a partial window after hitting the work cap.
        if (truncated) {
          outcome = "history_limit_reached";
          nextDelay = 5 * 60_000;
          continue;
        }
        const groups = new Map<string, GitHubAppWebhookDelivery[]>();
        for (const attempt of attempts) {
          const group = groups.get(attempt.guid) ?? [];
          group.push(attempt);
          groups.set(attempt.guid, group);
        }
        for (const [guid, group] of groups) {
          if (
            inspected >= 5 ||
            isShuttingDown() ||
            Date.now() >= Date.parse(window.nextScanAt)
          )
            break;
          if (
            group.some(
              (item) =>
                item.statusCode !== null &&
                item.statusCode >= 200 &&
                item.statusCode < 400,
            )
          )
            continue;
          const originals = group.filter((item) => !item.redelivery);
          if (originals.length !== 1) continue;
          const original = originals[0]!;
          if (
            Date.parse(original.deliveredAt) < floor ||
            Date.parse(original.deliveredAt) > now.getTime() - 10_000 ||
            original.statusCode === null ||
            original.statusCode < 500 ||
            original.action !== "created" ||
            !["issue_comment", "pull_request_review_comment"].includes(
              original.event,
            ) ||
            original.installationId !== credentials.installationId ||
            !original.repositoryId ||
            !(await githubRecoveryResource(db, endpoint, original.repositoryId))
          )
            continue;
          const recoveryId = `github_webhook_recovery:${guid}`;
          if (await githubRecoveryAlreadyReceived(db, endpoint, guid)) continue;
          const receipt = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpoint.id),
                eq(chatActions.providerActionId, recoveryId),
              ),
            )
            .then((items) => items[0] ?? null);
          const count =
            typeof receipt?.result?.attempts === "number"
              ? receipt.result.attempts
              : 0;
          const receiptWindow = githubRecoveryWindow(receipt?.payload);
          const latest = [...group].sort(
            (left, right) =>
              Date.parse(right.deliveredAt) - Date.parse(left.deliveredAt),
          )[0]!;
          if (
            latest.statusCode === null ||
            latest.statusCode < 500 ||
            latest.throttledAt !== null ||
            Date.parse(latest.deliveredAt) > now.getTime() - 10_000
          )
            continue;
          if (
            receipt &&
            (receipt.status === "cancelled" ||
              !receiptWindow ||
              receiptWindow.generation !== window.generation ||
              receiptWindow.credentialFingerprint !==
                window.credentialFingerprint ||
              receiptWindow.webhookUrl !== window.webhookUrl ||
              count >= 3 ||
              receipt.result?.latestAttemptId === latest.id ||
              !latest.redelivery ||
              latest.statusCode === null ||
              latest.statusCode < 500 ||
              Date.parse(latest.deliveredAt) <
                Date.parse(String(receipt.result?.requestedAt)) ||
              Date.parse(String(receipt.result?.retryAt)) > now.getTime())
          )
            continue;
          inspected += 1;
          const detail = await getGitHubAppWebhookDelivery({
            fetch: fetchImpl,
            appToken,
            deliveryId: original.id,
          });
          const comment = detail.payload.comment;
          if (
            detail.id !== original.id ||
            detail.guid !== guid ||
            detail.redelivery ||
            detail.url !== webhookUrl ||
            detail.event !== original.event ||
            detail.deliveredAt !== original.deliveredAt ||
            detail.statusCode !== original.statusCode ||
            detail.installationId !== original.installationId ||
            detail.repositoryId !== original.repositoryId ||
            detail.action !== "created" ||
            detail.payload.action !== "created" ||
            detail.payload.installationId !== credentials.installationId ||
            detail.payload.repositoryId !== original.repositoryId ||
            !comment ||
            comment.userType !== "User" ||
            detail.payload.senderId !== comment.userId ||
            Date.parse(comment.createdAt) < floor ||
            comment.createdAt !== comment.updatedAt ||
            !(await githubRecoveryResource(
              db,
              endpoint,
              original.repositoryId,
              detail.payload.repositoryFullName,
            ))
          ) {
            await rememberGitHubRecoverySkip(
              endpoint,
              context,
              window,
              original,
              "not_eligible_for_recovery",
            );
            continue;
          }
          if (!(await githubRecoverySourceIsCurrent(detail, credentials))) {
            await rememberGitHubRecoverySkip(
              endpoint,
              context,
              window,
              original,
              "source_changed_or_unavailable",
            );
            continue;
          }
          await withCredentialMutationLease(endpoint, async (lease) => {
            await lease.assertOwned();
            const currentConfig = await readGitHubAppWebhookConfig({
              fetch: fetchImpl,
              appToken,
            });
            if (
              currentConfig.url !== webhookUrl ||
              currentConfig.contentType !== "json" ||
              currentConfig.insecureSsl !== "0"
            )
              return;
            const claimed = await db.transaction(async (tx) => {
              await lease.assertOwned(tx);
              const current = await runtimeCallbackEndpoint(
                tx,
                endpoint.id,
                context,
                ["active"],
              );
              if (
                !current ||
                !(await githubRecoveryResource(
                  tx,
                  current,
                  original.repositoryId!,
                  detail.payload.repositoryFullName,
                ))
              )
                return null;
              const connection = await tx
                .select({ id: toolConnections.id })
                .from(toolConnections)
                .where(
                  and(
                    eq(toolConnections.id, current.connectionId),
                    eq(toolConnections.companyId, current.companyId),
                    eq(toolConnections.enabled, true),
                    eq(toolConnections.status, "active"),
                  ),
                )
                .then((items) => items[0]);
              const scan = await tx
                .select({ id: chatSdkState.id })
                .from(chatSdkState)
                .where(
                  and(
                    eq(chatSdkState.endpointId, endpoint.id),
                    eq(chatSdkState.stateKey, GITHUB_RECOVERY_STATE_KEY),
                    eq(chatSdkState.version, claimedVersion),
                  ),
                )
                .then((items) => items[0]);
              const local = await githubRecoveryAlreadyReceived(
                tx,
                current,
                guid,
              );
              if (
                !connection ||
                !scan ||
                local ||
                isShuttingDown() ||
                Date.now() >= Date.parse(window.nextScanAt)
              )
                return null;
              const result = {
                attempts: count + 1,
                latestAttemptId: latest.id,
                requestedAt: new Date().toISOString(),
                retryAt: new Date(
                  Date.now() + 60_000 * 5 ** count,
                ).toISOString(),
              };
              const payload: GitHubRecoveryReceipt = {
                ...window,
                original: detail,
              };
              const changes = receipt
                ? await tx
                    .update(chatActions)
                    .set({
                      status: "processing",
                      result,
                      updatedAt: new Date(),
                    })
                    .where(
                      and(
                        eq(chatActions.id, receipt.id),
                        eq(chatActions.updatedAt, receipt.updatedAt),
                      ),
                    )
                    .returning({ id: chatActions.id })
                : await tx
                    .insert(chatActions)
                    .values({
                      companyId: endpoint.companyId,
                      endpointId: endpoint.id,
                      kind: "github_webhook_recovery",
                      providerActionId: recoveryId,
                      payload,
                      status: "processing",
                      result,
                    })
                    .onConflictDoNothing()
                    .returning({ id: chatActions.id });
              return changes[0]?.id ?? null;
            });
            if (!claimed) return;
            requested += 1;
            // Commit the immutable denial fence before transport. Even an
            // ambiguous POST is not reattempted without a distinct failed
            // provider delivery. A stale scanner cannot overwrite a successor.
            await lease.assertOwned();
            try {
              await requestGitHubAppWebhookRedelivery({
                fetch: fetchImpl,
                appToken,
                deliveryId: original.id,
              });
              await db
                .update(chatActions)
                .set({ status: "processed", updatedAt: new Date() })
                .where(
                  and(
                    eq(chatActions.id, claimed),
                    eq(chatActions.status, "processing"),
                    sql`(${chatActions.result}->>'attempts')::int = ${count + 1}`,
                  ),
                );
            } catch (error) {
              await db
                .update(chatActions)
                .set({ status: "delivery_unknown", updatedAt: new Date() })
                .where(
                  and(
                    eq(chatActions.id, claimed),
                    eq(chatActions.status, "processing"),
                    sql`(${chatActions.result}->>'attempts')::int = ${count + 1}`,
                  ),
                );
              throw error;
            }
          });
        }
      } catch (error) {
        outcome = "scan_failed";
        nextDelay = Math.max(
          5 * 60_000,
          Math.min(
            24 * 60 * 60_000,
            Number((error as { retryAfterMs?: unknown })?.retryAfterMs) || 0,
          ),
        );
        logger.warn(
          { endpointId: endpoint.id, error: redactError(error) },
          "GitHub webhook recovery deferred",
        );
      } finally {
        await persistence.compareAndSet({
          ...scope,
          key: GITHUB_RECOVERY_STATE_KEY,
          expectedVersion: claimedVersion,
          value: {
            ...window,
            nextScanAt: new Date(Date.now() + nextDelay).toISOString(),
            outcome,
            requested,
          },
          expiresAt: null,
        });
      }
    }
    return rows.length;
  }

  async function processPendingGitHubWebhookIngress(
    limit = 25,
    onlyActionId?: string,
  ) {
    const now = new Date();
    const actions = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(and(
        onlyActionId ? eq(chatActions.id, onlyActionId) : undefined,
        dueChatAction("github_webhook_ingress", now.getTime()),
      ))
      .orderBy(asc(chatActions.createdAt))
      .limit(limit);
    for (const action of actions) await processGitHubWebhookIngress(action.id);
    return actions.length;
  }
  return { stageGitHubWebhookIngress, githubIngressAcceptedResponse, processGitHubWebhookIngress, processFailedGitHubWebhookDeliveries, processPendingGitHubWebhookIngress };
}
