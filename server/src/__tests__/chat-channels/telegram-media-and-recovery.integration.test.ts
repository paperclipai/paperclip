import { nativeResponsePresentationWork } from "../../services/native-runtime/native-response-presentation-work.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import request from "supertest";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, assets, chatActions, chatDeliveries, chatEndpointResources, chatEndpoints, chatMessageLinks, chatPublications, heartbeatRunEvents, heartbeatRuns, issueComments, issueAttachments, issues, nativeRunFinalizations, environmentLeases } from "@paperclipai/db";
import type { Attachment } from "chat";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
// Opt-in private physical candidate; normal CI uses the staged pinned package.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});
import { issueService } from "../../services/issues.js";
import { MAX_ATTACHMENT_BYTES, formatAttachmentSize } from "../../attachment-types.js";
import { TELEGRAM_VIDEO_NOTE_MP4 } from "../fixtures/telegram-video-note.js";
import { TELEGRAM_VOICE_OGG } from "../fixtures/telegram-voice.js";
import { type TestDb, describeEmbeddedPostgres, FakeChatSdkRuntime, fakeTelegramFetch, makeThread, makeMessage } from "./providers.js";
import { createChatChannelHarness } from "./harness.js";
import { createGitHubHarness } from "./github-harness.js";
import { createRetryFixtures } from "./retry-fixtures.js";

