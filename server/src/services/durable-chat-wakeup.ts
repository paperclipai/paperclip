import { createHash } from "node:crypto";
import { agentWakeupRequests, chatActions, chatDeliveries, chatEndpoints, type Db } from "@paperclipai/db";
import { and, eq, inArray, or, sql, type SQLWrapper } from "drizzle-orm";
import { HttpError } from "../errors.js";

export interface CommittedChatResponseAuthorizationInput {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  resultId: string;
}

type CommittedChatResponseAuthority = (
  tx: Db,
  input: CommittedChatResponseAuthorizationInput,
) => Promise<void>;

const committedChatResponseAuthorities = new WeakMap<
  Db,
  CommittedChatResponseAuthority
>();

const committedChatResponseAuthorityListeners = new WeakMap<Db, Set<() => void>>();

export function onCommittedChatResponseAuthorityRegistered(db: Db, listener: () => void): () => void {
  let listeners = committedChatResponseAuthorityListeners.get(db);
  if (!listeners) {
    listeners = new Set();
    committedChatResponseAuthorityListeners.set(db, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && committedChatResponseAuthorityListeners.get(db) === listeners) committedChatResponseAuthorityListeners.delete(db);
  };
}

export class CommittedChatResponseAuthorizationError extends HttpError {
  constructor() {
    super(
      409,
      "The accepted chat response is no longer authorized for this conversation.",
      {
        code: "chat_committed_response_not_authorized",
      },
    );
    this.name = "CommittedChatResponseAuthorizationError";
  }
}

/** Separate, server-only authority for presenting an already accepted result.
 * This grants no permission to execute or repair the provider session. */
export function registerCommittedChatResponseAuthority(
  db: Db,
  authority: CommittedChatResponseAuthority,
): () => void {
  committedChatResponseAuthorities.set(db, authority);
  for (const listener of committedChatResponseAuthorityListeners.get(db) ?? []) listener();
  return () => {
    if (committedChatResponseAuthorities.get(db) === authority) {
      committedChatResponseAuthorities.delete(db);
    }
  };
}

export async function authorizeCommittedChatResponse(
  db: Db,
  tx: Db,
  input: CommittedChatResponseAuthorizationInput,
): Promise<void> {
  const authority = committedChatResponseAuthorities.get(db);
  if (!authority) throw new CommittedChatResponseAuthorizationError();
  await authority(tx, input);
}

export interface FailedChatRunRetryAuthorizationInput {
  phase: "admission" | "promotion" | "execution";
  wakeupRequestId: string | null;
  companyId: string;
  agentId: string;
  issueId: string | null;
  runId?: string;
  contextSnapshot: Record<string, unknown>;
}

type FailedChatRunRetryAuthority = (
  tx: Db,
  input: FailedChatRunRetryAuthorizationInput & {
    wakeupRequestId: string;
    issueId: string;
  },
) => Promise<void>;

const failedChatRunRetryAuthorities = new WeakMap<
  Db,
  FailedChatRunRetryAuthority
>();

export class FailedChatRunRetryAuthorizationError extends HttpError {
  constructor() {
    super(
      409,
      "The exact failed chat request is no longer authorized. Send a new request in the current connected conversation.",
      {
        code: "chat_failed_run_retry_not_authorized",
      },
    );
    this.name = "FailedChatRunRetryAuthorizationError";
  }
}

/** The live chat service supplies the authority; serialized wake hints never do. */
export function registerFailedChatRunRetryAuthority(
  db: Db,
  authority: FailedChatRunRetryAuthority,
): () => void {
  failedChatRunRetryAuthorities.set(db, authority);
  return () => {
    if (failedChatRunRetryAuthorities.get(db) === authority) {
      failedChatRunRetryAuthorities.delete(db);
    }
  };
}

/** Re-discover retry provenance from the durable action, including after restart
 * or when an untrusted caller strips the serialized retry selector. */
