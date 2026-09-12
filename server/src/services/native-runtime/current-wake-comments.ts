import { createHash } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assets,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issues,
} from "@paperclipai/db";
import type { SourceTrustMetadata } from "@paperclipai/shared";

import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import { sanitizeQuarantinedCommentForHigherTrust } from "../source-trust.js";

export const READ_CURRENT_WAKE_COMMENTS_TOOL_NAME =
  "read_current_wake_comments";
export const CURRENT_WAKE_COMMENTS_BINDING_SCHEMA =
  "paperclip.current-wake-comments-binding.v1";
export const CURRENT_WAKE_COMMENTS_RECEIPT_SCHEMA =
  "paperclip.current-wake-comments-receipt.v1";

const CURRENT_WAKE_COMMENTS_RECEIPT_KEY = "currentWakeCommentsReceipt";
const MAX_PAGE_BODY_CHARS = 12_000;
const MAX_COMMENT_CHUNK_CHARS = 4_000;
const MAX_PAGE_COMMENT_CHUNKS = 8;
const MAX_CURSOR_CHARS = 1_024;
const EXTERNAL_CHAT_PROVIDERS = new Set([
  "slack",
  "github",
  "discord",
  "microsoft-teams",
  "telegram",
  "imessage-photon",
]);
const ATTACHMENT_OMISSION_REASONS = new Set([
  "attachment_limit",
  "storage_unavailable",
  "declared_too_large",
  "download_unavailable",
  "unsupported_type",
  "empty_download",
  "downloaded_too_large",
  "processing_failed",
]);

type CurrentWakeAttachmentOmission = {
  commentId: string;
  reasons: Record<string, number>;
};

