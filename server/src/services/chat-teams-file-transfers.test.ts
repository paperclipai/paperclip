import { teamsAttemptRecoveryWork } from "./chat-channels/microsoft-teams/attempt-recovery-work.js";
import { teamsConsentExpiryWork } from "./chat-channels/microsoft-teams/consent-expiry-work.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { idleWorkSnapshot } from "./task-admission.js";
import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agents,
  assets,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatExternalPrincipals,
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
import {
  installTeamsFileConsentHook,
  restoreTeamsFileConsentBinding,
  restoreTeamsFileConsentEvent,
  restoreTeamsFileUpload,
  sealTeamsFileConsentBinding,
  bindEarlyTeamsFileConsent,
  type TeamsConsentApp,
  type TeamsFileConsentEvent,
} from "./chat-teams-file-consent.js";
import {
  teamsFileTransferService,
  type TeamsFileTransferAuthority,
  type TeamsFileTransferOptions,
} from "./chat-teams-file-transfers.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const bytes = Buffer.from("Exact Teams file bytes\n");
const uploadUrl =
  "https://tenant-my.sharepoint.com/personal/user/_api/upload?token=PRIVATE-TEAMS-UPLOAD-CANARY";
const contentUrl =
  "https://tenant-my.sharepoint.com/personal/user/Documents/file.txt";
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");