export async function authorizeFailedChatRunRetryWake(
  db: Db,
  tx: Db,
  input: FailedChatRunRetryAuthorizationInput,
): Promise<boolean> {
  const action = input.wakeupRequestId
    ? await tx
        .select({ companyId: chatActions.companyId, kind: chatActions.kind, payload: chatActions.payload })
        .from(chatActions)
        .where(eq(chatActions.id, input.wakeupRequestId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  if (action?.kind !== "failed_run_retry") {
    if (Object.hasOwn(input.contextSnapshot, "chatFailedRunRetry")) {
      throw new FailedChatRunRetryAuthorizationError();
    }
    return false;
  }
  const authority = failedChatRunRetryAuthorities.get(db);
  const selector = input.contextSnapshot.chatFailedRunRetry;
  if (
    !authority ||
    action.companyId !== input.companyId ||
    !input.issueId ||
    !input.wakeupRequestId ||
    !selector ||
    typeof selector !== "object" ||
    Array.isArray(selector) ||
    (selector as Record<string, unknown>).version !== 1 ||
    (selector as Record<string, unknown>).actionId !== input.wakeupRequestId ||
    typeof (selector as Record<string, unknown>).failedRunId !== "string" ||
    !(selector as Record<string, unknown>).failedRunId ||
    (selector as Record<string, unknown>).failedRunId !==
      input.contextSnapshot.retryOfRunId ||
    (input.contextSnapshot.forceFreshSession === true &&
      (typeof action.payload.taskRetryIntentId !== "string" ||
        input.contextSnapshot.taskRetryRequestId !== action.payload.taskRetryIntentId)) ||
    ["resumeFromRunId", "resumeSessionParams", "resumeSessionDisplayId"].some(
      (key) => Object.hasOwn(input.contextSnapshot, key),
    )
  ) {
    throw new FailedChatRunRetryAuthorizationError();
  }
  await authority(tx, {
    ...input,
    issueId: input.issueId,
    wakeupRequestId: input.wakeupRequestId,
  });
  return true;
}

/** Prevent automatic recovery from treating committed-but-unadmitted input as
 * an ordinary stranded task. A receipt is historical admission evidence even
 * if its run subsequently fails or is cancelled; skipped was never admitted. */
export function unadmittedChatWakeupCondition(
  issueId: SQLWrapper,
  companyId: SQLWrapper,
) {
  return sql`case when exists (
    select 1 from chat_conversations unadmitted_conversation
    where unadmitted_conversation.company_id = ${companyId}
      and unadmitted_conversation.issue_id = ${issueId}
  ) then exists (
    select 1 from chat_actions chat_unadmitted
    where chat_unadmitted.company_id = ${companyId}
      and chat_unadmitted.payload->>'issueId' = ${issueId}::text
      and chat_unadmitted.kind = 'inbound_wakeup'
      and chat_unadmitted.status in ('preparing', 'issued', 'processing', 'failed')
      and not exists (
        select 1 from agent_wakeup_requests chat_admission
        where chat_admission.id = chat_unadmitted.id
          and chat_admission.company_id = chat_unadmitted.company_id
          and chat_admission.agent_id::text = chat_unadmitted.payload->>'agentId'
          and chat_admission.status <> 'skipped'
      )
      and not exists (
        select 1 from chat_actions chat_retry
        join agent_wakeup_requests chat_retry_admission on chat_retry_admission.id = chat_retry.id
        where chat_retry.company_id = chat_unadmitted.company_id
          and chat_retry.endpoint_id = chat_unadmitted.endpoint_id
          and chat_retry.conversation_id = chat_unadmitted.conversation_id
          and chat_retry.kind = 'failed_run_retry'
          and chat_retry.payload->'taskRetryInput'->'skippedActionIds' ? chat_unadmitted.id::text
          and chat_retry.payload->>'issueId' = chat_unadmitted.payload->>'issueId'
          and chat_retry_admission.company_id = chat_retry.company_id
          and chat_retry_admission.agent_id::text = chat_retry.payload->>'agentId'
          and chat_retry_admission.status <> 'skipped'
      )
      and (chat_unadmitted.status <> 'failed' or not exists (
        select 1 from chat_actions chat_later
        join agent_wakeup_requests chat_later_admission on chat_later_admission.id = chat_later.id
        where chat_later.company_id = chat_unadmitted.company_id
          and chat_later.endpoint_id = chat_unadmitted.endpoint_id
          and chat_later.conversation_id = chat_unadmitted.conversation_id
          and chat_later.payload->>'sessionGeneration' = chat_unadmitted.payload->>'sessionGeneration'
          and chat_later.payload->>'issueId' = chat_unadmitted.payload->>'issueId'
          and chat_later.kind = 'inbound_wakeup'
          and (chat_later.created_at, chat_later.id) > (chat_unadmitted.created_at, chat_unadmitted.id)
          and chat_later_admission.company_id = chat_later.company_id
          and chat_later_admission.agent_id::text = chat_later.payload->>'agentId'
          and chat_later_admission.status <> 'skipped'
      ))
  ) else false end`;
}

export interface DeferredChatWakeScope {
  companyId: string;
  agentId: string;
  issueId: string;
  requestId: string;
}
const deferredChatWakeOwners = new WeakMap<Db, (input: DeferredChatWakeScope) => Promise<void>>();

/** The live inbound owner reauthorizes the original source. Cleanup owns no chat authority. */
export function registerDeferredChatWakeOwner(db: Db, owner: (input: DeferredChatWakeScope) => Promise<void>) {
  deferredChatWakeOwners.set(db, owner);
  return () => { if (deferredChatWakeOwners.get(db) === owner) deferredChatWakeOwners.delete(db); };
}
export async function resumeDeferredChatWake(db: Db, input: DeferredChatWakeScope) {
  await deferredChatWakeOwners.get(db)?.(input);
}

/** Internal authority: this object cannot be supplied through a JSON API. */
export interface DurableChatWakeupRequest {
  readonly id: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly issueId: string;
  readonly commentId: string;
  readonly requestedByActorType: "user" | "system";
  readonly requestedByActorId: string;
  readonly requestedAt: Date;
  readonly idempotencyKey: string;
  readonly failedRunRetry?: { readonly failedRunId: string };
  /** Only the current inbound owner may reconsider its already saved, unconsumed receipt. */
  readonly resumeDeferred?: true;
  readonly authorize: (tx: Db) => Promise<void>;
  readonly onAdmitted?: (tx: Db, receipt: { runId: string | null }) => Promise<void>;
}

const trustedRequests = new WeakSet<object>();

export function createDurableChatWakeupRequest(
  input: Omit<DurableChatWakeupRequest, "idempotencyKey">,
): DurableChatWakeupRequest {
  const idempotencyKey = `chat-inbound:${createHash("sha256")
    .update(
      JSON.stringify([
        input.id,
        input.companyId,
        input.agentId,
        input.issueId,
        input.commentId,
        input.requestedByActorType,
        input.requestedByActorId,
      ]),
    )
    .digest("hex")}`;
  const request = Object.freeze({
    ...input,
    ...(input.failedRunRetry
      ? { failedRunRetry: Object.freeze({ ...input.failedRunRetry }) }
      : {}),
    idempotencyKey,
  });
  trustedRequests.add(request);
  return request;
}

export function assertDurableChatWakeupRequest(
  request: DurableChatWakeupRequest,
  scope: {
    agentId: string;
    companyId: string;
    issueId: string | null;
    commentId: string | null;
    requestedByActorType?: string;
    requestedByActorId?: string | null;
  },
) {
  if (
    !trustedRequests.has(request) ||
    !scope.issueId ||
    request.agentId !== scope.agentId ||
    request.companyId !== scope.companyId ||
    request.issueId !== scope.issueId ||
    request.commentId !== scope.commentId ||
    request.requestedByActorType !== scope.requestedByActorType ||
    request.requestedByActorId !== scope.requestedByActorId
  ) {
    throw new Error("chat_inbound_wakeup_binding_denied");
  }
}

export function assertDurableChatWakeupReceipt(
  request: DurableChatWakeupRequest,
  receipt: {
    id: string;
    companyId: string;
    agentId: string;
    idempotencyKey: string | null;
    requestedByActorType: string | null;
    requestedByActorId: string | null;
  },
) {
  if (
    receipt.id !== request.id ||
    receipt.companyId !== request.companyId ||
    receipt.agentId !== request.agentId ||
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.requestedByActorType !== request.requestedByActorType ||
    receipt.requestedByActorId !== request.requestedByActorId
  ) {
    throw new Error("chat_inbound_wakeup_receipt_conflict");
  }
}

export function withDurableChatAdmission<T extends { kind: string; admitted?: boolean }>(request: DurableChatWakeupRequest | undefined,
  admit: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>) {
  return async (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => {
    const outcome = await admit(tx);
    // An existing deferred receipt is not proof this transaction passed its
    // gates. Only dispatch or an explicitly persisted wait admits the input.
    if (request?.onAdmitted && (outcome.admitted === true || ["queued", "durable", "coalesced"].includes(outcome.kind))) {
      const [receipt] = await tx.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, request.companyId), eq(agentWakeupRequests.id, request.id),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution", "coalesced"]),
      ));
      if (receipt) {
        assertDurableChatWakeupReceipt(request, receipt);
        await request.onAdmitted(tx as unknown as Db, { runId: receipt.runId });
      }
    }
    return outcome;
  };
}

