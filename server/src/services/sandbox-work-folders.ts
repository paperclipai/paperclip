import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { managedAgentFiles } from "./work-folder-agent-import.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { agents, assets, companyMemberships, heartbeatRuns, issues, projects, issueAttachments, projectWorkspaces, taskRepositoryBindings, workFileOperations, workFolderRuns, workFolders, type Db } from "@paperclipai/db";
import { WORK_FOLDER_SCOPES, type SandboxWorkFolderManifest, type WorkFolderScope } from "@paperclipai/shared";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { StorageProvider } from "../storage/types.js";
import { loadConfig } from "../config.js";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import { workFolderService } from "./work-folders.js";
import { workFolderPaths, workFolderTransport, type WorkTreeEntry } from "./work-folder-transport.js";
import { workFolderRepositoryService } from "./work-folder-repositories.js";
import { startWorkFolderCheckpointer } from "./work-folder-checkpointer.js";
import { logActivity } from "./activity-log.js";
import { assertWorkFolderAccess } from "./work-folder-access.js";

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
  const { db, target } = input;
  if (!target.runner || !target.leaseId) throw new Error("Sandbox file transport is unavailable");
  async function assertBindings() {
    const memberships: Array<{ companyId: string; membershipRole: string | null; status: string }> = [];
    const deny = () => { throw new Error("Sandbox work-folder access is no longer authorized; working files were retained"); };
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
    if (!run || run.agentId !== input.agentId || run.responsibleUserId !== input.responsibleUserId) deny();
    const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    if (!agent) deny();
    if (input.taskId) {
      const [task] = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.taskId), eq(issues.companyId, input.companyId)));
      if (!task) deny();
    }
    if (input.projectId) {
      const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId)));
      if (!project) deny();
    }
    if (input.responsibleUserId) {
      const [membership] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, input.responsibleUserId), eq(companyMemberships.status, "active")));
      if (!membership || membership.membershipRole === "viewer") deny();
      if (membership) memberships.push({ companyId: membership.companyId, membershipRole: membership.membershipRole, status: membership.status });
    }
    for (const [scope, ownerId] of [["task", input.taskId], ["agent", input.agentId], ["project", input.projectId]] as const) {
      if (!ownerId) continue;
      await assertWorkFolderAccess(db, { type: "agent", source: "agent_jwt", companyId: input.companyId,
        agentId: input.agentId, runId: input.runId, onBehalfOfUserId: input.responsibleUserId, onBehalfOfMemberships: memberships },
      { companyId: input.companyId, scope, ownerId }, true);
    }
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
  const owners = { task: input.taskId, agent: input.agentId, user: input.responsibleUserId, project: input.projectId };
  const folders: Partial<Record<WorkFolderScope, typeof workFolders.$inferSelect>> = {};
  for (const scope of WORK_FOLDER_SCOPES) {
    const ownerId = owners[scope];
    if (ownerId) folders[scope] = await svc.ensure({ companyId: input.companyId, scope, ownerId });
  }
  const manifest: SandboxWorkFolderManifest = { version: 1, companyId: input.companyId, runId: input.runId,
    taskId: input.taskId, agentId: input.agentId, responsibleUserId: input.responsibleUserId,
    projectId: input.projectId, leaseId: target.leaseId, sandboxKey: input.sandboxKey ?? target.leaseId, home,
    folders: { task: folders.task?.id ?? null, agent: folders.agent!.id, user: folders.user?.id ?? null, project: folders.project?.id ?? null }, repositories: [] };
  const [previous] = await db.select().from(workFolderRuns).where(and(eq(workFolderRuns.companyId, input.companyId),
    sql`coalesce(${workFolderRuns.manifest}->>'sandboxKey', ${workFolderRuns.manifest}->>'leaseId') = ${manifest.sandboxKey}`)).orderBy(desc(workFolderRuns.updatedAt)).limit(1);
  if (previous && (previous.manifest.taskId !== input.taskId || previous.manifest.agentId !== input.agentId
    || previous.manifest.responsibleUserId !== input.responsibleUserId || previous.manifest.projectId !== input.projectId)) {
    throw new Error("Sandbox file identity changed; acquire a fresh sandbox before continuing");
  }
  const [previousTaskRun] = input.taskId ? await db.select({ manifest: workFolderRuns.manifest }).from(workFolderRuns)
    .where(and(eq(workFolderRuns.companyId, input.companyId), sql`${workFolderRuns.manifest}->>'taskId' = ${input.taskId}`))
    .orderBy(desc(workFolderRuns.updatedAt)).limit(1) : [];
  const identityChanged = Boolean(previousTaskRun && (previousTaskRun.manifest.agentId !== input.agentId
    || previousTaskRun.manifest.responsibleUserId !== input.responsibleUserId));
  const baselines: Record<string, WorkTreeEntry[]> = previous?.baselines ?? {};
  const pendingOperations = previous?.pendingOperations ?? {};
  await db.insert(workFolderRuns).values({ runId: input.runId, companyId: input.companyId, manifest, baselines, pendingOperations })
    .onConflictDoUpdate({ target: workFolderRuns.runId, set: { manifest, state: "starting", updatedAt: new Date() } });

  async function seedAttachments() {
    if (!folders.task || !input.taskId) return;
    const attached = await db.select({ attachment: issueAttachments, asset: assets }).from(issueAttachments)
      .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, issueAttachments.companyId)))
      .where(and(eq(issueAttachments.issueId, input.taskId), eq(issueAttachments.companyId, input.companyId)))
      .orderBy(asc(issueAttachments.createdAt), asc(issueAttachments.id));
    for (const { attachment, asset } of attached) {
      const operationId = `attachment:${attachment.id}`;
      const [seeded] = await db.select().from(workFileOperations).where(and(eq(workFileOperations.folderId, folders.task.id),
        eq(workFileOperations.operationId, operationId)));
      if (seeded) continue;
      const original = (asset.originalFilename ?? "attachment").split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g, "_").slice(0, 180) || "attachment";
      // The ID makes the destination independent of concurrent uploads and
      // earlier seeding attempts. Even dot/reserved filenames become safe.
      const extension = path.posix.extname(original);
      const filename = `${original.slice(0, original.length - extension.length)}-${attachment.id}${extension}`;
      const result = await storage.getObject({ objectKey: asset.objectKey });
      try { await svc.write(folders.task, { path: filename, body: result.stream, contentType: asset.contentType, operationId, onlyIfMissing: true }); }
      finally { result.stream.destroy(); }
    }
  }
  async function importAgentFiles() {
    const folder = folders.agent!;
    if (folder.importedAt) return;
    const root = resolveDefaultAgentWorkspaceDir(input.agentId);
    for await (const file of managedAgentFiles(root)) {
      const [receipt] = await db.select({ id: workFileOperations.id }).from(workFileOperations).where(and(
        eq(workFileOperations.folderId, folder.id), eq(workFileOperations.operationId, `import:${file.path}`)));
      if (receipt) continue;
      await svc.write(folder, { ...file, operationId: `import:${file.path}`, onlyIfMissing: true });
    }
    await db.update(workFolders).set({ importedAt: new Date() }).where(eq(workFolders.id, folder.id));
  }
  async function outgoing(scope: WorkFolderScope) {
    const folder = folders[scope];
    if (!folder) return;
    const current = await transport.scan(paths[scope]!);
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
  }
  async function incoming(scope: WorkFolderScope) {
    const folder = folders[scope];
    if (!folder) return;
    const current = new Map((await transport.scan(paths[scope]!)).map((entry) => [entry.path, entry]));
    const saved: WorkTreeEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await svc.list(folder, { cursor, limit: 1000 });
      for (const file of page.files) saved.push({ path: file.path, kind: file.kind, byteSize: file.byteSize, sha256: file.sha256, executable: file.executable });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const desired = new Map(saved.map((entry) => [entry.path, entry]));
    // Remove stale children before replacing their parent directory with a file.
    for (const entry of [...current.values()].sort((a, b) => b.path.length - a.path.length)) {
      if (!desired.has(entry.path) || desired.get(entry.path)!.kind !== entry.kind) {
        await transport.remove(paths[scope]!, entry.path);
        current.delete(entry.path);
      }
    }
    for (const entry of saved.sort((a, b) => a.path.length - b.path.length)) {
      if (signature(current.get(entry.path)) === signature(entry)) continue;
      if (entry.kind === "directory") await transport.mkdir(paths[scope]!, entry.path);
      else {
        const result = await svc.content(folder, entry.path);
        try { await transport.write(paths[scope]!, staging, entry, result.stream); } finally { result.stream.destroy(); }
      }
    }
    baselines[scope] = saved;
  }

  const bindings: Array<{ binding: typeof taskRepositoryBindings.$inferSelect; root: string }> = [];
  async function prepareRepositories() {
    if (!input.taskId || !input.projectId) return;
    const workspaces = await db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, input.companyId),
      eq(projectWorkspaces.projectId, input.projectId))).orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt));
    const existing = await db.select().from(taskRepositoryBindings).where(and(eq(taskRepositoryBindings.companyId, input.companyId), eq(taskRepositoryBindings.taskId, input.taskId)));
    const names = new Set(existing.map((binding) => binding.name));
    const resolveGitAuth = createGitRemoteAuthProvider(db, input.companyId, { responsibleUserId: input.responsibleUserId, agentId: input.agentId, issueId: input.taskId, heartbeatRunId: input.runId });
    for (const workspace of workspaces.filter((entry) => entry.repoUrl)) {
      const primary = input.primaryWorkspaceId ? workspace.id === input.primaryWorkspaceId : workspace.isPrimary;
      let binding = existing.find((entry) => entry.workspaceId === workspace.id);
      if (!binding) {
        const baseName = repoName(workspace.repoUrl!.split(/[/:]/).at(-1) ?? workspace.name, workspace.id);
        const name = names.has(baseName) ? `${baseName}-${workspace.id.slice(0, 8)}` : baseName;
        names.add(name);
        [binding] = await db.insert(taskRepositoryBindings).values({ companyId: input.companyId, taskId: input.taskId,
          workspaceId: workspace.id, name, repoUrl: workspace.repoUrl, repoRef: workspace.repoRef ?? workspace.defaultRef }).returning();
      }
      if (!binding) throw new Error("Repository binding could not be created");
      if (binding.repoUrl !== workspace.repoUrl) throw new Error(`Repository ${binding.name} configuration changed; saved work was retained`);
      if (binding.repoRef !== (workspace.repoRef ?? workspace.defaultRef)) throw new Error(`Repository ${binding.name} starting ref changed; saved work was retained`);
      const root = path.posix.join(paths.repos!, binding.name);
      const probe = await target.runner!.execute({ command: "git", args: ["-C", root, "rev-parse", "--git-dir"], bypassSession: true, timeoutMs: 10_000 });
      const freshCheckout = probe.exitCode !== 0;
      if (freshCheckout) {
        // Publish the checkout directory only after every restore object or
        // clone step completes. An interrupted attempt cannot masquerade as a
        // reusable checkout merely because it contains a .git directory.
        const temporary = path.posix.join(staging, `repo-${binding.id}-${randomUUID()}`);
        const restored = await repositories.restore(binding, temporary, staging);
        if (!restored) {
          const auth = await resolveGitAuth(workspace.repoUrl!);
          const result = await target.runner!.execute({ command: "git", args: [...(auth?.configArgs ?? []), "clone", "--no-hardlinks",
            "--", workspace.repoUrl!, temporary],
            env: { GIT_TERMINAL_PROMPT: "0", ...(auth?.env ?? {}) }, bypassSession: true, timeoutMs: 300_000 });
          if (result.exitCode !== 0 || result.timedOut) throw new Error(`Required repository ${binding.name} could not be cloned`);
          if (binding.repoRef) {
            const checkout = await target.runner!.execute({ command: "git", args: ["-C", temporary, "checkout", binding.repoRef, "--"], bypassSession: true, timeoutMs: 60_000 });
            if (checkout.exitCode !== 0 || checkout.timedOut) throw new Error(`Required repository ${binding.name} ref could not be checked out`);
          }
          if (primary && input.primaryBranchName) {
            const branch = input.primaryBranchName;
            const valid = await target.runner!.execute({ command: "git", args: ["check-ref-format", "--branch", branch], bypassSession: true, timeoutMs: 10_000 });
            if (valid.exitCode !== 0 || valid.stdout.trim() !== branch) throw new Error(`Required repository ${binding.name} branch is invalid`);
            // Honor the task's existing branch policy on the initial clone.
            // Restores and warm starts keep the saved HEAD and index untouched.
            const checkout = await target.runner!.execute({ command: "git", args: ["-C", temporary, "checkout", branch, "--"], bypassSession: true, timeoutMs: 60_000 });
            if (checkout.exitCode !== 0) {
              const create = await target.runner!.execute({ command: "git", args: ["-C", temporary, "checkout", "-b", branch], bypassSession: true, timeoutMs: 60_000 });
              if (create.exitCode !== 0 || create.timedOut) throw new Error(`Required repository ${binding.name} task branch could not be created`);
            }
          }
        } else {
          const init = await target.runner!.execute({ command: "git", args: ["-C", temporary, "init"], bypassSession: true, timeoutMs: 10_000 });
          if (init.exitCode !== 0) throw new Error(`Repository ${binding.name} could not be restored`);
          const remote = await target.runner!.execute({ command: "git", args: ["-C", temporary, "remote", "add", "origin", binding.repoUrl!], bypassSession: true, timeoutMs: 10_000 });
          if (remote.exitCode !== 0) throw new Error(`Repository ${binding.name} remote could not be restored`);
        }
        await transport.moveRoot(temporary, root);
      }
      // Warm checkouts retain completed setup. A replacement only restores
      // durable repository files, so setup must recreate ignored dependencies
      // and caches that are deliberately outside the checkpoint guarantee.
      if ((!binding.setupComplete || freshCheckout) && workspace.setupCommand) {
        const setup = await target.runner!.execute({ command: "sh", args: ["-c", workspace.setupCommand], cwd: root, bypassSession: true, timeoutMs: 300_000 });
        if (setup.exitCode !== 0 || setup.timedOut) throw new Error(`Repository ${binding.name} setup failed`);
      }
      await db.update(taskRepositoryBindings).set({ setupComplete: true, retiredAt: null }).where(eq(taskRepositoryBindings.id, binding.id));
      bindings.push({ binding, root });
      manifest.repositories.push({ bindingId: binding.id, workspaceId: workspace.id, name: binding.name, primary });
      await saveState("starting");
    }
    for (const old of existing) if (!workspaces.some((workspace) => workspace.id === old.workspaceId)) {
      await db.update(taskRepositoryBindings).set({ retiredAt: new Date() }).where(eq(taskRepositoryBindings.id, old.id));
    }
  }
  async function saveState(state: "starting" | "saving" | "saved" | "failed", error: string | null = null) {
    await db.update(workFolderRuns).set({ state, baselines, pendingOperations, manifest, error, updatedAt: new Date(),
      ...(state === "saved" ? { lastSavedAt: new Date() } : {}) }).where(eq(workFolderRuns.runId, input.runId));
  }
  async function recordCheckpoint(action: string) {
    await logActivity(db, { companyId: input.companyId, actorType: "agent", actorId: input.agentId,
      agentId: input.agentId, runId: input.runId, issueId: input.taskId,
      responsibleUserIdOverride: input.responsibleUserId, action, entityType: "heartbeat_run", entityId: input.runId,
      details: { phase: "started", scopes: WORK_FOLDER_SCOPES.filter((scope) => Boolean(folders[scope])), repositories: bindings.length } });
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
    if (previous?.refreshRequested) await db.update(workFolderRuns).set({ refreshRequested: false })
      .where(eq(workFolderRuns.runId, previous.runId));
  } catch (error) {
    await saveState("failed", "Work folder preparation failed; existing files were retained");
    throw error;
  }
  const checkpointer = startWorkFolderCheckpointer({
    async checkpoint() {
      await assertBindings();
      await recordCheckpoint("work_folder.checkpoint");
      await saveState("saving");
      for (const scope of WORK_FOLDER_SCOPES) await outgoing(scope);
      for (const { binding, root } of bindings) await repositories.checkpoint(binding, root);
      await saveState("saved");
    },
    async onError() { await saveState("failed", "Files could not be saved; the sandbox must be retained for recovery"); },
  });
  return { manifest, home, identityChanged, primaryRepo: bindings.find(({ binding }) => manifest.repositories.some((repo) => repo.bindingId === binding.id && repo.primary))?.root ?? bindings[0]?.root ?? paths.task!,
    env: { HOME: home, AGENT_HOME: paths.agent!, PAPERCLIP_PRIMARY_REPO: bindings.find(({ binding }) => manifest.repositories.some((repo) => repo.bindingId === binding.id && repo.primary))?.root ?? bindings[0]?.root ?? paths.task!, PAPERCLIP_TASK_DIR: paths.task!, PAPERCLIP_AGENT_DIR: paths.agent!,
      PAPERCLIP_USER_DIR: paths.user!, PAPERCLIP_PROJECT_DIR: paths.project!, PAPERCLIP_REPOS_DIR: paths.repos! },
    flush: checkpointer.flush, stop: async (beforeCompletion?: () => Promise<void>) => {
      await checkpointer.stop();
      const [run] = await db.select({ refreshRequested: workFolderRuns.refreshRequested }).from(workFolderRuns)
        .where(eq(workFolderRuns.runId, input.runId));
      if (run?.refreshRequested) {
        // The agent has stopped. The successful final flush above protects its
        // edits before accepting incoming shared files at this safe boundary.
        await assertBindings();
        for (const scope of WORK_FOLDER_SCOPES) await incoming(scope);
        await db.update(workFolderRuns).set({ refreshRequested: false, baselines, updatedAt: new Date() })
          .where(eq(workFolderRuns.runId, input.runId));
      }
      // Native resume identity must be published after the data is durable,
      // but before completion can release a new turn onto this sandbox.
      await beforeCompletion?.();
      manifest.finalCheckpointAt = new Date().toISOString();
      await saveState("saved");
    } };
}
