import { assertTaskWorkspaceExecutionAccess } from "./task-workspace-access.js";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { and, asc, eq } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, projectWorkspaces, workspaceOperations, type Db } from "@paperclipai/db";
import { freshWorkspaceSchema, type PluginFreshWorkspace } from "@paperclipai/plugin-sdk";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { getStorageService } from "../storage/index.js";
import { recoveryRunAncestry } from "./recovery-run-ancestry.js";
import { readSnapshot } from "./workspace-recovery-snapshot.js";
import { conflict, forbidden } from "../errors.js";
import { notifyTerminalWorkspaceWork } from "./terminal-workspace-work.js";
import { SystemRecoveryFailure } from "./system-recovery-state.js";

export async function stageProviderFreshWorkspace(input: {
  db: Db; companyId: string; issueId: string; attemptId: string; sourceRunId: string;
  previousWorkspaceId: string | null; existing?: PluginFreshWorkspace;
}): Promise<PluginFreshWorkspace> {
  const fresh: PluginFreshWorkspace = freshWorkspaceSchema.parse({ attemptId: input.attemptId,
    sourceRunId: input.sourceRunId, previousWorkspaceId: input.previousWorkspaceId, recoverySnapshots: [] });
  if (input.existing?.recoverySnapshots.length === 0) return freshWorkspaceSchema.parse(input.existing);
  const storage = getStorageService();
  const sources = await recoveryRunAncestry({ ...input, sourceRunIds: [input.sourceRunId] });
  const stagingRoot = path.join(resolvePaperclipInstanceRoot(), "runtime", "provider-recovery", input.companyId, fresh.attemptId);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(stagingRoot);
  for (const { id: sourceRunId } of sources) {
    const operations = await input.db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.issueId, input.issueId),
      eq(workspaceOperations.heartbeatRunId, sourceRunId), eq(workspaceOperations.phase, "workspace_recovery_snapshot"),
      eq(workspaceOperations.status, "succeeded")));
    for (const operation of operations) {
      if (input.existing && !input.existing.recoverySnapshots.some(snapshot => snapshot.operationId === operation.id)) continue;
      const saved = readSnapshot(operation.metadata, input.companyId, sourceRunId);
      const directory = path.join(root, operation.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await realpath(directory) !== directory) throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
      const files = {} as Pick<PluginFreshWorkspace["recoverySnapshots"][number], "archive" | "manifest">;
      for (const kind of ["archive", "manifest"] as const) {
        const expected = saved[kind];
        const destination = path.join(directory, `${expected.sha256}.${kind === "archive" ? "tar" : "jsonl"}`);
        const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (existing && (!existing.isFile() || existing.isSymbolicLink()))
          throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
        if (!existing) {
          const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
          const object = await storage.getObject(input.companyId, expected.objectKey);
          try {
            let received = 0;
            const bounded = new Transform({ transform(bytes, _encoding, callback) {
              received += bytes.length;
              callback(received > expected.byteSize ? new SystemRecoveryFailure("snapshot_verification_failed", "service_required") : null, bytes);
            } });
            await pipeline(object.stream, bounded, createWriteStream(temporary, { flags: "wx", mode: 0o400 }));
            await verify(temporary, expected);
            await rename(temporary, destination);
          } finally { object.stream.destroy(); await rm(temporary, { force: true }); }
        }
        await verify(destination, expected);
        files[kind] = { path: destination, sha256: expected.sha256, byteSize: expected.byteSize };
      }
      fresh.recoverySnapshots.push({ operationId: operation.id, sourceRunId, ...files });
    }
  }
  fresh.recoverySnapshots.sort((a, b) => a.operationId.localeCompare(b.operationId));
  if (input.existing && !isDeepStrictEqual(fresh, input.existing))
    throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
  return fresh;
}

async function verify(file: string, expected: { sha256: string; byteSize: number }) {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const bytes of createReadStream(file)) {
    byteSize += bytes.length;
    if (byteSize > expected.byteSize) throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
    hash.update(bytes);
  }
  if (byteSize !== expected.byteSize || hash.digest("hex") !== expected.sha256)
    throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
}

