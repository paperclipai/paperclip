import { measureSandboxOperation, measureSandboxStream, captureSandboxPerformanceContext } from "./sandbox-performance.js";
import { prefetchWorkFiles, WORK_FOLDER_PREFETCH_CONCURRENCY } from "./work-folder-transfer.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { managedAgentFiles } from "./work-folder-agent-import.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { agents, assets, companyMemberships, heartbeatRuns, issues, projects, issueAttachments, projectWorkspaces, taskRepositoryBindings, workFileOperations, workFolderRuns, workFolders, type Db } from "@paperclipai/db";
import { WORK_FOLDER_SCOPES, type SandboxWorkFolderManifest, type WorkFolderScope } from "@paperclipai/shared";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { StorageProvider } from "../storage/types.js";
import { loadConfig } from "../config.js";
import { logger } from "../middleware/logger.js";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import { workFolderService } from "./work-folders.js";
import { workFolderPaths, workFolderTransport, type WorkTreeEntry } from "./work-folder-transport.js";
import { workFolderRepositoryService } from "./work-folder-repositories.js";
import { startWorkFolderCheckpointer } from "./work-folder-checkpointer.js";
import { logActivity } from "./activity-log.js";
import { assertWorkFolderAccess } from "./work-folder-access.js";
import { WorkspaceRuntimeValidationFailure } from "./workspace-runtime.js";

function signature(entry: WorkTreeEntry | undefined) {
  return entry ? JSON.stringify([entry.kind, entry.sha256, entry.executable]) : "missing";
}
function repoName(value: string, id: string) {
  const name = value.replace(/\.git$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+/, "").slice(0, 80);
  return name || `repo-${id.slice(0, 8)}`;
}