/** Work-start policy only: ongoing tool and publication authorization must not
 * revoke an already-started run when the operator enables mention gating. */
export async function slackMentionAllowsRunStart(
  db: Db,
  run: { id: string; companyId: string; agentId: string; wakeupRequestId: string | null },
): Promise<boolean> {
  if (!run.wakeupRequestId) return true;
  const inputs = await db.select({ event: chatDeliveries.normalizedEvent })
    .from(agentWakeupRequests)
    .innerJoin(chatActions, and(
      eq(chatActions.id, agentWakeupRequests.id),
      eq(chatActions.companyId, run.companyId),
      eq(chatActions.kind, "inbound_wakeup"),
    ))
    .innerJoin(chatEndpoints, and(
      eq(chatEndpoints.id, chatActions.endpointId),
      eq(chatEndpoints.companyId, run.companyId),
      eq(chatEndpoints.provider, "slack"),
      eq(chatEndpoints.requireAtMention, true),
    ))
    .innerJoin(chatDeliveries, and(
      eq(chatDeliveries.id, chatActions.deliveryId),
      eq(chatDeliveries.endpointId, chatEndpoints.id),
      eq(chatDeliveries.companyId, run.companyId),
    ))
    .where(and(
      eq(agentWakeupRequests.companyId, run.companyId),
      eq(agentWakeupRequests.agentId, run.agentId),
      or(
        eq(agentWakeupRequests.runId, run.id),
        eq(agentWakeupRequests.id, run.wakeupRequestId),
        sql`${agentWakeupRequests.payload}->>'coalescedIntoWakeupRequestId' = ${run.wakeupRequestId}`,
      ),
    ));
  return inputs.every(({ event }) =>
    (event.conversation as { isDirectMessage?: boolean } | undefined)?.isDirectMessage === true ||
    event.trigger === "mention" ||
    (event.message as { mentionedBot?: boolean } | undefined)?.mentionedBot === true);
}
