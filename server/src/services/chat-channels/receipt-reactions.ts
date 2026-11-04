import type { ChatRuntime } from "../chat-runtime.js";
import type { EndpointRow, RuntimeContext, LifecycleRuntimeFence, DbOrTransaction } from "./runtime-types.js";

import { dueChatAction, PROVIDER_EFFECT_STALE_MS } from "../chat-action-work.js";

import { notifyChatActionWork } from "../chat-work-notifications.js";

import type { ChatEndpointRuntime } from "../voice/voice-runtime.js";

import {
  receiptReactionPayload,
  type ReceiptReactionPayload,
} from "../chat-receipt-reactions.js";

import { chatCredentialMutationLease, type CredentialMutationLeaseGuard } from "../chat-credential-mutation-lease.js";

import {
  and,
  asc,
  eq,
  like,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatDeliveries,
  chatEndpoints,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  ChatProvider,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import {
  parseGitHubReceiptIdentity,
  type GitHubReceiptIdentity,
} from "../chat-github-receipt-reactions.js";

import { logger } from "../../middleware/logger.js";

import { classifyChatPublicationError } from "../chat-publication-errors.js";

import type {
  Message,
  Thread,
} from "chat";

import type { EndpointRecord } from "./runtime-types.js";
import { isSlackReceiptReactionAlreadyApplied } from "./slack/messages.js";
import { beginSlackReceiptTiming } from "./slack/receipt-timing.js";

type ReceiptReactionsOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runtimeContextForRecord: (record: EndpointRecord) => RuntimeContext;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  fetchImpl: typeof fetch;
  runtime: Pick<ChatRuntime, "get">;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  redactError: (error: unknown) => string;
  MAX_ERROR_TEXT: number;
  receiptReactionTransportBarrier?: () => Promise<void>;
};

function deliveryWarningWithoutReceipt(previousDiagnostic: unknown) {
  const remaining = sql<string | null>`nullif(regexp_replace(${chatDeliveries.redactedError}, ${"^Receipt reaction [^\\n]*(\\n|$)"}, ''), '')`;
  if (typeof previousDiagnostic !== "string" || !previousDiagnostic) return remaining;
  return sql<string | null>`case
    when ${chatDeliveries.redactedError} = ${previousDiagnostic}::text then null
    when left(${chatDeliveries.redactedError}, length(${previousDiagnostic}::text) + 1) = ${previousDiagnostic}::text || ${"\n"}::text
      then nullif(substring(${chatDeliveries.redactedError} from length(${previousDiagnostic}::text) + 2), '')
    else ${remaining}
  end`;
}

