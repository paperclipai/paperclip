import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { ChatFileTransferPhase } from "@paperclipai/shared";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import {
  assets,
  chatActions,
  chatPublications,
  chatTeamsFileTransfers,
  issueAttachments,
  issueComments,
  type Db,
} from "@paperclipai/db";
import {
  bindEarlyTeamsFileConsent,
  bindTeamsFileConsent,
  buildTeamsFileConsentCard,
  buildTeamsUploadedFileCard,
  createTeamsFileConsentBinding,
  exchangeTeamsFileUpload,
  restoreTeamsFileConsentBinding,
  restoreTeamsFileConsentEvent,
  restoreTeamsFileUpload,
  sealTeamsFileConsentBinding,
  sealTeamsFileConsentEvent,
  sealTeamsFileUpload,
  type TeamsFileConsentBinding,
  type TeamsFileConsentEvent,
  type TeamsFilePrivateContext,
  type TeamsFileUploadCapability,
} from "./chat-teams-file-consent.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof chatTeamsFileTransfers.$inferSelect;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const opaque = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\x00-\x20\x7f]+$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.number().int().min(0).max(2_147_483_647);
const authoritySchema = z
  .object({
    companyId: z.uuid(),
    endpointId: z.uuid(),
    conversationId: z.uuid(),
    issueId: z.uuid(),
    publicationId: z.uuid(),
    commentId: z.uuid(),
    attachmentId: z.uuid(),
    principalId: z.uuid(),
    authorizedUserId: opaque.nullable(),
    runtimeGeneration: generation,
    credentialFingerprint: sha,
    conversationGeneration: generation.min(1),
    sourceDigest: sha,
    tenantId: z.uuid(),
    botAppId: z.uuid(),
    aadObjectId: z.uuid(),
    providerConversationId: opaque,
    providerUserId: opaque,
    sha256: sha,
    byteSize: z
      .number()
      .int()
      .positive()
      .max(60 * 1024 * 1024 - 1),
    filename: z.string().min(1).max(255),
  })
  .strict();
export type TeamsFileTransferAuthority = z.infer<typeof authoritySchema>;
export type TeamsFileTransferStage =
  "issue" | "consent" | "upload" | "file_info" | "response" | "status";