export async function reserveFreshPluginTaskWorkspace(input: {
  db: Db; companyId: string; issueId: string; runId: string; agentId: string; responsibleUserId: string | null;
  fresh: PluginFreshWorkspace; expectedBindingRevision: number;
  owner: Record<string, unknown>;
  source?: { projectId: string | null; projectWorkspaceId: string | null; repoUrl: string | null; baseRef: string | null };
}) {
  const source = input.source ?? { projectId: null, projectWorkspaceId: null, repoUrl: null, baseRef: null };
  return input.db.transaction(async tx => {
    const [task] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId)));
    if (!task || !run || run.agentId !== input.agentId || run.status !== "running" ||
        ![run.issueId, run.nativeIssueId].includes(input.issueId)) throw forbidden("Workspace preparation no longer has an active run");
    const actor = { type: "agent" as const, source: "agent_jwt" as const,
      companyId: input.companyId, agentId: input.agentId, runId: input.runId,
      onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId };
    if (!task.projectWorkspaceId && task.projectId && task.projectId === source.projectId && source.projectWorkspaceId) {
      await assertTaskWorkspaceExecutionAccess(tx, actor, input.companyId, { issueId: input.issueId });
      const [defaultSource] = await tx.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(and(
        eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, task.projectId)))
        .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id)).limit(1);
      if (defaultSource?.id === source.projectWorkspaceId) await tx.update(issues).set({ projectWorkspaceId: defaultSource.id })
        .where(eq(issues.id, task.id));
    }
    await assertTaskWorkspaceExecutionAccess(tx, actor, input.companyId, {
      issueId: input.issueId, projectWorkspaceId: source.projectWorkspaceId });
    const [reserved] = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.sourceIssueId, input.issueId),
      eq(executionWorkspaces.id, input.fresh.attemptId)));
    if (reserved) {
      if (task.executionWorkspaceId !== reserved.id || reserved.providerType !== "adapter_managed" ||
          !isDeepStrictEqual(reserved.metadata?.runnerTaskFreshWorkspace, input.fresh) ||
          !isDeepStrictEqual(reserved.metadata?.runnerTaskWorkspaceOwner, input.owner) ||
          Object.entries(source).some(([key, value]) => reserved[key as keyof typeof source] !== value))
        throw conflict("Task workspace binding changed; retry preparation");
      return reserved.id;
    }
    if (task.executionWorkspaceId !== input.fresh.previousWorkspaceId || task.workspaceBindingRevision !== input.expectedBindingRevision)
      throw conflict("Task workspace binding changed; retry preparation");
    await notifyTerminalWorkspaceWork(tx, `workspace:${input.fresh.attemptId}`);
    await tx.insert(executionWorkspaces).values({ id: input.fresh.attemptId,
      companyId: input.companyId, sourceIssueId: input.issueId, ...source,
      mode: "isolated_workspace", strategyType: "project_primary", name: "Fresh task workspace", status: "active",
      providerType: "adapter_managed", cwd: `/workspaces/${input.fresh.attemptId}`,
      metadata: { runnerTaskFreshWorkspace: input.fresh, runnerTaskWorkspaceOwner: input.owner },
    });
    await tx.update(issues).set({ executionWorkspaceId: input.fresh.attemptId, executionWorkspacePreference: "reuse_existing",
      workspaceBindingRevision: task.workspaceBindingRevision + 1,
      workspacePendingSelection: task.workspacePendingSelection?.expectedBindingRevision === task.workspaceBindingRevision
        ? { ...task.workspacePendingSelection, expectedBindingRevision: task.workspaceBindingRevision + 1 } : task.workspacePendingSelection, updatedAt: new Date() }).where(eq(issues.id, task.id));
    return input.fresh.attemptId;
  });
}

export async function releaseProviderRecoveryTransfers(companyId: string, input: PluginFreshWorkspace) {
  const fresh = freshWorkspaceSchema.parse(input);
  await rm(path.join(resolvePaperclipInstanceRoot(), "runtime", "provider-recovery", companyId, fresh.attemptId),
    { recursive: true, force: true });
}