suite(
  "durable Teams file transfers (real PostgreSQL, no provider network)",
  () => {
    let db: ReturnType<typeof createDb>;
    let temporary:
      Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
    beforeAll(async () => {
      vi.stubEnv(
        "PAPERCLIP_SECRETS_MASTER_KEY",
        Buffer.alloc(32, 79).toString("base64"),
      );
      if (external) db = createDb(external);
      else {
        temporary = await startEmbeddedPostgresTestDatabase(
          "paperclip-teams-transfers-",
        );
        db = createDb(temporary.connectionString);
      }
    }, 60_000);
    afterAll(async () => {
      await db?.$client.end();
      await temporary?.cleanup();
      vi.unstubAllEnvs();
    });
    afterEach(() => vi.restoreAllMocks());

    async function fixture(
      consentLifetimeMs = 60_000,
      originalFilename: string | null = "file.txt",
    ) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const applicationId = randomUUID();
      const connectionId = randomUUID();
      const attachmentId = randomUUID();
      const a: TeamsFileTransferAuthority = {
        companyId,
        endpointId: randomUUID(),
        conversationId: randomUUID(),
        issueId: randomUUID(),
        publicationId: randomUUID(),
        commentId: randomUUID(),
        attachmentId,
        principalId: randomUUID(),
        authorizedUserId: "board-user",
        runtimeGeneration: 3,
        credentialFingerprint: "c".repeat(64),
        conversationGeneration: 2,
        sourceDigest: "d".repeat(64),
        tenantId: randomUUID(),
        botAppId: randomUUID(),
        aadObjectId: randomUUID(),
        providerConversationId: "a:exact-personal",
        providerUserId: "29:exact-recipient",
        sha256: hash(bytes),
        byteSize: bytes.length,
        filename: originalFilename ?? `attachment-${attachmentId}`,
      };
      await db.insert(companies).values({
        id: companyId,
        name: "Teams transfer fixture",
        issuePrefix: `T${companyId.slice(0, 7)}`,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Teams test",
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
        id: a.endpointId,
        companyId,
        connectionId,
        provider: "microsoft-teams",
        publicId: randomUUID(),
        assignedAgentId: agentId,
        status: "active",
        providerAccountId: a.tenantId,
        botExternalId: a.botAppId,
      });
      await db
        .insert(issues)
        .values({ id: a.issueId, companyId, title: "Exact file output" });
      await db.insert(chatConversations).values({
        id: a.conversationId,
        companyId,
        endpointId: a.endpointId,
        issueId: a.issueId,
        externalConversationId: a.providerConversationId,
        externalThreadId: `teams:${Buffer.from(a.providerConversationId).toString("base64url")}`,
        externalLabel: "Personal",
        isDirectMessage: true,
        sessionGeneration: a.conversationGeneration,
      });
      await db.insert(chatExternalPrincipals).values({
        id: a.principalId,
        companyId,
        provider: "microsoft-teams",
        providerAccountId: a.tenantId,
        externalId: a.aadObjectId,
      });
      await db.insert(issueComments).values({
        id: a.commentId,
        companyId,
        issueId: a.issueId,
        body: "Share this exact file",
        authorUserId: a.authorizedUserId,
      });
      const assetId = randomUUID();
      await db.insert(assets).values({
        id: assetId,
        companyId,
        provider: "local_disk",
        objectKey: `test/${assetId}`,
        contentType: "text/plain",
        byteSize: bytes.length,
        sha256: a.sha256,
        originalFilename,
      });
      await db.insert(issueAttachments).values({
        id: a.attachmentId,
        companyId,
        issueId: a.issueId,
        assetId,
        issueCommentId: a.commentId,
      });
      await db.insert(chatPublications).values({
        id: a.publicationId,
        companyId,
        endpointId: a.endpointId,
        conversationId: a.conversationId,
        issueId: a.issueId,
        commentId: a.commentId,
        idempotencyKey: `test:${a.publicationId}`,
        payload: {
          text: "Shared file.txt.",
          attachmentIds: [a.attachmentId],
        },
      });
      let clock = new Date();
      let current = { ...a };
      const opts: TeamsFileTransferOptions = {
        // Consumer boundary fixture; full source/runtime policy lives in the
        // integrating service. Artifact checks below still use actual locked DB rows.
        authorize: vi.fn(async () => ({ ...current })),
        loadBytes: vi.fn(async () => Buffer.from(bytes)),
        postConsent: vi.fn(async () => ({ id: "card-1" })),
        postFileInfo: vi.fn(async () => ({ id: "file-info-1" })),
        uploadRequest: vi.fn(async () =>
          Response.json(
            { id: "item-1", name: "file.txt", size: bytes.length },
            { status: 201 },
          ),
        ),
        now: () => clock,
      };
      const service = () => teamsFileTransferService(db, opts);
      const created = await service().issue(
        a,
        new Date(clock.getTime() + consentLifetimeMs),
      );
      const read = () =>
        db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.id, created.id))
          .then((rows) => rows[0]!);
      const privateContext = async () => {
        const row = await read();
        return {
          companyId,
          endpointId: a.endpointId,
          transferId: row.id,
          authorityDigest: row.authorityDigest,
        };
      };
      async function event(
        action: "accept" | "decline" = "accept",
        override: Record<string, unknown> = {},
      ) {
        const row = await read();
        const binding = await restoreTeamsFileConsentBinding(
          await privateContext(),
          row.privateState.binding as Record<string, unknown>,
        );
        let captured: TeamsFileConsentEvent | undefined;
        const handlers = new Map<
          string,
          (context: { activity: unknown }) => Promise<{ status: number }>
        >();
        installTeamsFileConsentHook(
          {
            on: (name, callback) => {
              handlers.set(name, callback);
            },
          } satisfies TeamsConsentApp,
          {
            companyId,
            endpointId: a.endpointId,
            tenantId: a.tenantId,
            botAppId: a.botAppId,
            onConsent: async (value) => {
              captured = value;
              return "recorded";
            },
          },
        );
        const activity = {
          type: "invoke",
          name: "fileConsent/invoke",
          channelId: "msteams",
          id: "activity-1",
          from: { id: a.providerUserId, aadObjectId: a.aadObjectId },
          recipient: { id: `28:${a.botAppId}` },
          conversation: {
            id: a.providerConversationId,
            conversationType: "personal",
            tenantId: a.tenantId,
          },
          replyToId: "card-1",
          value: {
            action,
            context: { schema: binding.schema, token: binding.token, action },
            ...(action === "accept"
              ? {
                  uploadInfo: {
                    name: a.filename,
                    fileType: "txt",
                    uniqueId: "item-1",
                    uploadUrl,
                    contentUrl,
                  },
                }
              : {}),
          },
          ...override,
        };
        expect(
          (await handlers.get(`file.consent.${action}`)!({ activity })).status,
        ).toBe(200);
        return captured!;
      }
      return {
        a,
        opts,
        service,
        created,
        read,
        event,
        privateContext,
        assetId,
        setCurrent: (patch: Partial<TeamsFileTransferAuthority>) => {
          current = { ...current, ...patch };
        },
        advance: (ms: number) => {
          clock = new Date(clock.getTime() + ms);
        },
      };
    }

    describe("scheduled abandoned attempt recovery", () => {
      let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
      const transferIds: string[] = [], errors: unknown[] = [];
      let enabled = true;
      afterEach(async () => {
        await coordinator?.stop(); coordinator = undefined;
        vi.useRealTimers(); vi.restoreAllMocks();
        if (transferIds.length) await db.delete(chatTeamsFileTransfers).where(inArray(chatTeamsFileTransfers.id, transferIds.splice(0)));
        errors.length = 0; enabled = true;
      });
      async function transfer() {
        const f = await fixture(600_000); transferIds.push(f.created.id);
        f.opts.now = () => new Date();
        return f;
      }
      async function abandon(f: Awaited<ReturnType<typeof transfer>>, stage = "consent") {
        if (stage !== "consent") {
          await f.service().process(f.a.companyId, f.created.id);
          await f.service().recordConsent(await f.event());
          if (stage === "file_info") await f.service().process(f.a.companyId, f.created.id);
        }
        const outcome = stage === "consent" ? "awaiting_consent" : stage === "upload" ? "file_info_pending" : "delivered";
        f.opts.project = async (_tx, row) => { if (row.phase === outcome) throw new Error("receipt projection interrupted"); };
        await expect(f.service().process(f.a.companyId, f.created.id)).rejects.toThrow("receipt projection interrupted");
        delete f.opts.project;
        return (await f.read()).attemptExpiresAt!.getTime();
      }
      function worker(recover: (companyId: string, id: string) => Promise<boolean>) {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
        const work = teamsAttemptRecoveryWork(db, recover);
        return { work, ready: work.register(coordinator, () => enabled).ready };
      }
      async function settled() {
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 5000 });
      }
      async function quiet(ms = 10_000) {
        const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction"), execute = vi.spyOn(db, "execute");
        try { await vi.advanceTimersByTimeAsync(ms); expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); }
        finally { select.mockRestore(); transaction.mockRestore(); execute.mockRestore(); }
      }
      it("leaves unused consent and retained terminal history quiet", async () => {
        const f = await transfer(), cancelled = await transfer();
        await cancelled.service().cancel(cancelled.a.companyId, cancelled.created.id);
        await worker(f.service().recoverAbandonedAttempt).ready; await settled();
        expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(180_000);
        expect((await f.read()).phase).toBe("consent_pending"); expect(errors).toEqual([]);
      });
      it.each(["consent", "upload", "file_info"])("restores the actual %s claim deadline and quarantines without repeating provider I/O", async stage => {
        const f = await transfer(); const due = await abandon(f, stage);
        const calls = [f.opts.postConsent, f.opts.uploadRequest!, f.opts.postFileInfo].map(fn => vi.mocked(fn).mock.calls.length);
        await worker(f.service().recoverAbandonedAttempt).ready; await settled();
        expect(coordinator!.nextWakeAt()).toBe(due); await quiet();
        await coordinator!.stop(); await worker(f.service().recoverAbandonedAttempt).ready;
        expect(coordinator!.nextWakeAt()).toBe(due); await quiet();
        await vi.advanceTimersByTimeAsync(due - Date.now() + 1000); await settled();
        expect(await f.read()).toMatchObject({ phase: `${stage}_unknown`, attemptId: null, attemptExpiresAt: null, reason: "worker_outcome_unknown" });
        expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(180_000);
        expect([f.opts.postConsent, f.opts.uploadRequest!, f.opts.postFileInfo].map(fn => vi.mocked(fn).mock.calls.length)).toEqual(calls);
        expect(errors).toEqual([]);
      });
      it("wakes from the real first claim and removes the deadline after normal settlement", async () => {
        const f = await transfer(); let release!: () => void, entered!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
        f.opts.postConsent = vi.fn(async () => { entered(); await hold; return { id: "card-1" }; });
        await worker(f.service().recoverAbandonedAttempt).ready; await settled();
        expect(coordinator!.nextWakeAt()).toBeNull();
        const send = f.service().process(f.a.companyId, f.created.id);
        try {
          await ready; await settled(); const row = await f.read();
          expect(coordinator!.nextWakeAt()).toBe(row.attemptExpiresAt!.getTime()); await quiet();
        } finally { release(); }
        expect((await send).phase).toBe("awaiting_consent"); await settled();
        expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(180_000);
        expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
      });
      it("retains a first committed attempt across drain and recovers on resume", async () => {
        const f = await transfer(); enabled = false;
        await worker(f.service().recoverAbandonedAttempt).ready;
        let release!: () => void, entered!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
        f.opts.postConsent = vi.fn(async () => { entered(); await hold; return { id: "late-card" }; });
        const send = f.service().process(f.a.companyId, f.created.id);
        try {
          await ready; await f.service().recordConsent(await f.event());
          await f.service().recordConsent(await f.event("decline"));
        } finally { release(); await send; }
        await quiet(120_000);
        expect((await f.read()).phase).toBe("conflict"); expect((await f.read()).attemptId).not.toBeNull();
        enabled = true; await vi.advanceTimersByTimeAsync(30_000); await settled();
        expect((await f.read()).phase).toBe("conflict"); expect((await f.read()).attemptId).toBeNull();
        expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(); expect(errors).toEqual([]);
      });
      it("retains atomic recovery after projection failure without leaking its error", async () => {
        const f = await transfer(); const due = await abandon(f); let fail = true;
        f.opts.project = async tx => {
          await tx.update(chatPublications).set({ state: "failed" }).where(eq(chatPublications.id, f.a.publicationId));
          if (fail) throw new Error("PRIVATE-TEAMS-UPLOAD-CANARY");
        };
        await worker(f.service().recoverAbandonedAttempt).ready;
        await vi.advanceTimersByTimeAsync(due - Date.now() + 1000); await settled();
        expect((await f.read()).phase).toBe("consent_sending");
        expect((await db.select().from(chatPublications).where(eq(chatPublications.id, f.a.publicationId)))[0].state).toBe("pending");
        expect(errors).toHaveLength(1); expect(String((errors[0] as AggregateError).errors[0])).not.toContain("CANARY");
        fail = false; await vi.advanceTimersByTimeAsync(30_000); await settled();
        expect((await f.read()).phase).toBe("consent_unknown");
        expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(); expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
      });
      it("preserves conflict evidence and clears only its expired ownership", async () => {
        const f = await transfer(); let release!: () => void, entered!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
        f.opts.postConsent = vi.fn(async () => { entered(); await hold; return { id: "late-card" }; });
        await worker(f.service().recoverAbandonedAttempt).ready;
        const send = f.service().process(f.a.companyId, f.created.id);
        try {
          await ready; await f.service().recordConsent(await f.event());
          await f.service().recordConsent(await f.event("decline"));
        } finally { release(); }
        await send; const before = await f.read(); expect(before.phase).toBe("conflict");
        await settled(); expect(coordinator!.nextWakeAt()).toBe(before.attemptExpiresAt!.getTime());
        await vi.advanceTimersByTimeAsync(before.attemptExpiresAt!.getTime() - Date.now() + 1000); await settled();
        const after = await f.read(); expect(after).toMatchObject({ phase: "conflict", attemptId: null, attemptExpiresAt: null, reason: before.reason, privateState: before.privateState });
        expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(180_000);
        expect(f.opts.postConsent).toHaveBeenCalledTimes(1); expect(errors).toEqual([]);
      });
      it("does not observe a rolled-back claim or contact the provider before commit", async () => {
        const f = await transfer(); let release!: () => void, entered!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
        f.opts.project = async (_tx, row) => { if (row.phase === "consent_sending") { entered(); await hold; throw new Error("claim rolled back"); } };
        await worker(f.service().recoverAbandonedAttempt).ready; await settled();
        const send = f.service().process(f.a.companyId, f.created.id);
        const failure = expect(send).rejects.toThrow("claim rolled back");
        try {
          await ready; await vi.advanceTimersByTimeAsync(10_000);
          expect(await teamsAttemptRecoveryWork(db, f.service().recoverAbandonedAttempt).load()).toEqual([]);
          expect((await f.read()).phase).toBe("consent_pending"); expect(f.opts.postConsent).not.toHaveBeenCalled();
        } finally { release(); await failure; }
        await settled();
        expect((await f.read()).phase).toBe("consent_pending"); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
      });
      it("rounds submillisecond attempts up and rechecks a changed claim", async () => {
        const f = await transfer(); await abandon(f);
        const whole = Date.now() + 60_000;
        await db.update(chatTeamsFileTransfers).set({ attemptExpiresAt: sql`${new Date(whole).toISOString()}::timestamptz + interval '0.0005 second'` }).where(eq(chatTeamsFileTransfers.id, f.created.id));
        vi.useFakeTimers({ toFake: ["Date"] });
        const work = teamsAttemptRecoveryWork(db, f.service().recoverAbandonedAttempt), [entry] = await work.load();
        expect(entry.dueAt).toBe(whole + 1); vi.setSystemTime(whole); await work.check(entry);
        expect((await f.read()).phase).toBe("consent_sending");
        const changed = whole + 90_000;
        await db.update(chatTeamsFileTransfers).set({ attemptId: randomUUID(), attemptExpiresAt: new Date(changed) }).where(eq(chatTeamsFileTransfers.id, f.created.id));
        vi.setSystemTime(whole + 1); expect(await work.check(entry)).toMatchObject({ dueAt: changed });
        expect((await f.read()).phase).toBe("consent_sending");
        vi.setSystemTime(changed); expect(await work.check(entry)).toBeNull(); expect((await f.read()).phase).toBe("consent_unknown");
      });
      it("pages and drains healthy attempts across companies while a corrupt claim retains recovery", async () => {
        const f = await transfer(), other = await transfer(); await abandon(f); await abandon(other);
        for (let index = 0; index < 100; index++) {
          const publicationId = randomUUID();
          await db.insert(chatPublications).values({ id: publicationId, companyId: f.a.companyId,
            endpointId: f.a.endpointId, conversationId: f.a.conversationId, issueId: f.a.issueId,
            commentId: f.a.commentId, idempotencyKey: `attempt-page:${publicationId}`,
            payload: { text: "Same authorized file", attachmentIds: [f.a.attachmentId] } });
          const a = { ...f.a, publicationId };
          const service = teamsFileTransferService(db, { ...f.opts, authorize: async () => a,
            project: async (_tx, row) => { if (row.phase === "awaiting_consent") throw new Error("receipt interrupted"); } });
          const created = await service.issue(a, new Date(Date.now() + 600_000)); transferIds.push(created.id);
          await expect(service.process(a.companyId, created.id)).rejects.toThrow("receipt interrupted");
        }
        await db.update(chatTeamsFileTransfers).set({ authorityDigest: "0".repeat(64) }).where(eq(chatTeamsFileTransfers.id, f.created.id));
        const { work, ready } = worker(f.service().recoverAbandonedAttempt); await ready;
        const entries = await work.load(); expect(entries).toHaveLength(102);
        const calls = vi.mocked(f.opts.postConsent).mock.calls.length;
        await vi.advanceTimersByTimeAsync(Math.max(...entries.map(row => row.dueAt)) - Date.now() + 1000);
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(1000); expect((await other.read()).phase).toBe("consent_unknown");
          expect((await work.load()).map(row => row.id)).toEqual([f.created.id]);
        }, { timeout: 10_000 });
        expect((await f.read()).phase).toBe("consent_sending"); expect(errors.length).toBeGreaterThan(0);
        expect(f.opts.postConsent).toHaveBeenCalledTimes(calls);
      }, 30_000);
      it("joins recovery projection before shutdown completes", async () => {
        const f = await transfer(); const due = await abandon(f); let release!: () => void, entered!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
        f.opts.project = async () => { entered(); await hold; };
        await worker(f.service().recoverAbandonedAttempt).ready;
        try {
          await vi.advanceTimersByTimeAsync(due - Date.now() + 1000); await ready;
          let stopped = false; const stop = coordinator!.stop().then(() => { stopped = true; });
          await Promise.resolve(); expect(stopped).toBe(false); release(); await stop;
          expect((await f.read()).phase).toBe("consent_unknown");
        } finally { release(); }
      });
    });

    describe("scheduled unused consent expiry", () => {
      let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
      const transferIds: string[] = [], errors: unknown[] = [];
      let enabled = true;
      afterEach(async () => {
        await coordinator?.stop(); coordinator = undefined;
        vi.useRealTimers(); vi.restoreAllMocks();
        if (transferIds.length) await db.delete(chatTeamsFileTransfers).where(inArray(chatTeamsFileTransfers.id, transferIds.splice(0)));
        errors.length = 0; enabled = true;
      });
      async function transfer() {
        const f = await fixture(); transferIds.push(f.created.id);
        f.opts.now = () => new Date();
        return f;
      }
      function worker(expire: (companyId: string, id: string) => Promise<boolean>) {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
        const work = teamsConsentExpiryWork(db, expire);
        return { work, ready: work.register(coordinator, () => enabled).ready };
      }
      async function settled() {
        await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 5000 });
      }
      async function quiet(ms = 10_000) {
        const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction"), execute = vi.spyOn(db, "execute");
        try { await vi.advanceTimersByTimeAsync(ms); expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); }
        finally { select.mockRestore(); transaction.mockRestore(); execute.mockRestore(); }
      }
      it("bounds reconstruction and resets its cursor on same-owner restart", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const f = await transfer(), due = Date.now() + 300_000;
        await db.update(chatTeamsFileTransfers).set({ expiresAt: new Date(due) }).where(eq(chatTeamsFileTransfers.id, f.created.id));
        for (let index = 0; index < 104; index++) {
          const publicationId = randomUUID();
          await db.insert(chatPublications).values({ id: publicationId, companyId: f.a.companyId,
            endpointId: f.a.endpointId, conversationId: f.a.conversationId, issueId: f.a.issueId,
            commentId: f.a.commentId, idempotencyKey: `expiry-restart:${publicationId}`,
            payload: { text: "Same authorized file", attachmentIds: [f.a.attachmentId] } });
          const a = { ...f.a, publicationId };
          const created = await teamsFileTransferService(db, { ...f.opts, authorize: async () => a }).issue(a, new Date(due));
          transferIds.push(created.id);
        }
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: false });
        const counts: number[] = [], select = db.select.bind(db);
        const reads = vi.spyOn(db, "select").mockImplementation((...args) => {
          const selection = select(...args), from = selection.from.bind(selection);
          vi.spyOn(selection, "from").mockImplementation(table => {
            const query = from(table);
            if (table === chatTeamsFileTransfers) {
              const execute = query.execute.bind(query);
              vi.spyOn(query, "execute").mockImplementation(async () => {
                const rows = await execute(); counts.push(rows.length); return rows;
              });
            }
            return query;
          });
          return selection;
        });
        const expire = vi.fn(f.service().expireUnusedConsent), work = teamsConsentExpiryWork(db, expire);
        const start = () => {
          coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
          return work.register(coordinator, () => enabled).ready;
        };
        try {
          await start(); expect(counts.reduce((sum, count) => sum + count, 0)).toBe(100);
          await coordinator!.stop(); coordinator = undefined;
          const before = counts.length;
          await start(); expect(counts.slice(before).reduce((sum, count) => sum + count, 0)).toBe(100);
          await vi.advanceTimersByTimeAsync(1000);
          await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(due), { interval: 0 });
          expect(Math.max(...counts)).toBeLessThanOrEqual(100); reads.mockRestore();
          expect(await work.load()).toHaveLength(105);
          await quiet(1000); expect(expire).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(due - Date.now()); await settled();
          expect(expire).toHaveBeenCalledTimes(105);
          expect(await db.select().from(chatTeamsFileTransfers).where(inArray(chatTeamsFileTransfers.id, transferIds)))
            .toEqual(expect.arrayContaining([expect.objectContaining({ id: f.created.id, phase: "expired" })]));
          expect(await work.load()).toEqual([]); expect(errors).toEqual([]);
          await quiet(); expect(f.opts.postConsent).not.toHaveBeenCalled(); expect(f.opts.uploadRequest).not.toHaveBeenCalled();
        } finally { reads.mockRestore(); }
      }, 30_000);
      it("is quiet with configured endpoints and cancelled history", async () => {
        const f = await transfer(); await f.service().cancel(f.a.companyId, f.created.id);
        const expire = vi.fn(f.service().expireUnusedConsent);
        await worker(expire).ready; await settled();
        expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(180_000);
        expect(expire).not.toHaveBeenCalled();
      });
      it.each(["consent_pending", "awaiting_consent", "upload_pending"])("restores the saved %s expiry without an early scan or provider effect", async phase => {
        const f = await transfer();
        if (phase !== "consent_pending") await f.service().process(f.a.companyId, f.created.id);
        if (phase === "upload_pending") await f.service().recordConsent(await f.event());
        expect((await f.read()).phase).toBe(phase);
        const providerCalls = vi.mocked(f.opts.postConsent).mock.calls.length;
        const due = (await f.read()).expiresAt.getTime();
        await worker(f.service().expireUnusedConsent).ready; await settled();
        expect(coordinator!.nextWakeAt()).toBe(due); await quiet();
        await coordinator!.stop();
        await worker(f.service().expireUnusedConsent).ready;
        expect(coordinator!.nextWakeAt()).toBe(due); await quiet();
        await vi.advanceTimersByTimeAsync(due - Date.now() + 1000); await settled();
        expect((await f.read()).phase).toBe("expired"); expect(coordinator!.nextWakeAt()).toBeNull();
        await quiet(180_000); expect(f.opts.postConsent).toHaveBeenCalledTimes(providerCalls);
        expect(f.opts.uploadRequest).not.toHaveBeenCalled(); expect(f.opts.postFileInfo).not.toHaveBeenCalled(); expect(errors).toEqual([]);
      });
      it("reactivates from real issuance and disarms on cancellation", async () => {
        let f: Awaited<ReturnType<typeof transfer>>;
        await worker((companyId, id) => f.service().expireUnusedConsent(companyId, id)).ready;
        await settled(); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
        f = await transfer(); await settled();
        expect(coordinator!.nextWakeAt()).toBe((await f.read()).expiresAt.getTime());
        await f.service().cancel(f.a.companyId, f.created.id); await settled();
        expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(180_000);
        expect(f.opts.postConsent).not.toHaveBeenCalled();
      });
      it("keeps first committed work through drain without passive SQL", async () => {
        enabled = false;
        let f: Awaited<ReturnType<typeof transfer>>;
        await worker((companyId, id) => f.service().expireUnusedConsent(companyId, id)).ready;
        f = await transfer(); await quiet(90_000);
        expect((await f.read()).phase).toBe("consent_pending");
        enabled = true; await vi.advanceTimersByTimeAsync(30_000); await settled();
        expect((await f.read()).phase).toBe("expired"); expect(coordinator!.nextWakeAt()).toBeNull();
        await quiet(180_000); expect(errors).toEqual([]);
      });
      it("retains expiry after atomic projection failure and redacts its private error", async () => {
        const f = await transfer(); let fail = true;
        f.opts.project = async tx => {
          await tx.update(chatPublications).set({ state: "cancelled" }).where(eq(chatPublications.id, f.a.publicationId));
          if (fail) throw new Error("PRIVATE-TEAMS-UPLOAD-CANARY");
        };
        await worker(f.service().expireUnusedConsent).ready;
        await vi.advanceTimersByTimeAsync((await f.read()).expiresAt.getTime() - Date.now() + 1000); await settled();
        expect((await f.read()).phase).toBe("consent_pending");
        expect((await db.select().from(chatPublications).where(eq(chatPublications.id, f.a.publicationId)))[0].state).toBe("pending");
        expect(errors).toHaveLength(1);
        expect(String(errors[0])).not.toContain("CANARY");
        expect(String((errors[0] as AggregateError).errors[0])).not.toContain("CANARY");
        fail = false; await vi.advanceTimersByTimeAsync(30_000); await settled();
        expect((await f.read()).phase).toBe("expired");
        expect((await db.select().from(chatPublications).where(eq(chatPublications.id, f.a.publicationId)))[0].state).toBe("cancelled");
        expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
      });
      it("waits for outer commit and ignores nested rollback", async () => {
        const f = await transfer(); await db.delete(chatTeamsFileTransfers).where(eq(chatTeamsFileTransfers.id, f.created.id));
        await worker(f.service().expireUnusedConsent).ready; await settled();
        const due = new Date(Date.now() + 300_000);
        await expect(db.transaction(async tx => {
          await tx.transaction(async nested => teamsFileTransferService(nested as unknown as typeof db, f.opts).issue(f.a, due));
          await vi.advanceTimersByTimeAsync(10_000); expect(coordinator!.nextWakeAt()).not.toBe(due.getTime());
          throw new Error("rollback");
        })).rejects.toThrow("rollback");
        await settled(); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
        let release!: () => void, inserted!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { inserted = resolve; });
        const write = db.transaction(async tx => {
          const row = await tx.transaction(async nested => teamsFileTransferService(nested as unknown as typeof db, f.opts).issue(f.a, due));
          inserted(); await hold; return row;
        });
        try {
          await ready; await vi.advanceTimersByTimeAsync(10_000);
          expect(coordinator!.nextWakeAt()).not.toBe(due.getTime());
        } finally { release(); }
        const row = await write; transferIds.push(row.id); await settled();
        expect(coordinator!.nextWakeAt()).toBe(due.getTime()); await quiet();
      });
      it("rounds PostgreSQL expiry up and leaves active or unknown attempts alone", async () => {
        const f = await transfer();
        const whole = Date.now() + 60_000;
        await db.update(chatTeamsFileTransfers).set({ expiresAt: sql`${new Date(whole).toISOString()}::timestamptz + interval '0.0005 second'` }).where(eq(chatTeamsFileTransfers.id, f.created.id));
        vi.useFakeTimers({ toFake: ["Date"] });
        const work = teamsConsentExpiryWork(db, f.service().expireUnusedConsent);
        const [entry] = await work.load(); expect(entry.dueAt).toBe(whole + 1);
        vi.setSystemTime(whole); await work.check(entry);
        expect((await f.read()).phase).toBe("consent_pending");
        vi.setSystemTime(whole + 1); expect(await work.check(entry)).toBeNull();
        expect((await f.read()).phase).toBe("expired");
        for (const phase of ["consent_sending", "uploading", "file_info_sending", "consent_unknown", "upload_unknown", "file_info_unknown", "conflict"]) {
          await db.update(chatTeamsFileTransfers).set({ phase, attemptId: randomUUID(), attemptExpiresAt: new Date(0) }).where(eq(chatTeamsFileTransfers.id, f.created.id));
          const work = teamsConsentExpiryWork(db, f.service().expireUnusedConsent);
          expect(await work.load()).toEqual([]);
        }
      });
      it("pages and drains more than 100 obligations without starving another company behind a corrupt row", async () => {
        const f = await transfer(), other = await transfer();
        const due = new Date(Date.now() + 60_000);
        for (let index = 0; index < 100; index++) {
          const publicationId = randomUUID();
          await db.insert(chatPublications).values({ id: publicationId, companyId: f.a.companyId,
            endpointId: f.a.endpointId, conversationId: f.a.conversationId, issueId: f.a.issueId,
            commentId: f.a.commentId, idempotencyKey: `expiry-page:${publicationId}`,
            payload: { text: "Same authorized file", attachmentIds: [f.a.attachmentId] } });
          const a = { ...f.a, publicationId };
          const created = await teamsFileTransferService(db, { ...f.opts, authorize: async () => a }).issue(a, due);
          transferIds.push(created.id);
        }
        await db.update(chatTeamsFileTransfers).set({ authorityDigest: "0".repeat(64) }).where(eq(chatTeamsFileTransfers.id, f.created.id));
        const { work, ready } = worker(f.service().expireUnusedConsent); await ready;
        expect(await work.load()).toHaveLength(102);
        await vi.advanceTimersByTimeAsync(due.getTime() - Date.now() + 1000);
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(1000);
          expect((await other.read()).phase).toBe("expired");
          const remaining = await work.load(); expect(remaining.map(row => row.id)).toEqual([f.created.id]);
        }, { timeout: 10_000 });
        expect((await f.read()).phase).toBe("consent_pending");
        expect(errors.length).toBeGreaterThan(0); expect(f.opts.postConsent).not.toHaveBeenCalled();
      }, 30_000);
      it("joins an in-flight expiry projection during shutdown", async () => {
        const f = await transfer(); let release!: () => void, entered!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { entered = resolve; });
        f.opts.project = async () => { entered(); await hold; };
        await worker(f.service().expireUnusedConsent).ready;
        try {
          await vi.advanceTimersByTimeAsync((await f.read()).expiresAt.getTime() - Date.now() + 1000);
          await ready;
          let stopped = false; const stop = coordinator!.stop().then(() => { stopped = true; });
          await Promise.resolve(); expect(stopped).toBe(false);
          release(); await stop;
          expect((await f.read()).phase).toBe("expired");
        } finally { release(); }
      });
      it("keeps the compatibility attempt sweep from expiring unused consent", async () => {
        const f = await transfer();
        // Restore fixture time so the explicit maintenance operation sees it due.
        f.opts.now = () => new Date(Date.parse(f.created.expiresAt) + 1);
        expect(await f.service().recoverAbandonedAttempts(f.a.companyId)).toMatchObject({ scanned: 0, recovered: 0 });
        expect((await f.read()).phase).toBe("consent_pending");
        expect(await f.service().expireUnusedConsent(f.a.companyId, f.created.id)).toBe(true);
        expect((await f.read()).phase).toBe("expired");
      });
    });

    it("uses the exact attachment-derived filename for an unnamed source across issuance and restart", async () => {
      const f = await fixture(60_000, null);
      const expected = `attachment-${f.a.attachmentId}`;
      expect(f.created).toMatchObject({
        phase: "consent_pending",
        filename: expected,
      });
      expect(
        await f.service().process(f.a.companyId, f.created.id),
      ).toMatchObject({
        phase: "awaiting_consent",
        filename: expected,
      });
      expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.opts.postConsent).mock.calls[0]![0].card.name).toBe(
        expected,
      );
      // Each service() is a new instance; no normalized name is cached or
      // written back to the immutable source asset during recovery.
      expect(
        await f.service().process(f.a.companyId, f.created.id),
      ).toMatchObject({
        phase: "awaiting_consent",
        filename: expected,
      });
      const [asset] = await db
        .select()
        .from(assets)
        .where(eq(assets.id, f.assetId));
      expect(asset).toMatchObject({
        originalFilename: null,
        sha256: f.a.sha256,
        byteSize: bytes.length,
      });
      expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
      expect(f.opts.postFileInfo).not.toHaveBeenCalled();
    });

    it.each(["", "../unsafe.txt", "unsafe?.txt", " report.txt", "report."])(
      "does not normalize an unsafe stored filename to the unnamed-file fallback: %j",
      async (filename) => {
        const f = await fixture(60_000, null);
        await db
          .update(assets)
          .set({ originalFilename: filename })
          .where(eq(assets.id, f.assetId));
        const before = await f.read();
        await expect(
          f.service().process(f.a.companyId, f.created.id),
        ).rejects.toThrow("Teams file transfer authority or state changed");
        expect(await f.read()).toEqual(before);
        expect(f.opts.postConsent).not.toHaveBeenCalled();
        expect(f.opts.uploadRequest).not.toHaveBeenCalled();
        expect(f.opts.postFileInfo).not.toHaveBeenCalled();
      },
    );

    it("persists one exact encrypted issuance, never consent as delivered", async () => {
      const f = await fixture();
      const again = await f
        .service()
        .issue(f.a, new Date(Date.now() + 120_000));
      expect(again.id).toBe(f.created.id);
      const state = await f.service().process(f.a.companyId, f.created.id);
      expect(state).toMatchObject({
        phase: "awaiting_consent",
        consentConfirmed: true,
        fileDelivered: false,
      });
      expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
      expect(JSON.stringify(await f.read())).not.toContain("pcfc_");
      const [publication] = await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.id, f.a.publicationId));
      expect(publication!.state).toBe("pending"); // activation/projection is deliberately not installed
    });

    it("restarts between upload and file-info without repeating PUT or losing exact bytes", async () => {
      const f = await fixture();
      await f.service().process(f.a.companyId, f.created.id);
      expect(await f.service().recordConsent(await f.event())).toBe("recorded");
      expect(
        (await f.service().process(f.a.companyId, f.created.id)).phase,
      ).toBe("file_info_pending");
      expect(
        (await f.service().process(f.a.companyId, f.created.id)).phase,
      ).toBe("delivered");
      await f.service().process(f.a.companyId, f.created.id);
      expect(f.opts.uploadRequest).toHaveBeenCalledTimes(1);
      expect(f.opts.postFileInfo).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.opts.uploadRequest!).mock.calls[0]![1]!.body).toEqual(
        bytes,
      );
      expect(JSON.stringify(await f.read())).not.toContain(
        "PRIVATE-TEAMS-UPLOAD-CANARY",
      );
      expect(
        JSON.stringify(
          await db
            .select()
            .from(chatActions)
            .where(eq(chatActions.endpointId, f.a.endpointId)),
        ),
      ).not.toMatch(/uploadUrl|contentUrl|PRIVATE-TEAMS|pcfc_/);
    });

    it.each([false, true])(
      "buffers exact early consent while POST is owned; lost POST ACK=%s",
      async (lostAck) => {
        const f = await fixture();
        let release!: () => void;
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        f.opts.postConsent = vi.fn(async () => {
          started();
          await hold;
          if (lostAck) throw new Error("PRIVATE-ERROR");
          return { id: "card-1" };
        });
        const work = f.service().process(f.a.companyId, f.created.id);
        await entered;
        const event = await f.event("accept", { replyToId: undefined });
        expect(await f.service().recordConsent(event)).toBe("recorded");
        expect((await f.read()).phase).toBe("consent_sending");
        expect(f.opts.uploadRequest).not.toHaveBeenCalled();
        release();
        expect((await work).phase).toBe("upload_pending");
        expect((await f.read()).consentMessageId).toBe(
          lostAck ? null : "card-1",
        );
        await f.service().process(f.a.companyId, f.created.id);
        expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
        expect(f.opts.uploadRequest).toHaveBeenCalledTimes(1);
      },
    );

    it("denies consent before any durable card intent", async () => {
      const f = await fixture();
      expect(await f.service().recordConsent(await f.event())).toBe("denied");
      expect((await f.read()).phase).toBe("consent_pending");
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
    });

    it("deduplicates callback delivery and quarantines conflicting accepted capability", async () => {
      const f = await fixture();
      await f.service().process(f.a.companyId, f.created.id);
      const event = await f.event();
      expect(await f.service().recordConsent(event)).toBe("recorded");
      expect(await f.service().recordConsent(event)).toBe("ignored");
      expect(await f.service().recordConsent(await f.event("decline"))).toBe(
        "denied",
      );
      expect((await f.read()).phase).toBe("conflict");
      await f.service().process(f.a.companyId, f.created.id);
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
    });

    it("reads exact conflict cancellation readiness without authorization, mutation or provider work", async () => {
      const f = await fixture();
      await f.service().process(f.a.companyId, f.created.id);
      await f.service().recordConsent(await f.event());
      await f.service().recordConsent(await f.event("decline"));
      const before = await f.read();
      const input = {
        companyId: f.a.companyId,
        endpointId: f.a.endpointId,
        conversationId: f.a.conversationId,
        publicationId: f.a.publicationId,
        version: before.version,
      };
      const authorizations = vi.mocked(f.opts.authorize).mock.calls.length;
      await expect(f.service().canCancelConflict(input)).resolves.toBe(true);
      for (const key of [
        "companyId",
        "endpointId",
        "conversationId",
        "publicationId",
      ] as const)
        await expect(
          f.service().canCancelConflict({ ...input, [key]: randomUUID() }),
        ).resolves.toBe(false);
      await expect(
        f
          .service()
          .canCancelConflict({ ...input, version: before.version - 1 }),
      ).resolves.toBe(false);
      expect(await f.read()).toEqual(before);
      expect(f.opts.authorize).toHaveBeenCalledTimes(authorizations);
      expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
      expect(f.opts.loadBytes).not.toHaveBeenCalled();
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
      expect(f.opts.postFileInfo).not.toHaveBeenCalled();
    });

    it.each([
      "bad authority",
      "bad private binding",
      "missing quarantine",
      "future quarantine",
      "unknown reason",
      "unrelated expired owner",
    ] as const)(
      "does not offer conflict cancellation for %s evidence",
      async (fault) => {
        const f = await fixture();
        await f.service().process(f.a.companyId, f.created.id);
        await f.service().recordConsent(await f.event());
        await f.service().recordConsent(await f.event("decline"));
        const row = await f.read();
        const privateState = structuredClone(row.privateState) as Record<
          string,
          unknown
        >;
        const patch: Partial<typeof chatTeamsFileTransfers.$inferInsert> = {};
        if (fault === "bad authority") patch.authorityDigest = "0".repeat(64);
        if (fault === "bad private binding") {
          privateState.binding = {};
          patch.privateState = privateState;
        }
        if (fault === "missing quarantine") {
          delete privateState.quarantine;
          patch.privateState = privateState;
        }
        if (fault === "future quarantine") {
          privateState.quarantine = {
            ...(privateState.quarantine as Record<string, unknown>),
            fromVersion: row.version,
          };
          patch.privateState = privateState;
        }
        if (fault === "unknown reason") patch.reason = "unrecognized_conflict";
        if (fault === "unrelated expired owner") {
          patch.attemptId = randomUUID();
          patch.attemptExpiresAt = new Date(Date.now() - 1_000);
        }
        await db
          .update(chatTeamsFileTransfers)
          .set(patch)
          .where(eq(chatTeamsFileTransfers.id, row.id));
        const before = await f.read();
        await expect(
          f.service().canCancelConflict({
            companyId: f.a.companyId,
            endpointId: f.a.endpointId,
            conversationId: f.a.conversationId,
            publicationId: f.a.publicationId,
            version: before.version,
          }),
        ).resolves.toBe(false);
        expect(await f.read()).toEqual(before);
        expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
        expect(f.opts.uploadRequest).not.toHaveBeenCalled();
        expect(f.opts.postFileInfo).not.toHaveBeenCalled();
      },
    );

    it.each(["missing expiry", "orphaned expiry"] as const)(
      "rejects %s ownership at the database boundary before it can affect conflict readiness",
      async (fault) => {
        const f = await fixture();
        await f.service().process(f.a.companyId, f.created.id);
        await f.service().recordConsent(await f.event());
        await f.service().recordConsent(await f.event("decline"));
        const before = await f.read();
        await expect(
          db
            .update(chatTeamsFileTransfers)
            .set(
              fault === "missing expiry"
                ? { attemptId: randomUUID() }
                : { attemptExpiresAt: new Date(Date.now() - 1_000) },
            )
            .where(eq(chatTeamsFileTransfers.id, before.id)),
        ).rejects.toMatchObject({
          cause: {
            code: "23514",
            constraint_name: "chat_teams_file_transfers_attempt_check",
          },
        });
        expect(await f.read()).toEqual(before);
        await expect(
          f.service().canCancelConflict({
            companyId: f.a.companyId,
            endpointId: f.a.endpointId,
            conversationId: f.a.conversationId,
            publicationId: f.a.publicationId,
            version: before.version,
          }),
        ).resolves.toBe(true);
      },
    );

    it("preserves ambiguity after lost PUT or file-info ACK and never blindly retries", async () => {
      for (const stage of ["upload", "file_info"] as const) {
        const f = await fixture();
        await f.service().process(f.a.companyId, f.created.id);
        await f.service().recordConsent(await f.event());
        if (stage === "upload")
          f.opts.uploadRequest = vi.fn(async () => {
            throw new Error(uploadUrl);
          });
        else
          f.opts.postFileInfo = vi.fn(async () => {
            throw new Error(uploadUrl);
          });
        await f.service().process(f.a.companyId, f.created.id);
        if (stage === "file_info")
          await f.service().process(f.a.companyId, f.created.id);
        for (let i = 0; i < 2; i++)
          await f.service().process(f.a.companyId, f.created.id);
        expect((await f.read()).phase).toBe(
          stage === "upload" ? "upload_unknown" : "file_info_unknown",
        );
        expect(f.opts.uploadRequest).toHaveBeenCalledTimes(1);
        f.advance(120_000);
        await f.service().expireAndRecover(f.a.companyId);
        expect((await f.read()).phase).toBe(
          stage === "upload" ? "upload_unknown" : "file_info_unknown",
        );
        expect(JSON.stringify(await f.read())).not.toContain(
          "PRIVATE-TEAMS-UPLOAD-CANARY",
        );
      }
    });

    it.each([
      "runtimeGeneration",
      "credentialFingerprint",
      "conversationGeneration",
      "sourceDigest",
      "authorizedUserId",
      "principalId",
      "providerUserId",
    ] as const)("denies changed %s before a new effect", async (field) => {
      const f = await fixture();
      await f.service().process(f.a.companyId, f.created.id);
      await f.service().recordConsent(await f.event());
      f.setCurrent({
        [field]: field.endsWith("Generation")
          ? 99
          : field.endsWith("Digest") || field === "credentialFingerprint"
            ? "b".repeat(64)
            : field === "principalId"
              ? randomUUID()
              : "foreign-user",
      });
      await expect(
        f.service().process(f.a.companyId, f.created.id),
      ).rejects.toThrow();
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
    });

    it.each(["attachment", "comment", "bytes"])(
      "preserves evidence but denies deleted/changed %s",
      async (change) => {
        const f = await fixture();
        await f.service().process(f.a.companyId, f.created.id);
        await f.service().recordConsent(await f.event());
        if (change === "attachment")
          await db
            .delete(issueAttachments)
            .where(eq(issueAttachments.id, f.a.attachmentId));
        if (change === "comment")
          await db
            .delete(issueComments)
            .where(eq(issueComments.id, f.a.commentId));
        if (change === "bytes")
          await db
            .update(assets)
            .set({ sha256: "f".repeat(64) })
            .where(eq(assets.id, f.assetId));
        expect((await f.read()).phase).toBe("upload_pending");
        await expect(
          f.service().process(f.a.companyId, f.created.id),
        ).rejects.toThrow();
        expect(f.opts.uploadRequest).not.toHaveBeenCalled();
      },
    );

    it("authenticates ciphertext to exact company/endpoint/transfer/authority and purpose", async () => {
      const f = await fixture();
      const row = await f.read();
      const ctx = await f.privateContext();
      const material = row.privateState.binding as Record<string, unknown>;
      for (const changed of [
        { companyId: randomUUID() },
        { endpointId: randomUUID() },
        { transferId: randomUUID() },
        { authorityDigest: "b".repeat(64) },
      ]) {
        await expect(
          restoreTeamsFileConsentBinding({ ...ctx, ...changed }, material),
        ).rejects.toThrow("Teams private state could not be restored");
      }
      const binding = await restoreTeamsFileConsentBinding(ctx, material);
      await expect(
        restoreTeamsFileConsentEvent(ctx, binding, material),
      ).rejects.toThrow();
      await expect(
        restoreTeamsFileUpload(ctx, binding, material),
      ).rejects.toThrow();
      const unbranded = JSON.parse(JSON.stringify(await f.event()));
      expect(
        bindEarlyTeamsFileConsent({
          event: unbranded,
          stored: binding,
          current: binding,
          phase: "consent_unknown",
          now: Date.now(),
        }),
      ).toMatchObject({ ok: false });
      expect(
        JSON.stringify(await sealTeamsFileConsentBinding(ctx, binding)),
      ).not.toContain(binding.token);
    });

    it("decline/expiry are terminal without uploaded bytes; expiry cannot erase unknown POST", async () => {
      const f = await fixture();
      await f.service().process(f.a.companyId, f.created.id);
      await f.service().recordConsent(await f.event("decline"));
      expect((await f.read()).phase).toBe("declined");
      await f.service().process(f.a.companyId, f.created.id);
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
      const waiting = await fixture();
      await waiting.service().process(waiting.a.companyId, waiting.created.id);
      waiting.advance(61_000);
      await waiting.service().expireAndRecover(waiting.a.companyId);
      expect((await waiting.read()).phase).toBe("expired");
      const lost = await fixture();
      lost.opts.postConsent = vi.fn(async () => {
        throw new Error("lost ACK");
      });
      await lost.service().process(lost.a.companyId, lost.created.id);
      lost.advance(61_000);
      await lost.service().expireAndRecover(lost.a.companyId);
      expect((await lost.read()).phase).toBe("consent_unknown");
    });

    it("serializes concurrent workers and preserves a conflicting late card receipt", async () => {
      const f = await fixture();
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.opts.postConsent = vi.fn(async () => {
        started();
        await hold;
        return { id: "different-card" };
      });
      const work = f.service().process(f.a.companyId, f.created.id);
      await entered;
      await f.service().recordConsent(await f.event());
      expect(
        (await f.service().process(f.a.companyId, f.created.id)).phase,
      ).toBe("consent_sending");
      release();
      expect((await work).phase).toBe("conflict");
      expect((await f.read()).consentMessageId).toBe("different-card");
      expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
    });

    it("waits for the publication before holding its transfer lock", async () => {
      const f = await fixture();
      let release!: () => void;
      let entered!: (pid: number) => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<number>((resolve) => {
        entered = resolve;
      });
      const owner = db.transaction(async (tx) => {
        await tx
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.id, f.a.publicationId))
          .for("update");
        const [session] = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        entered(session!.pid);
        await held;
      });
      const pid = await ready;
      const work = f.service().process(f.a.companyId, f.created.id);
      void work.catch(() => {});
      try {
        await expect
          .poll(
            async () => {
              const [waiter] = await db.execute<{
                blocked: boolean;
              }>(sql`select exists (
            select 1 from pg_stat_activity where datname = current_database()
              and ${pid} = any(pg_blocking_pids(pid))
          ) as blocked`);
              return waiter!.blocked;
            },
            { timeout: 5_000 },
          )
          .toBe(true);
        // A normal publication owner may next need this transfer. The worker
        // waiting for that publication must not already own the transfer row.
        await expect(
          db.transaction(async (tx) => {
            await tx
              .select()
              .from(chatTeamsFileTransfers)
              .where(eq(chatTeamsFileTransfers.id, f.created.id))
              .for("update", { noWait: true });
          }),
        ).resolves.toBeUndefined();
        expect(f.opts.postConsent).not.toHaveBeenCalled();
      } finally {
        release();
        await owner;
        await work;
      }
      expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
    });

    it("a stale in-flight owner cannot commit after recovery; no card resend", async () => {
      const f = await fixture();
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.opts.postConsent = vi.fn(async () => {
        started();
        await hold;
        return { id: "late-card" };
      });
      const work = f.service().process(f.a.companyId, f.created.id);
      await entered;
      f.advance(91_000);
      await f.service().expireAndRecover(f.a.companyId);
      release();
      expect((await work).phase).toBe("consent_unknown");
      expect((await f.read()).consentMessageId).toBeNull();
      await f.service().process(f.a.companyId, f.created.id);
      expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
    });

    it("holds source mutation/current-authority gates across each effect, but records accepted POST facts after revocation", async () => {
      const f = await fixture();
      f.opts.postConsent = vi.fn(async () => {
        f.setCurrent({ runtimeGeneration: 8 });
        return { id: "card-1" };
      });
      expect(
        (await f.service().process(f.a.companyId, f.created.id)).phase,
      ).toBe("awaiting_consent");
      await expect(
        f.service().recordConsent(await f.event()),
      ).rejects.toThrow();
      expect((await f.read()).consentMessageId).toBe("card-1");
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
    });

    it("rejects changed bytes loaded after consent, before network", async () => {
      const f = await fixture();
      await f.service().process(f.a.companyId, f.created.id);
      await f.service().recordConsent(await f.event());
      f.opts.loadBytes = vi.fn(async () => Buffer.from("different bytes"));
      expect(
        await f.service().process(f.a.companyId, f.created.id),
      ).toMatchObject({
        phase: "upload_pending",
        reason: "provider_not_attempted",
      });
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
    });

    it("enforces company/publication FK and rejects ciphertext copied from another transfer", async () => {
      const left = await fixture();
      const right = await fixture();
      const source = await left.read();
      await expect(
        db.insert(chatTeamsFileTransfers).values({
          ...source,
          id: randomUUID(),
          publicationId: right.a.publicationId,
          tokenSha256: "e".repeat(64),
        }),
      ).rejects.toThrow();
      await db
        .update(chatTeamsFileTransfers)
        .set({ privateState: source.privateState })
        .where(eq(chatTeamsFileTransfers.id, right.created.id));
      await expect(
        right.service().process(right.a.companyId, right.created.id),
      ).rejects.toThrow();
      expect(right.opts.postConsent).not.toHaveBeenCalled();
    });

    it.each(["mark_delivered", "retry_anyway", "cancel"] as const)(
      "resolves file-info ambiguity transactionally: %s",
      async (action) => {
        const f = await fixture();
        await f.service().process(f.a.companyId, f.created.id);
        await f.service().recordConsent(await f.event());
        await f.service().process(f.a.companyId, f.created.id);
        f.opts.postFileInfo = vi.fn(async () => {
          throw new Error("lost ACK");
        });
        await f.service().process(f.a.companyId, f.created.id);
        const before = await f.read();
        const resolve = () =>
          db.transaction((tx) =>
            f.service().resolveInTransaction(tx, {
              companyId: f.a.companyId,
              publicationId: f.a.publicationId,
              transferId: f.created.id,
              expectedVersion: before.version,
              expectedPhase: "file_info_unknown",
              action,
            }),
          );
        const result = await resolve();
        expect(result.phase).toBe(
          action === "mark_delivered"
            ? "delivered"
            : action === "retry_anyway"
              ? "file_info_pending"
              : "cancelled",
        );
        expect(result.fileDelivered).toBe(action === "mark_delivered");
        expect((await f.read()).fileInfoMessageId).toBeNull();
        await expect(resolve()).rejects.toThrow();
        if (action === "retry_anyway") {
          f.opts.postFileInfo = vi.fn(async () => ({ id: "confirmed-info" }));
          expect(
            (await f.service().process(f.a.companyId, f.created.id)).phase,
          ).toBe("delivered");
        }
        expect(f.opts.uploadRequest).toHaveBeenCalledTimes(1);
        const after = await f.read();
        expect(after.privateState.resolution).toMatchObject({
          fromPhase: "file_info_unknown",
          fromVersion: before.version,
          action,
        });
      },
    );

    it.each(["consent_unknown", "upload_unknown"] as const)(
      "does not equate %s with delivered file; explicit cancellation preserves uncertainty",
      async (phase) => {
        const f = await fixture();
        if (phase === "consent_unknown")
          f.opts.postConsent = vi.fn(async () => {
            throw new Error("lost ACK");
          });
        await f.service().process(f.a.companyId, f.created.id);
        if (phase === "upload_unknown") {
          await f.service().recordConsent(await f.event());
          f.opts.uploadRequest = vi.fn(async () => {
            throw new Error("lost ACK");
          });
          await f.service().process(f.a.companyId, f.created.id);
        }
        const before = await f.read();
        for (const action of ["mark_delivered", "retry_anyway"] as const) {
          await expect(
            db.transaction((tx) =>
              f.service().resolveInTransaction(tx, {
                companyId: f.a.companyId,
                publicationId: f.a.publicationId,
                transferId: f.created.id,
                expectedVersion: before.version,
                expectedPhase: phase,
                action,
              }),
            ),
          ).rejects.toThrow();
        }
        await db
          .transaction(async (tx) => {
            const result = await f.service().resolveInTransaction(tx, {
              companyId: f.a.companyId,
              publicationId: f.a.publicationId,
              transferId: f.created.id,
              expectedVersion: before.version,
              expectedPhase: phase,
              action: "cancel",
            });
            expect(result).toMatchObject({
              phase: "cancelled",
              fileDelivered: false,
              reason: `operator_cancelled_${phase}`,
            });
            // A surrounding audit/publication failure must roll back the transfer too.
            throw new Error("paired publication write failed");
          })
          .catch(() => {});
        expect((await f.read()).phase).toBe(phase);
      },
    );

    it("recovers final file-info from confirmed upload after consent expiry", async () => {
      const f = await fixture();
      await f.service().process(f.a.companyId, f.created.id);
      await f.service().recordConsent(await f.event());
      await f.service().process(f.a.companyId, f.created.id);
      f.advance(61_000);
      expect(
        (await f.service().process(f.a.companyId, f.created.id)).phase,
      ).toBe("delivered");
      expect(f.opts.uploadRequest).toHaveBeenCalledTimes(1);
    });

    it("rolls back a failed intent projection before any provider call", async () => {
      const f = await fixture();
      f.opts.project = vi.fn(async (_tx, transfer) => {
        if (transfer.phase === "consent_sending")
          throw new Error("public projection failed");
      });
      await expect(
        f.service().process(f.a.companyId, f.created.id),
      ).rejects.toThrow("public projection failed");
      expect((await f.read()).phase).toBe("consent_pending");
      expect((await f.read()).attemptId).toBeNull();
      expect(f.opts.postConsent).not.toHaveBeenCalled();
    });

    it("receipt projection failure retains intent then recovers unknown without resend", async () => {
      const f = await fixture();
      f.opts.project = vi.fn(async (_tx, transfer) => {
        expect(transfer).toMatchObject({
          companyId: f.a.companyId,
          endpointId: f.a.endpointId,
          conversationId: f.a.conversationId,
          issueId: f.a.issueId,
          publicationId: f.a.publicationId,
        });
        expect(JSON.stringify(transfer)).not.toMatch(
          /privateState|uploadUrl|pcfc_|PRIVATE-TEAMS/,
        );
        if (transfer.phase === "awaiting_consent")
          throw new Error("public receipt failed");
      });
      await expect(
        f.service().process(f.a.companyId, f.created.id),
      ).rejects.toThrow("public receipt failed");
      expect((await f.read()).phase).toBe("consent_sending");
      f.advance(91_000);
      await f.service().expireAndRecover(f.a.companyId);
      expect(
        (await f.service().process(f.a.companyId, f.created.id)).phase,
      ).toBe("consent_unknown");
      expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
    });

    it("advances bounded expiry pages past malformed oldest records across fresh service instances", async () => {
      const f = await fixture();
      const ids = [f.created.id];
      for (let index = 0; index < 2; index++) {
        const publicationId = randomUUID();
        await db.insert(chatPublications).values({
          id: publicationId,
          companyId: f.a.companyId,
          endpointId: f.a.endpointId,
          conversationId: f.a.conversationId,
          issueId: f.a.issueId,
          commentId: f.a.commentId,
          idempotencyKey: `expiry:${publicationId}`,
          payload: {
            text: "Same authorized artifact",
            attachmentIds: [f.a.attachmentId],
          },
        });
        const a = { ...f.a, publicationId };
        const sibling = await teamsFileTransferService(db, {
          ...f.opts,
          authorize: async () => ({ ...a }),
        }).issue(a, (await f.read()).expiresAt);
        ids.push(sibling.id);
      }
      ids.sort();
      for (const id of ids.slice(0, 2))
        await db
          .update(chatTeamsFileTransfers)
          .set({
            authorityDigest: "0".repeat(64),
            updatedAt: new Date(Date.now() - 120_000),
            reason: "https://private.invalid/?token=POISON-SWEEP-CANARY",
          })
          .where(eq(chatTeamsFileTransfers.id, id));
      const poisonedBefore = await db
        .select()
        .from(chatTeamsFileTransfers)
        .where(inArray(chatTeamsFileTransfers.id, ids.slice(0, 2)));
      f.advance(61_000);
      for (let index = 0; index < 2; index++) {
        const result = await f.service().expireAndRecover(f.a.companyId, 1);
        expect(result).toMatchObject({ scanned: 1, recovered: 0, failed: 1 });
        expect(JSON.stringify(result)).not.toContain("POISON-SWEEP-CANARY");
      }
      expect(
        await f.service().expireAndRecover(f.a.companyId, 1),
      ).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });
      const [healthy] = await db
        .select()
        .from(chatTeamsFileTransfers)
        .where(eq(chatTeamsFileTransfers.id, ids[2]!));
      expect(healthy!.phase).toBe("expired");
      expect(
        await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(inArray(chatTeamsFileTransfers.id, ids.slice(0, 2))),
      ).toEqual(poisonedBefore);
      // The cursor wraps, but neither mutates nor interprets the poisoned rows.
      expect(
        await f.service().expireAndRecover(f.a.companyId, 1),
      ).toMatchObject({ scanned: 1, recovered: 0, failed: 1 });
      expect(f.opts.postConsent).not.toHaveBeenCalled();
      expect(f.opts.uploadRequest).not.toHaveBeenCalled();
    });

    it("recovers buffered acceptance after actual card POST receipt projection rolls back without reposting", async () => {
      const f = await fixture(5 * 60_000);
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.opts.postConsent = vi.fn(async () => {
        entered();
        await hold;
        return { id: "card-1" };
      });
      f.opts.project = vi.fn(async (_tx, transfer) => {
        if (transfer.phase === "awaiting_consent")
          throw new Error("receipt projection rollback");
      });
      const work = f.service().process(f.a.companyId, f.created.id);
      void work.catch(() => {});
      await started;
      try {
        expect(await f.service().recordConsent(await f.event())).toBe(
          "recorded",
        );
        const buffered = await f.read();
        expect(buffered.phase).toBe("consent_sending");
        expect(buffered.privateState.response).toBeDefined();
        release();
        await expect(work).rejects.toThrow("receipt projection rollback");
        expect(await f.read()).toEqual(buffered);
        f.advance(91_000);
        await f.service().expireAndRecover(f.a.companyId);
        const unknown = await f.read();
        expect(unknown).toMatchObject({
          phase: "consent_unknown",
          consentMessageId: null,
          reason: "worker_outcome_unknown",
        });
        expect(unknown.privateState.response).toEqual(
          buffered.privateState.response,
        );
        expect(f.opts.uploadRequest).not.toHaveBeenCalled(); // sweep performs no effects
        f.opts.project = undefined;
        expect(
          (await f.service().process(f.a.companyId, f.created.id)).phase,
        ).toBe("file_info_pending");
        expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
        expect(f.opts.uploadRequest).toHaveBeenCalledTimes(1);
        expect((await f.read()).consentMessageId).toBeNull(); // callback proof, not an invented POST receipt
      } finally {
        release();
        await work.catch(() => {});
      }
    });

    it("skips a held publication lock during expiry and recovers it on a later wrap", async () => {
      const f = await fixture();
      f.advance(61_000);
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const owner = db.transaction(async (tx) => {
        await tx
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.id, f.a.publicationId))
          .for("update");
        entered();
        await hold;
      });
      await ready;
      const sweep = f.service().expireAndRecover(f.a.companyId, 1);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          sweep,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("sweep blocked on an unrelated owner")),
              2_000,
            );
          }),
        ]);
        expect(result).toMatchObject({ scanned: 1, recovered: 0, failed: 1 });
        expect((await f.read()).phase).toBe("consent_pending");
      } finally {
        clearTimeout(timer);
        release();
        await owner;
        await sweep;
      }
      expect(
        await f.service().expireAndRecover(f.a.companyId, 1),
      ).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });
      expect((await f.read()).phase).toBe("expired");
      expect(f.opts.postConsent).not.toHaveBeenCalled();
    });

    it("bounds a held projection endpoint lock and still expires another endpoint in the same sweep", async () => {
      const f = await fixture();
      const [originalEndpoint] = await db
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, f.a.endpointId));
      const endpointId = randomUUID(),
        conversationId = randomUUID(),
        publicationId = randomUUID(),
        connectionId = randomUUID();
      const [originalConnection] = await db
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.id, originalEndpoint!.connectionId));
      await db.insert(toolConnections).values({
        id: connectionId,
        companyId: f.a.companyId,
        applicationId: originalConnection!.applicationId,
        uid: randomUUID(),
        name: "Other Teams fixture",
        transport: "chat_sdk",
        connectionPurpose: "channel",
      });
      await db.insert(chatEndpoints).values({
        id: endpointId,
        companyId: f.a.companyId,
        connectionId,
        provider: "microsoft-teams",
        publicId: randomUUID(),
        assignedAgentId: originalEndpoint!.assignedAgentId,
        status: "draft",
      });
      await db.insert(chatConversations).values({
        id: conversationId,
        companyId: f.a.companyId,
        endpointId,
        issueId: f.a.issueId,
        externalConversationId: "a:other-personal",
        externalThreadId: "teams:YTpvdGhlci1wZXJzb25hbA",
        externalLabel: "Other personal",
        isDirectMessage: true,
        sessionGeneration: f.a.conversationGeneration,
      });
      await db.insert(chatPublications).values({
        id: publicationId,
        companyId: f.a.companyId,
        endpointId,
        conversationId,
        issueId: f.a.issueId,
        commentId: f.a.commentId,
        idempotencyKey: `lock:${publicationId}`,
        payload: {
          text: "Same exact artifact",
          attachmentIds: [f.a.attachmentId],
        },
      });
      const a = {
        ...f.a,
        endpointId,
        conversationId,
        publicationId,
        providerConversationId: "a:other-personal",
      };
      const sibling = await teamsFileTransferService(db, {
        ...f.opts,
        authorize: async () => ({ ...a }),
      }).issue(a, (await f.read()).expiresAt);
      f.opts.project = async (tx, transfer) => {
        await tx
          .select()
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, transfer.endpointId))
          .for("no key update");
      };
      f.advance(61_000);
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const owner = db.transaction(async (tx) => {
        await tx
          .select()
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, f.a.endpointId))
          .for("update");
        entered();
        await hold;
      });
      await ready;
      const before = await f.read();
      const sweep = f.service().expireAndRecover(f.a.companyId, 2);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            sweep,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error("projection lock prevented bounded recovery"),
                  ),
                2_000,
              );
            }),
          ]),
        ).toMatchObject({ scanned: 2, recovered: 1, failed: 1 });
        expect(await f.read()).toEqual(before); // failed projection rolled back
        const [healthy] = await db
          .select()
          .from(chatTeamsFileTransfers)
          .where(eq(chatTeamsFileTransfers.id, sibling.id));
        expect(healthy!.phase).toBe("expired");
      } finally {
        clearTimeout(timer);
        release();
        await owner;
        await sweep;
      }
      expect(
        await f.service().expireAndRecover(f.a.companyId, 2),
      ).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });
      expect((await f.read()).phase).toBe("expired");
      expect(f.opts.postConsent).not.toHaveBeenCalled();
    });

    it("conflict during send retains the exact intent; late receipt cannot reopen, expired ownership permits explicit stop", async () => {
      const f = await fixture();
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.opts.postConsent = vi.fn(async () => {
        started();
        await hold;
        return { id: "late-card" };
      });
      const work = f.service().process(f.a.companyId, f.created.id);
      await entered;
      try {
        await f.service().recordConsent(await f.event());
        expect(await f.service().recordConsent(await f.event("decline"))).toBe(
          "denied",
        );
        const conflict = await f.read();
        expect(conflict.phase).toBe("conflict");
        expect(conflict.attemptId).not.toBeNull();
        const readiness = (version: number) =>
          f.service().canCancelConflict({
            companyId: f.a.companyId,
            endpointId: f.a.endpointId,
            conversationId: f.a.conversationId,
            publicationId: f.a.publicationId,
            version,
          });
        expect(await readiness(conflict.version)).toBe(false);
        const cancel = (version: number) =>
          db.transaction((tx) =>
            f.service().resolveInTransaction(tx, {
              companyId: f.a.companyId,
              publicationId: f.a.publicationId,
              transferId: f.created.id,
              expectedVersion: version,
              expectedPhase: "conflict",
              action: "cancel",
            }),
          );
        await expect(cancel(conflict.version)).rejects.toThrow();
        release();
        expect((await work).phase).toBe("conflict");
        expect((await f.read()).consentMessageId).toBeNull();
        f.advance(91_000);
        expect(await readiness(conflict.version)).toBe(true);
        await f.service().expireAndRecover(f.a.companyId);
        const expired = await f.read();
        expect(expired.phase).toBe("conflict");
        expect(expired.attemptId).toBeNull();
        expect(await readiness(expired.version)).toBe(true);
        expect(await readiness(conflict.version)).toBe(false);
        expect(await cancel(expired.version)).toMatchObject({
          phase: "cancelled",
          fileDelivered: false,
        });
        expect((await f.read()).privateState.quarantine).toMatchObject({
          fromPhase: "consent_sending",
          attemptId: conflict.attemptId,
        });
        expect(f.opts.postConsent).toHaveBeenCalledTimes(1);
        expect(f.opts.uploadRequest).not.toHaveBeenCalled();
      } finally {
        release();
        await work;
      }
    });
  },
);