const privateSchema = z
  .object({
    schema: z.literal("paperclip.teams.transfer-private.v1"),
    binding: z.record(z.string(), z.unknown()),
    response: z.record(z.string(), z.unknown()).optional(),
    upload: z.record(z.string(), z.unknown()).optional(),
    resolution: z
      .object({
        schema: z.literal("paperclip.teams.file-resolution.v1"),
        action: z.enum(["mark_delivered", "retry_anyway", "cancel"]),
        fromPhase: z.enum([
          "consent_unknown",
          "upload_unknown",
          "file_info_unknown",
          "conflict",
        ]),
        fromVersion: z.number().int().positive(),
        previousReason: z.string().nullable(),
        at: z.iso.datetime(),
      })
      .strict()
      .optional(),
    quarantine: z
      .object({
        schema: z.literal("paperclip.teams.file-quarantine.v1"),
        fromPhase: z.string().min(1).max(64),
        fromVersion: z.number().int().positive(),
        attemptId: z.uuid().nullable(),
        attemptExpiresAt: z.iso.datetime().nullable(),
        previousReason: z.string().nullable(),
        at: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
type PrivateState = z.infer<typeof privateSchema>;
const closed = ["delivered", "declined", "expired", "cancelled"];
const sending = ["consent_sending", "uploading", "file_info_sending"];
const unknownPhase: Record<string, string> = {
  consent_sending: "consent_unknown",
  uploading: "upload_unknown",
  file_info_sending: "file_info_unknown",
};
// Scheduling progress only: never authority, private capability, or an I/O
// receipt. Fresh service objects sharing this exact Db continue the bounded
// scan; a server restart safely restarts the scan from the beginning.
const expiryRecoveryCursors = new WeakMap<Db, Map<string, string>>();
export interface TeamsFileRecoverySweepSummary {
  scanned: number;
  recovered: number;
  failed: number;
  cursor: string | null;
}

export interface TeamsFileTransferOptions {
  /** Required by runtime activation: atomic public publication/link projection.
   * No network work. Throwing rolls back the transfer mutation too. */
  project?(tx: Tx, transfer: TeamsFileTransferSummary): Promise<void>;
  /** Must lock/rederive CURRENT runtime, source, recipient, linked/sponsored actor,
   * membership, conversation generation and destination policy. Returning the
   * supplied snapshot unchanged is NOT authorization. No provider I/O here. */
  authorize(
    tx: Tx,
    expected: TeamsFileTransferAuthority,
    stage: TeamsFileTransferStage,
  ): Promise<TeamsFileTransferAuthority>;
  loadBytes(authority: TeamsFileTransferAuthority): Promise<Buffer>;
  postConsent(input: {
    authority: TeamsFileTransferAuthority;
    card: ReturnType<typeof buildTeamsFileConsentCard>;
    signal: AbortSignal;
  }): Promise<{ id: string }>;
  postFileInfo(input: {
    authority: TeamsFileTransferAuthority;
    card: ReturnType<typeof buildTeamsUploadedFileCard>;
    signal: AbortSignal;
  }): Promise<{ id: string }>;
  /** Isolated test transport; production must use the foundation egress guard. */
  uploadRequest?: Parameters<typeof exchangeTeamsFileUpload>[0]["request"];
  now?: () => Date;
}

export interface TeamsFileTransferSummary {
  id: string;
  companyId: string;
  endpointId: string;
  conversationId: string;
  issueId: string;
  publicationId: string;
  filename: string;
  phase: ChatFileTransferPhase;
  version: number;
  reason: string | null;
  consentConfirmed: boolean;
  fileDelivered: boolean;
  consentMessageId: string | null;
  fileInfoMessageId: string | null;
  operatorConfirmed: boolean;
  expiresAt: string;
}
function summary(row: Row): TeamsFileTransferSummary {
  const resolution = privateSchema.safeParse(row.privateState);
  const operatorConfirmed =
    resolution.success &&
    resolution.data.resolution?.action === "mark_delivered" &&
    resolution.data.resolution.fromPhase === "file_info_unknown";
  return {
    id: row.id,
    companyId: row.companyId,
    endpointId: row.endpointId,
    conversationId: row.conversationId,
    issueId: row.issueId,
    publicationId: row.publicationId,
    filename: row.filename,
    phase: row.phase as ChatFileTransferPhase,
    version: row.version,
    reason: row.reason,
    consentConfirmed: Boolean(row.consentMessageId || row.responseActivityId),
    fileDelivered:
      row.phase === "delivered" &&
      Boolean(row.fileInfoMessageId || operatorConfirmed),
    consentMessageId: row.consentMessageId,
    fileInfoMessageId: row.fileInfoMessageId,
    operatorConfirmed,
    expiresAt: row.expiresAt.toISOString(),
  };
}
function authority(row: Row): TeamsFileTransferAuthority {
  return authoritySchema.parse(
    Object.fromEntries(
      Object.keys(authoritySchema.shape).map((key) => [
        key,
        row[key as keyof Row],
      ]),
    ),
  );
}
const authorityHash = (a: TeamsFileTransferAuthority) =>
  hash(JSON.stringify(authoritySchema.parse(a)));
const context = (row: Row): TeamsFilePrivateContext => ({
  companyId: row.companyId,
  endpointId: row.endpointId,
  transferId: row.id,
  authorityDigest: row.authorityDigest,
});
function fail(): never {
  throw new Error("Teams file transfer authority or state changed");
}

/** Durable protocol only; no runtime registration. Activation supplies project
 * for atomic public publication/link changes in the transfer transaction.
 * A consent-card receipt never means that file bytes were delivered. */
export function teamsFileTransferService(
  db: Db,
  options: TeamsFileTransferOptions,
) {
  const now = options.now ?? (() => new Date());
  async function locked(
    tx: Tx,
    companyId: string,
    id: string,
    nonblocking = false,
  ) {
    // Match normal publication claims and issue(): publication -> transfer ->
    // policy/source locks. The unlocked lookup selects a candidate, not authority.
    const candidate = await tx
      .select({ publicationId: chatTeamsFileTransfers.publicationId })
      .from(chatTeamsFileTransfers)
      .where(
        and(
          eq(chatTeamsFileTransfers.companyId, companyId),
          eq(chatTeamsFileTransfers.id, id),
        ),
      )
      .then((rows) => rows[0]);
    if (!candidate) fail();
    const publication = await tx
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, companyId),
          eq(chatPublications.id, candidate.publicationId),
        ),
      )
      .for("update", nonblocking ? { noWait: true } : undefined)
      .then((rows) => rows[0]);
    if (!publication) fail();
    const row = await tx
      .select()
      .from(chatTeamsFileTransfers)
      .where(
        and(
          eq(chatTeamsFileTransfers.companyId, companyId),
          eq(chatTeamsFileTransfers.id, id),
        ),
      )
      .for("update", nonblocking ? { noWait: true } : undefined)
      .then((rows) => rows[0]);
    if (!row || row.publicationId !== publication.id) fail();
    if (authorityHash(authority(row)) !== row.authorityDigest) fail();
    return row;
  }
  async function verify(
    tx: Tx,
    a: TeamsFileTransferAuthority,
    stage: TeamsFileTransferStage,
  ) {
    const expectedDigest = authorityHash(a);
    const current = authoritySchema.parse(
      await options.authorize(tx, Object.freeze({ ...a }), stage),
    );
    if (authorityHash(current) !== expectedDigest) fail();
    // Artifact authority is independent of the injected policy callback.
    const [source] = await tx
      .select({
        publicationCommentId: chatPublications.commentId,
        payload: chatPublications.payload,
        commentId: issueComments.id,
        deletedAt: issueComments.deletedAt,
        sha256: assets.sha256,
        byteSize: assets.byteSize,
        filename: assets.originalFilename,
      })
      .from(chatPublications)
      .innerJoin(
        issueComments,
        and(
          eq(issueComments.id, chatPublications.commentId),
          eq(issueComments.companyId, a.companyId),
          eq(issueComments.issueId, a.issueId),
        ),
      )
      .innerJoin(
        issueAttachments,
        and(
          eq(issueAttachments.id, a.attachmentId),
          eq(issueAttachments.companyId, a.companyId),
          eq(issueAttachments.issueId, a.issueId),
          eq(issueAttachments.issueCommentId, a.commentId),
        ),
      )
      .innerJoin(
        assets,
        and(
          eq(assets.id, issueAttachments.assetId),
          eq(assets.companyId, a.companyId),
        ),
      )
      .where(
        and(
          eq(chatPublications.id, a.publicationId),
          eq(chatPublications.companyId, a.companyId),
          eq(chatPublications.endpointId, a.endpointId),
          eq(chatPublications.conversationId, a.conversationId),
          eq(chatPublications.issueId, a.issueId),
        ),
      )
      .for("share", {
        of: [chatPublications, issueComments, issueAttachments, assets],
      });
    if (
      !source ||
      source.deletedAt ||
      source.publicationCommentId !== a.commentId ||
      source.sha256 !== a.sha256 ||
      source.byteSize !== a.byteSize ||
      (source.filename ?? `attachment-${a.attachmentId}`) !== a.filename ||
      source.payload.attachmentIds?.length !== 1 ||
      source.payload.attachmentIds[0] !== a.attachmentId
    )
      fail();
  }
  async function decoded(row: Row) {
    const state = privateSchema.parse(row.privateState);
    const binding = await restoreTeamsFileConsentBinding(
      context(row),
      state.binding,
    );
    const a = authority(row);
    const expected = {
      companyId: a.companyId,
      endpointId: a.endpointId,
      issueId: a.issueId,
      publicationId: a.publicationId,
      attachmentId: a.attachmentId,
      tenantId: a.tenantId,
      botAppId: a.botAppId,
      aadObjectId: a.aadObjectId,
      userId: a.providerUserId,
      conversationId: a.providerConversationId,
      sourceGeneration: a.conversationGeneration,
      sourceDigest: a.sourceDigest,
      sha256: a.sha256,
      byteSize: a.byteSize,
      filename: a.filename,
      expiresAt: row.expiresAt.toISOString(),
    };
    if (
      Object.entries(expected).some(
        ([key, value]) =>
          binding[key as keyof TeamsFileConsentBinding] !== value,
      ) ||
      hash(binding.token) !== row.tokenSha256
    )
      fail();
    return { state, binding };
  }
  async function update(
    tx: Tx,
    row: Row,
    patch: Partial<typeof chatTeamsFileTransfers.$inferInsert>,
  ): Promise<Row> {
    const [next] = await tx
      .update(chatTeamsFileTransfers)
      .set({ ...patch, version: row.version + 1, updatedAt: now() })
      .where(
        and(
          eq(chatTeamsFileTransfers.id, row.id),
          eq(chatTeamsFileTransfers.companyId, row.companyId),
          eq(chatTeamsFileTransfers.version, row.version),
        ),
      )
      .returning();
    if (!next) fail();
    await options.project?.(tx, summary(next));
    return next;
  }
  async function applyResponse(tx: Tx, row: Row): Promise<Row> {
    const { state, binding } = await decoded(row);
    if (
      !state.response ||
      !["consent_unknown", "awaiting_consent"].includes(row.phase)
    )
      return row;
    const event = await restoreTeamsFileConsentEvent(
      context(row),
      binding,
      state.response,
    );
    const decision = row.consentMessageId
      ? bindTeamsFileConsent({
          event,
          stored: binding,
          current: binding,
          phase: "awaiting_consent",
          cardMessageId: row.consentMessageId,
          now: now().getTime(),
        })
      : bindEarlyTeamsFileConsent({
          event,
          stored: binding,
          current: binding,
          phase: "consent_unknown",
          now: now().getTime(),
        });
    if (!decision.ok)
      return decision.reason === "wrong_scope"
        ? quarantine(tx, row, decision.reason)
        : update(tx, row, { phase: "cancelled", reason: decision.reason });
    if (decision.action === "decline")
      return update(tx, row, {
        phase: "declined",
        reason: "recipient_declined",
      });
    state.upload = await sealTeamsFileUpload(
      context(row),
      binding,
      decision.upload,
    );
    return update(tx, row, {
      phase: "upload_pending",
      privateState: state,
      reason: null,
    });
  }
  async function quarantine(tx: Tx, row: Row, reason: string) {
    const state = privateSchema.parse(row.privateState);
    state.quarantine ??= {
      schema: "paperclip.teams.file-quarantine.v1",
      fromPhase: row.phase,
      fromVersion: row.version,
      attemptId: row.attemptId,
      attemptExpiresAt: row.attemptExpiresAt?.toISOString() ?? null,
      previousReason: row.reason,
      at: now().toISOString(),
    };
    return update(tx, row, { phase: "conflict", reason, privateState: state });
  }
  async function issue(input: TeamsFileTransferAuthority, expiresAt: Date) {
    const a = authoritySchema.parse(input);
    return db.transaction(async (tx) => {
      // Publication row serializes two issuers before generating a token.
      await tx
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.id, a.publicationId),
            eq(chatPublications.companyId, a.companyId),
          ),
        )
        .for("update");
      await verify(tx, a, "issue");
      const existing = await tx
        .select()
        .from(chatTeamsFileTransfers)
        .where(
          and(
            eq(chatTeamsFileTransfers.companyId, a.companyId),
            eq(chatTeamsFileTransfers.publicationId, a.publicationId),
          ),
        )
        .then((rows) => rows[0]);
      if (existing) {
        if (existing.authorityDigest !== authorityHash(a)) fail();
        await options.project?.(tx, summary(existing));
        return summary(existing);
      }
      const checked = now();
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt <= checked ||
        expiresAt.getTime() > checked.getTime() + 24 * 60 * 60 * 1000
      )
        fail();
      const id = randomUUID();
      const authorityDigest = authorityHash(a);
      const binding = createTeamsFileConsentBinding({
        companyId: a.companyId,
        endpointId: a.endpointId,
        issueId: a.issueId,
        publicationId: a.publicationId,
        attachmentId: a.attachmentId,
        tenantId: a.tenantId,
        botAppId: a.botAppId,
        aadObjectId: a.aadObjectId,
        userId: a.providerUserId,
        conversationId: a.providerConversationId,
        sourceGeneration: a.conversationGeneration,
        sourceDigest: a.sourceDigest,
        sha256: a.sha256,
        byteSize: a.byteSize,
        filename: a.filename,
        expiresAt: expiresAt.toISOString(),
      });
      const privateState: PrivateState = {
        schema: "paperclip.teams.transfer-private.v1",
        binding: await sealTeamsFileConsentBinding(
          {
            companyId: a.companyId,
            endpointId: a.endpointId,
            transferId: id,
            authorityDigest,
          },
          binding,
        ),
      };
      const [row] = await tx
        .insert(chatTeamsFileTransfers)
        .values({
          ...a,
          id,
          authorityDigest,
          tokenSha256: hash(binding.token),
          privateState,
          expiresAt,
          createdAt: checked,
          updatedAt: checked,
        })
        .returning();
      await options.project?.(tx, summary(row!));
      return summary(row!);
    });
  }
  async function recordConsent(
    event: TeamsFileConsentEvent,
  ): Promise<"recorded" | "ignored" | "denied"> {
    return db.transaction(async (tx) => {
      const found = await tx
        .select({ id: chatTeamsFileTransfers.id })
        .from(chatTeamsFileTransfers)
        .where(
          and(
            eq(chatTeamsFileTransfers.companyId, event.companyId),
            eq(chatTeamsFileTransfers.endpointId, event.endpointId),
            eq(chatTeamsFileTransfers.tokenSha256, hash(event.token)),
          ),
        )
        .then((rows) => rows[0]);
      if (!found) return "denied";
      let row = await locked(tx, event.companyId, found.id);
      await verify(tx, authority(row), "response");
      const { state, binding } = await decoded(row);
      const encrypted = await sealTeamsFileConsentEvent(
        context(row),
        binding,
        event,
      ); // brand + exact scope
      const receiptDigest = event.receiptDigest();
      const providerActionId = `teams-file-consent:${event.activityId}`;
      const existing = await tx
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, row.endpointId),
            eq(chatActions.providerActionId, providerActionId),
          ),
        )
        .then((rows) => rows[0]);
      if (existing) {
        if (
          existing.companyId === row.companyId &&
          existing.payload.transferId === row.id &&
          existing.payload.receiptDigest === receiptDigest
        )
          return "ignored";
        if (!closed.includes(row.phase))
          await quarantine(tx, row, "conflicting_consent_receipt");
        return "denied";
      }
      if (closed.includes(row.phase)) return "ignored";
      if (row.phase === "consent_pending") return "denied";
      if (
        !["consent_sending", "consent_unknown", "awaiting_consent"].includes(
          row.phase,
        )
      ) {
        if (row.responseDigest !== receiptDigest)
          await quarantine(tx, row, "conflicting_consent_receipt");
        return "denied";
      }
      if (row.responseDigest && row.responseDigest !== receiptDigest) {
        await quarantine(tx, row, "conflicting_consent_receipt");
        return "denied";
      }
      await tx.insert(chatActions).values({
        companyId: row.companyId,
        endpointId: row.endpointId,
        conversationId: row.conversationId,
        principalId: row.principalId,
        kind: "teams_file_consent",
        providerActionId,
        status: "processed",
        payload: {
          schema: "paperclip.teams.consent-receipt.v1",
          transferId: row.id,
          publicationId: row.publicationId,
          receiptDigest,
          action: event.action,
        },
      });
      state.response = encrypted;
      row = await update(tx, row, {
        privateState: state,
        responseActivityId: event.activityId,
        responseDigest: receiptDigest,
      });
      // Never race a still-owned card POST. Its later receipt must match replyToId.
      if (row.phase !== "consent_sending") await applyResponse(tx, row);
      return "recorded";
    });
  }
  async function claim(companyId: string, id: string) {
    return db.transaction(async (tx) => {
      let row = await locked(tx, companyId, id);
      const checked = now();
      if (
        row.attemptId &&
        row.attemptExpiresAt &&
        row.attemptExpiresAt > checked
      )
        return null;
      if (sending.includes(row.phase)) {
        await verify(tx, authority(row), "response");
        row = await update(tx, row, {
          phase: unknownPhase[row.phase],
          attemptId: null,
          attemptExpiresAt: null,
          reason: "worker_outcome_unknown",
        });
        row = await applyResponse(tx, row);
      }
      if (row.phase === "consent_unknown") {
        await verify(tx, authority(row), "response");
        row = await applyResponse(tx, row);
      }
      if (
        ["consent_pending", "awaiting_consent", "upload_pending"].includes(
          row.phase,
        ) &&
        row.expiresAt <= now()
      ) {
        row = await update(tx, row, {
          phase: "expired",
          reason: "unused_consent_expired",
        });
        return null;
      }
      const stage: "consent" | "upload" | "file_info" | null =
        row.phase === "consent_pending"
          ? "consent"
          : row.phase === "upload_pending"
            ? "upload"
            : row.phase === "file_info_pending"
              ? "file_info"
              : null;
      if (!stage) return null;
      await verify(tx, authority(row), stage);
      const { state, binding } = await decoded(row);
      if (stage !== "file_info" && row.expiresAt <= now()) fail();
      row = await update(tx, row, {
        phase:
          stage === "consent"
            ? "consent_sending"
            : stage === "upload"
              ? "uploading"
              : "file_info_sending",
        attemptId: randomUUID(),
        attemptExpiresAt: new Date(now().getTime() + 90_000),
        reason: null,
      });
      return { row, state, binding, stage };
    });
  }
  async function checkClaim(row: Row, stage: TeamsFileTransferStage) {
    await db.transaction(async (tx) => {
      const current = await locked(tx, row.companyId, row.id);
      await verify(tx, authority(current), stage);
      if (
        current.attemptId !== row.attemptId ||
        current.phase !== row.phase ||
        !current.attemptExpiresAt ||
        current.attemptExpiresAt <= now() ||
        (stage !== "file_info" && current.expiresAt <= now())
      )
        fail();
    });
  }
  async function bounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Teams transfer outcome unknown"));
          }, 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  async function process(
    companyId: string,
    id: string,
  ): Promise<TeamsFileTransferSummary> {
    const work = await claim(companyId, id);
    if (!work) return get(companyId, id);
    const { row, state, binding, stage } = work;
    let messageId: string | null = null;
    let upload: TeamsFileUploadCapability | null = null;
    let uploadConfirmed = false;
    let providerAttempted = false;
    try {
      if (stage === "consent") {
        await checkClaim(row, stage);
        const card = buildTeamsFileConsentCard(binding);
        const receipt = await bounded((signal) => {
          providerAttempted = true;
          return options.postConsent({
            authority: authority(row),
            card,
            signal,
          });
        });
        messageId = opaque.parse(receipt.id);
      } else {
        if (!state.upload) fail();
        upload = await restoreTeamsFileUpload(
          context(row),
          binding,
          state.upload,
        );
        if (stage === "upload") {
          const bytes = await bounded(() => options.loadBytes(authority(row)));
          const outcome = await exchangeTeamsFileUpload({
            upload,
            binding,
            bytes,
            operation: "put",
            request: (...args) => {
              providerAttempted = true;
              return (options.uploadRequest ?? guardedRemoteHttpFetch)(...args);
            },
            authorize: () => checkClaim(row, stage),
          });
          uploadConfirmed = outcome.kind === "uploaded";
        } else {
          const card = buildTeamsUploadedFileCard(upload, { kind: "uploaded" });
          await checkClaim(row, stage);
          const receipt = await bounded((signal) => {
            providerAttempted = true;
            return options.postFileInfo({
              authority: authority(row),
              card,
              signal,
            });
          });
          messageId = opaque.parse(receipt.id);
        }
      }
    } catch {
      /* Only closed phase/reason below; never persist provider error text. */
    }
    return db.transaction(async (tx) => {
      let current = await locked(tx, companyId, id);
      if (current.attemptId !== row.attemptId || current.phase !== row.phase)
        return summary(current);
      // Receipt recording preserves the exact already-admitted side effect even
      // if policy is revoked during I/O; no next effect runs without reauthorization.
      const currentPrivate = privateSchema.parse(current.privateState);
      const patch: Partial<typeof chatTeamsFileTransfers.$inferInsert> = {
        attemptId: null,
        attemptExpiresAt: null,
      };
      if (!providerAttempted) {
        // This exact live attempt never reached the provider port. Unlike a
        // recovered/crashed intent, it has affirmative no-I/O evidence.
        patch.phase =
          stage === "consent"
            ? "consent_pending"
            : stage === "upload"
              ? "upload_pending"
              : "file_info_pending";
        patch.reason = "provider_not_attempted";
      } else if (stage === "consent") {
        patch.phase = messageId ? "awaiting_consent" : "consent_unknown";
        patch.consentMessageId = messageId;
        patch.reason = messageId ? null : "consent_post_unknown";
      } else if (stage === "upload") {
        patch.phase = uploadConfirmed ? "file_info_pending" : "upload_unknown";
        patch.reason = uploadConfirmed ? null : "upload_outcome_unknown";
        if (upload)
          currentPrivate.upload = await sealTeamsFileUpload(
            context(current),
            binding,
            upload,
          );
        patch.privateState = currentPrivate;
      } else {
        patch.phase = messageId ? "delivered" : "file_info_unknown";
        patch.fileInfoMessageId = messageId;
        patch.reason = messageId ? null : "file_info_post_unknown";
      }
      current = await update(tx, current, patch);
      if (stage === "consent" && providerAttempted && currentPrivate.response) {
        // This is only projection of the exact previously authorized callback.
        // Every next I/O claim rechecks current authority. Do not roll back a
        // proven POST receipt merely because permission changed during I/O.
        current = await applyResponse(tx, current);
      }
      return summary(current);
    });
  }
  async function get(companyId: string, id: string) {
    const [row] = await db
      .select()
      .from(chatTeamsFileTransfers)
      .where(
        and(
          eq(chatTeamsFileTransfers.companyId, companyId),
          eq(chatTeamsFileTransfers.id, id),
        ),
      );
    if (!row) fail();
    return summary(row);
  }
  async function expireAndRecover(
    companyId: string,
    limit = 25,
  ): Promise<TeamsFileRecoverySweepSummary> {
    if (!z.uuid().safeParse(companyId).success) fail();
    const size = Number.isSafeInteger(limit)
      ? Math.min(100, Math.max(1, limit))
      : 25;
    let cursors = expiryRecoveryCursors.get(db);
    if (!cursors) {
      cursors = new Map();
      expiryRecoveryCursors.set(db, cursors);
    }
    const cursor = cursors.get(companyId);
    const cutoff = now();
    const eligible = and(
      eq(chatTeamsFileTransfers.companyId, companyId),
      or(
        and(
          inArray(chatTeamsFileTransfers.phase, [...sending, "conflict"]),
          lte(chatTeamsFileTransfers.attemptExpiresAt, cutoff),
        ),
        and(
          inArray(chatTeamsFileTransfers.phase, [
            "consent_pending",
            "awaiting_consent",
            "upload_pending",
          ]),
          lte(chatTeamsFileTransfers.expiresAt, cutoff),
        ),
      ),
    );
    let rows: Array<{ id: string }>;
    try {
      rows = await db
        .select({ id: chatTeamsFileTransfers.id })
        .from(chatTeamsFileTransfers)
        .where(
          and(
            eligible,
            cursor ? gt(chatTeamsFileTransfers.id, cursor) : undefined,
          ),
        )
        .orderBy(chatTeamsFileTransfers.id)
        .limit(size);
      if (cursor && rows.length < size) {
        const wrapped = await db
          .select({ id: chatTeamsFileTransfers.id })
          .from(chatTeamsFileTransfers)
          .where(and(eligible, lte(chatTeamsFileTransfers.id, cursor)))
          .orderBy(chatTeamsFileTransfers.id)
          .limit(size - rows.length);
        rows.push(...wrapped);
      }
    } catch {
      throw new Error(
        "Teams file recovery selection is temporarily unavailable",
      );
    }
    const result: TeamsFileRecoverySweepSummary = {
      scanned: 0,
      recovered: 0,
      failed: 0,
      cursor: cursor ?? null,
    };
    for (const candidate of rows) {
      // Progress over rejected rows too. Neither corrupt evidence nor a held
      // publication lock can pin every later scan to the same oldest page.
      cursors.set(companyId, candidate.id);
      result.cursor = candidate.id;
      result.scanned++;
      try {
        const recovered = await db.transaction(async (tx) => {
          // The projection may need endpoint/conversation rows too. Bound
          // only maintenance lock waits, including locks inside that callback.
          await tx.execute(sql`set local lock_timeout = '250ms'`);
          const row = await locked(tx, companyId, candidate.id, true);
          if (
            (sending.includes(row.phase) || row.phase === "conflict") &&
            row.attemptExpiresAt &&
            row.attemptExpiresAt <= now()
          ) {
            await update(tx, row, {
              phase:
                row.phase === "conflict" ? "conflict" : unknownPhase[row.phase],
              attemptId: null,
              attemptExpiresAt: null,
              reason:
                row.phase === "conflict"
                  ? row.reason
                  : "worker_outcome_unknown",
            });
            return true;
          } else if (
            ["consent_pending", "awaiting_consent", "upload_pending"].includes(
              row.phase,
            ) &&
            row.expiresAt <= now()
          ) {
            await update(tx, row, {
              phase: "expired",
              reason: "unused_consent_expired",
            });
            return true;
          }
          return false;
        });
        if (recovered) result.recovered++;
      } catch {
        // Keep the exact evidence and rollback any paired projection. Only
        // closed counters escape; never log SQL parameters/ciphertext/errors.
        result.failed++;
      }
    }
    return result;
  }
  async function cancel(companyId: string, id: string) {
    return db.transaction(async (tx) => {
      const row = await locked(tx, companyId, id);
      if (closed.includes(row.phase)) return summary(row);
      // Unknown I/O is never relabelled as undelivered by cancellation.
      if (
        ![
          "consent_pending",
          "awaiting_consent",
          "upload_pending",
          "file_info_pending",
        ].includes(row.phase)
      )
        fail();
      return summary(
        await update(tx, row, {
          phase: "cancelled",
          reason:
            row.phase === "file_info_pending"
              ? "cancelled_after_upload"
              : "cancelled_before_upload",
        }),
      );
    });
  }

  /** Read-only UI readiness, not resolution authority. The resolver repeats its
   * exact version and ownership checks under lock. Never expose private proof. */
  async function canCancelConflict(input: {
    companyId: string;
    endpointId: string;
    conversationId: string;
    publicationId: string;
    version: number;
  }): Promise<boolean> {
    if (
      ![
        input.companyId,
        input.endpointId,
        input.conversationId,
        input.publicationId,
      ].every((id) => z.uuid().safeParse(id).success) ||
      !Number.isSafeInteger(input.version) ||
      input.version < 1
    )
      return false;
    try {
      const [selected] = await db
        .select({ transfer: chatTeamsFileTransfers })
        .from(chatTeamsFileTransfers)
        .innerJoin(
          chatPublications,
          and(
            eq(chatPublications.id, chatTeamsFileTransfers.publicationId),
            eq(chatPublications.companyId, chatTeamsFileTransfers.companyId),
            eq(chatPublications.endpointId, chatTeamsFileTransfers.endpointId),
            eq(
              chatPublications.conversationId,
              chatTeamsFileTransfers.conversationId,
            ),
            eq(chatPublications.issueId, chatTeamsFileTransfers.issueId),
          ),
        )
        .where(
          and(
            eq(chatTeamsFileTransfers.companyId, input.companyId),
            eq(chatTeamsFileTransfers.endpointId, input.endpointId),
            eq(chatTeamsFileTransfers.conversationId, input.conversationId),
            eq(chatTeamsFileTransfers.publicationId, input.publicationId),
            eq(chatTeamsFileTransfers.phase, "conflict"),
            eq(chatTeamsFileTransfers.version, input.version),
          ),
        )
        .limit(1);
      const row = selected?.transfer;
      if (!row || authorityHash(authority(row)) !== row.authorityDigest)
        return false;
      const { state } = await decoded(row);
      const quarantine = state.quarantine;
      if (
        !quarantine ||
        quarantine.fromVersion >= row.version ||
        ![
          "consent_sending",
          "consent_unknown",
          "awaiting_consent",
          "upload_pending",
          "uploading",
          "upload_unknown",
          "file_info_pending",
          "file_info_sending",
          "file_info_unknown",
        ].includes(quarantine.fromPhase) ||
        !["conflicting_consent_receipt", "wrong_scope"].includes(
          row.reason ?? "",
        )
      )
        return false;
      // An orphaned/indeterminate owner is not an expired owner. Only exact
      // cleared ownership or a coherent elapsed lease makes cancellation ready.
      return (
        (row.attemptId === null && row.attemptExpiresAt === null) ||
        Boolean(
          row.attemptId &&
          row.attemptExpiresAt &&
          row.attemptId === quarantine.attemptId &&
          row.attemptExpiresAt.toISOString() === quarantine.attemptExpiresAt &&
          row.attemptExpiresAt.getTime() <= now().getTime(),
        )
      );
    } catch {
      return false;
    }
  }

  /** Caller owns Board authorization, credential lease, audit, and paired public
   * publication update in THIS transaction. No nested transaction or effects. */
  async function resolveInTransaction(
    tx: Tx,
    input: {
      companyId: string;
      publicationId: string;
      transferId: string;
      expectedVersion: number;
      expectedPhase:
        "consent_unknown" | "upload_unknown" | "file_info_unknown" | "conflict";
      action: "mark_delivered" | "retry_anyway" | "cancel";
    },
  ) {
    const row = await locked(tx, input.companyId, input.transferId);
    if (
      row.publicationId !== input.publicationId ||
      row.version !== input.expectedVersion ||
      row.phase !== input.expectedPhase ||
      ![
        "consent_unknown",
        "upload_unknown",
        "file_info_unknown",
        "conflict",
      ].includes(row.phase) ||
      !["mark_delivered", "retry_anyway", "cancel"].includes(input.action) ||
      (row.attemptId && (!row.attemptExpiresAt || row.attemptExpiresAt > now()))
    )
      fail();
    if (input.action !== "cancel" && row.phase !== "file_info_unknown") fail();
    const { state, binding } = await decoded(row);
    if (input.action !== "cancel") {
      if (!state.upload) fail();
      const upload = await restoreTeamsFileUpload(
        context(row),
        binding,
        state.upload,
      );
      // Confirmation must already exist for the exact PUT; neither an operator
      // choice nor file-info retry can invent upload success or perform PUT.
      buildTeamsUploadedFileCard(upload, { kind: "uploaded" });
      if (input.action === "retry_anyway")
        await verify(tx, authority(row), "file_info");
    }
    state.resolution = {
      schema: "paperclip.teams.file-resolution.v1",
      action: input.action,
      fromPhase: input.expectedPhase,
      fromVersion: row.version,
      previousReason: row.reason,
      at: now().toISOString(),
    };
    return summary(
      await update(tx, row, {
        privateState: state,
        attemptId: null,
        attemptExpiresAt: null,
        phase:
          input.action === "mark_delivered"
            ? "delivered"
            : input.action === "retry_anyway"
              ? "file_info_pending"
              : "cancelled",
        reason:
          input.action === "mark_delivered"
            ? "operator_confirmed_file_delivery"
            : input.action === "retry_anyway"
              ? "operator_requested_file_info_retry"
              : `operator_cancelled_${row.phase}`,
        // Deliberately no fabricated fileInfoMessageId for an operator receipt.
      }),
    );
  }
  return {
    issue,
    recordConsent,
    process,
    get,
    expireAndRecover,
    cancel,
    canCancelConflict,
    resolveInTransaction,
  };
}
