import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { stageNativeRunnerAttachmentBytes } from "./native-runner-file-handoff.js";
import {
  findNativeChatWorkspaceScope,
  materializeNativeChatTaskRoot,
  nativeChatWorkspaceCwd,
  nativeChatWorkspaceMatches,
  type NativeChatWorkspaceScope,
} from "./native-chat-workspace.js";

describe("native external chat workspace boundary", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let instanceRoot: string;
  const companyId = "01000000-0000-4000-8000-000000000001";
  const agentId = "01000000-0000-4000-8000-000000000002";
  const issueA = "01000000-0000-4000-8000-000000000003";
  const issueB = "01000000-0000-4000-8000-000000000004";
  const boardIssue = "01000000-0000-4000-8000-000000000005";
  const runB = "01000000-0000-4000-8000-000000000006";
  const scopeInput = (issueId: string) => ({
    adapterType: "paperclip_runner",
    environmentDriver: "local",
    companyId,
    agentId,
    issueId,
    instanceRoot,
  });
  let scopeA: NativeChatWorkspaceScope;
  let scopeB: NativeChatWorkspaceScope;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase(
      "native-chat-workspace-",
    );
    db = createDb(temporary.connectionString);
    instanceRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "native-chat-workspace-")),
    );
    await db.insert(companies).values({
      id: companyId,
      name: "Chat workspaces",
      issuePrefix: "NCW",
      issueCounter: 3,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native agent",
      adapterType: "paperclip_runner",
      status: "active",
    });
    await db.insert(issues).values(
      [issueA, issueB, boardIssue].map((id, index) => ({
        id,
        companyId,
        issueNumber: index + 1,
        identifier: `NCW-${index + 1}`,
        title: "Workspace boundary",
        status: "in_progress",
        assigneeAgentId: agentId,
        originKind: id === boardIssue ? "manual" : "chat_channel",
      })),
    );
    await db.insert(heartbeatRuns).values({
      id: runB,
      companyId,
      agentId,
      nativeIssueId: issueB,
      runtimeMode: "native",
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId: issueB },
    });
    await db
      .update(issues)
      .set({ executionRunId: runB })
      .where(eq(issues.id, issueB));
    scopeA = (await findNativeChatWorkspaceScope(db, scopeInput(issueA)))!;
    scopeB = (await findNativeChatWorkspaceScope(db, scopeInput(issueB)))!;
  });

  afterAll(async () => {
    try {
      await temporary?.cleanup();
    } finally {
      if (instanceRoot)
        await rm(instanceRoot, { recursive: true, force: true });
    }
  });

  it("uses distinct sibling task roots for one agent, stable across turns, outside the legacy agent home", async () => {
    const legacy = path.join(instanceRoot, "workspaces", agentId);
    await mkdir(legacy, { recursive: true });
    await writeFile(
      path.join(legacy, "old-private.txt"),
      "legacy task fixture",
    );
    const [rootA, rootB] = await Promise.all([
      materializeNativeChatTaskRoot(scopeA),
      materializeNativeChatTaskRoot(scopeB),
    ]);
    expect(rootA).not.toBe(rootB);
    expect(path.relative(rootA, rootB)).toBe(`../${issueB}`);
    expect(path.relative(legacy, rootA).startsWith("..")).toBe(true);
    expect(await readdir(rootA)).toEqual([]);
    expect(await readdir(rootB)).toEqual([]);
    await writeFile(
      path.join(rootA, "same-task.txt"),
      "same task continuation",
    );
    const resumedScope = (await findNativeChatWorkspaceScope(
      db,
      scopeInput(issueA),
    ))!;
    expect(await materializeNativeChatTaskRoot(resumedScope)).toBe(rootA);
    expect(await readFile(path.join(rootA, "same-task.txt"), "utf8")).toBe(
      "same task continuation",
    );
    expect(await readFile(path.join(legacy, "old-private.txt"), "utf8")).toBe(
      "legacy task fixture",
    );
  });

  it("leaves ordinary Board tasks, legacy adapters, and remote sandbox realization unchanged", async () => {
    expect(
      await findNativeChatWorkspaceScope(db, scopeInput(boardIssue)),
    ).toBeNull();
    expect(
      await findNativeChatWorkspaceScope(db, {
        ...scopeInput(issueA),
        adapterType: "codex_local",
      }),
    ).toBeNull();
    expect(
      await findNativeChatWorkspaceScope(db, {
        ...scopeInput(issueA),
        environmentDriver: "sandbox",
      }),
    ).toBeNull();
    await expect(
      findNativeChatWorkspaceScope(db, {
        ...scopeInput(issueA),
        companyId: "01000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toThrow("native_chat_workspace_issue_unavailable");
  });

  it("does not expose another active task's staged inbound files or register its generated file", async () => {
    const [rootA, rootB] = await Promise.all([
      materializeNativeChatTaskRoot(scopeA),
      materializeNativeChatTaskRoot(scopeB),
    ]);
    const body = Buffer.from("only task A fixture bytes");
    const stages = await Promise.all([
      stageNativeRunnerAttachmentBytes({ workspaceRoot: rootA, body }),
      stageNativeRunnerAttachmentBytes({
        workspaceRoot: rootB,
        body: Buffer.from("only task B fixture bytes"),
      }),
    ]);
    try {
      await expect(
        readFile(path.join(rootB, stages[0]!.workspaceRelativePath)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path.join(rootA, "private-output.txt"), body);
      const authority = new PaperclipRunnerToolAuthority(db, {
        companyId,
        agentId,
        issueId: issueB,
        runId: runB,
        workspaceRoot: rootB,
        executionTargetKind: "local",
      });
      await expect(
        authority.execute({
          tool: "register_deliverable",
          callId: "foreign-generated-file",
          arguments: {
            idempotencyKey: "foreign-generated-file",
            filename: "private-output.txt",
            contentType: "text/plain",
            byteSize: body.length,
            sha256: createHash("sha256").update(body).digest("hex"),
            contentRef: path.relative(
              rootB,
              path.join(rootA, "private-output.txt"),
            ),
            title: "Foreign output",
          },
        }),
      ).rejects.toThrow("paperclip_runner_file_handoff_path_denied");
    } finally {
      await Promise.all(stages.map((stage) => stage.cleanup()));
    }
  });

  it("rejects shared or foreign project workspaces and honors only existing task-owned isolated worktrees", () => {
    const scope = { ...scopeA, projectId: "project-1" };
    const workspace = {
      companyId,
      projectId: "project-1",
      sourceIssueId: issueA,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      status: "active",
      cwd: "/task-owned-worktree",
      providerRef: "/task-owned-worktree",
    };
    expect(nativeChatWorkspaceCwd(scope, workspace, true)).toBe(workspace.cwd);
    expect(nativeChatWorkspaceCwd(scope, null, false)).toBeNull();
    for (const override of [
      { sourceIssueId: issueB },
      { companyId: "foreign" },
      { projectId: "foreign" },
      { mode: "shared_workspace" },
      { strategyType: "project_primary" },
      { status: "archived" },
      { providerRef: "/other" },
    ]) {
      expect(
        nativeChatWorkspaceCwd(scope, { ...workspace, ...override }, true),
      ).toBeNull();
    }
    expect(nativeChatWorkspaceCwd(scope, workspace, false)).toBeNull();
  });

  it("rejects an admitted legacy or other-task root without changing the immutable execution input", () => {
    const execution = {
      binding: { companyId, agentId, issueId: issueA },
      workspace: { cwd: scopeA.taskRoot },
    };
    expect(
      nativeChatWorkspaceMatches({
        scope: scopeA,
        expectedCwd: scopeA.taskRoot,
        execution,
      }),
    ).toBe(true);
    for (const cwd of [
      scopeB.taskRoot,
      path.join(instanceRoot, "workspaces", agentId),
    ]) {
      const oldInput = { ...execution, workspace: { cwd } };
      expect(
        nativeChatWorkspaceMatches({
          scope: scopeA,
          expectedCwd: scopeA.taskRoot,
          execution: oldInput,
        }),
      ).toBe(false);
      expect(oldInput.workspace.cwd).toBe(cwd);
    }
  });

  it("fails closed if an existing task directory is a symlink to another task", async () => {
    const target = {
      ...scopeA,
      issueId: "symlink-task",
      taskRoot: path.join(path.dirname(scopeA.taskRoot), "symlink-task"),
    };
    await symlink(scopeB.taskRoot, target.taskRoot);
    await expect(materializeNativeChatTaskRoot(target)).rejects.toThrow(
      "native_chat_workspace_path_not_isolated",
    );
  });
});