export const READ_CURRENT_WAKE_COMMENTS_TOOL_DEFINITION = Object.freeze({
  name: READ_CURRENT_WAKE_COMMENTS_TOOL_NAME,
  description:
    "Read only the complete, server-bound comments accepted for this external-chat turn. Start without a cursor, then pass each returned nextCursor until complete is true before answering.",
  inputSchema: {
    type: "object",
    properties: {
      cursor: {
        type: ["string", "null"],
        maxLength: MAX_CURSOR_CHARS,
        description:
          "Opaque cursor returned by the immediately preceding page. Omit for the first page.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: {
    semanticContract: "paperclip.server-current-wake-comments.v1",
    operationId: READ_CURRENT_WAKE_COMMENTS_TOOL_NAME,
    version: 1,
    exposure: "run_scoped",
    requiredClaims: [],
  },
});

export type CurrentWakeCommentsBinding = {
  schema: typeof CURRENT_WAKE_COMMENTS_BINDING_SCHEMA;
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  provider: string;
  commentIds: readonly string[];
  attachmentOmissions: readonly CurrentWakeAttachmentOmission[];
  bindingDigest: string;
};

type CurrentWakeComment = {
  id: string;
  state: "available" | "deleted" | "missing";
  body: string;
  authorType: string | null;
  authorId: string | null;
  createdAt: string | null;
  deletedAt: string | null;
  attachmentImportNotice: string | null;
  attachments: Array<{
    id: string;
    filename: string;
    contentType: string;
    byteSize: number;
    contentAccess: "metadata_only";
  }>;
};

type CurrentWakeCommentsSnapshot = {
  comments: CurrentWakeComment[];
  snapshotDigest: string;
};

type CurrentWakeCommentsCursor = {
  schema: "paperclip.current-wake-comments-cursor.v1";
  bindingDigest: string;
  snapshotDigest: string;
  commentIndex: number;
  bodyOffset: number;
};

type CurrentWakeCommentChunk = Omit<CurrentWakeComment, "body"> & {
  bodyChunk: string;
  bodyOffset: number;
  bodyComplete: boolean;
};

export type CurrentWakeCommentsPage = {
  schema: "paperclip.current-wake-comments-page.v1";
  bindingDigest: string;
  snapshotDigest: string;
  requestedCount: number;
  comments: CurrentWakeCommentChunk[];
  nextCursor: string | null;
  complete: boolean;
};

type CurrentWakeCommentsReceipt = {
  schema: typeof CURRENT_WAKE_COMMENTS_RECEIPT_SCHEMA;
  bindingDigest: string;
  snapshotDigest: string;
  inputCursor: string | null;
  nextCursor: string | null;
  complete: boolean;
  result: CurrentWakeCommentsPage;
  updatedAt: string;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function commentIdsFromWakePayload(value: unknown): string[] {
  const raw = record(value).commentIds;
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    const id = nonEmptyString(entry);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

function attachmentOmissionsFromWakePayload(
  value: unknown,
  commentIds: readonly string[],
): CurrentWakeAttachmentOmission[] {
  const raw = record(value).attachmentOmissions;
  if (!Array.isArray(raw)) return [];
  const commentIdSet = new Set(commentIds);
  const byCommentId = new Map<string, CurrentWakeAttachmentOmission>();
  for (const candidate of raw) {
    const omission = record(candidate);
    const commentId = nonEmptyString(omission.commentId);
    if (!commentId || !commentIdSet.has(commentId)) continue;
    const reasons = Object.fromEntries(
      Object.entries(record(omission.reasons)).flatMap(([reason, count]) =>
        ATTACHMENT_OMISSION_REASONS.has(reason) &&
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count > 0
          ? [[reason, count]]
          : [],
      ),
    );
    if (Object.keys(reasons).length === 0) continue;
    byCommentId.set(commentId, { commentId, reasons });
  }
  return [...byCommentId.values()];
}

function attachmentImportNotice(
  omission: CurrentWakeAttachmentOmission | undefined,
) {
  if (!omission) return null;
  const entries = Object.entries(omission.reasons);
  const omitted = entries.reduce((total, [, count]) => total + count, 0);
  const reasons = entries
    .map(([reason, count]) => `${reason.replaceAll("_", " ")}: ${count}`)
    .join(", ");
  return `Paperclip could not import every attachment from this exact external message: ${omitted} attachment${omitted === 1 ? " was" : "s were"} omitted (${reasons}). Treat omitted attachments as unavailable; do not infer their contents or substitute an older workspace file.`;
}

function bindingDigest(input: {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  provider: string;
  commentIds: readonly string[];
  attachmentOmissions: readonly CurrentWakeAttachmentOmission[];
}) {
  return sha256({
    schema: CURRENT_WAKE_COMMENTS_BINDING_SCHEMA,
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.runId,
    agentId: input.agentId,
    provider: input.provider,
    commentIds: input.commentIds,
    attachmentOmissions: input.attachmentOmissions,
  });
}

/**
 * Resolve the reader only from a server-built, durably persisted native wake.
 * The provider marker itself was produced by the chat-link join in heartbeat;
 * callers cannot manufacture reader authority with source text or arbitrary ids.
 */
export async function resolveCurrentWakeCommentsBinding(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    agentId: string;
  },
): Promise<CurrentWakeCommentsBinding | null> {
  const bound = await db
    .select({
      run: heartbeatRuns,
      issueAssigneeAgentId: issues.assigneeAgentId,
      issueExecutionRunId: issues.executionRunId,
    })
    .from(heartbeatRuns)
    .innerJoin(
      issues,
      and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)),
    )
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.nativeIssueId, input.issueId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !bound ||
    bound.run.runtimeMode !== "native" ||
    bound.run.status !== "running" ||
    bound.issueAssigneeAgentId !== input.agentId ||
    bound.issueExecutionRunId !== input.runId
  ) {
    return null;
  }

  const wake = record(record(bound.run.contextSnapshot).paperclipWake);
  const provider = nonEmptyString(wake.externalChatProvider);
  const commentIds = commentIdsFromWakePayload(wake);
  const attachmentOmissions = attachmentOmissionsFromWakePayload(
    wake,
    commentIds,
  );
  const commentWindow = record(wake.commentWindow);
  if (
    !provider ||
    !EXTERNAL_CHAT_PROVIDERS.has(provider) ||
    (wake.checkedOutByHarness !== true &&
      !(
        wake.externalChatExecutionBound === true &&
        record(bound.run.contextSnapshot)
          .paperclipExternalChatExecutionBound === true
      )) ||
    wake.fallbackFetchNeeded !== true ||
    commentIds.length === 0 ||
    wake.latestCommentId !== commentIds[commentIds.length - 1] ||
    commentWindow.requestedCount !== commentIds.length
  ) {
    return null;
  }

  const digest = bindingDigest({
    ...input,
    provider,
    commentIds,
    attachmentOmissions,
  });
  return {
    schema: CURRENT_WAKE_COMMENTS_BINDING_SCHEMA,
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.runId,
    agentId: input.agentId,
    provider,
    commentIds,
    attachmentOmissions,
    bindingDigest: digest,
  };
}

