import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  assets,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatExternalPrincipals,
  chatMessageLinks,
  chatPublications,
  chatTeamsFileTransfers,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issueAttachments,
  issueComments,
  issues,
  startEmbeddedPostgresTestDatabase,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { ChatFileTransferPhase } from "@paperclipai/shared";
import type { TeamsFileTransferSummary } from "./chat-teams-file-transfers.js";
import { projectTeamsFilePublication } from "./chat-teams-file-publication.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;
suite("Teams same-transaction publication projection (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary:
    Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase(
        "paperclip-teams-projection-",
      );
      db = createDb(temporary.connectionString);
    }
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture(
    phase: ChatFileTransferPhase = "consent_pending",
    operatorConfirmed = false,
  ) {
    const companyId = randomUUID(),
      agentId = randomUUID(),
      applicationId = randomUUID(),
      connectionId = randomUUID();
    const endpointId = randomUUID(),
      conversationId = randomUUID(),
      issueId = randomUUID();
    const commentId = randomUUID(),
      attachmentId = randomUUID(),
      assetId = randomUUID(),
      principalId = randomUUID();
    const publicationId = randomUUID(),
      id = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Teams projection fixture",
      issuePrefix: `P${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Teams fixture",
      adapterType: "codex_local",
    });
    await db
      .insert(toolApplications)
      .values({ id: applicationId, companyId, name: "Teams", type: "chat" });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      uid: randomUUID(),
      name: "Teams",
      transport: "chat_sdk",
      connectionPurpose: "channel",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider: "microsoft-teams",
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
    });
    await db
      .insert(issues)
      .values({ id: issueId, companyId, title: "Exact file output" });
    await db.insert(chatConversations).values({
      id: conversationId,
      companyId,
      endpointId,
      issueId,
      externalConversationId: "a:personal",
      externalThreadId: "teams:YTpwZXJzb25hbA",
      externalLabel: "Personal",
      isDirectMessage: true,
    });
    await db.insert(chatExternalPrincipals).values({
      id: principalId,
      companyId,
      provider: "microsoft-teams",
      providerAccountId: randomUUID(),
      externalId: randomUUID(),
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      body: "Preserve original comment",
      authorUserId: "fixture-user",
    });
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local_disk",
      objectKey: `fixture/${assetId}`,
      contentType: "text/plain",
      byteSize: 12,
      sha256: "a".repeat(64),
      originalFilename: "file.txt",
    });
    await db.insert(issueAttachments).values({
      id: attachmentId,
      companyId,
      issueId,
      assetId,
      issueCommentId: commentId,
    });
    await db.insert(chatPublications).values({
      id: publicationId,
      companyId,
      endpointId,
      conversationId,
      issueId,
      commentId,
      idempotencyKey: `fixture:${publicationId}`,
      payload: { text: "Original body", attachmentIds: [attachmentId] },
    });
    const sending = [
      "consent_sending",
      "uploading",
      "file_info_sending",
    ].includes(phase);
    const hasCard = ![
      "consent_pending",
      "consent_sending",
      "consent_unknown",
    ].includes(phase);
    const privateState = {
      schema: "paperclip.teams.transfer-private.v1",
      binding: { ciphertext: "PRIVATE-PROJECTION-CANARY" },
      ...(operatorConfirmed
        ? {
            resolution: {
              schema: "paperclip.teams.file-resolution.v1",
              action: "mark_delivered",
              fromPhase: "file_info_unknown",
              fromVersion: 3,
              previousReason: null,
              at: new Date().toISOString(),
            },
          }
        : {}),
    };
    await db.insert(chatTeamsFileTransfers).values({
      id,
      companyId,
      endpointId,
      conversationId,
      publicationId,
      issueId,
      commentId,
      attachmentId,
      principalId,
      authorizedUserId: "fixture-user",
      runtimeGeneration: 1,
      credentialFingerprint: "c".repeat(64),
      conversationGeneration: 1,
      sourceDigest: "d".repeat(64),
      authorityDigest: "e".repeat(64),
      tenantId: randomUUID(),
      botAppId: randomUUID(),
      aadObjectId: randomUUID(),
      providerConversationId: "a:personal",
      providerUserId: "29:recipient",
      sha256: "a".repeat(64),
      byteSize: 12,
      filename: "file.txt",
      tokenSha256: id.replaceAll("-", "").repeat(2),
      phase,
      version: 1,
      attemptId: sending ? randomUUID() : null,
      attemptExpiresAt: sending ? new Date(Date.now() + 90_000) : null,
      consentMessageId: hasCard ? "card-1" : null,
      responseActivityId: phase === "declined" ? "decline-1" : null,
      fileInfoMessageId:
        phase === "delivered" && !operatorConfirmed ? "file-info-1" : null,
      privateState,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const row = () =>
      db
        .select()
        .from(chatTeamsFileTransfers)
        .where(eq(chatTeamsFileTransfers.id, id))
        .then((rows) => rows[0]!);
    const summary = async (): Promise<TeamsFileTransferSummary> => {
      const r = await row();
      const op =
        (r.privateState.resolution as { action?: string } | undefined)
          ?.action === "mark_delivered";
      return {
        id,
        companyId,
        endpointId,
        conversationId,
        issueId,
        publicationId,
        filename: r.filename,
        phase: r.phase as ChatFileTransferPhase,
        version: r.version,
        reason: r.reason,
        consentMessageId: r.consentMessageId,
        fileInfoMessageId: r.fileInfoMessageId,
        consentConfirmed: Boolean(r.consentMessageId || r.responseActivityId),
        operatorConfirmed: op,
        fileDelivered:
          r.phase === "delivered" && Boolean(r.fileInfoMessageId || op),
        expiresAt: r.expiresAt.toISOString(),
      };
    };
    const project = async () => {
      const s = await summary();
      await db.transaction((tx) => projectTeamsFilePublication(tx, s));
    };
    const publication = () =>
      db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.id, publicationId))
        .then((rows) => rows[0]!);
    const links = () =>
      db
        .select()
        .from(chatMessageLinks)
        .where(eq(chatMessageLinks.endpointId, endpointId));
    const actions = () =>
      db
        .select()
        .from(chatActions)
        .where(eq(chatActions.endpointId, endpointId));
    const endpoint = () =>
      db
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpointId))
        .then((rows) => rows[0]!);
    return {
      id,
      companyId,
      endpointId,
      conversationId,
      issueId,
      publicationId,
      commentId,
      attachmentId,
      row,
      summary,
      project,
      publication,
      links,
      actions,
      endpoint,
    };
  }

  it.each([
    ["consent_pending", "pending"],
    ["consent_sending", "streaming"],
    ["consent_unknown", "delivery_unknown"],
    ["awaiting_consent", "awaiting_consent"],
    ["upload_pending", "pending"],
    ["uploading", "streaming"],
    ["upload_unknown", "delivery_unknown"],
    ["file_info_pending", "pending"],
    ["file_info_sending", "streaming"],
    ["file_info_unknown", "delivery_unknown"],
    ["delivered", "published"],
    ["declined", "cancelled"],
    ["expired", "cancelled"],
    ["cancelled", "cancelled"],
    ["conflict", "delivery_unknown"],
  ] as const)(
    "projects %s as %s without treating consent as a file",
    async (phase, state) => {
      const f = await fixture(phase);
      await f.project();
      const p = await f.publication();
      expect(p.state).toBe(state);
      expect(p.providerMessageId).toBe(
        phase === "delivered" ? "file-info-1" : null,
      );
      expect(p.providerUrl).toBeNull();
      expect(p.publishedAt !== null).toBe(phase === "delivered");
      expect((await f.links()).length).toBe(phase === "delivered" ? 1 : 0);
      expect((await f.endpoint()).lastPublicationAt !== null).toBe(
        phase === "delivered",
      );
      expect(p.attempts).toBe(
        ["consent_sending", "uploading", "file_info_sending"].includes(phase)
          ? 1
          : 0,
      );
      expect(p.nextAttemptAt !== null).toBe(
        ["pending", "streaming", "awaiting_consent"].includes(state),
      );
      expect(p.payload).toEqual({
        text: "Original body",
        attachmentIds: [f.attachmentId],
      });
      expect(
        JSON.stringify({
          p,
          links: await f.links(),
          actions: await f.actions(),
        }),
      ).not.toContain("PRIVATE-PROJECTION-CANARY");
    },
  );

  it("counts each exact intent once across duplicate projections and buffered-response versions", async () => {
    const f = await fixture("consent_sending");
    await f.project();
    const first = await f.publication();
    await f.project();
    expect(await f.publication()).toEqual(first);
    await db
      .update(chatTeamsFileTransfers)
      .set({ version: 2, responseActivityId: "early-response" })
      .where(eq(chatTeamsFileTransfers.id, f.id));
    await f.project();
    expect((await f.publication()).attempts).toBe(1);
    await db
      .update(chatTeamsFileTransfers)
      .set({ version: 3, attemptId: randomUUID() })
      .where(eq(chatTeamsFileTransfers.id, f.id));
    await f.project();
    expect((await f.publication()).attempts).toBe(2);
    expect(await f.actions()).toHaveLength(2);
  });
  it("keeps publishedAt, final link and endpoint timestamp unchanged on replay", async () => {
    const f = await fixture("delivered");
    await f.project();
    const p = await f.publication(),
      e = await f.endpoint();
    await f.project();
    expect(await f.publication()).toEqual(p);
    expect(await f.endpoint()).toEqual(e);
    expect(await f.links()).toHaveLength(1);
  });
  it("operator confirmation publishes without inventing a native ID, link or endpoint receipt", async () => {
    const f = await fixture("delivered", true);
    await f.project();
    const p = await f.publication();
    expect(p.state).toBe("published");
    expect(p.publishedAt).not.toBeNull();
    expect(p.providerMessageId).toBeNull();
    expect(await f.links()).toEqual([]);
    expect((await f.endpoint()).lastPublicationAt).toBeNull();
  });
  it("retains a final receipt after source deletion without linking another comment", async () => {
    const f = await fixture("delivered");
    await db
      .delete(issueAttachments)
      .where(eq(issueAttachments.id, f.attachmentId));
    await db.delete(issueComments).where(eq(issueComments.id, f.commentId));
    await db
      .update(chatEndpoints)
      .set({ status: "paused" })
      .where(eq(chatEndpoints.id, f.endpointId));
    await f.project();
    expect((await f.publication()).state).toBe("published");
    expect((await f.links())[0]).toMatchObject({
      publicationId: f.publicationId,
      commentId: null,
      providerMessageId: "file-info-1",
    });
  });
  it("rejects a final message identity owned by another publication, rolling back all projection", async () => {
    const f = await fixture("delivered"),
      other = randomUUID();
    await db.insert(chatPublications).values({
      id: other,
      companyId: f.companyId,
      endpointId: f.endpointId,
      conversationId: f.conversationId,
      issueId: f.issueId,
      commentId: f.commentId,
      idempotencyKey: other,
      payload: { text: "Other" },
    });
    await db.insert(chatMessageLinks).values({
      companyId: f.companyId,
      endpointId: f.endpointId,
      conversationId: f.conversationId,
      publicationId: other,
      commentId: f.commentId,
      providerMessageId: "file-info-1",
      direction: "outbound",
    });
    const before = await f.publication();
    await expect(f.project()).rejects.toThrow("conflicted");
    expect(await f.publication()).toEqual(before);
    expect((await f.endpoint()).lastPublicationAt).toBeNull();
  });
  it.each([
    "companyId",
    "endpointId",
    "conversationId",
    "issueId",
    "publicationId",
  ] as const)("rejects mismatched %s without projection", async (key) => {
    const f = await fixture(),
      s = await f.summary(),
      before = await f.publication();
    await expect(
      db.transaction((tx) =>
        projectTeamsFilePublication(tx, { ...s, [key]: randomUUID() }),
      ),
    ).rejects.toThrow("conflicted");
    expect(await f.publication()).toEqual(before);
    expect(await f.actions()).toEqual([]);
  });
  it("rejects stale version and forged receipt flags", async () => {
    const f = await fixture("delivered"),
      s = await f.summary();
    for (const patch of [
      { version: s.version + 1 },
      { operatorConfirmed: true },
      { fileInfoMessageId: "fabricated" },
    ])
      await expect(
        db.transaction((tx) =>
          projectTeamsFilePublication(tx, { ...s, ...patch }),
        ),
      ).rejects.toThrow("conflicted");
    expect((await f.publication()).state).toBe("pending");
    expect(await f.links()).toEqual([]);
  });
  it.each(["delivered", "awaiting_consent"] as const)(
    "keeps missing %s receipt unknown rather than fabricating success",
    async (phase) => {
      const f = await fixture(phase);
      await db
        .update(chatTeamsFileTransfers)
        .set({ consentMessageId: null, fileInfoMessageId: null })
        .where(eq(chatTeamsFileTransfers.id, f.id));
      await f.project();
      expect((await f.publication()).state).toBe("delivery_unknown");
      expect((await f.publication()).publishedAt).toBeNull();
      expect(await f.links()).toEqual([]);
    },
  );
  it("rejects an effect-intent UUID receipt belonging to another transfer", async () => {
    const f = await fixture("consent_sending"),
      r = await f.row();
    await db
      .insert(chatActions)
      .values({
        companyId: f.companyId,
        endpointId: f.endpointId,
        conversationId: f.conversationId,
        kind: "teams_file_effect_intent",
        providerActionId: `teams-file-effect:${r.attemptId}`,
        status: "processed",
        payload: {
          schema: "paperclip.teams.file-effect-intent.v1",
          transferId: randomUUID(),
          publicationId: f.publicationId,
          attemptId: r.attemptId,
          stage: "consent",
        },
      });
    await expect(f.project()).rejects.toThrow("conflicted");
    expect((await f.publication()).attempts).toBe(0);
    expect((await f.publication()).state).toBe("pending");
  });
  it("rejects changed selected attachment and a consent ID masquerading as final", async () => {
    const f = await fixture("delivered");
    await db
      .update(chatPublications)
      .set({ payload: { text: "Changed", attachmentIds: [randomUUID()] } })
      .where(eq(chatPublications.id, f.publicationId));
    await expect(f.project()).rejects.toThrow("conflicted");
    await db
      .update(chatPublications)
      .set({ payload: { text: "Original", attachmentIds: [f.attachmentId] } })
      .where(eq(chatPublications.id, f.publicationId));
    await db
      .update(chatTeamsFileTransfers)
      .set({ fileInfoMessageId: "card-1" })
      .where(eq(chatTeamsFileTransfers.id, f.id));
    await expect(f.project()).rejects.toThrow("conflicted");
    expect((await f.publication()).state).toBe("pending");
    expect(await f.links()).toEqual([]);
  });
  it("rolls back transfer mutation, attempt receipt and publication together", async () => {
    const f = await fixture(),
      s = await f.summary();
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(chatTeamsFileTransfers)
          .set({
            phase: "consent_sending",
            version: 2,
            attemptId: randomUUID(),
            attemptExpiresAt: new Date(Date.now() + 90_000),
          })
          .where(eq(chatTeamsFileTransfers.id, f.id));
        await projectTeamsFilePublication(tx, {
          ...s,
          phase: "consent_sending",
          version: 2,
        });
        throw new Error("outer audit failed");
      }),
    ).rejects.toThrow("outer audit failed");
    expect((await f.row()).phase).toBe("consent_pending");
    expect((await f.publication()).attempts).toBe(0);
    expect(await f.actions()).toEqual([]);
  });
  it("never echoes unknown reason prose and backs off a proved unattempted step", async () => {
    const f = await fixture("upload_unknown");
    await db
      .update(chatTeamsFileTransfers)
      .set({ reason: "https://private.invalid/?secret=DO-NOT-ECHO" })
      .where(eq(chatTeamsFileTransfers.id, f.id));
    await f.project();
    expect((await f.publication()).redactedError).toBe(
      "The file-transfer outcome requires operator review.",
    );
    await db
      .update(chatTeamsFileTransfers)
      .set({
        phase: "upload_pending",
        reason: "provider_not_attempted",
        version: 2,
      })
      .where(eq(chatTeamsFileTransfers.id, f.id));
    await f.project();
    expect((await f.publication()).nextAttemptAt!.getTime()).toBeGreaterThan(
      Date.now() + 25_000,
    );
  });
});