describeEmbeddedPostgres("chat channels: telegram media and recovery", () => {
  const h = createChatChannelHarness();
  let db!: TestDb;
  beforeAll(() => { db = h.db; });
  const gh = createGitHubHarness(h);
  const rf = createRetryFixtures(h, gh);
  const { seedCompany, readChatDeliveriesByEndpointId, readChatDeliveriesById, readHeartbeatRunsById, readChatActionsById, readChatPublicationsByEndpointId, readIssuesByCompanyId, readChatPublicationsByCommentId, readHeartbeatRunsByCompanyId, readAgentWakeupRequestsById, readIssueCommentsByCompanyId, createService, createStorageService, retirePublicationFixture, qualifySetupRoundTrip, configuredTelegramEndpoint, deliverMessage } = h;
  const { committedChatResponseRecoveryFixture } = rf;

  it("publishes an explicitly selected board attachment through Telegram's native file lane", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture, {
        storage: storage.storage,
      });
    const chatId = "77119911";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram board file",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:1`,
        text: "Send the selected result here",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Telegram file conversation");
    const body = Buffer.from("telegram selected result", "utf8");
    const stored = await storage.storage.putFile({
      companyId: fixture.companyId,
      namespace: `issues/${conversation.issueId}`,
      originalFilename: "telegram-result.txt",
      contentType: "text/plain",
      body,
    });
    const attachment = await issueService(db).createAttachment({
      issueId: conversation.issueId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByUserId: "owner-user",
    });

    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Telegram file delivery",
      "telegram-file-delivery-1",
      "owner-user",
      [attachment.id],
    );

    expect(runtime.endpoints.get(endpoint.id)?.posts).toEqual([
      { threadId: dm.thread.id, text: "Telegram file delivery" },
      {
        threadId: dm.thread.id,
        text: "Shared telegram-result.txt.",
        attachments: [
          expect.objectContaining({
            name: "telegram-result.txt",
            mimeType: "text/plain",
            data: body,
            type: "file",
          }),
        ],
      },
    ]);
    await expect(
      db
        .select({
          attempts: chatPublications.attempts,
          state: chatPublications.state,
        })
        .from(chatPublications)
        .where(
          like(
            chatPublications.idempotencyKey,
            `explicit-board:${endpoint.id}:${conversation.id}:telegram-file-delivery-1%`,
          ),
        )
        .orderBy(asc(chatPublications.createdAt), asc(chatPublications.id)),
    ).resolves.toEqual([
      { attempts: 1, state: "published" },
      { attempts: 1, state: "published" },
    ]);
  });

  it.each([
    "ratio_20",
    "ratio_21",
    "dimensions_10001",
    "photo_size_over",
    "malformed",
  ])(
    "selects the Telegram photo boundary before provider I/O (%s)",
    async (mode) => {
      const fixture = await seedCompany();
      const storage = createStorageService();
      const { callbacks, endpoint, runtime, service } =
        await configuredTelegramEndpoint(fixture, { storage: storage.storage });
      let pinned: ReturnType<typeof createChatSdkEndpointRuntime> | undefined;
      let threadSpy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const chatId = "77119914";
        const dm = makeThread({
          channelId: `telegram:${chatId}`,
          id: `telegram:${chatId}`,
          isDM: true,
          name: "Telegram photo boundaries",
        });
        await deliverMessage({
          callbacks,
          endpointId: endpoint.id,
          provider: "telegram",
          thread: dm.thread,
          message: makeMessage({
            id: `${chatId}:1`,
            text: "Return this exact image",
            userId: chatId,
          }),
          trigger: "direct_message",
        });
        await qualifySetupRoundTrip(service, endpoint.id, chatId);
        await service.test(endpoint.id);
        const [conversation] = await service.listConversations(endpoint.id);
        if (!conversation) throw new Error("Expected photo test conversation");

        const [width, height] =
          mode === "ratio_20"
            ? [200, 10]
            : mode === "ratio_21"
              ? [210, 10]
              : mode === "portrait_21"
                ? [10, 210]
                : mode === "dimensions_10000"
                  ? [9500, 500]
                  : mode === "dimensions_10001"
                    ? [9501, 500]
                    : [16, 16];
        const format =
          mode === "jpeg" || mode === "gif" || mode === "webp" ? mode : "png";
        let bytes = await sharp({
          create: { width, height, channels: 3, background: "#e08040" },
        })
          .toFormat(format)
          .toBuffer();
        if (mode === "malformed") bytes = bytes.subarray(0, 20);
        if (mode === "photo_size_limit" || mode === "photo_size_over") {
          // A genuine PNG with a legal uncompressed ancillary text chunk;
          // exercise upload bytes without allocating/decompressing huge pixels.
          const target = 10_000_000 + Number(mode === "photo_size_over");
          const payload = Buffer.alloc(target - bytes.length - 12, 0x78);
          payload.write("padding\0", 0, "ascii");
          const chunk = Buffer.alloc(payload.length + 12);
          chunk.writeUInt32BE(payload.length);
          chunk.write("tEXt", 4, "ascii");
          payload.copy(chunk, 8);
          chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
          bytes = Buffer.concat([
            bytes.subarray(0, -12),
            chunk,
            bytes.subarray(-12),
          ]);
          expect(bytes.length).toBe(target);
        }
        if (mode !== "malformed") {
          await expect(sharp(bytes).metadata()).resolves.toMatchObject({
            width,
            height,
            format,
          });
        }
        const filename = `original-${mode}.${format}`;
        const mimeType = `image/${format}`;
        const stored = await storage.storage.putFile({
          companyId: fixture.companyId,
          namespace: `issues/${conversation.issueId}`,
          originalFilename: filename,
          contentType: mimeType,
          body: bytes,
        });
        const attachment = await issueService(db).createAttachment({
          issueId: conversation.issueId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByUserId: "owner-user",
        });
        const expectedMethod = [
          "ratio_21",
          "portrait_21",
          "dimensions_10001",
          "gif",
          "webp",
          "malformed",
          "photo_size_over",
        ].includes(mode)
          ? "sendDocument"
          : "sendPhoto";
        const methods: string[] = [];
        const uploadedBytes: Buffer[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            expect(url.hostname).toBe("api.telegram.org");
            const method = url.pathname.split("/").at(-1)!;
            methods.push(method);
            if (method === "sendPhoto" || method === "sendDocument") {
              expect(init?.body).toBeInstanceOf(FormData);
              const file = (init!.body as FormData).get(
                method === "sendPhoto" ? "photo" : "document",
              ) as File;
              expect(file.name).toBe(filename);
              expect(file.type).toBe(mimeType);
              uploadedBytes.push(Buffer.from(await file.arrayBuffer()));
              if (mode === "ambiguous")
                throw new TypeError("fetch failed", {
                  cause: Object.assign(new Error("synthetic connection loss"), {
                    code: "UND_ERR_SOCKET",
                  }),
                });
              if (expectedMethod === "sendDocument" && method === "sendPhoto") {
                return Response.json(
                  {
                    ok: false,
                    error_code: 400,
                    description: "Bad Request: PHOTO_INVALID_DIMENSIONS",
                  },
                  { status: 400 },
                );
              }
            } else expect(method).toBe("sendRichMessage");
            return Response.json({
              ok: true,
              result: {
                message_id: 100 + methods.length,
                date: 1_788_700_002,
                chat: { id: Number(chatId), type: "private" },
              },
            });
          }),
        );
        pinned = createChatSdkEndpointRuntime({
          companyId: fixture.companyId,
          endpointId: endpoint.id,
          callbacks: { onMessage() {} },
          logger: "silent",
          persistence: {
            async compareAndSet() {
              return true;
            },
            async deleteIfVersion() {
              return true;
            },
            async read() {
              return null;
            },
          },
          providerConfig: {
            provider: "telegram",
            userName: "photo_fixture_bot",
            credentials: {
              botToken: "123:synthetic-photo-fixture",
              secretToken: "synthetic",
            },
          },
        });
        const adapter = pinned.getProviderAdapter();
        const endpointRuntime = runtime.endpoints.get(endpoint.id)!;
        const originalThread = endpointRuntime.thread.bind(endpointRuntime);
        threadSpy = vi
          .spyOn(endpointRuntime, "thread")
          .mockImplementation((threadId) => ({
            ...originalThread(threadId),
            post: async (message: unknown) => {
              const posted = await adapter.postMessage(
                threadId,
                message as Parameters<typeof adapter.postMessage>[1],
              );
              return { id: posted.id, threadId };
            },
          }));
        const result = await service.publishBoardMessage(
          endpoint.id,
          conversation.id,
          "Original image attached",
          `photo-boundary-${mode}`,
          "owner-user",
          [attachment.id],
        );
        expect(methods).toEqual(["sendRichMessage", expectedMethod]);
        expect(uploadedBytes).toHaveLength(1);
        // Buffer.equals still compares every byte, without Vitest expanding
        // a ten-megabyte boundary fixture into a recursive object comparison.
        expect(uploadedBytes[0]!.equals(bytes)).toBe(true);
        expect(result.state).toBe(
          mode === "ambiguous" ? "delivery_unknown" : "published",
        );
        const publications = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.endpointId, endpoint.id),
              eq(chatPublications.commentId, result.commentId!),
            ),
          )
          .orderBy(asc(chatPublications.createdAt));
        expect(
          publications.map((row) => ({
            state: row.state,
            attempts: row.attempts,
          })),
        ).toEqual([
          { state: "published", attempts: 1 },
          {
            state: mode === "ambiguous" ? "delivery_unknown" : "published",
            attempts: 1,
          },
        ]);
        await service.processPendingPublications();
        expect(methods).toEqual(["sendRichMessage", expectedMethod]);
      } finally {
        threadSpy?.mockRestore();
        await pinned?.shutdown();
        vi.unstubAllGlobals();
        await retirePublicationFixture(service, endpoint.id);
      }
    },
  );

  it("maps Telegram image, audio, and video output onto native media lanes", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, runtime, service } =
      await configuredTelegramEndpoint(fixture, {
        storage: storage.storage,
      });
    const chatId = "77119912";
    const dm = makeThread({
      channelId: `telegram:${chatId}`,
      id: `telegram:${chatId}`,
      isDM: true,
      name: "Telegram native media",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        id: `${chatId}:1`,
        text: "Send native media",
        userId: chatId,
      }),
      trigger: "direct_message",
    });
    await qualifySetupRoundTrip(service, endpoint.id, chatId);
    await service.test(endpoint.id);
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Telegram media conversation");
    const media = [
      {
        contentType: "image/png",
        filename: "result.png",
        type: "image",
      },
      {
        contentType: "audio/mpeg",
        filename: "result.mp3",
        type: "audio",
      },
      {
        contentType: "audio/mp4",
        filename: "result.m4a",
        type: "audio",
      },
      {
        contentType: "video/mp4",
        filename: "result.mp4",
        type: "video",
      },
    ] as const;
    const attachmentIds: string[] = [];
    for (const item of media) {
      const body =
        item.type === "image"
          ? await sharp({
              create: {
                width: 16,
                height: 16,
                channels: 3,
                background: "#e08040",
              },
            })
              .png()
              .toBuffer()
          : Buffer.from(`native-${item.type}`, "utf8");
      const stored = await storage.storage.putFile({
        companyId: fixture.companyId,
        namespace: `issues/${conversation.issueId}`,
        originalFilename: item.filename,
        contentType: item.contentType,
        body,
      });
      const attachment = await issueService(db).createAttachment({
        issueId: conversation.issueId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByUserId: "owner-user",
      });
      attachmentIds.push(attachment.id);
    }

    await service.publishBoardMessage(
      endpoint.id,
      conversation.id,
      "Telegram native media delivery",
      "telegram-native-media-delivery-1",
      "owner-user",
      attachmentIds,
    );

    const posts = runtime.endpoints.get(endpoint.id)?.posts ?? [];
    expect(posts[0]).toEqual({
      threadId: dm.thread.id,
      text: "Telegram native media delivery",
    });
    expect(posts.slice(1)).toEqual(
      media.map((item) => ({
        threadId: dm.thread.id,
        text: `Shared ${item.filename}.`,
        attachments: [
          expect.objectContaining({
            mimeType: item.contentType,
            name: item.filename,
            type: item.type,
          }),
        ],
      })),
    );
    expect(posts.slice(1).every((post) => post.files === undefined)).toBe(true);
  });

  it.each([
    ...[
      "settled",
      "wrong_account",
      "committed_marker",
      "pending_lease_cleanup",
      "source_edited",
      "different_error",
    ].map((mode) => ({ mode, errorMessage: "runner_state_identity_mismatch" })),
    { mode: "settled", errorMessage: "runner_state_identity_mismatch: prior_owner_active" },
  ])(
    "retries only the original pre-provider Telegram request after exact cleanup: $mode ($errorMessage)",
    async ({ mode, errorMessage }) => {
      const context = await committedChatResponseRecoveryFixture("telegram");
      const providerAccount =
        mode === "null_account"
          ? null
          : mode === "distinct_account"
            ? "retained-backend-account"
            : "same-retained-thread";
      const checkpointAccount =
        mode === "wrong_account"
          ? "another-account"
          : mode === "missing_account"
            ? undefined
            : mode === "malformed_account"
              ? 123
              : providerAccount;
      const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      const directory = mkdtempSync(
        path.join(os.tmpdir(), "paperclip-chat-cleanup-retry-"),
      );
      process.env.PAPERCLIP_RUNNER_STATE_DIR = directory;
      try {
        const runId = randomUUID();
        const nativeSessionId = context.binding.normalizedSessionId;
        const runnerInstanceId = context.binding.runnerSourceInstanceId;
        const inputFor = (id: string) => ({
          schema: "paperclip.native-execution-input.v1",
          provider: { kind: "codex", model: null },
          binding: {
            companyId: context.fixture.companyId,
            runId: id,
            issueId: context.issue.id,
            agentId: context.fixture.assignedAgentId,
            executionWorkspaceId: id,
          },
          task: {
            identifier: context.issue.identifier,
            title: "Exact queued request",
            description: null,
            prompt: "Exact queued request",
            workMode: "standard",
          },
          workspace: {
            cwd: "/tmp/paperclip-cleanup-retry",
            repoUrl: null,
            repoRef: null,
            branchName: null,
          },
          session: {
            normalizedSessionId: nativeSessionId,
            driverKind: "codex_app_server",
            protocolVersion: 1,
            lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
          },
          completionContract: {
            id: context.binding.completionContractId,
            sha256: context.binding.completionContractSha256,
            schemaVersion: "paperclip.completion-contract.v1",
            contract: {
              revision: "recovered-response-v1",
              objective: "Exact request",
              criteria: [
                { id: "response", requirement: "Return the requested answer" },
              ],
            },
          },
          interactionResponses: [],
          credentialBindings: [],
        });
        await db
          .update(heartbeatRuns)
          .set({
            status: "succeeded",
            processPid: 99_999_999,
            processGroupId: 99_999_999,
            runnerProfileJson: {
              nativeExecutionInput: inputFor(context.runId),
            },
          })
          .where(eq(heartbeatRuns.id, context.runId));
        if (mode === "older_warm_run") {
          const olderId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: olderId,
            companyId: context.fixture.companyId,
            agentId: context.fixture.assignedAgentId,
            status: "succeeded",
            finishedAt: new Date(Date.now() - 60_000),
            runtimeMode: "native",
            nativeIssueId: context.issue.id,
            nativeSessionId,
            runnerInstanceId,
            processPid: 99_999_999,
            processGroupId: 99_999_999,
            runnerProfileJson: { nativeExecutionInput: inputFor(olderId) },
          });
        }
        await deliverMessage({
          callbacks: context.runtime.configurations.get(context.endpoint.id)!
            .callbacks,
          endpointId: context.endpoint.id,
          provider: "telegram",
          thread: context.thread.thread,
          message: makeMessage({
            id: `${context.thread.thread.channelId}:102`,
            text: "The exact queued request B",
            userId: context.thread.thread.channelId,
          }),
          trigger: "direct_message",
        });
        const [action] = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.conversationId, context.conversation.id),
              eq(chatActions.kind, "inbound_wakeup"),
              sql`${chatActions.id} <> ${context.action.id}::uuid`,
            ),
          );
        expect(action).toBeDefined();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: context.fixture.companyId,
          agentId: context.fixture.assignedAgentId,
          status: "failed",
          errorCode: "adapter_failed",
          error: mode === "different_error"
            ? errorMessage.replace("runner_state_identity_mismatch", "runner_state_identity_mismatch_other")
            : errorMessage,
          finishedAt: new Date(),
          wakeupRequestId: action.id,
          runtimeMode: "native",
          nativeIssueId: context.issue.id,
          nativeSessionId,
          runnerInstanceId,
          nativePhase: "observed",
          processPid: 99_999_999,
          processGroupId: 99_999_999,
          contextSnapshot: {
            issueId: context.issue.id,
            taskKey: context.issue.identifier,
            source: "chat:telegram",
            wakeCommentId: action.payload.commentId,
            wakeCommentIds: [action.payload.commentId],
          },
          runnerProfileJson: {
            nativeExecutionInput: inputFor(runId),
            sessionCheckpoint: {
              sessionId:
                mode === "wrong_thread"
                  ? "another-thread"
                  : mode === "missing_thread"
                    ? undefined
                    : "same-retained-thread",
              providerSessionId: checkpointAccount,
              identity: {
                companyId: context.fixture.companyId,
                issueId: context.issue.id,
                agentId: context.fixture.assignedAgentId,
                runId,
                sessionId: nativeSessionId,
              },
            },
          },
        });
        await db
          .update(agentWakeupRequests)
          .set({ status: "failed", runId })
          .where(eq(agentWakeupRequests.id, action.id));
        await db.insert(nativeRunFinalizations).values({
          companyId: context.fixture.companyId,
          issueId: context.issue.id,
          runId,
          phase: "observed",
          attempt: 0,
          leaseOwner: mode === "leased" ? "other-owner" : null,
        });
        await db.insert(environmentLeases).values({
          companyId: context.fixture.companyId,
          issueId: context.issue.id,
          heartbeatRunId: runId,
          provider: "local",
          status: "failed",
          releasedAt: new Date(),
          cleanupStatus: mode === "pending_lease_cleanup" ? "pending" : null,
        });
        await db
          .update(issues)
          .set({ status: "in_review", executionRunId: null })
          .where(eq(issues.id, context.issue.id));
        const canonical = (value: unknown): string =>
          value && typeof value === "object" && !Array.isArray(value)
            ? `{${Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(
                  ([key, entry]) =>
                    `${JSON.stringify(key)}:${canonical(entry)}`,
                )
                .join(",")}}`
            : JSON.stringify(value);
        const key = createHash("sha256")
          .update(
            canonical({
              schema: "paperclip.native-session-scope.v2",
              companyId: context.fixture.companyId,
              agentId: context.fixture.assignedAgentId,
              workspace: { kind: "transient", ...inputFor(runId).workspace },
              provider: {
                driverKind: "codex_app_server",
                identity: { kind: "codex" },
              },
              normalizedSessionId: nativeSessionId,
            }),
          )
          .digest("hex");
        const root = path.join(directory, key);
        mkdirSync(path.join(root, "runner"), { recursive: true });
        mkdirSync(path.join(root, "control-plane"), { recursive: true });
        const identity = {
          runId: context.runId,
          runnerInstanceId,
          environmentLeaseId: context.runId,
          normalizedSessionId: nativeSessionId,
        };
        const files = [
          [
            "control-plane/control-plane-state.json",
            {
              schema: "paperclip.runner.durable.control-plane-state.v1",
              identity,
            },
          ],
          [
            "runner/runner-state.json",
            {
              schema: "paperclip.runner.durable.state.v1",
              ...identity,
              lifecycle: "suspended",
              outbox: [],
            },
          ],
          [
            "runner/codex-provider-state.json",
            {
              schema: "paperclip.runner.codex-provider-state.v1",
              lifecycle: "prepared",
              threadId: "same-retained-thread",
              providerSessionId: providerAccount,
              activeProviderTurnId: null,
              config: { provider: "codex", driver: "codex_app_server" },
              pendingEvents: [],
              queuedEvents: [],
              toolBridge: { pending: {} },
            },
          ],
        ] as const;
        const bytes = files.map(([file, data]) => {
          const text = JSON.stringify(data);
          writeFileSync(path.join(root, file), text);
          return text;
        });
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify(
              bytes.map((text) =>
                createHash("sha256").update(text).digest("hex"),
              ),
            ),
          )
          .digest("hex");
        await db
          .update(nativeRunFinalizations)
          .set({
            recoveryHistory:
              mode === "missing_receipt"
                ? []
                : [
                    {
                      kind: "native_cleanup_maintenance",
                      version: 1,
                      phase:
                        mode === "activation_prepared" ||
                        mode === "prepared_marker"
                          ? "activation_prepared"
                          : "settled",
                      requestId: "exact-cleanup-receipt",
                      nativeSessionId,
                      runnerInstanceId,
                      providerSessionId: "same-retained-thread",
                      sourceFingerprint: "a".repeat(64),
                      settledFingerprint: fingerprint,
                    },
                  ],
          })
          .where(eq(nativeRunFinalizations.runId, context.runId));
        if (
          ["committed_marker", "foreign_marker", "prepared_marker"].includes(
            mode,
          )
        ) {
          writeFileSync(
            path.join(root, "cleanup-activation.json"),
            JSON.stringify({
              schema: "paperclip.native_cleanup_activation.v1",
              companyId: context.fixture.companyId,
              issueId: context.issue.id,
              runId: context.runId,
              requestId:
                mode === "foreign_marker"
                  ? "another-receipt"
                  : "exact-cleanup-receipt",
              sourceFingerprint: "a".repeat(64),
              settledFingerprint: fingerprint,
            }),
          );
        }
        if (mode === "changed_checkpoint")
          writeFileSync(
            path.join(root, "runner/runner-state.json"),
            JSON.stringify({ ...files[1][1], lifecycle: "ready" }),
          );
        if (mode === "late_event")
          await db.insert(heartbeatRunEvents).values({
            companyId: context.fixture.companyId,
            agentId: context.fixture.assignedAgentId,
            runId,
            seq: 1,
            eventType: "session.started",
            sourceInstanceId: runnerInstanceId,
            payload: { prpEvent: { sourceKind: "runner" } },
          });
        if (mode === "source_edited")
          await db
            .update(issueComments)
            .set({ body: "Changed after admission", updatedAt: new Date() })
            .where(eq(issueComments.id, String(action.payload.commentId)));
        const stage = () =>
          db.transaction((tx) =>
            context.service.prepareFailedChatRunRetry(tx, {
              companyId: context.fixture.companyId,
              issueId: context.issue.id,
              agentId: context.fixture.assignedAgentId,
              failedRunId: runId,
              initiatedByUserId: "owner-user",
            }),
          );
        const [original] = await readHeartbeatRunsById(runId);
        if (
          mode === "settled" ||
          mode === "distinct_account" ||
          mode === "null_account" ||
          mode === "older_warm_run" ||
          mode === "committed_marker"
        ) {
          const intent = await stage();
          expect(await stage()).toEqual(intent);
          await expect(
            context.service.processFailedChatRunRetry(intent.actionId),
          ).resolves.toMatchObject({ status: "queued" });
          const [receipt] = await readAgentWakeupRequestsById(intent.actionId);
          expect(receipt.payload).toMatchObject({
            retryOfRunId: runId,
            wakeCommentIds: [action.payload.commentId],
          });
          expect(
            await readHeartbeatRunsById(runId),
          ).toEqual([original]);
          expect(
            (
              await db
                .select()
                .from(nativeRunFinalizations)
                .where(eq(nativeRunFinalizations.runId, runId))
            )[0],
          ).toMatchObject({ phase: "observed", attempt: 0 });
          if (mode === "committed_marker")
            expect(existsSync(path.join(root, "cleanup-activation.json"))).toBe(
              true,
            );
        } else
          await expect(stage()).rejects.toMatchObject({
            details: { code: "chat_failed_run_retry_not_authorized" },
          });
      } finally {
        await context.service.shutdown();
        if (previous === undefined)
          delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
        else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("ingests bounded Telegram photo, audio, video, and document attachments without stranding text", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const runtime = new FakeChatSdkRuntime();
    const { service, wakeup } = createService(
      runtime,
      fakeTelegramFetch() as typeof globalThis.fetch,
      {
        storage: storage.storage,
      },
    );
    const endpoint = await service.create(
      fixture.companyId,
      { provider: "telegram", assignedAgentId: fixture.assignedAgentId },
      "owner-user",
    );
    await service.configure(
      endpoint.id,
      {
        action: "configure",
        credentials: { botToken: "123456:telegram-media-test" },
      },
      "owner-user",
    );
    const callbacks = runtime.configurations.get(endpoint.id)?.callbacks;
    if (!callbacks) throw new Error("Expected Telegram media callbacks");

    const accepted = [
      {
        type: "image",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        body: Buffer.from("photo"),
      },
      {
        type: "audio",
        name: "voice.ogg",
        mimeType: "audio/ogg",
        body: Buffer.from("voice"),
      },
      {
        type: "video",
        name: "clip.mp4",
        mimeType: "video/mp4",
        body: Buffer.from("video"),
      },
      {
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        body: Buffer.from("notes"),
      },
    ] as const;
    const acceptedFetches = accepted.map(({ body }) => vi.fn(async () => body));
    const oversizedDeclaredFetch = vi.fn(async () =>
      Buffer.from("must-not-download"),
    );
    const rejectedTypeFetch = vi.fn(async () =>
      Buffer.from("must-not-download"),
    );
    const oversizedDownloadedFetch = vi.fn(async () =>
      Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
    );
    const emptyFetch = vi.fn(async () => Buffer.alloc(0));
    const failedDownload = vi.fn(async () => {
      throw new Error("injected Telegram download failure");
    });
    const attachments: Attachment[] = [
      ...accepted.map(
        (item, index) =>
          ({
            type: item.type,
            name: item.name,
            mimeType: item.mimeType,
            size: item.body.length,
            fetchData: acceptedFetches[index],
            fetchMetadata: { testRecoveryKey: `telegram-media-${index}` },
          }) as Attachment,
      ),
      {
        type: "file",
        name: "declared-too-large.txt",
        mimeType: "text/plain",
        size: MAX_ATTACHMENT_BYTES + 1,
        fetchData: oversizedDeclaredFetch,
      },
      {
        type: "file",
        name: "payload.exe",
        mimeType: "application/x-msdownload",
        size: 4,
        fetchData: rejectedTypeFetch,
      },
      {
        type: "file",
        name: "downloaded-too-large.txt",
        mimeType: "text/plain",
        fetchData: oversizedDownloadedFetch,
      },
      {
        type: "file",
        name: "empty.txt",
        mimeType: "text/plain",
        fetchData: emptyFetch,
      },
      {
        type: "file",
        name: "unavailable.txt",
        mimeType: "text/plain",
        fetchData: failedDownload,
      },
    ];
    const dm = makeThread({
      channelId: "77115566",
      id: "telegram:77115566",
      isDM: true,
      name: "Telegram media DM",
    });
    await deliverMessage({
      callbacks,
      endpointId: endpoint.id,
      provider: "telegram",
      thread: dm.thread,
      message: makeMessage({
        attachments,
        id: "77115566:40",
        text: "",
        userId: "77115566",
      }),
      trigger: "direct_message",
    });

    expect(
      acceptedFetches.every((fetchData) => fetchData.mock.calls.length === 1),
    ).toBe(true);
    expect(oversizedDeclaredFetch).not.toHaveBeenCalled();
    expect(rejectedTypeFetch).not.toHaveBeenCalled();
    expect(oversizedDownloadedFetch).toHaveBeenCalledTimes(1);
    expect(emptyFetch).toHaveBeenCalledTimes(1);
    expect(failedDownload).toHaveBeenCalledTimes(1);
    expect(storage.putFile).toHaveBeenCalledTimes(4);
    const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
    expect(delivery).toMatchObject({
      state: "processed",
      attempts: 1,
      redactedError: expect.stringContaining(
        "5 external attachments were omitted",
      ),
    });
    expect(delivery.redactedError).toContain("declared too large: 1");
    expect(delivery.redactedError).toContain("unsupported type: 1");
    expect(delivery.redactedError).toContain("downloaded too large: 1");
    expect(delivery.redactedError).toContain("empty download: 1");
    expect(delivery.redactedError).toContain("processing failed: 1");
    expect(delivery.redactedError).not.toContain("unavailable.txt");
    await expect(service.listActivity(endpoint.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: delivery.id,
          status: "processed",
          detail: expect.stringContaining(
            "5 external attachments were omitted",
          ),
        }),
      ]),
    );
    const [conversation] = await service.listConversations(endpoint.id);
    if (!conversation) throw new Error("Expected Telegram media conversation");
    await expect(
      db
        .select({
          contentType: assets.contentType,
          originalFilename: assets.originalFilename,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
        .where(eq(issueAttachments.issueId, conversation.issueId)),
    ).resolves.toEqual(
      expect.arrayContaining(
        accepted.map((item) => ({
          contentType: item.mimeType,
          originalFilename: item.name,
        })),
      ),
    );
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("surfaces an attachment-only Telegram ingestion failure without waking the agent", async () => {
    const fixture = await seedCompany();
    const storage = createStorageService();
    const { callbacks, endpoint, service, wakeup } =
      await configuredTelegramEndpoint(fixture, { storage: storage.storage });
    const dm = makeThread({
      channelId: "77115567",
      id: "telegram:77115567",
      isDM: true,
      name: "Telegram failed media DM",
    });
    const failedDownload = vi.fn(async () => {
      throw new Error("injected Telegram attachment outage");
    });
    try {
      await deliverMessage({
        callbacks,
        endpointId: endpoint.id,
        provider: "telegram",
        thread: dm.thread,
        message: makeMessage({
          attachments: [
            {
              type: "file",
              name: "request.txt",
              mimeType: "text/plain",
              size: 42,
              fetchData: failedDownload,
              fetchMetadata: { testRecoveryKey: "telegram-failed-media" },
            } as Attachment,
          ],
          id: "77115567:41",
          text: "",
          userId: "77115567",
        }),
        trigger: "direct_message",
      });

      expect(failedDownload).toHaveBeenCalledTimes(1);
      expect(storage.putFile).not.toHaveBeenCalled();
      expect(wakeup).not.toHaveBeenCalled();
      const [conversation] = await service.listConversations(endpoint.id);
      if (!conversation)
        throw new Error("Expected Telegram attachment failure conversation");
      const visibleFailure = `Paperclip could not safely import the attached Telegram file. Please resend it as a supported file under ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} or include text describing the request.`;
      await expect(
        db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(eq(issueComments.issueId, conversation.issueId)),
      ).resolves.toEqual([{ body: visibleFailure }]);
      const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
      expect(delivery).toMatchObject({
        state: "processed",
        redactedError: expect.stringContaining(
          "1 external attachment was omitted",
        ),
      });
      await vi.waitFor(() =>
        expect(dm.post).toHaveBeenCalledWith(visibleFailure),
      );
      await vi.waitFor(async () => {
        await expect(
          db
            .select({ kind: chatActions.kind, status: chatActions.status })
            .from(chatActions)
            .where(eq(chatActions.deliveryId, delivery.id)),
        ).resolves.toEqual(
          expect.arrayContaining([
            { kind: "inbound_wakeup", status: "failed" },
            { kind: "provider_effect", status: "processed" },
          ]),
        );
      });
    } finally {
      await retirePublicationFixture(service, endpoint.id);
    }
  });

  it("settles a shared-endpoint accepted-response backlog without retrying its own locks", async () => {
    const fixture = await seedCompany();
    const configured = await configuredTelegramEndpoint(fixture);
    const contexts = [];
    for (let index = 0; index < 4; index++) {
      contexts.push(await committedChatResponseRecoveryFixture("telegram", "coordinator", false,
        undefined, undefined, true, { fixture, configured, suffix: String(211 + index) }));
    }
    expect(new Set(contexts.map(context => context.issue.id)).size).toBe(4);
    const independent = await committedChatResponseRecoveryFixture("telegram");
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    // Hold one real comment write after authority locks are acquired. Another
    // endpoint must still publish while this endpoint's backlog waits.
    const functionName = `hold_presentation_${randomUUID().replaceAll("-", "")}`;
    const gate = Math.floor(Math.random() * 1_000_000_000);
    let release!: () => void, locked!: () => void;
    let holderPid = 0;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      holderPid = Number(backend.pid);
      await tx.execute(sql`select pg_advisory_xact_lock(${gate})`); locked(); await hold;
    });
    await acquired;
    const sharedRuns = contexts.map(context => `'${context.runId}'::uuid`).join(",");
    await db.execute(sql.raw(`create function ${functionName}() returns trigger language plpgsql as $$ begin if NEW.created_by_run_id in (${sharedRuns}) then perform pg_advisory_xact_lock(${gate}); end if; return NEW; end $$`));
    await db.execute(sql.raw(`create trigger ${functionName} before insert on issue_comments for each row execute function ${functionName}()`));
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    try {
      await expect.poll(async () => {
        const [state] = await db.execute(sql`select exists (select 1 from pg_stat_activity
          where datname = current_database() and ${holderPid} = any(pg_blocking_pids(pid))) as blocked`);
        return state.blocked;
      }, { timeout: 10_000 }).toBe(true);
      await expect.poll(async () => (await db.select({ id: issueComments.id }).from(issueComments)
        .where(eq(issueComments.createdByRunId, independent.runId))).length, { timeout: 10_000 }).toBe(1);
      expect(await db.select({ id: issueComments.id }).from(issueComments)
        .where(inArray(issueComments.createdByRunId, contexts.map(context => context.runId)))).toHaveLength(0);
      release(); await holder;
      await worker.ready;
      await expect.poll(() => idleWorkSnapshot().active, { timeout: 10_000 }).toBe(0);
      expect(errors).toEqual([]);
      for (const context of contexts) {
        const comments = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, context.runId));
        expect(comments).toHaveLength(1);
        expect(comments[0].body).toBe(context.result.summary);
        const publications = await readChatPublicationsByCommentId(comments[0].id);
        expect(publications).toHaveLength(1);
        expect(publications[0]).toMatchObject({ companyId: fixture.companyId, endpointId: configured.endpoint.id,
          issueId: context.issue.id, conversationId: context.conversation.id, payload: { text: context.result.summary } });
      }
      expect(await readChatPublicationsByEndpointId(configured.endpoint.id)).toHaveLength(4);
      expect(coordinator.nextWakeAt()).toBeNull();
    } finally {
      release(); await holder;
      worker.stop(); await coordinator.stop();
      await db.execute(sql.raw(`drop trigger ${functionName} on issue_comments`));
      await db.execute(sql.raw(`drop function ${functionName}()`));
      await configured.service.shutdown(); await independent.service.shutdown();
    }
  });

  describe("Telegram retained zero-message admission", () => {
    it.each([
      { state: "received", command: false, source: "zero" },
      { state: "processing", command: true, source: "zero" },
      { state: "issued", command: false, source: "zero_sequence" },
      { state: "processing", command: false, source: "zero_replaced" },
      { state: "received", command: false, source: "positive" },
    ])(
      "recovers only ordinary source identity ($state / command=$command / $source)",
      async ({ state, command, source }) => {
        const fixture = await seedCompany();
        const pendingWake = state === "issued";
        const replacedSource = source === "zero_replaced";
        const preparingWake = source === "zero_locked" || replacedSource;
        const seededWake = pendingWake || preparingWake;
        const denied = source.startsWith("zero") && !replacedSource;
        const first = await configuredTelegramEndpoint(fixture, {
          deferWebhookProcessing: !seededWake,
          scheduleDeferredWork: () => undefined,
          ...(seededWake
            ? {
                wakeup: async () => {
                  throw new Error("injected scheduler outage before receipt");
                },
              }
            : {}),
        });
        let restarted: ReturnType<typeof createService> | undefined;
        try {
          await db
            .update(chatEndpoints)
            .set({ status: "active" })
            .where(eq(chatEndpoints.id, first.endpoint.id));
          await db.insert(chatEndpointResources).values({
            companyId: fixture.companyId,
            endpointId: first.endpoint.id,
            type: "chat",
            providerResourceId: "-100123",
            label: "Retained source fixture",
            availability: "available",
            enabled: true,
          });
          const channel = makeThread({
            channelId: "-100123",
            id: "telegram:-100123",
            isDM: false,
          });
          await deliverMessage({
            callbacks: first.callbacks,
            endpointId: first.endpoint.id,
            provider: "telegram",
            thread: channel.thread,
            trigger: "mention",
            message: makeMessage({
              id: "-100123:71",
              text: command
                ? "/task PRIVATE_RETAINED_ZERO_BODY"
                : "@maya PRIVATE_RETAINED_ZERO_BODY",
              mentioned: true,
              userId: "77115580",
              raw: {
                message_id: 71,
                chat: { id: -100123 },
                from: { id: 77115580 },
                date: Math.floor(Date.now() / 1000),
              },
            }),
          });
          const [original] = await readChatDeliveriesByEndpointId(first.endpoint.id);
          expect(original).toMatchObject({
            state: seededWake ? "processed" : "received",
          });
          const actions = await db
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.deliveryId, original.id),
                eq(chatActions.kind, "inbound_wakeup"),
              ),
            );
          expect(actions).toHaveLength(seededWake ? 1 : 0);
          if (seededWake)
            expect(actions[0]).toMatchObject({ status: "issued" });
          expect(
            await db
              .select()
              .from(agentWakeupRequests)
              .where(eq(agentWakeupRequests.companyId, fixture.companyId)),
          ).toEqual([]);
          await first.service.shutdown();
          expect(first.runtime.get(first.endpoint.id)).toBeNull();
          // Simulate a receipt saved by an older process. No current runtime
          // callback supplies raw message_id during either recovery path.
          const messageId =
            source === "zero" || source === "zero_microseconds" || preparingWake
              ? "-100123:0"
              : source === "legacy"
                ? "legacy-message"
                : "-100123:71";
          const eventId = `${channel.thread.id}:${source === "zero_event" ? "-100123:0" : messageId}`;
          const normalized = original.normalizedEvent as {
            message: Record<string, unknown>;
          };
          const retained = {
            ...original.normalizedEvent,
            providerEventId: eventId,
            message: {
              ...normalized.message,
              providerMessageId: messageId,
              providerMessageSequence:
                source === "zero_sequence"
                  ? 0
                  : source === "legacy" || source === "zero"
                    ? null
                    : 71,
            },
          };
          await db
            .update(chatDeliveries)
            .set({
              providerEventId: eventId,
              normalizedEvent: retained,
              state: pendingWake
                ? "processed"
                : (state as "received" | "retry" | "processing"),
              nextAttemptAt: new Date(0),
              updatedAt: new Date(0),
            })
            .where(eq(chatDeliveries.id, original.id));
          if (source === "zero_microseconds") {
            await db.execute(
              sql`update chat_deliveries set updated_at = '2026-09-01 12:00:00.123456+00'::timestamptz where id = ${original.id}::uuid`,
            );
            expect(
              await db
                .select({
                  micros: sql<string>`to_char(${chatDeliveries.updatedAt}, 'US')`,
                })
                .from(chatDeliveries)
                .where(eq(chatDeliveries.id, original.id)),
            ).toEqual([{ micros: "123456" }]);
          }
          if (seededWake) {
            await db
              .update(chatActions)
              .set({
                ...(preparingWake ? { status: "preparing" } : {}),
                result: {
                  code: "inbound_wakeup_retry",
                  retryAt: new Date(0).toISOString(),
                },
              })
              .where(eq(chatActions.id, actions[0]!.id));
            await db
              .update(chatMessageLinks)
              .set({ providerMessageId: messageId })
              .where(eq(chatMessageLinks.deliveryId, original.id));
          }
          const commentsBefore = await readIssueCommentsByCompanyId(fixture.companyId);
          const issuesBefore = await readIssuesByCompanyId(fixture.companyId);
          const publicationsBefore = await db
            .select()
            .from(chatPublications)
            .where(eq(chatPublications.companyId, fixture.companyId));
          restarted = createService(
            new FakeChatSdkRuntime(),
            fakeTelegramFetch() as typeof globalThis.fetch,
            { scheduleDeferredWork: () => undefined },
          );
          if (preparingWake) {
            const replacement = {
              ...retained,
              providerEventId: `${channel.thread.id}:-100123:71`,
              message: {
                ...retained.message,
                providerMessageId: "-100123:71",
                providerMessageSequence: 71,
              },
            };
            let release!: () => void;
            let acquired!: () => void;
            const held = new Promise<void>((resolve) => {
              release = resolve;
            });
            const locked = new Promise<void>((resolve) => {
              acquired = resolve;
            });
            const owner = db.transaction(async (tx) => {
              await tx
                .select()
                .from(chatDeliveries)
                .where(eq(chatDeliveries.id, original.id))
                .for("update");
              await tx
                .update(chatDeliveries)
                .set({
                  updatedAt: new Date(),
                  ...(replacedSource
                    ? {
                        providerEventId: replacement.providerEventId,
                        normalizedEvent: replacement,
                      }
                    : {}),
                })
                .where(eq(chatDeliveries.id, original.id));
              if (replacedSource)
                await tx
                  .update(chatMessageLinks)
                  .set({ providerMessageId: "-100123:71" })
                  .where(eq(chatMessageLinks.deliveryId, original.id));
              acquired();
              await held;
            });
            await locked;
            let drain: Promise<unknown> | undefined;
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
              drain = restarted.service.processPendingDeliveries(
                25,
                original.id,
              );
              await Promise.race([
                drain,
                new Promise<never>((_resolve, reject) => {
                  deadline = setTimeout(
                    () =>
                      reject(
                        new Error(
                          "held claim must stop the drain without waiting",
                        ),
                      ),
                    1500,
                  );
                }),
              ]);
              expect(
                await db
                  .select({ state: chatDeliveries.state })
                  .from(chatDeliveries)
                  .where(eq(chatDeliveries.id, original.id)),
              ).toEqual([{ state: "processing" }]);
              expect(
                await db
                  .select({ status: chatActions.status })
                  .from(chatActions)
                  .where(eq(chatActions.id, actions[0]!.id)),
              ).toEqual([{ status: "preparing" }]);
              expect(restarted.wakeup).not.toHaveBeenCalled();
            } finally {
              if (deadline) clearTimeout(deadline);
              release();
              await owner;
              await drain;
            }
            // The newly committed live claim remains owned; filtering must
            // not continue from the stale pre-lock candidate snapshot.
            await restarted.service.processPendingDeliveries(25, original.id);
            if (replacedSource)
              expect(
                await db
                  .select({ normalizedEvent: chatDeliveries.normalizedEvent })
                  .from(chatDeliveries)
                  .where(eq(chatDeliveries.id, original.id)),
              ).toEqual([{ normalizedEvent: replacement }]);
            expect(
              await db
                .select({ status: chatActions.status })
                .from(chatActions)
                .where(eq(chatActions.id, actions[0]!.id)),
            ).toEqual([{ status: "preparing" }]);
            await db.execute(
              sql`update chat_deliveries set updated_at = '2026-09-01 12:00:00.123456+00'::timestamptz where id = ${original.id}::uuid`,
            );
          }
          await restarted.service.processPendingDeliveries(25, original.id);
          const [settled] = await readChatDeliveriesById(original.id);
          if (denied) {
            expect(restarted.wakeup).not.toHaveBeenCalled();
            expect(settled).toMatchObject({
              state: pendingWake ? "processed" : "filtered",
            });
            expect(settled.normalizedEvent).toEqual(retained);
            expect(settled.redactedError).not.toContain(
              "PRIVATE_RETAINED_ZERO_BODY",
            );
            expect(
              await readIssueCommentsByCompanyId(fixture.companyId),
            ).toEqual(commentsBefore);
            expect(
              await readIssuesByCompanyId(fixture.companyId),
            ).toEqual(issuesBefore);
            expect(
              await db
                .select()
                .from(chatPublications)
                .where(eq(chatPublications.companyId, fixture.companyId)),
            ).toEqual(publicationsBefore);
            if (seededWake)
              expect(
                await readChatActionsById(actions[0]!.id),
              ).toEqual([
                expect.objectContaining({
                  status: "failed",
                  payload: actions[0]!.payload,
                  result: expect.objectContaining({
                    code: preparingWake
                      ? "inbound_wakeup_delivery_rejected"
                      : "inbound_wakeup_authorization_changed",
                  }),
                }),
              ]);
            for (const runtime of restarted.runtime.endpoints.values()) {
              expect(runtime.posts).toEqual([]);
              expect(runtime.reactions).toEqual([]);
              expect(runtime.rehydratedAttachmentDescriptors).toEqual([]);
            }
          } else {
            expect(restarted.wakeup).toHaveBeenCalledOnce();
            expect(settled.state).toBe("processed");
          }
          expect(
            await db
              .select()
              .from(agentWakeupRequests)
              .where(eq(agentWakeupRequests.companyId, fixture.companyId)),
          ).toHaveLength(denied ? 0 : 1);
          expect(
            await readHeartbeatRunsByCompanyId(fixture.companyId),
          ).toEqual([]);
          await restarted.service.processPendingDeliveries(25, original.id);
          expect(restarted.wakeup).toHaveBeenCalledTimes(denied ? 0 : 1);
          if (denied)
            expect(
              await readChatDeliveriesById(original.id),
            ).toEqual([settled]);
        } finally {
          try {
            await retirePublicationFixture(
              restarted?.service ?? first.service,
              first.endpoint.id,
            );
          } finally {
            await first.service.shutdown();
          }
        }
      },
    );
  });

  describe("Telegram current rich inbound compatibility", () => {
    it.each([
      "mixed_files",
      "restart_topic",
      "revoked",
      "unknown_document",
    ])(
      "keeps rich files and omissions scoped through lifecycle recovery (%s)",
      async (mode) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const deferred = mode === "restart_topic" || mode === "revoked";
        const first = await configuredTelegramEndpoint(fixture, {
          storage: storage.storage,
          deferWebhookProcessing: deferred,
          scheduleDeferredWork: () => undefined,
        });
        const { service, runtime, endpoint, callbacks, wakeup } = first;
        const configuration = runtime.configurations.get(endpoint.id)!;
        const pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        const recovered = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        let restarted: ReturnType<typeof createService> | undefined;
        const topic = mode === "restart_topic";
        const chatId = topic ? -10077115580 : 77115580;
        const threadId = `telegram:${chatId}${topic ? ":42" : ""}`;
        const thread = makeThread({
          channelId: String(chatId),
          id: threadId,
          isDM: !topic,
        }).thread;
        const bytes = Buffer.from("Exact rich restart file\nshape=hexagon\n");
        const photo = await sharp({
          create: { width: 16, height: 16, channels: 3, background: "teal" },
        })
          .jpeg()
          .toBuffer();
        const document = {
          type: "document",
          document: {
            file_id: "rich-document",
            file_unique_id: "rich-unique",
            file_name: "rich-document.txt",
            mime_type: "text/plain",
            file_size: bytes.length,
          },
        };
        const raw = {
          message_id: 71,
          date: Math.floor(Date.now() / 1_000),
          ...(topic ? { message_thread_id: 42 } : {}),
          chat: { id: chatId, type: topic ? "supergroup" : "private" },
          from: {
            id: 77115580,
            is_bot: false,
            first_name: "Rich lifecycle fixture",
          },
          rich_message: {
            blocks:
              mode === "unknown_block"
                ? [{ type: "future_block", text: "PRIVATE_UNSUPPORTED_BODY" }]
                : mode === "malformed_block"
                  ? [{ type: "details", blocks: null }]
                  : mode === "unknown_document"
                    ? [
                        {
                          type: "document",
                          document: {
                            file_id: "rich-document",
                            file_unique_id: "rich-unique",
                            file_name: "unknown.bin",
                            file_size: bytes.length,
                          },
                        },
                      ]
                    : mode === "mixed_files"
                      ? [
                          { type: "paragraph", text: "Before files" },
                          {
                            type: "details",
                            summary: "File section",
                            blocks: [
                              document,
                              {
                                type: "photo",
                                photo: [
                                  {
                                    file_id: "rich-photo",
                                    file_unique_id: "rich-photo-unique",
                                    width: 16,
                                    height: 16,
                                    file_size: photo.length,
                                  },
                                ],
                                caption: { text: "Photo caption" },
                              },
                            ],
                          },
                          {
                            type: "expandable_blockquote",
                            text: "Quoted tail",
                            credit: "Quote author",
                          },
                        ]
                      : [document],
          },
        };
        const requests: string[] = [];
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.hostname !== "api.telegram.org")
              throw new Error("Unexpected fixture host");
            if (url.pathname.endsWith("/getFile")) {
              const file = JSON.parse(String(init?.body)).file_id;
              expect(["rich-document", "rich-photo"]).toContain(file);
              requests.push(`getFile:${file}`);
              return Response.json({
                ok: true,
                result: { file_path: `fixture/${file}` },
              });
            }
            const file = url.pathname.split("/").at(-1)!;
            if (!["rich-document", "rich-photo"].includes(file))
              throw new Error("Unexpected fixture method");
            requests.push(`download:${file}`);
            if (mode === "source_edit") {
              const updated = pinned.parseTelegramCommandMessage({
                ...raw,
                edit_date: raw.date + 1,
                rich_message: {
                  blocks: [
                    {
                      ...document,
                      document: {
                        ...document.document,
                        file_id: "different-file",
                      },
                    },
                  ],
                },
              })!;
              await callbacks.onMessageUpdated!({
                endpointId: endpoint.id,
                provider: "telegram",
                thread,
                message: updated,
              });
            }
            return new Response(file === "rich-photo" ? photo : bytes);
          });
        try {
          Object.assign(runtime.endpoints.get(endpoint.id)!, {
            attachmentRecoveryDescriptor:
              pinned.attachmentRecoveryDescriptor.bind(pinned),
            rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
          });
          if (topic) {
            await db
              .update(chatEndpoints)
              .set({ status: "active" })
              .where(eq(chatEndpoints.id, endpoint.id));
            await db.insert(chatEndpointResources).values({
              companyId: fixture.companyId,
              endpointId: endpoint.id,
              type: "chat",
              providerResourceId: String(chatId),
              label: "Rich topic",
              availability: "available",
              enabled: true,
            });
          }
          const message = pinned.parseTelegramCommandMessage(raw)!;
          if (topic) message.isMention = true; // Verified runtime callback addressing, not attachment authority.
          const ingress = deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "telegram",
            thread,
            message,
            trigger: topic ? "mention" : "direct_message",
          });
          if (mode === "source_edit")
            await expect(ingress).rejects.toThrow("admitted source changed");
          else await ingress;
          const [delivery] = await db
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(
                  chatDeliveries.eventKind,
                  topic ? "mention" : "direct_message",
                ),
              ),
            );
          if (deferred) {
            expect(delivery).toMatchObject({ state: "received", attempts: 0 });
            expect(requests).toEqual([]);
            expect(wakeup).not.toHaveBeenCalled();
            const retired = vi.fn(async () => {
              throw new Error("Retired rich closure used");
            });
            message.attachments[0]!.fetchData = retired;
            await service.shutdown();
            if (mode === "revoked")
              await db
                .update(chatEndpoints)
                .set({ allowDirectMessages: false })
                .where(eq(chatEndpoints.id, endpoint.id));
            await db
              .update(chatDeliveries)
              .set({ nextAttemptAt: new Date(0) })
              .where(eq(chatDeliveries.id, delivery.id));
            const nextRuntime = new FakeChatSdkRuntime();
            const replace = nextRuntime.replaceEndpoint.bind(nextRuntime);
            vi.spyOn(nextRuntime, "replaceEndpoint").mockImplementation(
              async (options) => {
                const next = await replace(options);
                Object.assign(next, {
                  attachmentRecoveryDescriptor:
                    recovered.attachmentRecoveryDescriptor.bind(recovered),
                  rehydrateAttachment:
                    recovered.rehydrateAttachment.bind(recovered),
                });
                const originalThread = next.thread.bind(next);
                vi.spyOn(next, "thread").mockImplementation((id) => ({
                  ...originalThread(id),
                  channelId: String(chatId),
                  isDM: !topic,
                }));
                return next;
              },
            );
            restarted = createService(
              nextRuntime,
              fakeTelegramFetch() as typeof globalThis.fetch,
              {
                storage: storage.storage,
                scheduleDeferredWork: () => undefined,
              },
            );
            await restarted.service.processPendingDeliveries(25, delivery.id);
            expect(retired).not.toHaveBeenCalled();
          }
          const finalService = restarted?.service ?? service;
          const finalWake = restarted?.wakeup ?? wakeup;
          if (["revoked", "source_edit", "unknown_document"].includes(mode)) {
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(finalWake).not.toHaveBeenCalled();
            expect(requests).toEqual(
              mode === "source_edit"
                ? ["getFile:rich-document", "download:rich-document"]
                : [],
            );
          } else if (mode === "unknown_block" || mode === "malformed_block") {
            const comments = await db
              .select({ body: issueComments.body })
              .from(issueComments)
              .where(eq(issueComments.companyId, fixture.companyId));
            expect(comments[0]?.body).toContain("could not import");
            expect(JSON.stringify(comments)).not.toContain(
              "PRIVATE_UNSUPPORTED_BODY",
            );
            expect(requests).toEqual([]);
          } else {
            expect(storage.putFile).toHaveBeenCalledTimes(
              mode === "mixed_files" ? 2 : 1,
            );
            expect(storage.putFile.mock.calls[0]![0]).toMatchObject({
              body: bytes,
              contentType: "text/plain",
            });
            if (mode === "mixed_files") {
              expect(storage.putFile.mock.calls[1]![0]).toMatchObject({
                body: photo,
                contentType: "image/jpeg",
              });
              const [comment] = await readIssueCommentsByCompanyId(fixture.companyId);
              expect(comment.body).toBe(
                "Before files\n\nFile section\n\nPhoto caption\n\nQuoted tail\n\nQuote author",
              );
            }
            expect(finalWake).toHaveBeenCalledOnce();
            expect(await finalService.listConversations(endpoint.id)).toEqual([
              expect.objectContaining({ externalThreadId: threadId }),
            ]);
            const before = [...requests];
            await finalService.processPendingDeliveries(25, delivery.id);
            if (!deferred)
              await deliverMessage({
                callbacks,
                endpointId: endpoint.id,
                provider: "telegram",
                thread,
                message,
                trigger: "direct_message",
              });
            expect(requests).toEqual(before);
            expect(finalWake).toHaveBeenCalledOnce();
          }
        } finally {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await recovered.shutdown();
            } finally {
              try {
                await retirePublicationFixture(
                  restarted?.service ?? service,
                  endpoint.id,
                );
              } finally {
                try {
                  await service.shutdown();
                } finally {
                  fetchSpy.mockRestore();
                }
              }
            }
          }
        }
      },
    );

    it.each(["quote", "mixed", "document"] as const)(
      "retains current rich content through the pinned parser and service (%s)",
      async (mode) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const { service, runtime, endpoint, callbacks, wakeup } =
          await configuredTelegramEndpoint(fixture, {
            storage: storage.storage,
          });
        const pinned = createChatSdkEndpointRuntime({
          ...runtime.configurations.get(endpoint.id)!,
          logger: "silent",
        });
        const bytes = Buffer.from(
          "Exact rich document fixture\nshape=hexagon\n",
        );
        const requests: string[] = [];
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.hostname !== "api.telegram.org")
              throw new Error("Unexpected fixture host");
            if (url.pathname.endsWith("/getFile")) {
              expect(JSON.parse(String(init?.body))).toEqual({
                file_id: "rich-document",
              });
              requests.push("getFile");
              return Response.json({
                ok: true,
                result: { file_path: "fixture/rich-document.txt" },
              });
            }
            if (!url.pathname.endsWith("/fixture/rich-document.txt"))
              throw new Error("Unexpected fixture method");
            requests.push("download");
            return new Response(bytes);
          });
        try {
          Object.assign(runtime.endpoints.get(endpoint.id)!, {
            attachmentRecoveryDescriptor:
              pinned.attachmentRecoveryDescriptor.bind(pinned),
            rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
          });
          const quote = {
            type: "expandable_blockquote",
            text: ["Exact quoted ", { type: "bold", text: "tail" }],
            credit: "Visible credit",
          };
          const blocks =
            mode === "document"
              ? [
                  {
                    type: "document",
                    document: {
                      file_id: "rich-document",
                      file_unique_id: "rich-unique",
                      file_name: "rich-document.txt",
                      mime_type: "text/plain",
                      file_size: bytes.length,
                    },
                  },
                ]
              : mode === "mixed"
                ? [
                    { type: "paragraph", text: "Before" },
                    quote,
                    { type: "paragraph", text: "After" },
                  ]
                : [quote];
          const message = pinned.parseTelegramCommandMessage({
            message_id: 70,
            date: Math.floor(Date.now() / 1_000),
            chat: { id: 77115580, type: "private" },
            from: { id: 77115580, is_bot: false, first_name: "Rich fixture" },
            rich_message: { blocks },
          })!;
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "telegram",
            thread: makeThread({
              channelId: "77115580",
              id: "telegram:77115580",
              isDM: true,
            }).thread,
            message,
            trigger: "direct_message",
          });
          if (mode === "document") {
            expect(storage.putFile).toHaveBeenCalledOnce();
            expect(storage.putFile.mock.calls[0]![0]).toMatchObject({
              body: bytes,
              contentType: "text/plain",
              originalFilename: "rich-document.txt",
            });
            expect(requests).toEqual(["getFile", "download"]);
          } else {
            const [comment] = await readIssueCommentsByCompanyId(fixture.companyId);
            expect(comment?.body).toBe(
              mode === "mixed"
                ? "Before\n\nExact quoted tail\n\nVisible credit\n\nAfter"
                : "Exact quoted tail\n\nVisible credit",
            );
          }
          expect(wakeup).toHaveBeenCalledOnce();
        } finally {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await retirePublicationFixture(service, endpoint.id);
            } finally {
              fetchSpy.mockRestore();
            }
          }
        }
      },
    );
  });

  describe("Telegram source-bound optional media", () => {
    it.each([
      "topic_restart",
      "changed_locator",
      "revoked_before_fetch",
      "revoked_during_fetch",
    ] as const)(
      "retains exact durable media authority across restart (%s)",
      async (mode) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const first = await configuredTelegramEndpoint(fixture, {
          storage: storage.storage,
          deferWebhookProcessing: true,
          scheduleDeferredWork: () => undefined,
        });
        const { endpoint, runtime, service, callbacks, wakeup } = first;
        const configuration = runtime.configurations.get(endpoint.id)!;
        const pinned = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        const recovered = createChatSdkEndpointRuntime({
          ...configuration,
          logger: "silent",
        });
        let restarted: ReturnType<typeof createService> | undefined;
        const topic = mode === "topic_restart";
        const chatId = topic ? -10077115579 : 77115579;
        const threadId = `telegram:${chatId}${topic ? ":42" : ""}`;
        const requests: string[] = [];
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.hostname !== "api.telegram.org")
              throw new Error("Unexpected fixture host");
            if (url.pathname.endsWith("/getFile")) {
              expect(JSON.parse(String(init?.body))).toEqual({
                file_id: "restart-media",
              });
              requests.push("getFile");
              return Response.json({
                ok: true,
                result: { file_path: "fixture/restart.mp4" },
              });
            }
            if (!url.pathname.endsWith("/fixture/restart.mp4"))
              throw new Error("Unexpected fixture method");
            requests.push("download");
            if (mode === "revoked_during_fetch")
              await db
                .update(chatEndpoints)
                .set({ allowDirectMessages: false })
                .where(eq(chatEndpoints.id, endpoint.id));
            return new Response(TELEGRAM_VIDEO_NOTE_MP4);
          });
        try {
          Object.assign(runtime.endpoints.get(endpoint.id)!, {
            attachmentRecoveryDescriptor:
              pinned.attachmentRecoveryDescriptor.bind(pinned),
            rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
          });
          if (topic) {
            await db
              .update(chatEndpoints)
              .set({ status: "active" })
              .where(eq(chatEndpoints.id, endpoint.id));
            await db.insert(chatEndpointResources).values({
              companyId: fixture.companyId,
              endpointId: endpoint.id,
              type: "chat",
              providerResourceId: String(chatId),
              label: "Fixture topic",
              availability: "available",
              enabled: true,
            });
          }
          const message = pinned.parseTelegramCommandMessage({
            message_id: 50,
            date: Math.floor(Date.now() / 1_000),
            ...(topic ? { message_thread_id: 42 } : {}),
            chat: { id: chatId, type: topic ? "supergroup" : "private" },
            from: {
              id: 77115579,
              is_bot: false,
              first_name: "Restart fixture",
            },
            video: {
              file_id: "restart-media",
              file_unique_id: "restart-unique",
              file_size: TELEGRAM_VIDEO_NOTE_MP4.length,
              width: 16,
              height: 16,
              duration: 1,
            },
          })!;
          // The runtime's verified mention callback supplies addressing;
          // attachment bytes/identity still come from the actual pinned parser.
          if (topic) message.isMention = true;
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "telegram",
            thread: makeThread({
              channelId: String(chatId),
              id: threadId,
              isDM: !topic,
            }).thread,
            message,
            trigger: topic ? "mention" : "direct_message",
          });
          const [received] = await readChatDeliveriesByEndpointId(endpoint.id);
          expect(received).toMatchObject({ state: "received", attempts: 0 });
          expect(received.normalizedEvent).toMatchObject({
            message: {
              attachments: [
                {
                  recovery: {
                    locator: {
                      kind: "telegram_media",
                      fileId: "restart-media",
                      fileUniqueId: "restart-unique",
                      threadId,
                      messageId: `${chatId}:50`,
                      principalExternalId: "77115579",
                    },
                  },
                },
              ],
            },
          });
          expect(requests).toEqual([]);
          expect(wakeup).not.toHaveBeenCalled();
          const originalFetch = vi.fn(async () => {
            throw new Error("Retired closure used");
          });
          message.attachments[0]!.fetchData = originalFetch;
          await service.shutdown();
          if (mode === "changed_locator") {
            const normalized = structuredClone(received.normalizedEvent) as {
              message: {
                attachments: Array<{
                  recovery: { locator: { fileId: string } };
                }>;
              };
            };
            normalized.message.attachments[0]!.recovery.locator.fileId =
              "unrelated-file";
            await db
              .update(chatDeliveries)
              .set({ normalizedEvent: normalized })
              .where(eq(chatDeliveries.id, received.id));
          }
          if (mode === "revoked_before_fetch")
            await db
              .update(chatEndpoints)
              .set({ allowDirectMessages: false })
              .where(eq(chatEndpoints.id, endpoint.id));
          await db
            .update(chatDeliveries)
            .set({ nextAttemptAt: new Date(0) })
            .where(eq(chatDeliveries.id, received.id));
          const nextRuntime = new FakeChatSdkRuntime();
          const replace = nextRuntime.replaceEndpoint.bind(nextRuntime);
          vi.spyOn(nextRuntime, "replaceEndpoint").mockImplementation(
            async (options) => {
              const next = await replace(options);
              Object.assign(next, {
                attachmentRecoveryDescriptor:
                  recovered.attachmentRecoveryDescriptor.bind(recovered),
                rehydrateAttachment:
                  recovered.rehydrateAttachment.bind(recovered),
              });
              const thread = next.thread.bind(next);
              vi.spyOn(next, "thread").mockImplementation((id) => ({
                ...thread(id),
                channelId: String(chatId),
                isDM: !topic,
              }));
              return next;
            },
          );
          restarted = createService(
            nextRuntime,
            fakeTelegramFetch() as typeof globalThis.fetch,
            { storage: storage.storage, scheduleDeferredWork: () => undefined },
          );
          await restarted.service.processPendingDeliveries(25, received.id);
          expect(originalFetch).not.toHaveBeenCalled();
          if (topic) {
            expect(requests).toEqual(["getFile", "download"]);
            expect(storage.putFile).toHaveBeenCalledOnce();
            expect(storage.putFile.mock.calls[0]![0]).toMatchObject({
              body: TELEGRAM_VIDEO_NOTE_MP4,
              contentType: "video/mp4",
            });
            expect(restarted.wakeup).toHaveBeenCalledOnce();
            expect(
              await restarted.service.listConversations(endpoint.id),
            ).toEqual([
              expect.objectContaining({ externalThreadId: threadId }),
            ]);
            await restarted.service.processPendingDeliveries(25, received.id);
            expect(requests).toEqual(["getFile", "download"]);
            expect(restarted.wakeup).toHaveBeenCalledOnce();
          } else {
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(restarted.wakeup).not.toHaveBeenCalled();
            expect(requests).toEqual(
              mode === "revoked_during_fetch" ? ["getFile", "download"] : [],
            );
            if (mode === "changed_locator") {
              const [comment] = await readIssueCommentsByCompanyId(fixture.companyId);
              expect(comment!.body).toContain("could not safely import");
            }
          }
        } finally {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await recovered.shutdown();
            } finally {
              try {
                await retirePublicationFixture(
                  restarted?.service ?? service,
                  endpoint.id,
                );
              } finally {
                try {
                  await service.shutdown();
                } finally {
                  fetchSpy.mockRestore();
                }
              }
            }
          }
        }
      },
    );

    it.each([
      "video",
      "voice",
      "oversize",
      "malformed_video",
      "office_named_video",
    ])(
      "imports exact permitted bytes or gives accurate recovery advice (%s)",
      async (mode) => {
        const fixture = await seedCompany();
        const storage = createStorageService();
        const context = await configuredTelegramEndpoint(fixture, {
          storage: storage.storage,
        });
        const { service, runtime, endpoint, callbacks, wakeup } = context;
        const pinned = createChatSdkEndpointRuntime({
          ...runtime.configurations.get(endpoint.id)!,
          logger: "silent",
        });
        const photo = await sharp({
          create: { width: 16, height: 16, channels: 3, background: "teal" },
        })
          .jpeg()
          .toBuffer();
        const bytes =
          mode === "voice"
            ? TELEGRAM_VOICE_OGG
            : mode === "malformed_bytes" || mode === "office_named_invalid"
              ? TELEGRAM_VIDEO_NOTE_MP4.subarray(0, -1)
              : TELEGRAM_VIDEO_NOTE_MP4;
        const requests: string[] = [];
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.hostname !== "api.telegram.org")
              throw new Error("Unexpected fixture host");
            if (url.pathname.endsWith("/getFile")) {
              const fileId = JSON.parse(String(init?.body)).file_id as string;
              expect(["optional-media", "optional-photo"]).toContain(fileId);
              requests.push(`getFile:${fileId}`);
              return Response.json({
                ok: true,
                result: { file_path: `fixture/${fileId}` },
              });
            }
            const file = url.pathname.split("/").at(-1)!;
            if (!["optional-media", "optional-photo"].includes(file))
              throw new Error("Unexpected fixture method");
            requests.push(`download:${file}`);
            return new Response(file === "optional-photo" ? photo : bytes);
          });
        try {
          Object.assign(runtime.endpoints.get(endpoint.id)!, {
            attachmentRecoveryDescriptor:
              pinned.attachmentRecoveryDescriptor.bind(pinned),
            rehydrateAttachment: pinned.rehydrateAttachment.bind(pinned),
          });
          const media = {
            file_id: "optional-media",
            file_unique_id: "optional-media-unique",
            file_size:
              mode === "oversize" ? MAX_ATTACHMENT_BYTES + 1 : bytes.length,
            duration:
              mode === "malformed_video" || mode === "malformed_live_photo"
                ? -1
                : 1,
            ...(mode.startsWith("office_named")
              ? { file_name: "recording.docx" }
              : {}),
          };
          const raw = {
            message_id: 41,
            date: Math.floor(Date.now() / 1_000),
            chat: { id: 77115579, type: "private" },
            from: {
              id: 77115579,
              is_bot: false,
              first_name: "Optional media fixture",
            },
            ...(mode === "unknown_document"
              ? { document: media }
              : mode === "voice"
                ? { voice: media }
                : mode === "live_photo" || mode === "malformed_live_photo"
                  ? {
                      live_photo: {
                        ...media,
                        width: 16,
                        height: 16,
                        photo: [
                          {
                            file_id: "optional-photo",
                            file_unique_id: "optional-photo-unique",
                            file_size: photo.length,
                            width: 16,
                            height: 16,
                          },
                        ],
                      },
                    }
                  : { video: { ...media, width: 16, height: 16 } }),
          };
          const message = pinned.parseTelegramCommandMessage(raw)!;
          await deliverMessage({
            callbacks,
            endpointId: endpoint.id,
            provider: "telegram",
            thread: makeThread({
              channelId: "77115579",
              id: "telegram:77115579",
              isDM: true,
            }).thread,
            message,
            trigger: "direct_message",
          });
          if (
            [
              "oversize",
              "unknown_document",
              "malformed_video",
              "malformed_live_photo",
              "malformed_bytes",
              "office_named_invalid",
            ].includes(mode)
          ) {
            expect(storage.putFile).not.toHaveBeenCalled();
            expect(requests).toEqual(
              mode === "malformed_bytes" || mode === "office_named_invalid"
                ? ["getFile:optional-media", "download:optional-media"]
                : [],
            );
            const [comment] = await readIssueCommentsByCompanyId(fixture.companyId);
            expect(comment!.body).toContain(
              `under ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)}`,
            );
            expect(wakeup).not.toHaveBeenCalled();
            return;
          }
          expect(storage.putFile).toHaveBeenCalledTimes(
            mode === "live_photo" ? 2 : 1,
          );
          expect(
            storage.putFile.mock.calls.some(
              ([input]) =>
                Buffer.isBuffer(input.body) && input.body.equals(bytes) &&
                input.contentType ===
                  (mode === "voice" ? "audio/ogg" : "video/mp4"),
            ),
          ).toBe(true);
          if (mode === "live_photo")
            expect(
              storage.putFile.mock.calls.some(
                ([input]) =>
                  Buffer.isBuffer(input.body) && input.body.equals(photo) &&
                  input.contentType === "image/jpeg",
              ),
            ).toBe(true);
          expect(wakeup).toHaveBeenCalledOnce();
          const [delivery] = await readChatDeliveriesByEndpointId(endpoint.id);
          expect(delivery).toMatchObject({
            state: "processed",
            redactedError: null,
          });
          // Replay this exact source, not unrelated admission retries left in
          // the shared fixture DB by tests exercising failed scheduler calls.
          await service.processPendingDeliveries(25, delivery.id);
          expect(requests).toHaveLength(mode === "live_photo" ? 4 : 2);
          expect(wakeup).toHaveBeenCalledOnce();
          expect(wakeup.mock.calls[0]![0]).toBe(fixture.assignedAgentId);
          await expect(
            db
              .select({ id: agentWakeupRequests.id })
              .from(agentWakeupRequests)
              .innerJoin(
                chatActions,
                eq(chatActions.id, agentWakeupRequests.id),
              )
              .where(
                and(
                  eq(chatActions.deliveryId, delivery.id),
                  eq(agentWakeupRequests.companyId, fixture.companyId),
                  eq(agentWakeupRequests.agentId, fixture.assignedAgentId),
                ),
              ),
          ).resolves.toHaveLength(1);
        } finally {
          try {
            await pinned.shutdown();
          } finally {
            try {
              await retirePublicationFixture(service, endpoint.id);
            } finally {
              fetchSpy.mockRestore();
            }
          }
        }
      },
    );
  });
});