function encodeCursor(cursor: CurrentWakeCommentsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  value: unknown,
  binding: CurrentWakeCommentsBinding,
  snapshotDigest: string,
): CurrentWakeCommentsCursor | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_CHARS
  ) {
    throw new Error("paperclip_current_wake_comments_cursor_invalid");
  }
  try {
    const parsed = record(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (
      parsed.schema !== "paperclip.current-wake-comments-cursor.v1" ||
      parsed.bindingDigest !== binding.bindingDigest ||
      parsed.snapshotDigest !== snapshotDigest ||
      !Number.isSafeInteger(parsed.commentIndex) ||
      !Number.isSafeInteger(parsed.bodyOffset) ||
      Number(parsed.commentIndex) < 0 ||
      Number(parsed.bodyOffset) < 0
    ) {
      throw new Error("paperclip_current_wake_comments_cursor_invalid");
    }
    return parsed as CurrentWakeCommentsCursor;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "paperclip_current_wake_comments_cursor_invalid"
    ) {
      throw error;
    }
    throw new Error("paperclip_current_wake_comments_cursor_invalid");
  }
}

function parseReceipt(value: unknown): CurrentWakeCommentsReceipt | null {
  const receipt = record(value);
  const result = record(receipt.result);
  if (
    receipt.schema !== CURRENT_WAKE_COMMENTS_RECEIPT_SCHEMA ||
    typeof receipt.bindingDigest !== "string" ||
    typeof receipt.snapshotDigest !== "string" ||
    !(
      receipt.inputCursor === null || typeof receipt.inputCursor === "string"
    ) ||
    !(receipt.nextCursor === null || typeof receipt.nextCursor === "string") ||
    typeof receipt.complete !== "boolean" ||
    result.schema !== "paperclip.current-wake-comments-page.v1"
  ) {
    return null;
  }
  return receipt as CurrentWakeCommentsReceipt;
}

async function currentWakeCommentsSnapshot(
  db: Db,
  binding: CurrentWakeCommentsBinding,
): Promise<CurrentWakeCommentsSnapshot> {
  const rows = await db
    .select({
      id: issueComments.id,
      body: issueComments.body,
      authorType: issueComments.authorType,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      deletedAt: issueComments.deletedAt,
      sourceTrust: issueComments.sourceTrust,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, binding.companyId),
        eq(issueComments.issueId, binding.issueId),
        inArray(issueComments.id, [...binding.commentIds]),
      ),
    )
    .orderBy(asc(issueComments.id))
    .for("update");
  const attachments = await db
    .select({
      id: issueAttachments.id,
      issueCommentId: issueAttachments.issueCommentId,
      filename: assets.originalFilename,
      contentType: assets.contentType,
      byteSize: assets.byteSize,
      createdAt: issueAttachments.createdAt,
    })
    .from(issueAttachments)
    .innerJoin(
      assets,
      and(
        eq(assets.id, issueAttachments.assetId),
        eq(assets.companyId, binding.companyId),
      ),
    )
    .where(
      and(
        eq(issueAttachments.companyId, binding.companyId),
        eq(issueAttachments.issueId, binding.issueId),
        inArray(issueAttachments.issueCommentId, [...binding.commentIds]),
      ),
    )
    .orderBy(asc(issueAttachments.createdAt), asc(issueAttachments.id));

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const omissionsByCommentId = new Map(
    binding.attachmentOmissions.map((omission) => [
      omission.commentId,
      omission,
    ]),
  );
  const attachmentsByCommentId = new Map<
    string,
    CurrentWakeComment["attachments"]
  >();
  for (const attachment of attachments) {
    if (!attachment.issueCommentId) continue;
    const current = attachmentsByCommentId.get(attachment.issueCommentId) ?? [];
    current.push({
      id: attachment.id,
      filename: attachment.filename?.trim() || "attachment",
      contentType: attachment.contentType,
      byteSize: attachment.byteSize,
      // This closed reader intentionally has no general Paperclip API key.
      // Inline wake attachments are staged separately by the native harness;
      // overflow attachments remain visible as metadata so the agent can be
      // truthful rather than claiming it inspected bytes it cannot access.
      contentAccess: "metadata_only",
    });
    attachmentsByCommentId.set(attachment.issueCommentId, current);
  }

  const unredacted = binding.commentIds.map((commentId): CurrentWakeComment => {
    const row = rowsById.get(commentId);
    if (!row) {
      return {
        id: commentId,
        state: "missing",
        body: "",
        authorType: null,
        authorId: null,
        createdAt: null,
        deletedAt: null,
        attachmentImportNotice: attachmentImportNotice(
          omissionsByCommentId.get(commentId),
        ),
        attachments: [],
      };
    }
    const deletedAt = row.deletedAt?.toISOString() ?? null;
    const safe = deletedAt
      ? row
      : sanitizeQuarantinedCommentForHigherTrust({
          ...row,
          presentation: null,
          metadata: null,
          sourceTrust: row.sourceTrust as SourceTrustMetadata | null,
        });
    return {
      id: commentId,
      state: deletedAt ? "deleted" : "available",
      body: deletedAt ? "" : safe.body,
      authorType:
        row.authorType ??
        (row.authorAgentId ? "agent" : row.authorUserId ? "user" : "system"),
      authorId: row.authorAgentId ?? row.authorUserId ?? null,
      createdAt: row.createdAt.toISOString(),
      deletedAt,
      attachmentImportNotice: deletedAt
        ? null
        : attachmentImportNotice(omissionsByCommentId.get(commentId)),
      attachments: deletedAt
        ? []
        : (attachmentsByCommentId.get(commentId) ?? []),
    };
  });
  const comments = await createRunSecretRedactionRegistry(db).redactForIssue(
    binding.companyId,
    binding.issueId,
    unredacted,
  );
  return {
    comments,
    snapshotDigest: sha256({
      bindingDigest: binding.bindingDigest,
      comments,
    }),
  };
}

