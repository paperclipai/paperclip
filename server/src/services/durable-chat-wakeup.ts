import { createHash } from "node:crypto";
import { chatActions, type Db } from "@paperclipai/db";
import { eq, sql, type SQLWrapper } from "drizzle-orm";
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
        .select({ companyId: chatActions.companyId, kind: chatActions.kind })
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
    input.contextSnapshot.forceFreshSession === true ||
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
  return sql`exists (
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
  )`;
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
  readonly authorize: (tx: Db) => Promise<void>;
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