export function createReceiptReactions(db: Db, options: ReceiptReactionsOptions) {
  const { endpointRecord, runtimeContextForRecord, withCredentialMutationLease, runtimeFor, fetchImpl, runtime, runtimeGeneration, credentialFingerprint, redactError, MAX_ERROR_TEXT } = options;


  async function addReceiptReaction(input: {
    deliveryId: string;
    endpoint: EndpointRow;
    message: Message;
    runtimeContext?: LifecycleRuntimeFence;
    thread: Thread;
  }): Promise<void> {
    // GitHub acknowledges through one editable response comment. Continue to
    // drain legacy eyes removals, but never create new eyes for these requests.
    if (input.endpoint.provider === "github") return;
    const record = await endpointRecord(input.endpoint.id);
    if (!record) return;
    // A live SDK object remains bound to the credentials that authenticated
    // its callback. Preserve that original fence rather than sampling the
    // endpoint again after a rotation and accidentally blessing an obsolete
    // adapter with the new generation.
    const context = input.runtimeContext ?? runtimeContextForRecord(record);
    const actionId = await db.transaction((tx) => stageReceiptReaction(tx, {
      deliveryId: input.deliveryId,
      endpoint: input.endpoint,
      threadId: input.thread.id,
      messageId: input.message.id,
      runtimeContext: context,
    }));
    if (!actionId) return;
    await processReceiptReaction(actionId);
  }

  // Stage on the caller's task transaction: acknowledgement survives a crash
  // after task acceptance, and a rollback can never leave a visible receipt.
  async function stageReceiptReaction(tx: DbOrTransaction, input: {
    deliveryId: string;
    endpoint: EndpointRow;
    threadId: string;
    messageId: string;
    runtimeContext: LifecycleRuntimeFence;
  }): Promise<string | null> {
    if (input.endpoint.provider === "github") return null;
    await notifyChatActionWork(tx, "receipt_reaction");
    const [inserted] = await tx
        .insert(chatActions)
        .values({
          companyId: input.endpoint.companyId,
          endpointId: input.endpoint.id,
          deliveryId: input.deliveryId,
          kind: "receipt_reaction",
          providerActionId: `receipt_reaction:${input.deliveryId}`,
          payload: {
            version: 1,
            operation: "add",
            threadId: input.threadId,
            messageId: input.messageId,
            reaction: "eyes",
            runtimeGeneration: input.runtimeContext.generation,
            credentialFingerprint: input.runtimeContext.credentialFingerprint,
          } satisfies ReceiptReactionPayload,
          status: "received",
        })
        .onConflictDoNothing()
        .returning({ id: chatActions.id });
    const actionId =
      inserted?.id ??
      (await tx
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, input.endpoint.id),
            eq(
              chatActions.providerActionId,
              `receipt_reaction:${input.deliveryId}`,
            ),
          ),
        )
        .then((rows) => rows[0]?.id ?? null));
    return actionId;
  }

  async function processReceiptReaction(actionId: string): Promise<void> {
    await options.receiptReactionTransportBarrier?.();
    const initialAction = await db
      .select({ endpointId: chatActions.endpointId, receivedAt: chatDeliveries.receivedAt })
      .from(chatActions)
      .leftJoin(chatDeliveries, and(
        eq(chatDeliveries.id, chatActions.deliveryId),
        eq(chatDeliveries.companyId, chatActions.companyId),
        eq(chatDeliveries.endpointId, chatActions.endpointId),
      ))
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "receipt_reaction"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!initialAction) return;
    const initialEndpoint = await endpointRecord(initialAction.endpointId);
    if (!initialEndpoint) return;
    // Receipt reactions are GitHub repository mutations too. Serialize their
    // final runtime-fence check and provider call with reconnect, secret
    // rotation, pause, and removal so credentials cannot become obsolete
    // between authorization and transport.
    await withCredentialMutationLease(initialEndpoint.endpoint, (lease) =>
      processReceiptReactionWithCredentialLease(actionId, lease, initialAction.receivedAt),
    );
  }

  async function processReceiptReactionWithCredentialLease(
    actionId: string,
    credentialLease: CredentialMutationLeaseGuard,
    receivedAt: Date | null,
  ): Promise<void> {
    let action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "receipt_reaction"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!action || ["processed", "cancelled"].includes(action.status)) return;
    const payload = receiptReactionPayload(action.payload);
    if (!payload) {
      await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "receipt_reaction");
        return tx
          .update(chatActions)
          .set({
            status: "failed",
            result: {
              code: "receipt_reaction_payload_invalid",
              retryable: false,
            },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, action.id));
      });
      return;
    }
    if (payload.operation === "add" && action.deliveryId) {
      const terminalRemoval = await db
        .select({ id: chatActions.id })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, action.endpointId),
            eq(
              chatActions.providerActionId,
              `receipt_reaction_remove:${action.deliveryId}`,
            ),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (terminalRemoval) {
        await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          await notifyChatActionWork(tx, "receipt_reaction");
          await tx
            .update(chatActions)
            .set({
              status: "cancelled",
              result: {
                ...(typeof action!.result?.attempts === "number"
                  ? { attempts: action!.result.attempts }
                  : {}),
                code: "receipt_reaction_superseded_by_terminal_publication",
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, action!.id),
                eq(chatActions.status, action!.status),
              ),
            );
          await credentialLease.assertOwned(tx);
        });
        return;
      }
    }
    if (action.status === "processing") {
      if (action.updatedAt > new Date(Date.now() - PROVIDER_EFFECT_STALE_MS))
        return;
      // Adding or removing the same reaction is idempotent. A worker
      // interruption can be retried safely without an ambiguous
      // duplicate-message boundary.
      await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "receipt_reaction");
        return tx
          .update(chatActions)
          .set({
            status: "failed",
            result: {
              ...(action.result ?? {}),
              retryable: true,
              retryAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "processing"),
              eq(chatActions.updatedAt, action.updatedAt),
            ),
          );
      });
      action = await db
        .select()
        .from(chatActions)
        .where(eq(chatActions.id, action.id))
        .then((rows) => rows[0] ?? null);
      if (!action) return;
    }
    if (action.status === "failed") {
      if (action.result?.retryable !== true) return;
      const retryAt =
        typeof action.result.retryAt === "string"
          ? new Date(action.result.retryAt)
          : null;
      if (retryAt && retryAt > new Date()) return;
    } else if (action.status !== "received") {
      return;
    }
    const attempt =
      (typeof action.result?.attempts === "number" ? action.result.attempts : 0) +
      1;
    const retainedGitHubReceipt = parseGitHubReceiptIdentity(
      action.result?.githubReceipt,
    );
    const [claimed] = await db.transaction(async (tx) => {
      await credentialLease.assertOwned(tx);
      await notifyChatActionWork(tx, "receipt_reaction");
      const rows = await tx
        .update(chatActions)
        .set({
          status: "processing",
          result: {
            attempts: attempt,
            ...(retainedGitHubReceipt
              ? { githubReceipt: retainedGitHubReceipt }
              : {}),
          },
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
    if (!claimed) return;

    let reactionProvider: ChatProvider | null = null;
    let githubReceipt: GitHubReceiptIdentity | null = retainedGitHubReceipt;
    try {
      const record = await endpointRecord(action.endpointId);
      if (
        !record ||
        !["verifying", "active"].includes(record.endpoint.status) ||
        runtimeGeneration(record.endpoint.setup) !== payload.runtimeGeneration ||
        credentialFingerprint(record.credentialSecretRefs) !==
          payload.credentialFingerprint
      ) {
        await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          await notifyChatActionWork(tx, "receipt_reaction");
          await tx
            .update(chatActions)
            .set({
              status: "cancelled",
              result: {
                attempts: attempt,
                code: "receipt_reaction_runtime_superseded",
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
        return;
      }
      reactionProvider = record.endpoint.provider;
      // Resolve the adapter only after acquiring the credential lease and
      // proving the action's durable generation/fingerprint is still current.
      // Never reuse the live callback's adapter: it may hold an installation
      // token minted by a superseded private key.
      const endpointRuntime = await runtimeFor(record.endpoint);
      const adapter = endpointRuntime.thread(payload.threadId).adapter;
      await credentialLease.assertOwned();
      if (record.endpoint.provider === "slack") {
        const finishTiming = beginSlackReceiptTiming({ operation: payload.operation, queuedAt: action.createdAt, receivedAt });
        try {
          await endpointRuntime.applySlackReceiptReaction(payload, fetchImpl);
          finishTiming("confirmed");
        } catch (error) {
          finishTiming(payload.operation === "add" && isSlackReceiptReactionAlreadyApplied(error) ? "confirmed" : "failed");
          throw error;
        }
      } else if (record.endpoint.provider === "github") {
        const assertCurrent = async () => {
          await credentialLease.assertOwned();
          const [current] = await db
            .select({ endpoint: chatEndpoints, connection: toolConnections })
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
                eq(chatEndpoints.id, action!.endpointId),
                eq(chatEndpoints.companyId, action!.companyId),
              ),
            )
            .limit(1);
          if (
            !current ||
            !["active", "verifying"].includes(current.endpoint.status) ||
            !current.connection.enabled ||
            current.connection.status !== "active" ||
            runtimeGeneration(current.endpoint.setup) !==
              payload.runtimeGeneration ||
            credentialFingerprint(current.connection.credentialSecretRefs) !==
              payload.credentialFingerprint ||
            runtime.get(action!.endpointId) !== endpointRuntime
          )
            throw new Error("GitHub receipt authority is no longer current");
        };
        const applied = await endpointRuntime.applyGitHubReceiptReaction(
          { ...payload, ...(githubReceipt ? { githubReceipt } : {}) },
          assertCurrent,
          fetchImpl,
        );
        githubReceipt = parseGitHubReceiptIdentity(applied);
        if (
          !githubReceipt ||
          (payload.operation === "add" && !githubReceipt.reactionId)
        )
          throw new Error("GitHub receipt identity was not confirmed");
      } else if (payload.operation === "remove") {
        await adapter.removeReaction(
          payload.threadId,
          payload.messageId,
          payload.reaction,
        );
      } else {
        await adapter.addReaction(
          payload.threadId,
          payload.messageId,
          payload.reaction,
        );
      }
      // The provider may already have accepted the idempotent reaction. Fence
      // the local success receipt so a reclaimed lease cannot report success
      // for an obsolete runtime.
      await db.transaction(async (tx) => {
        await credentialLease.assertOwned(tx);
        await notifyChatActionWork(tx, "receipt_reaction");
        const processed = await tx
          .update(chatActions)
          .set({
            status: "processed",
            result: {
              attempts: attempt,
              ...(githubReceipt ? { githubReceipt } : {}),
            },
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
            "Receipt-reaction ownership changed before success settlement",
          );
        }
        if (action.deliveryId) {
          await tx
            .update(chatDeliveries)
            .set({ redactedError: deliveryWarningWithoutReceipt(action.result?.redactedError), updatedAt: new Date() })
            .where(
              and(
                eq(chatDeliveries.id, action.deliveryId),
                eq(chatDeliveries.state, "processed"),
                like(chatDeliveries.redactedError, "Receipt reaction %"),
              ),
            );
        }
        await credentialLease.assertOwned(tx);
      });
    } catch (error) {
      if (
        payload.operation === "add" &&
        reactionProvider === "slack" &&
        isSlackReceiptReactionAlreadyApplied(error)
      ) {
        await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          await notifyChatActionWork(tx, "receipt_reaction");
          const processed = await tx
            .update(chatActions)
            .set({
              status: "processed",
              result: {
                attempts: attempt,
                code: "receipt_reaction_already_applied",
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, action!.id),
                eq(chatActions.status, "processing"),
                sql`(${chatActions.result}->>'attempts')::int = ${attempt}`,
              ),
            )
            .returning({ id: chatActions.id });
          if (!processed.length) {
            throw new Error(
              "Receipt-reaction ownership changed before idempotent settlement",
            );
          }
          if (action.deliveryId) {
            await tx
              .update(chatDeliveries)
              .set({ redactedError: deliveryWarningWithoutReceipt(action!.result?.redactedError), updatedAt: new Date() })
              .where(
                and(
                  eq(chatDeliveries.id, action.deliveryId),
                  eq(chatDeliveries.state, "processed"),
                  like(chatDeliveries.redactedError, "Receipt reaction %"),
                ),
              );
          }
          await credentialLease.assertOwned(tx);
        });
        return;
      }
      const disposition = classifyChatPublicationError(error, attempt);
      const retryable =
        disposition.kind === "retry" ||
        (disposition.kind === "delivery_unknown" && attempt < 3);
      const retryAfterMs =
        disposition.kind === "retry"
          ? disposition.retryAfterMs
          : 100 * 2 ** Math.max(0, attempt - 1);
      const operationLabel =
        payload.operation === "remove" ? " reaction removal" : " reaction";
      const diagnostic =
        `Receipt${operationLabel} ${retryable ? "deferred" : "failed"} after ${attempt} attempt${attempt === 1 ? "" : "s"} (${disposition.kind}): ${redactError(error).replace(/[\r\n]+/g, " ")}`.slice(
          0,
          MAX_ERROR_TEXT,
        );
      const retryAt = retryable
        ? new Date(Date.now() + retryAfterMs).toISOString()
        : null;
      await db.transaction(async (tx) => {
        await credentialLease.assertOwned(tx);
        await notifyChatActionWork(tx, "receipt_reaction");
        const [failed] = await tx
          .update(chatActions)
          .set({
            status: "failed",
            result: {
              attempts: attempt,
              ...(githubReceipt ? { githubReceipt } : {}),
              code:
                payload.operation === "remove"
                  ? `receipt_reaction_removal_${disposition.kind}`
                  : `receipt_reaction_${disposition.kind}`,
              redactedError: diagnostic,
              retryable,
              retryAt,
            },
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
        if (failed && action.deliveryId) {
          await tx
            .update(chatDeliveries)
            .set({ redactedError: sql`concat_ws(${"\n"}, ${diagnostic}::text, ${deliveryWarningWithoutReceipt(action.result?.redactedError)})`, updatedAt: new Date() })
            .where(
              and(
                eq(chatDeliveries.id, action.deliveryId),
                eq(chatDeliveries.state, "processed"),
              ),
            );
        }
        await credentialLease.assertOwned(tx);
      });
      logger.warn(
        {
          endpointId: action.endpointId,
          deliveryId: action.deliveryId,
          attempts: attempt,
          disposition: disposition.kind,
          operation: payload.operation,
          retryAt,
        },
        "external chat receipt reaction deferred",
      );
    }
  }

  async function processPendingReceiptReactions(
    limit = 25,
    onlyActionId?: string,
  ) {
    const actions = await db.select({ id: chatActions.id }).from(chatActions)
      .where(and(dueChatAction("receipt_reaction"), onlyActionId ? eq(chatActions.id, onlyActionId) : undefined))
      .orderBy(asc(chatActions.createdAt)).limit(limit);
    for (const action of actions) await processReceiptReaction(action.id);
    return actions.length;
  }
  return { stageReceiptReaction, addReceiptReaction, processReceiptReaction, processPendingReceiptReactions };
}