function buildPage(
  binding: CurrentWakeCommentsBinding,
  snapshot: CurrentWakeCommentsSnapshot,
  cursor: CurrentWakeCommentsCursor | null,
): CurrentWakeCommentsPage {
  let commentIndex = cursor?.commentIndex ?? 0;
  let bodyOffset = cursor?.bodyOffset ?? 0;
  if (commentIndex > snapshot.comments.length) {
    throw new Error("paperclip_current_wake_comments_cursor_invalid");
  }
  const chunks: CurrentWakeCommentChunk[] = [];
  let remainingChars = MAX_PAGE_BODY_CHARS;

  while (
    commentIndex < snapshot.comments.length &&
    chunks.length < MAX_PAGE_COMMENT_CHUNKS &&
    remainingChars > 0
  ) {
    const comment = snapshot.comments[commentIndex]!;
    if (bodyOffset > comment.body.length) {
      throw new Error("paperclip_current_wake_comments_cursor_invalid");
    }
    const remainingBody = comment.body.slice(bodyOffset);
    const chunkSize = Math.min(
      remainingBody.length,
      MAX_COMMENT_CHUNK_CHARS,
      remainingChars,
    );
    const bodyChunk = remainingBody.slice(0, chunkSize);
    const bodyComplete = bodyOffset + chunkSize >= comment.body.length;
    chunks.push({
      ...comment,
      bodyChunk,
      bodyOffset,
      bodyComplete,
    });
    remainingChars -= bodyChunk.length;
    if (bodyComplete) {
      commentIndex += 1;
      bodyOffset = 0;
    } else {
      bodyOffset += chunkSize;
    }
  }

  const complete = commentIndex >= snapshot.comments.length;
  const nextCursor = complete
    ? null
    : encodeCursor({
        schema: "paperclip.current-wake-comments-cursor.v1",
        bindingDigest: binding.bindingDigest,
        snapshotDigest: snapshot.snapshotDigest,
        commentIndex,
        bodyOffset,
      });
  return {
    schema: "paperclip.current-wake-comments-page.v1",
    bindingDigest: binding.bindingDigest,
    snapshotDigest: snapshot.snapshotDigest,
    requestedCount: binding.commentIds.length,
    comments: chunks,
    nextCursor,
    complete,
  };
}

