import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  assets,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";

import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import type { StorageService } from "../../storage/types.js";
import { issueService } from "../issues.js";
import { NativeChatAttachmentReadScope } from "./chat-attachment-read.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

const stagingControl = vi.hoisted(() => ({
  beforeStage: undefined as (() => Promise<void>) | undefined,
  afterStage: undefined as
    ((workspaceRelativePath: string) => void) | undefined,
}));
vi.mock("./native-runner-file-handoff.js", async (original) => {
  const actual =
    await original<typeof import("./native-runner-file-handoff.js")>();
  return {
    ...actual,
    stageNativeRunnerAttachmentBytes: async (
      input: Parameters<typeof actual.stageNativeRunnerAttachmentBytes>[0],
    ) => {
      await stagingControl.beforeStage?.();
      const result = await actual.stageNativeRunnerAttachmentBytes(input);
      stagingControl.afterStage?.(result.workspaceRelativePath);
      return result;
    },
  };
});

describe("native same-conversation historical attachment reading", () => {
  let temporary: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let db: ReturnType<typeof createDb>;
  let storage: ReturnType<typeof createStorageService>;

  const companyId = "10000000-0000-4000-8000-000000000101";
  const agentId = "10000000-0000-4000-8000-000000000102";
  const issueId = "10000000-0000-4000-8000-000000000103";
  const runId = "10000000-0000-4000-8000-000000000104";
  const endpointId = "10000000-0000-4000-8000-000000000105";
  const conversationId = "10000000-0000-4000-8000-000000000106";
  const resourceId = "10000000-0000-4000-8000-000000000107";
  const principalId = "10000000-0000-4000-8000-000000000108";
  const userId = "chat-user-1";
  let workspaceRoot: string;
  let currentCommentId: string;
  let sourceCommentId: string;
  let sourceAttachmentId: string;
  const sourceBody = Buffer.from(
    "same-conversation historical bytes\n",
    "utf8",
  );

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-chat-reuse-");
    db = createDb(temporary.connectionString);
    workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "paperclip-chat-read-workspace-"),
    );
    const storageRoot = await mkdtemp(
      path.join(tmpdir(), "paperclip-chat-reuse-"),
    );
    await mkdir(storageRoot, { recursive: true });
    storage = createStorageService(createLocalDiskStorageProvider(storageRoot));
    await db.insert(companies).values({
      id: companyId,
      name: "Native chat attachment reuse",
      issuePrefix: "NCR",
      issueCounter: 1,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native chat agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "NCR-1",
      title: "Reuse the earlier file",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: {},
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));

    const applicationId = randomUUID();
    const connectionId = randomUUID();
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `chat:discord:${endpointId}`,
      name: "Discord reuse",
      type: "chat",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "Discord reuse",
      uid: `chat-discord-${endpointId}`,
      connectionPurpose: "channel",
      transport: "chat_sdk",
      status: "active",
      enabled: true,
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider: "discord",
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
      providerAccountId: "guild-1",
      allowUnlinkedPeople: false,
    });
    await db.insert(chatEndpointResources).values({
      id: resourceId,
      companyId,
      endpointId,
      type: "channel",
      providerResourceId: "channel-1",
      label: "#files",
      availability: "available",
      enabled: true,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      companyId,
      endpointId,
      resourceId,
      issueId,
      externalConversationId: "channel-1",
      externalThreadId: "thread-1",
      externalLabel: "#files thread",
      state: "active",
    });
    await db.insert(chatExternalPrincipals).values({
      id: principalId,
      companyId,
      provider: "discord",
      providerAccountId: "guild-1",
      externalId: "discord-user-1",
      kind: "user",
    });
    await db.insert(chatIdentityLinks).values({
      companyId,
      endpointId,
      principalId,
      paperclipUserId: userId,
      status: "linked",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });

    const sourceComment = await issueService(db).addComment(
      issueId,
      "The earlier upload",
      { userId },
    );
    sourceCommentId = sourceComment.id;
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: "earlier.txt",
      contentType: "text/plain",
      body: sourceBody,
    });
    const sourceAttachment = await issueService(db).createAttachment({
      issueId,
      issueCommentId: sourceCommentId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByUserId: userId,
    });
    sourceAttachmentId = sourceAttachment.id;
    const sourceDeliveryId = randomUUID();
    await db.insert(chatDeliveries).values({
      id: sourceDeliveryId,
      companyId,
      endpointId,
      conversationId,
      principalId,
      providerEventId: "source-event",
      deduplicationKey: "source-event",
      eventKind: "message",
      normalizedEvent: {},
      state: "processed",
      attempts: 1,
      processedAt: new Date(),
    });
    await db.insert(chatMessageLinks).values({
      companyId,
      endpointId,
      conversationId,
      deliveryId: sourceDeliveryId,
      commentId: sourceCommentId,
      providerMessageId: "source-message",
      direction: "inbound",
    });

    const currentComment = await issueService(db).addComment(
      issueId,
      "Please send that earlier file again",
      { userId },
    );
    currentCommentId = currentComment.id;
    const currentDeliveryId = randomUUID();
    await db.insert(chatDeliveries).values({
      id: currentDeliveryId,
      companyId,
      endpointId,
      conversationId,
      principalId,
      providerEventId: "current-event",
      deduplicationKey: "current-event",
      eventKind: "message",
      normalizedEvent: {},
      state: "processed",
      attempts: 1,
      processedAt: new Date(),
    });
    await db.insert(chatMessageLinks).values({
      companyId,
      endpointId,
      conversationId,
      deliveryId: currentDeliveryId,
      commentId: currentCommentId,
      providerMessageId: "current-message",
      direction: "inbound",
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          source: "chat:discord",
          paperclipHarnessCheckedOut: true,
          wakeCommentIds: [currentCommentId],
          commentId: currentCommentId,
          paperclipWake: {
            reason: "External chat message received",
            externalChatProvider: "discord",
            checkedOutByHarness: true,
            issue: { id: issueId, workMode: "standard" },
            commentIds: [currentCommentId],
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  const binding = { companyId, agentId, issueId, runId };
  function scope(
    overrides: Partial<
      ConstructorParameters<typeof NativeChatAttachmentReadScope>[0]
    > = {},
  ) {
    return new NativeChatAttachmentReadScope({
      db,
      binding,
      workspaceRoot,
      executionTargetKind: "local",
      storage,
      ...overrides,
    });
  }
  function selection() {
    return { sourceCommentId, attachmentId: sourceAttachmentId };
  }

  it("opens verified historical bytes without creating a publication or deliverable, then clears its exact inode", async () => {
    const reader = scope();
    const before = await db.select().from(issueAttachments);
    const result = await reader.read(selection());
    expect(result).toMatchObject({
      attachmentId: sourceAttachmentId,
      contentAccess: "staged_workspace_file",
      selectedForPublication: false,
      sha256: createHash("sha256").update(sourceBody).digest("hex"),
    });
    expect(result).not.toHaveProperty("objectKey");
    expect(result.workspaceRelativePath).toMatch(/^\.paperclip-inbound\//);
    const stagedPath = path.join(workspaceRoot, result.workspaceRelativePath);
    expect(await readFile(stagedPath)).toEqual(sourceBody);
    expect(await db.select().from(issueAttachments)).toEqual(before);
    expect(await db.select().from(chatPublications)).toEqual([]);
    await reader.close();
    expect((await stat(stagedPath)).size).toBe(0);
    expect(() => reader.read(selection())).toThrow("scope_closed");
  });

  it("cannot read another issue, an unknown source, or a remote workspace", async () => {
    for (const candidate of [
      scope({ binding: { ...binding, issueId: randomUUID() } }),
      scope({ executionTargetKind: "remote" }),
    ]) {
      try {
        await expect(
          Promise.resolve().then(() => candidate.read(selection())),
        ).rejects.toThrow();
      } finally {
        await candidate.close();
      }
    }
    const reader = scope();
    try {
      await expect(
        reader.read({ ...selection(), sourceCommentId: randomUUID() }),
      ).rejects.toThrow("source_denied");
      expect(() =>
        reader.read({ ...selection(), attachmentId: "../../outside" }),
      ).toThrow("arguments_invalid");
    } finally {
      await reader.close();
    }
  });

  it("rejects revoked current membership and disabled destination access before opening bytes", async () => {
    const member = scope();
    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(eq(companyMemberships.principalId, userId));
    try {
      await expect(member.read(selection())).rejects.toThrow("not_authorized");
    } finally {
      await member.close();
      await db
        .update(companyMemberships)
        .set({ status: "active" })
        .where(eq(companyMemberships.principalId, userId));
    }
    const disabled = scope();
    await db
      .update(chatEndpointResources)
      .set({ enabled: false })
      .where(eq(chatEndpointResources.id, resourceId));
    try {
      await expect(disabled.read(selection())).rejects.toThrow(
        "not_authorized",
      );
    } finally {
      await disabled.close();
      await db
        .update(chatEndpointResources)
        .set({ enabled: true })
        .where(eq(chatEndpointResources.id, resourceId));
    }
  });

  it("rechecks permission after asynchronous storage retrieval", async () => {
    const reader = scope({
      storage: {
        ...storage,
        getObject: async (...args: Parameters<StorageService["getObject"]>) => {
          const object = await storage.getObject(...args);
          await db
            .update(companyMemberships)
            .set({ status: "suspended" })
            .where(eq(companyMemberships.principalId, userId));
          return object;
        },
      },
    });
    try {
      await expect(reader.read(selection())).rejects.toThrow("not_authorized");
    } finally {
      await reader.close();
      await db
        .update(companyMemberships)
        .set({ status: "active" })
        .where(eq(companyMemberships.principalId, userId));
    }
  });

  it("rejects hash or size mismatches without exposing a path", async () => {
    for (const body of [
      Buffer.from("x".repeat(sourceBody.length)),
      Buffer.concat([sourceBody, Buffer.from("extra")]),
    ]) {
      const reader = scope({
        storage: {
          ...storage,
          getObject: async (
            ...args: Parameters<StorageService["getObject"]>
          ) => {
            const object = await storage.getObject(...args);
            object.stream.destroy();
            return { ...object, stream: Readable.from(body) };
          },
        },
      });
      try {
        await expect(reader.read(selection())).rejects.toThrow(/mismatch/);
      } finally {
        await reader.close();
      }
    }
  });

  it("cancels a pending storage acquisition and destroys its late stream", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lateStream: Readable | undefined;
    const reader = scope({
      storage: {
        ...storage,
        getObject: async (...args: Parameters<StorageService["getObject"]>) => {
          const object = await storage.getObject(...args);
          lateStream = object.stream;
          acquired();
          await blocked;
          return object;
        },
      },
    });
    const read = reader.read(selection());
    const rejected = expect(read).rejects.toThrow("aborted");
    await ready;
    await reader.close();
    await rejected;
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lateStream?.destroyed).toBe(true);
  });

  it("rejects a symlinked staging root without touching its target", async () => {
    const unsafeRoot = await mkdtemp(
      path.join(tmpdir(), "paperclip-chat-read-symlink-"),
    );
    const outside = await mkdtemp(
      path.join(tmpdir(), "paperclip-chat-read-outside-"),
    );
    await symlink(outside, path.join(unsafeRoot, ".paperclip-inbound"));
    const reader = scope({ workspaceRoot: unsafeRoot });
    try {
      await expect(reader.read(selection())).rejects.toThrow("path_denied");
    } finally {
      await reader.close();
    }
  });

  it("denies a stopped run and a deleted source comment", async () => {
    const stopped = scope();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, runId));
    try {
      await expect(stopped.read(selection())).rejects.toThrow("not_authorized");
    } finally {
      await stopped.close();
      await db
        .update(heartbeatRuns)
        .set({ status: "running" })
        .where(eq(heartbeatRuns.id, runId));
    }
    const deleted = scope();
    await db
      .update(issueComments)
      .set({ deletedAt: new Date() })
      .where(eq(issueComments.id, sourceCommentId));
    try {
      await expect(deleted.read(selection())).rejects.toThrow("source_denied");
    } finally {
      await deleted.close();
      await db
        .update(issueComments)
        .set({ deletedAt: null })
        .where(eq(issueComments.id, sourceCommentId));
    }
  });

  it("rejects nonchat wake authority and private same-task files without provider lineage", async () => {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const reader = scope();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: { source: "board", prompt: "pretend chat:discord" },
      })
      .where(eq(heartbeatRuns.id, runId));
    try {
      await expect(reader.read(selection())).rejects.toThrow("not_authorized");
    } finally {
      await reader.close();
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: run!.contextSnapshot })
        .where(eq(heartbeatRuns.id, runId));
    }
    const privateComment = await issueService(db).addComment(
      issueId,
      "Private board note",
      { userId },
    );
    const privateReader = scope();
    try {
      await expect(
        privateReader.read({
          ...selection(),
          sourceCommentId: privateComment.id,
        }),
      ).rejects.toThrow("source_denied");
    } finally {
      await privateReader.close();
    }
  });

  it("rejects unsupported stored MIME types before storage retrieval", async () => {
    const [attachment] = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.id, sourceAttachmentId));
    const reader = scope();
    await db
      .update(assets)
      .set({ contentType: "application/x-executable" })
      .where(eq(assets.id, attachment!.assetId));
    try {
      await expect(reader.read(selection())).rejects.toThrow("source_denied");
    } finally {
      await reader.close();
      await db
        .update(assets)
        .set({ contentType: "text/plain" })
        .where(eq(assets.id, attachment!.assetId));
    }
  });

  it("advertises a scoped reader and opens empty files without selecting them for publication", async () => {
    const [attachment] = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.id, sourceAttachmentId));
    const [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, attachment!.assetId));
    const emptyStorage: StorageService = {
      ...storage,
      getObject: async (...args) => {
        const object = await storage.getObject(...args);
        object.stream.destroy();
        return { ...object, stream: Readable.from(Buffer.alloc(0)) };
      },
    };
    const reader = scope({ storage: emptyStorage });
    const authority = new PaperclipRunnerToolAuthority(db, {
      ...binding,
      workspaceRoot,
      executionTargetKind: "local",
      storage: emptyStorage,
      chatAttachmentReadScope: reader,
    });
    expect(authority.definitions()).toContainEqual(
      expect.objectContaining({ name: "read_chat_attachment" }),
    );
    await db
      .update(assets)
      .set({
        byteSize: 0,
        sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      })
      .where(eq(assets.id, asset!.id));
    try {
      const listed = (await authority.execute({
        tool: "list_chat_attachments",
        callId: "list-empty",
        arguments: {},
      })) as {
        attachments: Array<{
          attachmentId: string;
          contentAccess: string;
          byteSize: number;
        }>;
      };
      expect(listed.attachments).toContainEqual(
        expect.objectContaining({
          attachmentId: sourceAttachmentId,
          contentAccess: "metadata_only",
          byteSize: 0,
        }),
      );
      const result = (await authority.execute({
        tool: "read_chat_attachment",
        callId: "read-empty",
        arguments: selection(),
      })) as { workspaceRelativePath: string; selectedForPublication: boolean };
      expect(result.selectedForPublication).toBe(false);
      expect(
        await readFile(path.join(workspaceRoot, result.workspaceRelativePath)),
      ).toEqual(Buffer.alloc(0));
      await expect(
        authority.execute({
          tool: "read_chat_attachment",
          callId: "read-spoof",
          arguments: { ...selection(), workspaceRoot: "/" },
        }),
      ).rejects.toThrow("arguments_invalid");
      const unbound = new PaperclipRunnerToolAuthority(db, {
        ...binding,
        workspaceRoot,
      });
      await expect(
        unbound.execute({
          tool: "read_chat_attachment",
          callId: "read-no-scope",
          arguments: selection(),
        }),
      ).rejects.toThrow("scope_unavailable");
    } finally {
      await reader.close();
      await db
        .update(assets)
        .set({ byteSize: asset!.byteSize, sha256: asset!.sha256 })
        .where(eq(assets.id, asset!.id));
    }
  });

  it("stages image bytes exactly, without interpreting them as text", async () => {
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    const [attachment] = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.id, sourceAttachmentId));
    const [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, attachment!.assetId));
    const reader = scope({
      storage: {
        ...storage,
        getObject: async (...args) => {
          const object = await storage.getObject(...args);
          object.stream.destroy();
          return { ...object, stream: Readable.from(imageBytes) };
        },
      },
    });
    await db
      .update(assets)
      .set({
        byteSize: imageBytes.length,
        sha256: createHash("sha256").update(imageBytes).digest("hex"),
        contentType: "image/png",
        originalFilename: "pixel.png",
      })
      .where(eq(assets.id, asset!.id));
    try {
      const result = await reader.read(selection());
      expect(result).toMatchObject({
        contentType: "image/png",
        filename: "pixel.png",
      });
      expect(
        await readFile(path.join(workspaceRoot, result.workspaceRelativePath)),
      ).toEqual(imageBytes);
    } finally {
      await reader.close();
      await db
        .update(assets)
        .set({
          byteSize: asset!.byteSize,
          sha256: asset!.sha256,
          contentType: asset!.contentType,
          originalFilename: asset!.originalFilename,
        })
        .where(eq(assets.id, asset!.id));
    }
  });

  it("retries brief run-event lock contention without asking the model to retry", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .for("update");
      acquired();
      await blocked;
    });
    await ready;
    const reader = scope();
    const releaseTimer = setTimeout(release, 100);
    try {
      const result = await reader.read(selection());
      expect(
        await readFile(path.join(workspaceRoot, result.workspaceRelativePath)),
      ).toEqual(sourceBody);
      expect(result.selectedForPublication).toBe(false);
    } finally {
      clearTimeout(releaseTimer);
      release();
      await holder;
      await reader.close();
    }
  });

  it("rechecks policy after contention clears and rejects a revocation before reading bytes", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpointId))
        .for("update");
      acquired();
      await blocked;
      await tx
        .update(chatEndpoints)
        .set({ status: "paused" })
        .where(eq(chatEndpoints.id, endpointId));
    });
    await ready;
    const getObject = vi.fn(storage.getObject.bind(storage));
    const reader = scope({ storage: { ...storage, getObject } });
    const releaseTimer = setTimeout(release, 100);
    try {
      await expect(reader.read(selection())).rejects.toThrow(
        "read_not_authorized",
      );
      expect(getObject).not.toHaveBeenCalled();
    } finally {
      clearTimeout(releaseTimer);
      release();
      await holder;
      await reader.close();
      await db
        .update(chatEndpoints)
        .set({ status: "active" })
        .where(eq(chatEndpoints.id, endpointId));
    }
  });

  it("cancels an authorization retry without reading or staging bytes", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .for("update");
      acquired();
      await blocked;
    });
    await ready;
    const getObject = vi.fn(storage.getObject.bind(storage));
    const reader = scope({ storage: { ...storage, getObject } });
    const pending = expect(reader.read(selection())).rejects.toThrow(
      "scope_closed",
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await reader.close();
      await pending;
      expect(getObject).not.toHaveBeenCalled();
    } finally {
      release();
      await holder;
      await reader.close();
    }
  });

  it("bounds retries when policy locks remain contended", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpointId))
        .for("update");
      acquired();
      await blocked;
    });
    await ready;
    const reader = scope();
    try {
      await expect(reader.read(selection())).rejects.toThrow("read_busy");
    } finally {
      release();
      await holder;
      await reader.close();
    }
  });

  it("releases governance and source locks before staging filesystem bytes", async () => {
    const reader = scope();
    let checked = false;
    stagingControl.beforeStage = async () => {
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(issues)
          .where(eq(issues.id, issueId))
          .for("update", { noWait: true });
        await tx
          .select()
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpointId))
          .for("update", { noWait: true });
        await tx
          .select()
          .from(companyMemberships)
          .where(eq(companyMemberships.principalId, userId))
          .for("update", { noWait: true });
        await tx
          .select()
          .from(issueComments)
          .where(eq(issueComments.id, sourceCommentId))
          .for("update", { noWait: true });
        await tx
          .select()
          .from(issueAttachments)
          .where(eq(issueAttachments.id, sourceAttachmentId))
          .for("update", { noWait: true });
      });
      checked = true;
    };
    try {
      const result = await reader.read(selection());
      expect(checked).toBe(true);
      expect(
        await readFile(path.join(workspaceRoot, result.workspaceRelativePath)),
      ).toEqual(sourceBody);
    } finally {
      stagingControl.beforeStage = undefined;
      await reader.close();
    }
  });

  it.each([
    {
      originalFilename: null,
      contentType: "image/png",
      extension: "png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    },
    {
      originalFilename: "",
      contentType: "text/plain",
      extension: "txt",
      body: Buffer.from("unnamed historical text\n"),
    },
  ])(
    "lists, reads and prepares exact unnamed $contentType bytes without widening publication scope",
    async ({ originalFilename, contentType, extension, body }) => {
      const stored = await storage.putFile({
        companyId,
        namespace: `issues/${issueId}`,
        originalFilename,
        contentType,
        body,
      });
      const attachment = await issueService(db).createAttachment({
        issueId,
        issueCommentId: sourceCommentId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename,
        createdByUserId: userId,
      });
      const filename = `attachment-${attachment.id}.${extension}`;
      const reader = scope();
      const authority = new PaperclipRunnerToolAuthority(db, {
        ...binding,
        workspaceRoot,
        executionTargetKind: "local",
        storage,
        chatAttachmentReadScope: reader,
      });
      const publicationsBefore = await db.select().from(chatPublications);
      try {
        const listed = await authority.execute({
          tool: "list_chat_attachments",
          callId: `list-${attachment.id}`,
          arguments: {},
        });
        expect(listed).toMatchObject({
          attachments: expect.arrayContaining([
            expect.objectContaining({
              attachmentId: attachment.id,
              sourceCommentId,
              filename,
              contentType,
              byteSize: body.length,
              sha256: stored.sha256,
              contentAccess: "metadata_only",
            }),
          ]),
        });
        const result = (await authority.execute({
          tool: "read_chat_attachment",
          callId: `read-${attachment.id}`,
          arguments: { sourceCommentId, attachmentId: attachment.id },
        })) as { workspaceRelativePath: string };
        expect(result).toMatchObject({
          filename,
          contentType,
          selectedForPublication: false,
        });
        expect(
          await readFile(
            path.join(workspaceRoot, result.workspaceRelativePath),
          ),
        ).toEqual(body);
        const reused = (await authority.execute({
          tool: "reuse_chat_attachment",
          callId: `reuse-${attachment.id}`,
          arguments: {
            sourceCommentId,
            attachmentId: attachment.id,
            idempotencyKey: `unnamed-${attachment.id}`,
            title: "Exact earlier attachment",
          },
        })) as { prepared: { attachmentId: string; sha256: string } };
        expect(reused).toMatchObject({
          disposition: "applied",
          source: { attachmentId: attachment.id, commentId: sourceCommentId },
          prepared: { sha256: stored.sha256 },
        });
        const [prepared] = await db
          .select({
            filename: assets.originalFilename,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            sha256: assets.sha256,
            originatingRunId: issueAttachments.originatingRunId,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
          .where(eq(issueAttachments.id, reused.prepared.attachmentId));
        expect(prepared).toMatchObject({
          filename,
          contentType,
          sha256: stored.sha256,
          originatingRunId: runId,
        });
        const object = await storage.getObject(companyId, prepared!.objectKey);
        const chunks: Buffer[] = [];
        for await (const chunk of object.stream)
          chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(body);
        expect(await db.select().from(chatPublications)).toEqual(
          publicationsBefore,
        );
        // Lack of a filename does not make a private same-task asset lineaged.
        await db
          .update(issueAttachments)
          .set({ issueCommentId: null })
          .where(eq(issueAttachments.id, attachment.id));
        await expect(
          reader.read({ sourceCommentId, attachmentId: attachment.id }),
        ).rejects.toThrow("source_denied");
      } finally {
        await reader.close();
      }
    },
  );

  it("clears a file staged while cancellation is settling and never returns its path", async () => {
    const reader = scope();
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stagedPath: string | undefined;
    stagingControl.beforeStage = async () => {
      ready();
      await blocked;
    };
    stagingControl.afterStage = (relativePath) => {
      stagedPath = path.join(workspaceRoot, relativePath);
    };
    const rejected = expect(reader.read(selection())).rejects.toThrow(
      "scope_closed",
    );
    try {
      await entered;
      const closing = reader.close();
      release();
      await rejected;
      await closing;
      expect(stagedPath).toBeDefined();
      expect((await stat(stagedPath!)).size).toBe(0);
    } finally {
      release();
      stagingControl.beforeStage = undefined;
      stagingControl.afterStage = undefined;
      await reader.close();
    }
  });
});
