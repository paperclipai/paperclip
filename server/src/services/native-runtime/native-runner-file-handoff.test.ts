import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  link,
  mkdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activityLog,
  agents,
  assets,
  companies,
  createDb,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";

import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import type { StorageService } from "../../storage/types.js";
import { issueService } from "../issues.js";
import {
  renderNativeRunnerStagedAttachmentPrompt,
  stageNativeRunnerWakeAttachments,
} from "./native-runner-file-handoff.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("native runner file handoff", () => {
  let temporary: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let db: ReturnType<typeof createDb>;
  let temporaryRoot: string;
  let workspaceRoot: string;
  let storageRoot: string;

  const companyId = "00000000-0000-4000-8000-000000009101";
  const agentId = "00000000-0000-4000-8000-000000009102";
  const issueId = "00000000-0000-4000-8000-000000009103";
  const runId = "00000000-0000-4000-8000-000000009104";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase(
      "native-runner-file-handoff-",
    );
    db = createDb(temporary.connectionString);
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "paperclip-native-file-handoff-"),
    );
    workspaceRoot = path.join(temporaryRoot, "workspace");
    storageRoot = path.join(temporaryRoot, "storage");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(storageRoot, { recursive: true });
    await db.insert(companies).values({
      id: companyId,
      name: "Native file handoff",
      issuePrefix: "NFH",
      issueCounter: 1,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native file agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "NFH-1",
      title: "Prepare a requested file",
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
      contextSnapshot: { issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  function authority(
    overrides: Partial<{
      companyId: string;
      executionTargetKind: "local" | "remote";
    }> = {},
  ) {
    return new PaperclipRunnerToolAuthority(db, {
      companyId: overrides.companyId ?? companyId,
      agentId,
      issueId,
      runId,
      workspaceRoot,
      executionTargetKind: overrides.executionTargetKind ?? "local",
      storage: createStorageService(
        createLocalDiskStorageProvider(storageRoot),
      ),
    });
  }

  function callFor(relativePath: string, body: Buffer, idempotencyKey: string) {
    return {
      tool: "register_deliverable",
      callId: `call-${idempotencyKey}`,
      arguments: {
        idempotencyKey,
        filename: "answer.txt",
        contentType: "text/plain",
        byteSize: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        contentRef: relativePath,
        title: "Requested answer",
      },
    };
  }

  async function createInboundAttachmentFixture(input: {
    storage: StorageService;
    filename: string;
    body: Buffer;
    commentBody: string;
  }) {
    const stored = await input.storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: input.filename,
      contentType: "text/plain",
      body: input.body,
    });
    const comment = await issueService(db).addComment(
      issueId,
      input.commentBody,
      { userId: "inbound-user" },
    );
    const attachment = await issueService(db).createAttachment({
      issueId,
      issueCommentId: comment.id,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByUserId: "inbound-user",
    });
    return { attachment, comment, stored };
  }

  it("prepares one verified same-run attachment and replays without duplicates", async () => {
    const body = Buffer.from("native runner file handoff\n", "utf8");
    await mkdir(path.join(workspaceRoot, "out"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "out", "answer.txt"), body);
    const runner = authority();
    const definition = runner
      .definitions()
      .find((entry) => entry.name === "register_deliverable");
    expect(definition).toMatchObject({
      description: expect.stringContaining(
        "does not confirm provider delivery",
      ),
      inputSchema: {
        properties: {
          filename: {
            description: expect.stringContaining("Directory components"),
          },
          byteSize: { minimum: 1, maximum: 10 * 1024 * 1024 },
          contentRef: {
            description: expect.stringContaining("Workspace-relative"),
          },
        },
      },
    });

    const call = callFor("out/answer.txt", body, "requested-answer-v1");
    const first = (await runner.execute(call)) as {
      entityRefs: string[];
    } & Record<string, unknown>;
    const replay = await runner.execute({ ...call, callId: "replay-same-key" });
    const replayWithNewKey = await runner.execute({
      ...call,
      callId: "replay-new-key",
      arguments: { ...call.arguments, idempotencyKey: "requested-answer-v2" },
    });

    expect(first).toMatchObject({
      commandId: expect.stringMatching(/^deliverable-prepared:/u),
      disposition: "applied",
      stateRevision: 0,
      entityRefs: [expect.any(String), expect.any(String), expect.any(String)],
      scheduledWakeIds: [],
    });
    expect(replay).toEqual(first);
    expect(replayWithNewKey).toMatchObject({
      disposition: "duplicate",
      entityRefs: first.entityRefs,
    });

    const attachmentRows = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, issueId));
    expect(attachmentRows).toHaveLength(1);
    expect(attachmentRows[0]).toMatchObject({
      originatingRunId: runId,
      issueCommentId: expect.any(String),
    });
    await expect(
      db.select().from(assets).where(eq(assets.companyId, companyId)),
    ).resolves.toEqual([
      expect.objectContaining({
        createdByAgentId: agentId,
        originalFilename: "answer.txt",
        contentType: "text/plain",
        byteSize: body.length,
        sha256: call.arguments.sha256,
      }),
    ]);
    await expect(
      db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId)),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "artifact",
        provider: "paperclip",
        title: "Requested answer",
        createdByRunId: runId,
      }),
    ]);
    await expect(
      db.select().from(issueComments).where(eq(issueComments.issueId, issueId)),
    ).resolves.toEqual([
      expect.objectContaining({
        authorAgentId: agentId,
        createdByRunId: runId,
        body: "Prepared Requested answer for this response.",
        metadata: expect.objectContaining({
          authorizationReason: "paperclip_runner_protocol",
        }),
      }),
    ]);
    await expect(
      db.select().from(activityLog).where(eq(activityLog.entityId, issueId)),
    ).resolves.toEqual([
      expect.objectContaining({
        action: "issue.attachment_added",
        agentId,
        runId,
        details: expect.objectContaining({
          attachmentId: first.entityRefs[0],
          workProductId: first.entityRefs[1],
          commentId: first.entityRefs[2],
          source: "paperclip_runner_protocol",
        }),
      }),
    ]);
  });

  it("fails closed for remote targets, symlinks, traversal, hash drift, and foreign bindings", async () => {
    const body = Buffer.from("untrusted path checks\n", "utf8");
    await writeFile(path.join(workspaceRoot, "checked.txt"), body);
    await symlink(
      path.join(workspaceRoot, "checked.txt"),
      path.join(workspaceRoot, "linked.txt"),
    );
    await mkdir(path.join(workspaceRoot, "real-directory"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspaceRoot, "real-directory", "nested.txt"),
      body,
    );
    await symlink(
      path.join(workspaceRoot, "real-directory"),
      path.join(workspaceRoot, "linked-directory"),
    );
    await writeFile(path.join(workspaceRoot, "hardlink-origin.txt"), body);
    await link(
      path.join(workspaceRoot, "hardlink-origin.txt"),
      path.join(workspaceRoot, "hardlinked.txt"),
    );

    await expect(
      authority({ executionTargetKind: "remote" }).execute(
        callFor("checked.txt", body, "remote-denied"),
      ),
    ).rejects.toThrow("paperclip_runner_file_handoff_remote_unsupported");
    await expect(
      authority().execute(callFor("linked.txt", body, "symlink-denied")),
    ).rejects.toThrow("paperclip_runner_file_handoff_symlink_denied");
    await expect(
      authority().execute(
        callFor(
          "linked-directory/nested.txt",
          body,
          "intermediate-symlink-denied",
        ),
      ),
    ).rejects.toThrow("paperclip_runner_file_handoff_symlink_denied");
    await expect(
      authority().execute(callFor("hardlinked.txt", body, "hardlink-denied")),
    ).rejects.toThrow("paperclip_runner_file_handoff_file_changed");
    await expect(
      authority().execute(callFor("../checked.txt", body, "traversal-denied")),
    ).rejects.toThrow("paperclip_runner_file_handoff_path_denied");
    await expect(
      authority().execute({
        ...callFor("checked.txt", body, "hash-denied"),
        arguments: {
          ...callFor("checked.txt", body, "hash-denied").arguments,
          sha256: "0".repeat(64),
        },
      }),
    ).rejects.toThrow("paperclip_runner_file_handoff_hash_mismatch");
    await expect(
      authority({ companyId: "00000000-0000-4000-8000-000000009999" }).execute(
        callFor("checked.txt", body, "foreign-denied"),
      ),
    ).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
  });

  it("stages only exact wake-bound inbound bytes without exposing an API credential", async () => {
    const storage = createStorageService(
      createLocalDiskStorageProvider(storageRoot),
    );
    const body = Buffer.from(
      "inspect these authenticated inbound bytes\n",
      "utf8",
    );
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: "inbound.txt",
      contentType: "text/plain",
      body,
    });
    const comment = await issueService(db).addComment(
      issueId,
      "Please inspect the attached file.",
      { userId: "inbound-user" },
    );
    const attachment = await issueService(db).createAttachment({
      issueId,
      issueCommentId: comment.id,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByUserId: "inbound-user",
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          paperclipWake: {
            comments: [
              {
                id: comment.id,
                body: "Please inspect the attached file.",
                attachments: [
                  {
                    id: attachment.id,
                    filename: "inbound.txt",
                    contentType: "text/plain",
                    byteSize: body.length,
                    contentPath: `/api/attachments/${attachment.id}/content`,
                  },
                ],
              },
            ],
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const stage = await stageNativeRunnerWakeAttachments({
      db,
      binding: {
        companyId,
        issueId,
        runId,
        agentId,
        workspaceRoot,
        executionTargetKind: "local",
      },
      storage,
    });
    expect(stage.attachments).toEqual([
      {
        id: attachment.id,
        filename: "inbound.txt",
        contentType: "text/plain",
        byteSize: body.length,
        workspaceRelativePath: expect.stringMatching(
          /^\.paperclip-inbound\/.+\/[0-9a-f-]{36}$/u,
        ),
        unavailableReason: null,
      },
    ]);
    const relativePath = stage.attachments[0]?.workspaceRelativePath;
    expect(relativePath).toBeTruthy();
    await expect(
      readFile(path.join(workspaceRoot, relativePath!)),
    ).resolves.toEqual(body);
    const concurrentStage = await stageNativeRunnerWakeAttachments({
      db,
      binding: {
        companyId,
        issueId,
        runId,
        agentId,
        workspaceRoot,
        executionTargetKind: "local",
      },
      storage,
    });
    expect(concurrentStage.attachments[0]?.workspaceRelativePath).not.toBe(
      relativePath,
    );
    await expect(
      readFile(path.join(workspaceRoot, relativePath!)),
    ).resolves.toEqual(body);
    await concurrentStage.cleanup();

    const liveOwner = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1_000)"],
      { stdio: "ignore" },
    );
    await once(liveOwner, "spawn");
    if (!liveOwner.pid) throw new Error("live staging owner did not start");
    try {
      const liveForeignDirectory = path.join(
        workspaceRoot,
        ".paperclip-inbound",
        `process-${liveOwner.pid}-unknown-00000000-0000-4000-8000-000000009298`,
      );
      const liveForeignFile = path.join(liveForeignDirectory, "active-slot");
      await mkdir(liveForeignDirectory, { recursive: true });
      await writeFile(liveForeignFile, "bytes owned by another live process");
      const crossProcessStage = await stageNativeRunnerWakeAttachments({
        db,
        binding: {
          companyId,
          issueId,
          runId,
          agentId,
          workspaceRoot,
          executionTargetKind: "local",
        },
        storage,
      });
      await expect(readFile(liveForeignFile, "utf8")).resolves.toBe(
        "bytes owned by another live process",
      );
      await crossProcessStage.cleanup();

      const recycledOwnerDirectory = path.join(
        workspaceRoot,
        ".paperclip-inbound",
        `process-${liveOwner.pid}-0-00000000-0000-4000-8000-000000009297`,
      );
      const recycledOwnerFile = path.join(recycledOwnerDirectory, "stale-slot");
      await mkdir(recycledOwnerDirectory, { recursive: true });
      await writeFile(recycledOwnerFile, "bytes from a recycled pid owner");
      const recycledOwnerStage = await stageNativeRunnerWakeAttachments({
        db,
        binding: {
          companyId,
          issueId,
          runId,
          agentId,
          workspaceRoot,
          executionTargetKind: "local",
        },
        storage,
      });
      await expect(readFile(recycledOwnerFile)).resolves.toEqual(
        Buffer.alloc(0),
      );
      await recycledOwnerStage.cleanup();
    } finally {
      liveOwner.kill("SIGTERM");
      await once(liveOwner, "exit");
    }

    const prompt = renderNativeRunnerStagedAttachmentPrompt(stage.attachments);
    expect(prompt).toContain(
      "Never substitute an older generated workspace file",
    );
    expect(prompt).toContain(relativePath!);
    expect(prompt).not.toContain("/api/attachments/");
    expect(prompt).not.toContain("PAPERCLIP_API_KEY");
    await stage.cleanup();
    await expect(
      readFile(path.join(workspaceRoot, relativePath!)),
    ).resolves.toEqual(Buffer.alloc(0));

    const crashDirectory = path.join(
      workspaceRoot,
      ".paperclip-inbound",
      "process-2147483647-0-00000000-0000-4000-8000-000000009299",
    );
    await mkdir(crashDirectory, { recursive: true });
    const outsideResidue = path.join(temporaryRoot, "outside-residue.txt");
    const linkedResidue = path.join(crashDirectory, "linked-residue");
    await writeFile(outsideResidue, "outside bytes must remain intact");
    await symlink(outsideResidue, linkedResidue);
    await expect(
      stageNativeRunnerWakeAttachments({
        db,
        binding: {
          companyId,
          issueId,
          runId,
          agentId,
          workspaceRoot,
          executionTargetKind: "local",
        },
        storage,
      }),
    ).rejects.toThrow("paperclip_runner_attachment_staging_residue_denied");
    await expect(readFile(outsideResidue, "utf8")).resolves.toBe(
      "outside bytes must remain intact",
    );
    await unlink(linkedResidue);

    const crashedResidue = path.join(crashDirectory, "opaque-residue");
    await writeFile(crashedResidue, "bytes retained by an abrupt prior crash");
    const recoveredStage = await stageNativeRunnerWakeAttachments({
      db,
      binding: {
        companyId,
        issueId,
        runId,
        agentId,
        workspaceRoot,
        executionTargetKind: "local",
      },
      storage,
    });
    await expect(readFile(crashedResidue)).resolves.toEqual(Buffer.alloc(0));
    await recoveredStage.cleanup();

    await expect(
      stageNativeRunnerWakeAttachments({
        db,
        binding: {
          companyId: "00000000-0000-4000-8000-000000009999",
          issueId,
          runId,
          agentId,
          workspaceRoot,
          executionTargetKind: "local",
        },
        storage,
      }),
    ).rejects.toThrow("paperclip_runner_attachment_staging_not_authorized");

    const remoteStage = await stageNativeRunnerWakeAttachments({
      db,
      binding: {
        companyId,
        issueId,
        runId,
        agentId,
        workspaceRoot: "/remote/workspace",
        executionTargetKind: "remote",
      },
      storage,
    });
    expect(remoteStage.attachments).toEqual([
      expect.objectContaining({
        id: attachment.id,
        workspaceRelativePath: null,
        unavailableReason: "remote_workspace_staging_unsupported",
      }),
    ]);
    await remoteStage.cleanup();
  });

  it("excludes an older same-issue attachment when the current wake selects a newer file", async () => {
    const storage = createStorageService(
      createLocalDiskStorageProvider(storageRoot),
    );
    const historicalBody = Buffer.from(
      "historical decoy marker: amber-larch-17\n",
      "utf8",
    );
    const currentBody = Buffer.from(
      "current wake marker: cobalt-sparrow-42\n",
      "utf8",
    );
    const historical = await createInboundAttachmentFixture({
      storage,
      filename: "historical.txt",
      body: historicalBody,
      commentBody: "An older attachment from this task.",
    });
    const current = await createInboundAttachmentFixture({
      storage,
      filename: "current.txt",
      body: currentBody,
      commentBody: "Inspect only the file attached to this turn.",
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          paperclipWake: {
            comments: [
              {
                id: current.comment.id,
                body: "Inspect only the file attached to this turn.",
                attachments: [
                  {
                    id: current.attachment.id,
                    filename: "current.txt",
                    contentType: "text/plain",
                    byteSize: currentBody.length,
                    contentPath: `/api/attachments/${current.attachment.id}/content`,
                  },
                ],
              },
            ],
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const objectReads: string[] = [];
    const observingStorage: StorageService = {
      ...storage,
      getObject: async (readCompanyId, objectKey, options) => {
        objectReads.push(objectKey);
        return storage.getObject(readCompanyId, objectKey, options);
      },
    };
    const stage = await stageNativeRunnerWakeAttachments({
      db,
      binding: {
        companyId,
        issueId,
        runId,
        agentId,
        workspaceRoot,
        executionTargetKind: "local",
      },
      storage: observingStorage,
    });

    expect(stage.attachments).toEqual([
      expect.objectContaining({
        id: current.attachment.id,
        filename: "current.txt",
        unavailableReason: null,
      }),
    ]);
    expect(objectReads).toEqual([current.stored.objectKey]);
    expect(objectReads).not.toContain(historical.stored.objectKey);
    const relativePath = stage.attachments[0]?.workspaceRelativePath;
    expect(relativePath).toBeTruthy();
    await expect(
      readFile(path.join(workspaceRoot, relativePath!)),
    ).resolves.toEqual(currentBody);
    await stage.cleanup();
  });

  it("stages no historical attachment when the current wake contains only an omission", async () => {
    const storage = createStorageService(
      createLocalDiskStorageProvider(storageRoot),
    );
    const historical = await createInboundAttachmentFixture({
      storage,
      filename: "omission-decoy.txt",
      body: Buffer.from(
        "never substitute this historical attachment\n",
        "utf8",
      ),
      commentBody: "Historical file that is not part of the current wake.",
    });
    const currentComment = await issueService(db).addComment(
      issueId,
      "Inspect the current attachment if Paperclip imported it.",
      { userId: "inbound-user" },
    );
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          paperclipWake: {
            comments: [
              {
                id: currentComment.id,
                body: "Inspect the current attachment if Paperclip imported it.",
                attachments: [],
              },
            ],
            attachmentOmissions: [
              {
                commentId: currentComment.id,
                reasons: { unsupported_type: 1 },
              },
            ],
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const objectReads: string[] = [];
    const observingStorage: StorageService = {
      ...storage,
      getObject: async (readCompanyId, objectKey, options) => {
        objectReads.push(objectKey);
        return storage.getObject(readCompanyId, objectKey, options);
      },
    };
    const stage = await stageNativeRunnerWakeAttachments({
      db,
      binding: {
        companyId,
        issueId,
        runId,
        agentId,
        workspaceRoot,
        executionTargetKind: "local",
      },
      storage: observingStorage,
    });

    expect(stage.attachments).toEqual([]);
    expect(objectReads).toEqual([]);
    expect(objectReads).not.toContain(historical.stored.objectKey);
    expect(renderNativeRunnerStagedAttachmentPrompt(stage.attachments)).toBe(
      "",
    );
    await stage.cleanup();
  });

  it("fails closed on a reminted work product and removes definite pre-commit storage failures", async () => {
    const [existingAttachment] = await db
      .select({ id: issueAttachments.id })
      .from(issueAttachments)
      .where(eq(issueAttachments.originatingRunId, runId))
      .limit(1);
    expect(existingAttachment).toBeDefined();
    await db
      .delete(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId));
    const foreignRunId = "00000000-0000-4000-8000-000000009105";
    await db.insert(heartbeatRuns).values({
      id: foreignRunId,
      companyId,
      agentId,
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: issueId,
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      externalId: existingAttachment!.id,
      title: "Reminted by another run",
      status: "active",
      reviewState: "none",
      isPrimary: false,
      healthStatus: "unknown",
      createdByRunId: foreignRunId,
    });
    const originalBody = Buffer.from("native runner file handoff\n", "utf8");
    await expect(
      authority().execute(
        callFor("out/answer.txt", originalBody, "reminted-work-product"),
      ),
    ).rejects.toThrow("paperclip_runner_file_handoff_work_product_missing");

    const failureBody = Buffer.from("storage mismatch cleanup\n", "utf8");
    await writeFile(path.join(workspaceRoot, "mismatch.txt"), failureBody);
    const realStorage = createStorageService(
      createLocalDiskStorageProvider(storageRoot),
    );
    let deletedObjectKey: string | null = null;
    const mismatchingStorage: StorageService = {
      ...realStorage,
      putFile: async (input) => ({
        ...(await realStorage.putFile(input)),
        sha256: "0".repeat(64),
      }),
      deleteObject: async (deleteCompanyId, objectKey) => {
        deletedObjectKey = objectKey;
        await realStorage.deleteObject(deleteCompanyId, objectKey);
      },
    };
    const mismatchingAuthority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
      workspaceRoot,
      executionTargetKind: "local",
      storage: mismatchingStorage,
    });
    await expect(
      mismatchingAuthority.execute(
        callFor("mismatch.txt", failureBody, "storage-mismatch"),
      ),
    ).rejects.toThrow("paperclip_runner_file_handoff_storage_mismatch");
    expect(deletedObjectKey).toEqual(expect.any(String));
    await expect(
      realStorage.headObject(companyId, deletedObjectKey!),
    ).resolves.toMatchObject({ exists: false });

    const receiptFailureBody = Buffer.from(
      "receipt persistence cleanup\n",
      "utf8",
    );
    await writeFile(
      path.join(workspaceRoot, "receipt-failure.txt"),
      receiptFailureBody,
    );
    let receiptFailureObjectKey: string | null = null;
    const receiptFailureStorage: StorageService = {
      ...realStorage,
      putFile: async (input) => {
        const stored = await realStorage.putFile(input);
        receiptFailureObjectKey = stored.objectKey;
        return stored;
      },
      deleteObject: async (deleteCompanyId, objectKey) => {
        await realStorage.deleteObject(deleteCompanyId, objectKey);
      },
    };
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION paperclip_test_fail_native_receipt()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.result_json IS DISTINCT FROM OLD.result_json THEN
          RAISE EXCEPTION 'forced_native_receipt_failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await db.execute(sql`
      CREATE TRIGGER paperclip_test_fail_native_receipt
      BEFORE UPDATE ON heartbeat_runs
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_fail_native_receipt()
    `);
    try {
      const receiptFailureAuthority = new PaperclipRunnerToolAuthority(db, {
        companyId,
        agentId,
        issueId,
        runId,
        workspaceRoot,
        executionTargetKind: "local",
        storage: receiptFailureStorage,
      });
      let receiptFailure: unknown;
      try {
        await receiptFailureAuthority.execute(
          callFor(
            "receipt-failure.txt",
            receiptFailureBody,
            "receipt-persistence-failure",
          ),
        );
      } catch (error) {
        receiptFailure = error;
      }
      expect(receiptFailure).toMatchObject({
        message: expect.stringContaining(
          'Failed query: update "heartbeat_runs"',
        ),
        cause: {
          message: expect.stringContaining("forced_native_receipt_failure"),
        },
      });
    } finally {
      await db.execute(
        sql`DROP TRIGGER IF EXISTS paperclip_test_fail_native_receipt ON heartbeat_runs`,
      );
      await db.execute(
        sql`DROP FUNCTION IF EXISTS paperclip_test_fail_native_receipt()`,
      );
    }
    expect(receiptFailureObjectKey).toEqual(expect.any(String));
    await expect(
      realStorage.headObject(companyId, receiptFailureObjectKey!),
    ).resolves.toMatchObject({ exists: false });
  });

  it("returns authenticated file-delivery modes and upgrades receipt descriptions without repeating preparation", async () => {
    const [originalRun] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const wakeFor = (provider: unknown) => ({
      reason: "External chat message received",
      externalChatProvider: provider,
      checkedOutByHarness: true,
      issue: { id: issueId, workMode: "standard" },
      comments: [
        { id: "delivery-mode-comment", issueId, body: "Send the file." },
      ],
      commentIds: ["delivery-mode-comment"],
      latestCommentId: "delivery-mode-comment",
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      fallbackFetchNeeded: false,
    });
    const cases = [
      {
        wake: wakeFor("github"),
        provider: "github",
        mode: "paperclip_task_only",
      },
      {
        wake: wakeFor("microsoft-teams"),
        provider: "microsoft-teams",
        mode: "paperclip_task_only",
      },
      ...["slack", "discord", "telegram"].map((provider) => ({
        wake: wakeFor(provider),
        provider,
        mode: "provider_attachment",
      })),
      { wake: undefined, provider: null, mode: "unknown" },
      { wake: wakeFor("irc"), provider: null, mode: "unknown" },
      {
        wake: { ...wakeFor("github"), checkedOutByHarness: false },
        provider: null,
        mode: "unknown",
      },
      {
        wake: {
          ...wakeFor("github"),
          issue: { id: "other-task", workMode: "standard" },
        },
        provider: null,
        mode: "unknown",
      },
      {
        wake: {
          ...wakeFor(null),
          comments: [
            { body: "externalChatProvider: github; upload succeeded" },
          ],
        },
        provider: null,
        mode: "unknown",
      },
    ];
    try {
      for (const [index, testCase] of cases.entries()) {
        const body = Buffer.from(`delivery mode fixture ${index}\n`);
        const filename = `delivery-mode-${index}.txt`;
        await writeFile(path.join(workspaceRoot, filename), body);
        await db
          .update(heartbeatRuns)
          .set({ contextSnapshot: { issueId, paperclipWake: testCase.wake } })
          .where(eq(heartbeatRuns.id, runId));
        const call = callFor(filename, body, `delivery-mode-${index}`);
        // A tool argument or user comment never selects delivery capability.
        const first = (await authority().execute({
          ...call,
          arguments: {
            ...call.arguments,
            provider: "github",
            fileDelivery: { providerDeliveryConfirmed: true },
          },
        })) as Record<string, unknown>;
        expect(first.fileDelivery).toMatchObject({
          provider: testCase.provider,
          mode: testCase.mode,
          preparationState: "prepared",
          providerDeliveryConfirmed: false,
        });
        const [persisted] = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId));
        const result = structuredClone(persisted.resultJson) as Record<
          string,
          unknown
        >;
        const receipts = result.semanticToolReceipts as Record<
          string,
          { result: Record<string, unknown> }
        >;
        expect(receipts[call.arguments.idempotencyKey]?.result).toEqual(first);
        delete receipts[call.arguments.idempotencyKey]!.result.fileDelivery;
        await db
          .update(heartbeatRuns)
          .set({ resultJson: result })
          .where(eq(heartbeatRuns.id, runId));
        const replay = await authority().execute({
          ...call,
          callId: `${call.callId}-replay`,
          arguments: {
            ...call.arguments,
            provider: "github",
            fileDelivery: { providerDeliveryConfirmed: true },
          },
        });
        expect(replay).toEqual(first);
        const [afterReplay] = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId));
        expect(afterReplay.resultJson).toEqual(result);
      }
    } finally {
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: originalRun.contextSnapshot })
        .where(eq(heartbeatRuns.id, runId));
    }
  });
});