export async function readCurrentWakeComments(
  db: Db,
  binding: CurrentWakeCommentsBinding,
  input: unknown,
): Promise<CurrentWakeCommentsPage> {
  const request = record(input);
  if (
    Object.keys(request).some((key) => key !== "cursor") ||
    !(
      request.cursor === undefined ||
      request.cursor === null ||
      typeof request.cursor === "string"
    )
  ) {
    throw new Error("paperclip_current_wake_comments_input_invalid");
  }
  const inputCursor = request.cursor ?? null;

  return db.transaction(async (tx) => {
    const locked = await tx
      .select({
        run: heartbeatRuns,
        issueAssigneeAgentId: issues.assigneeAgentId,
        issueExecutionRunId: issues.executionRunId,
      })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        and(
          eq(issues.id, binding.issueId),
          eq(issues.companyId, binding.companyId),
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.id, binding.runId),
          eq(heartbeatRuns.companyId, binding.companyId),
          eq(heartbeatRuns.agentId, binding.agentId),
          eq(heartbeatRuns.nativeIssueId, binding.issueId),
        ),
      )
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !locked ||
      locked.run.runtimeMode !== "native" ||
      locked.run.status !== "running" ||
      locked.issueAssigneeAgentId !== binding.agentId ||
      locked.issueExecutionRunId !== binding.runId
    ) {
      throw new Error("paperclip_current_wake_comments_binding_not_authorized");
    }
    const currentBinding = await resolveCurrentWakeCommentsBinding(
      tx as unknown as Db,
      {
        companyId: binding.companyId,
        issueId: binding.issueId,
        runId: binding.runId,
        agentId: binding.agentId,
      },
    );
    if (
      !currentBinding ||
      currentBinding.bindingDigest !== binding.bindingDigest
    ) {
      throw new Error("paperclip_current_wake_comments_binding_changed");
    }

    const snapshot = await currentWakeCommentsSnapshot(
      tx as unknown as Db,
      binding,
    );
    const resultJson = record(locked.run.resultJson);
    const prior = parseReceipt(resultJson[CURRENT_WAKE_COMMENTS_RECEIPT_KEY]);
    if (
      prior &&
      prior.bindingDigest === binding.bindingDigest &&
      prior.snapshotDigest === snapshot.snapshotDigest &&
      prior.inputCursor === inputCursor
    ) {
      return prior.result;
    }
    if (
      prior &&
      (prior.bindingDigest !== binding.bindingDigest ||
        prior.snapshotDigest !== snapshot.snapshotDigest)
    ) {
      if (inputCursor !== null) {
        throw new Error("paperclip_current_wake_comments_snapshot_changed");
      }
    } else if (!prior && inputCursor !== null) {
      throw new Error("paperclip_current_wake_comments_cursor_out_of_order");
    } else if (prior && prior.nextCursor !== inputCursor) {
      throw new Error(
        prior.complete
          ? "paperclip_current_wake_comments_already_complete"
          : "paperclip_current_wake_comments_cursor_out_of_order",
      );
    }

    const cursor = decodeCursor(inputCursor, binding, snapshot.snapshotDigest);
    const result = buildPage(binding, snapshot, cursor);
    const receipt: CurrentWakeCommentsReceipt = {
      schema: CURRENT_WAKE_COMMENTS_RECEIPT_SCHEMA,
      bindingDigest: binding.bindingDigest,
      snapshotDigest: snapshot.snapshotDigest,
      inputCursor,
      nextCursor: result.nextCursor,
      complete: result.complete,
      result,
      updatedAt: new Date().toISOString(),
    };
    await tx
      .update(heartbeatRuns)
      .set({
        resultJson: {
          ...resultJson,
          [CURRENT_WAKE_COMMENTS_RECEIPT_KEY]: receipt,
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, binding.runId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    return result;
  });
}

/**
 * Terminal fence for a truncated external-chat wake. Success is not allowed
 * until every exact accepted comment was read and that completed snapshot is
 * still current at this transaction's linearization point.
 */
export async function assertCurrentWakeCommentsRead(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    agentId: string;
  },
  expectedBinding?: CurrentWakeCommentsBinding | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const locked = await tx
      .select({
        resultJson: heartbeatRuns.resultJson,
        issueAssigneeAgentId: issues.assigneeAgentId,
        issueExecutionRunId: issues.executionRunId,
      })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        and(
          eq(issues.id, input.issueId),
          eq(issues.companyId, input.companyId),
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
          eq(heartbeatRuns.nativeIssueId, input.issueId),
          eq(heartbeatRuns.status, "running"),
        ),
      )
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !locked ||
      locked.issueAssigneeAgentId !== input.agentId ||
      locked.issueExecutionRunId !== input.runId
    ) {
      throw new Error("native_current_wake_comments_binding_changed");
    }
    const currentBinding = await resolveCurrentWakeCommentsBinding(
      tx as unknown as Db,
      {
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        agentId: input.agentId,
      },
    );
    if (expectedBinding !== undefined) {
      const matchesExpected =
        expectedBinding === null
          ? currentBinding === null
          : currentBinding?.bindingDigest === expectedBinding.bindingDigest;
      if (!matchesExpected) {
        throw new Error("native_current_wake_comments_binding_changed");
      }
    }
    const binding = currentBinding;
    if (!binding) return;
    const receipt = parseReceipt(
      record(locked.resultJson)[CURRENT_WAKE_COMMENTS_RECEIPT_KEY],
    );
    if (!receipt || receipt.complete !== true || receipt.nextCursor !== null) {
      throw new Error("native_current_wake_comments_unread");
    }
    if (receipt.bindingDigest !== binding.bindingDigest) {
      throw new Error("native_current_wake_comments_changed_after_read");
    }
    const snapshot = await currentWakeCommentsSnapshot(
      tx as unknown as Db,
      binding,
    );
    if (receipt.snapshotDigest !== snapshot.snapshotDigest) {
      throw new Error("native_current_wake_comments_changed_after_read");
    }
  });
}
