import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as gitWorkspaceSync from "@paperclipai/adapter-utils/git-workspace-sync";
import { DatabaseSync } from "node:sqlite";
import { captureDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
const execFile = promisify(execFileCallback);
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, authUsers, companyMemberships, principalPermissionGrants, heartbeatRuns, agentInstructionWorkingCopies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { buildNativeRuntimeContext } from "../services/native-runtime/runtime-context.js";

describe("registered run instruction copies", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  let revisions: ReturnType<typeof agentInstructionRevisionService>;
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let companyId: string, agentId: string, userId: string, root: string;
  const entryFile = "policy/INSTRUCTIONS.txt";
  const initial = "\uFEFF# Original\r\n☃\n";
  const target = () => ({ companyId, agentId });
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  async function run() {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    return (await copies.prepare({ legacy: true, ...target(), runId, cwd: home }))!;
  }
  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-working-copies-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("instruction-copies-db-");
    db = createDb(database.connectionString);
    copies = agentInstructionWorkingCopyService(db);
    revisions = agentInstructionRevisionService(db);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) {
      const writable = async (dir: string) => {
        await fs.chmod(dir, 0o700);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
      };
      await writable(home);
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Instruction tests", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ ...target(), id: agentId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), initial);
  });

  it("persists an atomic editor replacement, ignores repository instructions, and gives the next run exact bytes", async () => {
    const copy = await run();
    await fs.writeFile(path.join(home, "AGENTS.md"), "Repository text must not become agent instructions");
    const edited = "\uFEFF# Updated\r\nKeep this persistent. ☃\n";
    const replacement = path.join(copy.localRoot, "edited.tmp");
    await fs.writeFile(replacement, edited);
    await fs.rename(replacement, path.join(copy.localRoot, entryFile));
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
    const saved = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(saved).toMatchObject({ state: "saved", candidateHash: expect.any(String), processStoppedAt: expect.any(Date) });
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(edited);
    copies = agentInstructionWorkingCopyService(db);
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.receipt).toEqual(saved?.receipt);
    expect((await revisions.history({ ...target(), entryFile }, board())).revisions).toHaveLength(0);
    const next = await run();
    expect(await fs.readFile(path.join(next.localRoot, entryFile), "utf8")).toBe(edited);
  });

  it.each(["failed", "cancelled", "timed_out"])("retains edits from stopped %s runs without restarting execution", async (status) => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), status);
    await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, copy.runId));
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
    expect((await revisions.readCurrent(target(), board()))?.content).toBe(status);
    const [unchangedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, copy.runId));
    expect(unchangedRun.status).toBe(status);
  });

  it.each(["saved", "unchanged"])("refreshes a stopped %s copy from the current canonical revision before retry", async (state) => {
    const copy = await run();
    if (state === "saved") await fs.writeFile(path.join(copy.localRoot, entryFile), "previous saved turn");
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe(state);
    const before = (await revisions.readCurrent(target(), board()))!;
    const current = await revisions.commit({ ...target(), entryFile, baseRevisionId: before.revision.id, content: "new board instructions", source: "api" }, board());
    const retried = (await copies.prepare({ legacy: true, ...target(), runId: copy.runId, cwd: home }))!;
    expect(retried).toMatchObject({ state: "prepared", baseRevisionId: current.revision.id, baseHash: current.revision.contentHash, processStoppedAt: null });
    expect(await fs.readFile(path.join(retried.localRoot, entryFile), "utf8")).toBe("new board instructions");
    await fs.writeFile(path.join(retried.localRoot, entryFile), "retry adds a change");
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
  });

  it("never rebases uncollected private bytes or a live warm copy onto a newer head", async () => {
    const stopped = await run();
    await copies.collectStopped({ companyId, runId: stopped.runId });
    await fs.writeFile(path.join(stopped.localRoot, entryFile), "uncollected private edit");
    const warm = await run();
    expect(await copies.hasChanges({ companyId, runId: warm.runId })).toBe(false);
    const prior = (await revisions.readCurrent(target(), board()))!;
    await revisions.commit({ ...target(), entryFile, baseRevisionId: prior.revision.id, content: "board change", source: "api" }, board());
    for (const copy of [stopped, warm]) {
      const retried = (await copies.prepare({ legacy: true, ...target(), runId: copy.runId, cwd: home }))!;
      expect(retried.baseRevisionId).toBe(copy.baseRevisionId);
    }
    expect(await fs.readFile(path.join(stopped.localRoot, entryFile), "utf8")).toBe("uncollected private edit");
    expect(await fs.readFile(path.join(warm.localRoot, entryFile), "utf8")).toBe(initial);
    expect((await copies.collectStopped({ companyId, runId: stopped.runId }))?.state).toBe("conflict");
    expect((await revisions.readCurrent(target(), board()))?.content).toBe("board change");
  });

  it.each(["before replacement", "after replacement"])("preserves the completed receipt when retry staging fails %s", async (point) => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), "completed turn");
    const saved = (await copies.collectStopped({ companyId, runId: copy.runId }))!;
    expect(saved.state).toBe("saved");
    const prior = (await revisions.readCurrent(target(), board()))!;
    const current = await revisions.commit({ ...target(), entryFile, baseRevisionId: prior.revision.id, content: "new board instructions", source: "api" }, board());
    const originalMkdir = fs.mkdir.bind(fs);
    const originalChmod = fs.chmod.bind(fs);
    const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      if (point === "before replacement" && args[0] === copy.localRoot) throw new Error("retry staging failed");
      return originalMkdir(...args);
    });
    const chmod = vi.spyOn(fs, "chmod").mockImplementation(async (...args) => {
      if (point === "after replacement" && args[0] === path.join(copy.localRoot, entryFile)) throw new Error("retry staging failed");
      return originalChmod(...args);
    });
    try {
      await expect(copies.prepare({ legacy: true, ...target(), runId: copy.runId, cwd: home })).rejects.toThrow("retry staging failed");
    } finally { mkdir.mockRestore(); chmod.mockRestore(); }
    expect(await copies.get(companyId, copy.runId)).toEqual(saved);
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverStopped();
    expect(await copies.get(companyId, copy.runId)).toEqual(saved);
    expect((await revisions.readCurrent(target(), board()))?.revision.id).toBe(current.revision.id);
    const retried = (await copies.prepare({ legacy: true, ...target(), runId: copy.runId, cwd: home }))!;
    expect(retried).toMatchObject({ state: "prepared", baseRevisionId: current.revision.id, processStoppedAt: null });
    expect(await fs.readFile(path.join(retried.localRoot, entryFile), "utf8")).toBe(current.content);
  });

  it("reads an existing canonical runtime snapshot without seeding or changing instruction bytes", async () => {
    expect((await revisions.readCommittedForRuntime(target()))?.content).toBe(initial);
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), "saved runtime content");
    await copies.collectStopped({ companyId, runId: copy.runId });
    const current = (await revisions.readCurrent(target(), board()))!;
    await fs.writeFile(path.join(root, entryFile), "current filesystem contents");
    expect((await revisions.readCommittedForRuntime(target()))?.content).toBe("current filesystem contents");
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const context = await buildNativeRuntimeContext({ db, agent, runId: copy.runId, runtimeConfig: {}, runtimeSkillEntries: [] });
    try {
      expect(context.instructions.entryPath).toBe(entryFile);
      expect(await fs.readFile(path.join(context.instructions.bundle.rootPath, entryFile), "utf8"))
        .toBe("current filesystem contents");
    } finally {
      // Runtime assets are immutable, so make only this fixture's directories
      // removable before the ordinary temporary-home cleanup.
      const makeRemovable = async (directory: string): Promise<void> => {
        await fs.chmod(directory, 0o700);
        for (const child of await fs.readdir(directory, { withFileTypes: true })) {
          if (child.isDirectory()) await makeRemovable(path.join(directory, child.name));
        }
      };
      await makeRemovable(context.instructions.bundle.rootPath);
    }
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe("current filesystem contents");
    expect((await revisions.history({ ...target(), entryFile }, board())).revisions).toHaveLength(0);
    await expect(revisions.readCommittedForRuntime({ companyId: randomUUID(), agentId })).rejects.toThrow("Agent not found");
  });

  it("preserves a competing stale candidate and requires explicit resolution against the new head", async () => {
    const first = await run();
    const second = await run();
    await fs.writeFile(path.join(first.localRoot, entryFile), "first run");
    await fs.writeFile(path.join(second.localRoot, entryFile), "second run");
    await copies.collectStopped({ companyId, runId: first.runId });
    const conflict = await copies.collectStopped({ companyId, runId: second.runId });
    expect(conflict).toMatchObject({ state: "conflict", errorCode: "INSTRUCTION_REVISION_CONFLICT" });
    expect(Buffer.from(conflict!.candidateBase64!, "base64").toString("utf8")).toBe("second run");
    expect((await revisions.readCurrent(target(), board()))?.content).toBe("first run");
    copies = agentInstructionWorkingCopyService(db);
    expect(await copies.list(companyId, agentId, board())).toHaveLength(1);
    const current = (await revisions.readCurrent(target(), board()))!;
    await copies.resolve({ ...target(), runId: second.runId, baseRevisionId: current.revision.id, content: "explicitly combined" }, board());
    expect((await revisions.readCurrent(target(), board()))?.content).toBe("explicitly combined");
    expect((await copies.collectStopped({ companyId, runId: second.runId }))?.state).toBe("resolved");
    const resumed = (await copies.prepare({ legacy: true, ...target(), runId: second.runId, cwd: home }))!;
    const resolved = (await revisions.readCurrent(target(), board()))!;
    expect(resumed.baseRevisionId).toBe(resolved.revision.id);
    expect(await fs.readFile(path.join(resumed.localRoot, entryFile), "utf8")).toBe("explicitly combined");
  });

  it("rechecks responsible-user permission at collection and preserves denied edits", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), "candidate after revocation");
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, userId));
    const denied = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(denied).toMatchObject({ state: "conflict", errorCode: "RESPONSIBLE_USER_UNAVAILABLE" });
    expect(denied?.candidateBase64).not.toBeNull();
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
  });

  it("preserves the specific low-trust denial in the instruction-save receipt", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), "Unauthorized persistent edit");
    await db.update(agents).set({ permissions: {
      trustPreset: "low_trust_review",
      authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId, rootIssueId: randomUUID() } },
    } }).where(eq(agents.id, agentId));
    const denied = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(denied?.state).toBe("conflict");
    expect(denied?.errorMessage).toContain("Your low-trust permissions do not allow changing persistent agent instructions, including your own AGENTS.md");
    expect(denied?.candidateBase64).not.toBeNull();
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
  });

  it("does not import a symlink or confuse a removed entry with an empty file", async () => {
    const linked = await run();
    await fs.unlink(path.join(linked.localRoot, entryFile));
    await fs.symlink(path.join(home, "AGENTS.md"), path.join(linked.localRoot, entryFile));
    expect((await copies.collectStopped({ companyId, runId: linked.runId }))?.state).toBe("pending_collection");
    const missing = await run();
    await fs.unlink(path.join(missing.localRoot, entryFile));
    expect((await copies.collectStopped({ companyId, runId: missing.runId }))?.state).toBe("unavailable");
    const empty = await run();
    await fs.writeFile(path.join(empty.localRoot, entryFile), "");
    expect((await copies.collectStopped({ companyId, runId: empty.runId }))?.state).toBe("saved");
    expect((await revisions.readCurrent(target(), board()))?.content).toBe("");
  });

  it("keeps unchanged warm copies reusable without a content revision", async () => {
    const copy = await run();
    expect(await copies.hasChanges({ companyId, runId: copy.runId })).toBe(false);
    expect((await copies.get(companyId, copy.runId))?.processStoppedAt).toBeNull();
    expect((await revisions.history({ ...target(), entryFile }, board())).revisions).toHaveLength(0);
    await fs.writeFile(path.join(copy.localRoot, entryFile), "changed after turn");
    expect(await copies.hasChanges({ companyId, runId: copy.runId })).toBe(true);
    expect((await revisions.readCurrent(target(), board()))?.content).toBe(initial);
  });

  it("advances an explicit save baseline only when the private copy matches that revision", async () => {
    const copy = await run();
    const local = path.join(copy.localRoot, entryFile);
    await fs.writeFile(local, "explicit self-save");
    const first = await revisions.commit({ ...target(), entryFile, baseRevisionId: copy.baseRevisionId, content: "explicit self-save", source: "tool" }, board());
    await copies.acknowledgeExplicitSave({ ...target(), runId: copy.runId, entryFile, revisionId: first.revision.id, contentHash: first.revision.contentHash });
    await fs.writeFile(local, "local edit after explicit save");
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
    expect((await revisions.readCurrent(target(), board()))?.content).toBe("local edit after explicit save");

    const competing = await run();
    await fs.writeFile(path.join(competing.localRoot, entryFile), "older local draft");
    const separate = await revisions.commit({ ...target(), entryFile, baseRevisionId: competing.baseRevisionId, content: "different explicit content", source: "tool" }, board());
    await copies.acknowledgeExplicitSave({ ...target(), runId: competing.runId, entryFile, revisionId: separate.revision.id, contentHash: separate.revision.contentHash });
    expect((await copies.collectStopped({ companyId, runId: competing.runId }))?.state).toBe("conflict");
    expect((await revisions.readCurrent(target(), board()))?.content).toBe("different explicit content");
    expect((await copies.list(companyId, agentId, board()))[0]).not.toHaveProperty("localRoot");
  });

  it("recovers captured bytes after restart and deduplicates concurrent cleanup callbacks", async () => {
    const copy = await run();
    await db.update(agentInstructionWorkingCopies).set({ state: "pending_commit", candidateBase64: Buffer.from("captured before restart").toString("base64"), processStoppedAt: new Date() })
      .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverCaptured();
    expect((await revisions.readCurrent(target(), board()))?.content).toBe("captured before restart");
    const duplicate = await run();
    await fs.writeFile(path.join(duplicate.localRoot, entryFile), "one final edit");
    await Promise.all([copies.collectStopped({ companyId, runId: duplicate.runId }), copies.collectStopped({ companyId, runId: duplicate.runId })]);
    expect((await copies.get(companyId, duplicate.runId))?.state).toBe("saved");
    expect((await revisions.history({ ...target(), entryFile }, board())).revisions).toHaveLength(0);
  });
  it("requires durable stop evidence before recovering an uncaptured copy", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), "edit before controller restart");
    await db.update(heartbeatRuns).set({ runtimeMode: "native", status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, copy.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverStopped();
    expect((await revisions.readCurrent(target(), board()))?.content).toBe(initial);
    expect((await copies.list(companyId, agentId, board()))[0]).toMatchObject({ state: "pending_collection", content: null });
    await appendHeartbeatRunEvent(db, { ...target(), runId: copy.runId, eventType: "native.local_process_stopped", stream: "system" });
    await copies.recoverStopped();
    expect((await revisions.readCurrent(target(), board()))?.content).toBe("edit before controller restart");
  });

  it("never treats a superseded stop receipt or unavailable environment as a save", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), "unverified live edit");
    await db.update(heartbeatRuns).set({ runtimeMode: "native", status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, copy.runId));
    await appendHeartbeatRunEvent(db, { ...target(), runId: copy.runId, eventType: "native.local_process_stopped", stream: "system" });
    await appendHeartbeatRunEvent(db, { ...target(), runId: copy.runId, eventType: "native.process_start_requested", stream: "system" });
    await copies.recoverStopped();
    expect((await revisions.readCurrent(target(), board()))?.content).toBe(initial);
    const lost = await copies.reportUnavailable(companyId, copy.runId);
    expect(lost).toMatchObject({ state: "unavailable", candidateBase64: null, processStoppedAt: null });
    expect(lost?.errorMessage).not.toContain(copy.localRoot);
  });

  it("keeps private run copies out of normal Git staging and workspace snapshots", async () => {
    const workspace = path.join(home, `workspace-${randomUUID()}`);
    await fs.mkdir(workspace);
    await execFile("git", ["init", workspace]);
    await execFile("git", ["-C", workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture"]);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    const copy = (await copies.prepare({ legacy: true, ...target(), runId, cwd: workspace }))!;
    expect(copy.localRoot).toBe(path.join(workspace, ".paperclip-runtime", `instruction-edits-${runId}`, "instructions"));
    await fs.writeFile(path.join(workspace, "deliverable.txt"), "public work");
    await execFile("git", ["-C", workspace, "add", "."]);
    const staged = await execFile("git", ["-C", workspace, "diff", "--cached", "--name-only"]);
    expect(staged.stdout).toBe("deliverable.txt\n");
    const snapshot = await gitWorkspaceSync.readGitWorkspaceSnapshot(workspace);
    try {
      const paths: unknown = snapshot?.overlayPaths;
      if (Array.isArray(paths)) {
        expect(paths).toEqual(["deliverable.txt"]);
      } else {
        // The streaming Git snapshot stores the same path set in a private
        // manifest. Inspect its actual records, not only the reported count.
        expect(paths).toMatchObject({ kind: "path_manifest", version: 1, category: "overlay", count: 1 });
        const manifest = paths as { filePath: string; category: string };
        const manifestDb = new DatabaseSync(manifest.filePath, { readOnly: true, allowExtension: false });
        try {
          const rows = manifestDb.prepare("SELECT path FROM records WHERE category = ? ORDER BY path").all(manifest.category);
          expect(rows.map((row) => row.path)).toEqual(["deliverable.txt"]);
        } finally { manifestDb.close(); }
      }
    } finally {
      if ("disposeGitWorkspaceSnapshot" in gitWorkspaceSync && typeof gitWorkspaceSync.disposeGitWorkspaceSnapshot === "function") {
        await gitWorkspaceSync.disposeGitWorkspaceSnapshot(snapshot);
      }
    }
    const files = await captureDirectorySnapshot(workspace, { exclude: [".git", ".paperclip-runtime"] });
    expect([...files.entries].map(([relative]) => relative)).toEqual(["deliverable.txt"]);
    await expect(copies.prepare({ legacy: true, ...target(), runId, cwd: home })).rejects.toThrow("different run workspace");
  });

});