/** Host-owned lifecycle; neither an adapter nor a sandbox can choose its owners. */
export async function prepareSandboxWorkFolders(input: {
  db: Db; companyId: string; runId: string; agentId: string; responsibleUserId: string | null;
  taskId: string | null; projectId: string | null; target: AdapterSandboxExecutionTarget;
  primaryWorkspaceId?: string | null; primaryBranchName?: string | null;
  storage?: StorageProvider; sandboxKey?: string;
}) {
  const runInRunContext = captureSandboxPerformanceContext();
  return measureSandboxOperation("work_folder.prepare", { phase: "prepare" }, async (prepareSpan) => {
    const { db, target, taskId, projectId, responsibleUserId } = input;
    if (!target.runner || !target.leaseId) throw new Error("Sandbox file transport is unavailable");
    async function assertBindings() {
      return measureSandboxOperation("work_folder.authorization", { operation: "validate_bindings" }, async () => {
        const memberships: Array<{ companyId: string; membershipRole: string | null; status: string }> = [];
        const deny = () => { throw new Error("Sandbox work-folder access is no longer authorized; working files were retained"); };
        const [run] = await measureSandboxOperation("work_folder.db.query", { operation: "select_heartbeat_runs", requestCount: 1 }, async () => (db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))));
        if (!run || run.agentId !== input.agentId || run.responsibleUserId !== responsibleUserId) deny();
        const [agent] = await measureSandboxOperation("work_folder.db.query", { operation: "select_agents", requestCount: 1 }, async () => (db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))));
        if (!agent) deny();
        if (taskId) {
          const [task] = await measureSandboxOperation("work_folder.db.query", { operation: "select_issues", requestCount: 1 }, async () => (db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, taskId), eq(issues.companyId, input.companyId)))));
          if (!task) deny();
        }
        if (projectId) {
          const [project] = await measureSandboxOperation("work_folder.db.query", { operation: "select_projects", requestCount: 1 }, async () => (db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, input.companyId)))));
          if (!project) deny();
        }
        if (responsibleUserId) {
          const [membership] = await measureSandboxOperation("work_folder.db.query", { operation: "select_company_memberships", requestCount: 1 }, async () => (db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, input.companyId),
            eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, responsibleUserId), eq(companyMemberships.status, "active")))));
          if (!membership || membership.membershipRole === "viewer") deny();
          if (membership) memberships.push({ companyId: membership.companyId, membershipRole: membership.membershipRole, status: membership.status });
        }
        for (const [scope, ownerId] of [["task", taskId], ["agent", input.agentId], ["project", projectId]] as const) {
          if (!ownerId) continue;
          await assertWorkFolderAccess(db, { type: "agent", source: "agent_jwt", companyId: input.companyId,
            agentId: input.agentId, runId: input.runId, onBehalfOfUserId: responsibleUserId, onBehalfOfMemberships: memberships },
          { companyId: input.companyId, scope, ownerId }, true);
        }
      });
    }
    // Host-side transfers do not go through HTTP authorization middleware. Check
    // the authoritative bindings here too, including after membership revocation.
    // An ended heartbeat may still flush; its immutable identity must still match.
    await assertBindings();
    const storage = input.storage ?? createStorageProviderFromConfig(loadConfig());
    const svc = workFolderService(db, storage);
    const transport = workFolderTransport(target.runner);
    const repositories = workFolderRepositoryService(db, storage, transport);
    const home = await transport.home();
    const paths = workFolderPaths(home);
    for (const value of Object.values(paths)) await transport.mkdirRoot(value);
    const staging = paths[".paperclip-work-folders"]!;
    const owners = { task: taskId, agent: input.agentId, user: responsibleUserId, project: projectId };
    const folders: Partial<Record<WorkFolderScope, typeof workFolders.$inferSelect>> = {};
    for (const scope of WORK_FOLDER_SCOPES) {
      const ownerId = owners[scope];
      if (ownerId) folders[scope] = await svc.ensure({ companyId: input.companyId, scope, ownerId });
    }
    const manifest: SandboxWorkFolderManifest = { version: 1, companyId: input.companyId, runId: input.runId,
      taskId: taskId, agentId: input.agentId, responsibleUserId: responsibleUserId,
      projectId: projectId, leaseId: target.leaseId, sandboxKey: input.sandboxKey ?? target.leaseId, home,
      folders: { task: folders.task?.id ?? null, agent: folders.agent!.id, user: folders.user?.id ?? null, project: folders.project?.id ?? null }, repositories: [] };
    const [previous] = await measureSandboxOperation("work_folder.history.sandbox", { operation: "select_work_folder_runs", requestCount: 1 }, async () => (db.select().from(workFolderRuns).where(and(eq(workFolderRuns.companyId, input.companyId),
      sql`coalesce(${workFolderRuns.manifest}->>'sandboxKey', ${workFolderRuns.manifest}->>'leaseId') = ${manifest.sandboxKey}`)).orderBy(desc(workFolderRuns.updatedAt)).limit(1)));
    if (previous && (previous.manifest.taskId !== taskId || previous.manifest.agentId !== input.agentId
      || previous.manifest.responsibleUserId !== responsibleUserId || previous.manifest.projectId !== projectId)) {
      throw new Error("Sandbox file identity changed; acquire a fresh sandbox before continuing");
    }
    // These dimensions describe validated work-folder history for this physical
    // sandbox key, not whether the provider was powered on or restarted.
    prepareSpan.set({ cold: !previous, warm: Boolean(previous), reused: Boolean(previous) });
    const [previousTaskRun] = taskId ? await measureSandboxOperation("work_folder.history.task", { operation: "select_work_folder_runs", requestCount: 1 }, async () => (db.select({ manifest: workFolderRuns.manifest }).from(workFolderRuns)
      .where(and(eq(workFolderRuns.companyId, input.companyId), sql`${workFolderRuns.manifest}->>'taskId' = ${taskId}`))
      .orderBy(desc(workFolderRuns.updatedAt)).limit(1))) : [];
    const identityChanged = Boolean(previousTaskRun && (previousTaskRun.manifest.agentId !== input.agentId
      || previousTaskRun.manifest.responsibleUserId !== responsibleUserId));
    const baselines: Record<string, WorkTreeEntry[]> = previous?.baselines ?? {};
    const pendingOperations = previous?.pendingOperations ?? {};
    await measureSandboxOperation("work_folder.manifest.initialize", { operation: "insert_work_folder_runs", requestCount: 1 }, async () => (db.insert(workFolderRuns).values({ runId: input.runId, companyId: input.companyId, manifest, baselines, pendingOperations })
      .onConflictDoUpdate({ target: workFolderRuns.runId, set: { manifest, state: "starting", updatedAt: new Date() } })));

    async function seedAttachments() {
      return measureSandboxOperation("work_folder.attachments", { phase: "prepare" }, async (span) => {
        const taskFolder = folders.task;
        if (!taskFolder || !taskId) return;
        const attached = await measureSandboxOperation("work_folder.db.query", { operation: "select_issue_attachments", requestCount: 1 }, async () => (db.select({ attachment: issueAttachments, asset: assets }).from(issueAttachments)
          .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, issueAttachments.companyId)))
          .where(and(eq(issueAttachments.issueId, taskId), eq(issueAttachments.companyId, input.companyId)))
          .orderBy(asc(issueAttachments.createdAt), asc(issueAttachments.id))));
        span.set({ files: attached.length });
        for (const [fileIndex, { attachment, asset }] of attached.entries()) {
          const operationId = `attachment:${attachment.id}`;
          const [seeded] = await measureSandboxOperation("work_folder.db.query", { operation: "select_work_file_operations", requestCount: 1 }, async () => (db.select().from(workFileOperations).where(and(eq(workFileOperations.folderId, taskFolder.id),
            eq(workFileOperations.operationId, operationId)))));
          if (seeded) continue;
          const original = (asset.originalFilename ?? "attachment").split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g, "_").slice(0, 180) || "attachment";
          // The ID makes the destination independent of concurrent uploads and
          // earlier seeding attempts. Even dot/reserved filenames become safe.
          const extension = path.posix.extname(original);
          const filename = `${original.slice(0, original.length - extension.length)}-${attachment.id}${extension}`;
          const result = await measureSandboxOperation("work_folder.attachment.get_response", { requestCount: 1, bytes: asset.byteSize, fileIndex }, async () => (storage.getObject({ objectKey: asset.objectKey })));
          try { await svc.write(taskFolder, { path: filename, body: measureSandboxStream("work_folder.attachment.body", { bytes: asset.byteSize, scope: "task", fileIndex }, result.stream), contentType: asset.contentType, operationId, onlyIfMissing: true }); }
          finally { result.stream.destroy(); }
        }
      });
    }
    async function importAgentFiles() {
      return measureSandboxOperation("work_folder.agent_import", { phase: "prepare" }, async () => {
        const folder = folders.agent!;
        if (folder.importedAt) return;
        const root = resolveDefaultAgentWorkspaceDir(input.agentId);
        for await (const file of managedAgentFiles(root)) {
          const [receipt] = await measureSandboxOperation("work_folder.db.query", { operation: "select_work_file_operations", requestCount: 1 }, async () => (db.select({ id: workFileOperations.id }).from(workFileOperations).where(and(
            eq(workFileOperations.folderId, folder.id), eq(workFileOperations.operationId, `import:${file.path}`)))));
          if (receipt) continue;
          await svc.write(folder, { ...file, operationId: `import:${file.path}`, onlyIfMissing: true });
        }
        await measureSandboxOperation("work_folder.db.query", { operation: "update_work_folders", requestCount: 1 }, async () => (db.update(workFolders).set({ importedAt: new Date() }).where(eq(workFolders.id, folder.id))));
      });
    }
    async function reconcileIncoming(scope: WorkFolderScope, current: WorkTreeEntry[]) {
      const targets = baselines[`incoming:${scope}`];
      const removed = baselines[`incomingRemoved:${scope}`];
      if (!targets && !removed) return;
      const before = new Map((baselines[scope] ?? []).map((entry) => [entry.path, entry]));
      const observed = new Map(current.map((entry) => [entry.path, entry]));
      // A failed command may have published some imports or removed some files.
      // Only adopt effects actually observed on disk; different bytes remain
      // genuine local edits and must still pass through outgoing synchronization.
      for (const entry of removed ?? []) if (!observed.has(entry.path)) before.delete(entry.path);
      for (const entry of targets ?? []) {
        if (signature(observed.get(entry.path)) === signature(entry)) before.set(entry.path, entry);
      }
      baselines[scope] = [...before.values()];
      delete baselines[`incoming:${scope}`];
      delete baselines[`incomingRemoved:${scope}`];
      // Persist the reconciled baseline and remove its provenance atomically,
      // before any outgoing write can be accepted by the shared collection.
      await saveState("saving");
    }
    async function outgoing(scope: WorkFolderScope) {
      return measureSandboxOperation("work_folder.scope.outgoing", { scope }, async (span) => {
        const folder = folders[scope];
        if (!folder) return;
        const current = await measureSandboxOperation("work_folder.scope.disk_scan", { scope }, async () => (transport.scan(paths[scope]!)));
        span.set({ files: current.length });
        await reconcileIncoming(scope, current);
        const before = new Map((baselines[scope] ?? []).map((entry) => [entry.path, entry]));
        const after = new Map(current.map((entry) => [entry.path, entry]));
        async function operation(filePath: string, nextSignature: string, apply: (id: string) => Promise<unknown>, accept: () => void) {
          const key = `${scope}/${filePath}`;
          if (pendingOperations[key]?.signature !== nextSignature) pendingOperations[key] = { id: randomUUID(), signature: nextSignature };
          // Persist the receipt ID BEFORE sending bytes. A process restart or lost
          // COMMIT response must retry this ID, not overwrite another run's edit.
          await saveState("saving");
          await apply(pendingOperations[key]!.id);
          accept();
          baselines[scope] = [...before.values()];
          delete pendingOperations[key];
          await saveState("saving");
        }
        for (const entry of current) {
          if (signature(before.get(entry.path)) === signature(entry)) continue;
          const body = entry.kind === "file" ? transport.read(paths[scope]!, entry.path, entry.byteSize) : undefined;
          try {
            await operation(entry.path, signature(entry), (operationId) => svc.write(folder, { path: entry.path, body,
              kind: entry.kind, replaceKind: true, executable: entry.executable, expectedSha256: entry.sha256, operationId }), () => {
                if (before.get(entry.path)?.kind !== entry.kind) for (const key of before.keys()) {
                  if (key.startsWith(`${entry.path}/`)) before.delete(key);
                }
                before.set(entry.path, entry);
              });
          } finally { body?.destroy(); }
        }
        for (const old of [...before.values()].sort((a, b) => a.path.length - b.path.length)) {
          if (!after.has(old.path) && before.has(old.path)) {
            await operation(old.path, "missing", (operationId) => svc.remove(folder, old.path, operationId), () => {
              for (const key of before.keys()) if (key === old.path || key.startsWith(`${old.path}/`)) before.delete(key);
            });
          }
        }
        baselines[scope] = [...before.values()];
      });
    }
    async function incoming(scope: WorkFolderScope) {
      return measureSandboxOperation("work_folder.scope.incoming", { scope }, async (span) => {
        const folder = folders[scope];
        if (!folder) return;
        const current = new Map((await measureSandboxOperation("work_folder.scope.disk_scan", { scope }, async () => (transport.scan(paths[scope]!)))).map((entry) => [entry.path, entry]));
        const saved: WorkTreeEntry[] = [];
        let cursor: string | undefined;
        do {
          const page = await svc.list(folder, { cursor, limit: 1000 });
          for (const file of page.files) saved.push({ path: file.path, kind: file.kind, byteSize: file.byteSize, sha256: file.sha256, executable: file.executable });
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        span.set({ files: saved.length });
        const desired = new Map(saved.map((entry) => [entry.path, entry]));
        // Persist all deletion intents before the first removal, including children
        // that can disappear when a directory is replaced. A lost response must not
        // turn an imported deletion into a new delete against a newer shared file.
        const removed = [...current.values()].filter((entry) => !desired.has(entry.path) || desired.get(entry.path)!.kind !== entry.kind)
          .sort((a, b) => b.path.length - a.path.length);
        if (removed.length) {
          baselines[`incomingRemoved:${scope}`] = removed;
          await saveState("starting");
        }
        for (const entry of removed) {
          await transport.remove(paths[scope]!, entry.path);
          current.delete(entry.path);
        }
        const changed = saved.sort((a, b) => a.path.length - b.path.length)
          .filter((entry) => signature(current.get(entry.path)) !== signature(entry));
        await measureSandboxOperation("work_folder.scope.hydrate", { scope, files: changed.length, parallelism: WORK_FOLDER_PREFETCH_CONCURRENCY }, async () => (transport.writeMany(paths[scope]!, staging, prefetchWorkFiles(changed, async (entry, fileIndex) => {
          if (entry.kind === "directory") return { entry };
          const result = await svc.content(folder, entry.path, fileIndex);
          // A shared file can change after listing. Validate and baseline the
          // version opened by content(), whose metadata and stream belong together.
          Object.assign(entry, { byteSize: result.file.byteSize, sha256: result.file.sha256, executable: result.file.executable });
          return { entry, body: result.stream };
        }), async (entries) => {
          const targets = new Map((baselines[`incoming:${scope}`] ?? []).map((entry) => [entry.path, entry]));
          for (const entry of entries) {
            targets.set(entry.path, entry);
            // Publishing nested files can create parents absent from the listing.
            // Record those directory imports too, so they cannot be mistaken for
            // agent-created directories after an interrupted batch.
            let parent = path.posix.dirname(entry.path);
            while (parent !== ".") {
              if (!targets.has(parent)) targets.set(parent, { path: parent, kind: "directory", byteSize: 0, sha256: null, executable: false });
              parent = path.posix.dirname(parent);
            }
          }
          baselines[`incoming:${scope}`] = [...targets.values()];
          await saveState("starting");
        })));
        baselines[scope] = saved;
        delete baselines[`incoming:${scope}`];
        delete baselines[`incomingRemoved:${scope}`];
        await saveState("starting");
      });
    }

    const bindings: Array<{ binding: typeof taskRepositoryBindings.$inferSelect; root: string }> = [];
    async function prepareRepositories() {
      return measureSandboxOperation("work_folder.repositories.prepare", { phase: "prepare" }, async () => {
        if (!taskId || !projectId) return;
        const workspaces = await measureSandboxOperation("work_folder.db.query", { operation: "select_project_workspaces", requestCount: 1 }, async () => (db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, input.companyId),
          eq(projectWorkspaces.projectId, projectId))).orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt))));
        const existing = await measureSandboxOperation("work_folder.db.query", { operation: "select_task_repository_bindings", requestCount: 1 }, async () => (db.select().from(taskRepositoryBindings).where(and(eq(taskRepositoryBindings.companyId, input.companyId), eq(taskRepositoryBindings.taskId, taskId)))));
        const names = new Set(existing.map((binding) => binding.name));
        const resolveGitAuth = createGitRemoteAuthProvider(db, input.companyId, { responsibleUserId: responsibleUserId, agentId: input.agentId, issueId: taskId, heartbeatRunId: input.runId });
        for (const [repositoryIndex, workspace] of workspaces.filter((entry) => entry.repoUrl).entries()) {
          await measureSandboxOperation("work_folder.repository.prepare", { repositoryIndex }, async (repositorySpan) => {
            const primary = input.primaryWorkspaceId ? workspace.id === input.primaryWorkspaceId : workspace.isPrimary;
            let binding = existing.find((entry) => entry.workspaceId === workspace.id);
            if (!binding) {
              const baseName = repoName(workspace.repoUrl!.split(/[/:]/).at(-1) ?? workspace.name, workspace.id);
              const name = names.has(baseName) ? `${baseName}-${workspace.id.slice(0, 8)}` : baseName;
              names.add(name);
              [binding] = await measureSandboxOperation("work_folder.db.query", { operation: "insert_task_repository_bindings", requestCount: 1 }, async () => (db.insert(taskRepositoryBindings).values({ companyId: input.companyId, taskId: taskId,
                workspaceId: workspace.id, name, repoUrl: workspace.repoUrl, repoRef: workspace.repoRef ?? workspace.defaultRef }).returning()));
            }
            if (!binding) throw new Error("Repository binding could not be created");
            const repositoryBinding = binding;
            const failPreparation = (operation: string, message: string): never => {
              // No adapter has started and a continuation cannot repair these
              // inputs. Preserve completed checkouts for an explicit retry.
              throw new WorkspaceRuntimeValidationFailure(message, {
                workspaceValidation: {
                  reason: "sandbox_repository_preparation_failed", operation,
                  issueId: taskId, projectId, projectWorkspaceId: workspace.id,
                  repositoryBindingId: repositoryBinding.id, repositoryName: repositoryBinding.name,
                  fingerprint: `sandbox_repository:${repositoryBinding.id}:${operation}`,
                },
              });
            };
            if (binding.repoUrl !== workspace.repoUrl) failPreparation("configuration", `Repository ${binding.name} configuration changed; saved work was retained`);
            if (binding.repoRef !== (workspace.repoRef ?? workspace.defaultRef)) failPreparation("configuration", `Repository ${binding.name} starting ref changed; saved work was retained`);
            const root = path.posix.join(paths.repos!, binding.name);
            const probe = await measureSandboxOperation("work_folder.repository.probe", { repositoryIndex, requestCount: 1 }, async () => (target.runner!.execute({ command: "git", args: ["-C", root, "rev-parse", "--git-dir"], bypassSession: true, timeoutMs: 10_000 })));
            const freshCheckout = probe.exitCode !== 0;
            // Checkout reuse is observed on disk; a durable restore remains cold.
            repositorySpan.set({ exists: !freshCheckout, reused: !freshCheckout, cold: freshCheckout, warm: !freshCheckout, cacheHit: false });
            if (freshCheckout) {
              // Publish the checkout directory only after every restore object or
              // clone step completes. An interrupted attempt cannot masquerade as a
              // reusable checkout merely because it contains a .git directory.
              const temporary = path.posix.join(staging, `repo-${binding.id}-${randomUUID()}`);
              const restored = await repositories.restore(binding, temporary, staging);
              repositorySpan.set({ cacheHit: restored });
              if (!restored) {
                const auth = await measureSandboxOperation("work_folder.repository.credentials", { repositoryIndex }, async () => (resolveGitAuth(workspace.repoUrl!)));
                const result = await measureSandboxOperation("work_folder.repository.clone", { repositoryIndex, requestCount: 1 }, async () => (target.runner!.execute({ command: "git", args: [...(auth?.configArgs ?? []), "clone", "--no-hardlinks",
                  "--", workspace.repoUrl!, temporary],
                  env: { GIT_TERMINAL_PROMPT: "0", ...(auth?.env ?? {}) }, bypassSession: true, timeoutMs: 300_000 })));
                if (result.exitCode !== 0 || result.timedOut) failPreparation("clone", `Required repository ${binding.name} could not be cloned`);
                const repoRef = binding.repoRef;
                if (repoRef) {
                  const checkout = await measureSandboxOperation("work_folder.repository.checkout", { repositoryIndex, requestCount: 1 }, async () => (target.runner!.execute({ command: "git", args: ["-C", temporary, "checkout", repoRef, "--"], bypassSession: true, timeoutMs: 60_000 })));
                  if (checkout.exitCode !== 0 || checkout.timedOut) failPreparation("checkout", `Required repository ${binding.name} ref could not be checked out`);
                }
                if (primary && input.primaryBranchName) {
                  const branch = input.primaryBranchName;
                  const valid = await measureSandboxOperation("work_folder.repository.validate_branch", { repositoryIndex, requestCount: 1 }, async () => (target.runner!.execute({ command: "git", args: ["check-ref-format", "--branch", branch], bypassSession: true, timeoutMs: 10_000 })));
                  if (valid.exitCode !== 0 || valid.stdout.trim() !== branch) failPreparation("branch", `Required repository ${binding.name} branch is invalid`);
                  // Honor the task's existing branch policy on the initial clone.
                  // Restores and warm starts keep the saved HEAD and index untouched.
                  const checkout = await measureSandboxOperation("work_folder.repository.checkout", { repositoryIndex, requestCount: 1 }, async () => (target.runner!.execute({ command: "git", args: ["-C", temporary, "checkout", branch, "--"], bypassSession: true, timeoutMs: 60_000 })));
                  if (checkout.exitCode !== 0) {
                    const create = await measureSandboxOperation("work_folder.repository.create_branch", { repositoryIndex, requestCount: 1 }, async () => (target.runner!.execute({ command: "git", args: ["-C", temporary, "checkout", "-b", branch], bypassSession: true, timeoutMs: 60_000 })));
                    if (create.exitCode !== 0 || create.timedOut) failPreparation("branch", `Required repository ${binding.name} task branch could not be created`);
                  }
                }
              } else {
                const init = await measureSandboxOperation("work_folder.repository.restore_init", { repositoryIndex, requestCount: 1 }, async () => (target.runner!.execute({ command: "git", args: ["-C", temporary, "init"], bypassSession: true, timeoutMs: 10_000 })));
                if (init.exitCode !== 0) throw new Error(`Repository ${binding.name} could not be restored`);
                const remote = await measureSandboxOperation("work_folder.repository.restore_remote", { repositoryIndex, requestCount: 1 }, async () => (target.runner!.execute({ command: "git", args: ["-C", temporary, "remote", "add", "origin", binding.repoUrl!], bypassSession: true, timeoutMs: 10_000 })));
                if (remote.exitCode !== 0) throw new Error(`Repository ${binding.name} remote could not be restored`);
              }
              await measureSandboxOperation("work_folder.repository.publish", { repositoryIndex }, async () => (transport.moveRoot(temporary, root)));
            }
            // Warm checkouts retain completed setup. A replacement only restores
            // durable repository files, so setup must recreate ignored dependencies
            // and caches that are deliberately outside the checkpoint guarantee.
            const setupCommand = workspace.setupCommand;
            if ((!binding.setupComplete || freshCheckout) && setupCommand) {
              const setup = await measureSandboxOperation("work_folder.repository.setup", { repositoryIndex, requestCount: 1 }, async () => (target.runner!.execute({ command: "sh", args: ["-c", setupCommand], cwd: root, bypassSession: true, timeoutMs: 300_000 })));
              if (setup.exitCode !== 0 || setup.timedOut) failPreparation("setup", `Repository ${binding.name} setup failed`);
            }
            await measureSandboxOperation("work_folder.db.query", { operation: "update_task_repository_bindings", requestCount: 1 }, async () => (db.update(taskRepositoryBindings).set({ setupComplete: true, retiredAt: null }).where(eq(taskRepositoryBindings.id, binding.id))));
            bindings.push({ binding, root });
            manifest.repositories.push({ bindingId: binding.id, workspaceId: workspace.id, name: binding.name, primary });
            await saveState("starting");
          });
        }
        for (const old of existing) if (!workspaces.some((workspace) => workspace.id === old.workspaceId)) {
          await measureSandboxOperation("work_folder.db.query", { operation: "update_task_repository_bindings", requestCount: 1 }, async () => (db.update(taskRepositoryBindings).set({ retiredAt: new Date() }).where(eq(taskRepositoryBindings.id, old.id))));
        }
      });
    }
    async function saveState(state: "starting" | "saving" | "saved" | "failed", error: string | null = null) {
      return measureSandboxOperation("work_folder.progress.save", { phase: state, requestCount: 1 }, async () => {
        await measureSandboxOperation("work_folder.db.query", { operation: "update_work_folder_runs", requestCount: 1 }, async () => (db.update(workFolderRuns).set({ state, baselines, pendingOperations, manifest, error, updatedAt: new Date(),
          ...(state === "saved" ? { lastSavedAt: new Date() } : {}) }).where(eq(workFolderRuns.runId, input.runId))));
      });
    }
    async function recordCheckpoint(action: string) {
      return measureSandboxOperation("work_folder.activity.record", { requestCount: 1 }, async () => {
        await logActivity(db, { companyId: input.companyId, actorType: "agent", actorId: input.agentId,
          agentId: input.agentId, runId: input.runId, issueId: taskId,
          responsibleUserIdOverride: responsibleUserId, action, entityType: "heartbeat_run", entityId: input.runId,
          details: { phase: "started", scopes: WORK_FOLDER_SCOPES.filter((scope) => Boolean(folders[scope])), repositories: bindings.length } });
      });
    }
    try {
      // Record intent before mutations. An unavailable audit store blocks new
      // work instead of turning an already completed save into a false failure.
      // The run's persisted state/lastSavedAt records checkpoint completion.
      await recordCheckpoint("work_folder.prepared");
      await seedAttachments();
      await importAgentFiles();
      // A resumed sandbox can hold edits newer than its last completed checkpoint.
      if (previous) for (const scope of WORK_FOLDER_SCOPES) await outgoing(scope);
      for (const scope of WORK_FOLDER_SCOPES) await incoming(scope);
      await prepareRepositories();
      await saveState("starting");
      if (previous?.refreshRequested) await measureSandboxOperation("work_folder.db.query", { operation: "update_work_folder_runs", requestCount: 1 }, async () => (db.update(workFolderRuns).set({ refreshRequested: false })
        .where(eq(workFolderRuns.runId, previous.runId))));
    } catch (error) {
      await saveState("failed", "Work folder preparation failed; existing files were retained");
      throw error;
    }
    const checkpointer = startWorkFolderCheckpointer({
      async checkpoint() {
        const checkpoint = () => measureSandboxOperation("work_folder.checkpoint", { phase: completion ? "final" : explicitFlushes ? "explicit" : "periodic" }, async () => {
          await assertBindings();
          await recordCheckpoint("work_folder.checkpoint");
          await saveState("saving");
          for (const scope of WORK_FOLDER_SCOPES) await outgoing(scope);
          for (const [repositoryIndex, { binding, root }] of bindings.entries()) await measureSandboxOperation("work_folder.repository.checkpoint", { repositoryIndex }, async () => repositories.checkpoint(binding, root));
          await saveState("saved");
        });
        return completion || explicitFlushes ? checkpoint() : runInRunContext(checkpoint);
      },
      async onError(error) {
        const failure = error as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
        // Do not log SDK request objects, headers, file contents or credentials.
        const label = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : null;
        logger.warn({ runId: input.runId, errorName: label(failure?.name), errorCode: label(failure?.code),
          httpStatus: typeof failure?.$metadata?.httpStatusCode === "number" ? failure.$metadata.httpStatusCode : null },
        "Work folder checkpoint failed; retaining sandbox for recovery");
        await saveState("failed", "Files could not be saved; the sandbox must be retained for recovery");
      },
    });
    let completion: Promise<void> | null = null;
    let explicitFlushes = 0;
    function stop(beforeCompletion?: () => Promise<void>) {
      // Error teardown must observe the original outcome, including failures
      // after the data save. A later run owns any recovery of this working copy.
      completion ??= measureSandboxOperation("work_folder.finalize", { phase: "final" }, async () => {
        await checkpointer.stop();
        const [run] = await measureSandboxOperation("work_folder.db.query", { operation: "select_work_folder_runs", requestCount: 1 }, async () => (db.select({ refreshRequested: workFolderRuns.refreshRequested }).from(workFolderRuns)
          .where(eq(workFolderRuns.runId, input.runId))));
        if (run?.refreshRequested) {
          // The successful final flush protects edits before incoming refresh.
          try {
            await assertBindings();
            for (const scope of WORK_FOLDER_SCOPES) await incoming(scope);
            await measureSandboxOperation("work_folder.db.query", { operation: "update_work_folder_runs", requestCount: 1 }, async () => (db.update(workFolderRuns).set({ refreshRequested: false, baselines, updatedAt: new Date() })
              .where(eq(workFolderRuns.runId, input.runId))));
          } catch (error) {
            await saveState("failed", "Work folder refresh failed; existing files were retained");
            throw error;
          }
        }
        // Publish resume identity after data is durable, before releasing a turn.
        await beforeCompletion?.();
        manifest.finalCheckpointAt = new Date().toISOString();
        await saveState("saved");
      });
      return completion;
    }
    return { manifest, home, identityChanged, primaryRepo: bindings.find(({ binding }) => manifest.repositories.some((repo) => repo.bindingId === binding.id && repo.primary))?.root ?? bindings[0]?.root ?? paths.task!,
      env: { HOME: home, AGENT_HOME: paths.agent!, PAPERCLIP_PRIMARY_REPO: bindings.find(({ binding }) => manifest.repositories.some((repo) => repo.bindingId === binding.id && repo.primary))?.root ?? bindings[0]?.root ?? paths.task!, PAPERCLIP_TASK_DIR: paths.task!, PAPERCLIP_AGENT_DIR: paths.agent!,
        PAPERCLIP_USER_DIR: paths.user!, PAPERCLIP_PROJECT_DIR: paths.project!, PAPERCLIP_REPOS_DIR: paths.repos! },
      flush: () => measureSandboxOperation("work_folder.flush", { phase: "explicit" }, async () => {
        explicitFlushes++;
        try { await checkpointer.flush(); } finally { explicitFlushes--; }
      }), stop };
  });
}
