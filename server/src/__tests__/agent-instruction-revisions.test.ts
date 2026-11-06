import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, agentApiKeys, companies, authUsers, companyMemberships, principalPermissionGrants, heartbeatRuns,
  agentInstructionRevisions, agentInstructionHeads, issueThreadInteractions, issues, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { instructionBytes, instructionPath, materializeInstructionBytes, readInstructionBytes } from "../services/agent-instruction-files.js";
import { agentInstructionsService, resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { upsertAgentInstructionsFileSchema } from "@paperclipai/shared";

describe("canonical instruction revisions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof agentInstructionRevisionService>;
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let companyId: string, agentId: string, userId: string, actorId: string, runId: string, root: string;
  let actor: AuthorizationActor;
  const entryFile = "policy/INSTRUCTIONS.txt";
  const initial = "\\uFEFF# Original\r\n☃\0\n";
  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-revisions-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("instruction-revisions-db-");
    db = createDb(database.connectionString);
    service = agentInstructionRevisionService(db);
  }, 90_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); actorId = randomUUID(); userId = randomUUID(); runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Instruction tests", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } },
      { id: actorId, companyId, name: "Writer" },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: actorId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } },
      { companyId, principalType: "agent", principalId: actorId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: actorId, invocationSource: "on_demand", responsibleUserId: userId });
    actor = { type: "agent", companyId, agentId: actorId, runId, source: "agent_jwt" };
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), initial);
  });
  const target = () => ({ companyId, agentId });
  async function base() { return (await service.readCurrent(target(), actor))!; }
  async function save(content: string, baseRevisionId: string | null) {
    return service.commit({ ...target(), entryFile, content, baseRevisionId, source: "cleanup" }, actor);
  }
  it("reads peer instructions with read-only agent and responsible-user grants but denies saves", async () => {
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:read", scope: { agentIds: [agentId] } },
      { companyId, principalType: "agent", principalId: actorId, permissionKey: "agents:read", scope: { agentIds: [agentId] } },
    ]);
    const first = await base();
    expect(first.content).toBe(initial);
    await expect(service.history({ ...target(), entryFile }, actor)).resolves.toMatchObject({ revisions: [] });
    await expect(save("read access cannot write", first.revision.id)).rejects.toMatchObject({ status: 403 });
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
    await expect(base()).rejects.toMatchObject({ status: 403 });
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
  });
  it.each(["current", "history", "revision", "diff", "candidates"])("denies peer %s reads without a configuration grant or responsible-user target access", async (operation) => {
    const first = await base();
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
    const read = () => {
      if (operation === "current") return service.readCurrent(target(), actor);
      if (operation === "history") return service.history({ ...target(), entryFile }, actor);
      if (operation === "revision") return service.readRevision({ ...target(), entryFile, revisionId: first.revision.id }, actor);
      if (operation === "diff") return service.diff({ ...target(), entryFile, fromRevisionId: first.revision.id, toRevisionId: first.revision.id }, actor);
      return agentInstructionWorkingCopyService(db).list(companyId, agentId, actor);
    };
    await expect(read()).rejects.toMatchObject({ status: 403 });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [actorId] } });
    await expect(read()).rejects.toMatchObject({ status: 403 });
  });
  it.each(["current", "history", "revision", "diff", "candidates", "write"])("requires the caller's own target-scoped grant for peer %s access", async (operation) => {
    const first = await base();
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, actorId));
    const access = () => {
      if (operation === "current") return service.readCurrent(target(), actor);
      if (operation === "history") return service.history({ ...target(), entryFile }, actor);
      if (operation === "revision") return service.readRevision({ ...target(), entryFile, revisionId: first.revision.id }, actor);
      if (operation === "diff") return service.diff({ ...target(), entryFile, fromRevisionId: first.revision.id, toRevisionId: first.revision.id }, actor);
      if (operation === "write") return save("authorized peer edit", first.revision.id);
      return agentInstructionWorkingCopyService(db).list(companyId, agentId, actor);
    };
    // The responsible user retains permission on the target throughout.
    await expect(access()).rejects.toMatchObject({ status: 403 });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: actorId, permissionKey: "agents:configure", scope: { agentIds: [actorId] } });
    await expect(access()).rejects.toMatchObject({ status: 403 });
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [agentId] } }).where(eq(principalPermissionGrants.principalId, actorId));
    // The current content ETag is readable as a revision once access is granted.
    await expect(access()).resolves.toBeDefined();
  });
  it("allows self and board reads without requiring instruction edit permission", async () => {
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
    const selfRoot = resolveManagedInstructionsRoot({ id: actorId, companyId, name: "Writer", adapterConfig: {} });
    await fs.mkdir(selfRoot, { recursive: true });
    await fs.writeFile(path.join(selfRoot, "AGENTS.md"), "Self instructions");
    expect((await service.readCurrent({ companyId, agentId: actorId }, actor))?.content).toBe("Self instructions");
    expect((await service.readCurrent(target(), { type: "board", userId, source: "session" }))?.content).toBe(initial);
  });
  it("reads and replaces current bytes using content tokens without storing revisions", async () => {
    const first = await base();
    expect(first.content).toBe(initial);
    const saved = await save("# Changed\r\n", first.revision.id);
    expect(saved).toMatchObject({ changed: true, materialization: "current" });
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(saved.content);
    expect((await save(saved.content, first.revision.id)).changed).toBe(false);
    expect((await service.history({ ...target(), entryFile }, actor)).revisions).toHaveLength(1);
    expect(await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId))).toHaveLength(0);
  });
  it("names the writer, run and save time of the current bytes, never the reader", async () => {
    const board = { type: "board", userId, source: "session" } as const;
    const unrecorded = await base();
    expect(unrecorded.revision).toMatchObject({ actorAgentId: null, actorUserId: null, responsibleUserId: null, sourceRunId: null });
    const saved = await save("# Saved by the writer\n", unrecorded.revision.id);
    expect(saved.revision).toMatchObject({ actorAgentId: actorId, sourceRunId: runId, responsibleUserId: userId });
    expect(new Date(saved.revision.createdAt).getTime()).toBeGreaterThan(0);
    const read = (await service.readCurrent(target(), board))!;
    expect(read.revision).toMatchObject({ id: saved.revision.id, actorAgentId: actorId, actorUserId: null, sourceRunId: runId,
      responsibleUserId: userId, createdAt: saved.revision.createdAt });
    // An identical re-send by another writer does not take over the save.
    const resent = await service.commit({ ...target(), entryFile, content: saved.content, baseRevisionId: saved.revision.id, source: "board" }, board);
    expect(resent).toMatchObject({ changed: false, revision: { actorAgentId: actorId, sourceRunId: runId, createdAt: saved.revision.createdAt } });
  });
  it("records an identical save over unrecorded bytes as an adoption, not a save", async () => {
    const first = await base();
    const adopted = await save(first.content, first.revision.id);
    expect(adopted).toMatchObject({ changed: false, revision: { actorAgentId: null, sourceRunId: null } });
    expect((await service.history({ ...target(), entryFile }, actor)).revisions).toEqual([]);
    expect((await base()).revision).toMatchObject({ actorAgentId: null, sourceRunId: null });
  });
  it("lists every save newest first with its writer and pages through them", async () => {
    const board = { type: "board", userId, source: "session" } as const;
    const first = await base();
    const one = await save("one", first.revision.id);
    const two = await service.commit({ ...target(), entryFile, content: "two", baseRevisionId: one.revision.id, source: "board" }, board);
    const three = await service.commit({ ...target(), entryFile, content: "three", baseRevisionId: two.revision.id, source: "tool" }, actor);
    const all = await service.history({ ...target(), entryFile }, board);
    expect(all.nextCursor).toBeNull();
    expect(all.revisions.map(revision => [revision.contentHash, revision.source, revision.actorAgentId, revision.actorUserId, revision.sourceRunId])).toEqual([
      [three.revision.contentHash, "tool", actorId, null, runId],
      [two.revision.contentHash, "board", null, userId, null],
      [one.revision.contentHash, "cleanup", actorId, null, runId],
    ]);
    expect(all.revisions.map(revision => revision.createdAt)).toEqual([three, two, one].map(receipt => receipt.revision.createdAt));
    expect(all.revisions.map(revision => revision.byteLength)).toEqual([5, 3, 3]);
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await service.history({ ...target(), entryFile, cursor, limit: 1 }, board);
      pages.push(...page.revisions.map(revision => revision.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages).toEqual(all.revisions.map(revision => revision.id));
    // The latest save is still the current content; older saves keep metadata only.
    expect(await service.readRevision({ ...target(), entryFile, revisionId: all.revisions[0]!.id }, board)).toMatchObject({ content: "three" });
    await expect(service.readRevision({ ...target(), entryFile, revisionId: all.revisions[2]!.id }, board))
      .rejects.toMatchObject({ status: 404, details: { code: "INSTRUCTION_REVISION_CONTENT_NOT_RETAINED" } });
    await expect(service.restore({ ...target(), entryFile, baseRevisionId: three.revision.id, revisionId: all.revisions[2]!.id }, board))
      .rejects.toMatchObject({ status: 404 });
    expect(await service.diff({ ...target(), entryFile, fromRevisionId: all.revisions[0]!.id, toRevisionId: three.revision.id }, board))
      .toMatchObject({ added: "", removed: "" });
  });
  it("requires a matching initial content token and serializes competing saves", async () => {
    await expect(save("without reading", null)).rejects.toMatchObject({ status: 409 });
    const first = await base();
    const results = await Promise.allSettled([save("one", first.revision.id), save("two", first.revision.id)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });
  it("does not claim a save when atomic file replacement fails", async () => {
    const first = await base();
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("interrupted replacement"));
    await expect(save("new content", first.revision.id)).rejects.toThrow("interrupted replacement");
    rename.mockRestore();
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
    service = agentInstructionRevisionService(db);
    await service.materializeCurrent(target());
    expect((await base()).content).toBe(initial);
    expect((await save("new content", first.revision.id)).content).toBe("new content");
  });
  it("allows authorized peer edits but rejects missing, forged and revoked responsible identity", async () => {
    const first = await base();
    await save("peer save", first.revision.id);
    await expect(service.commit({ ...target(), entryFile, content: "forged", baseRevisionId: first.revision.id, source: "tool" }, { ...actor, onBehalfOfUserId: "forged" })).rejects.toMatchObject({ status: 403 });
    await db.update(heartbeatRuns).set({ responsibleUserId: null }).where(eq(heartbeatRuns.id, runId));
    await expect(save("missing", first.revision.id)).rejects.toMatchObject({ status: 403 });
    await db.update(heartbeatRuns).set({ responsibleUserId: userId }).where(eq(heartbeatRuns.id, runId));
    await db.update(companyMemberships).set({ status: "suspended" }).where(and(eq(companyMemberships.principalId, userId), eq(companyMemberships.companyId, companyId)));
    await expect(save("revoked", first.revision.id)).rejects.toMatchObject({ status: 403 });
  });
  it("rechecks user target scope and agent containment, even with shadow authorization enabled", async () => {
    const first = await base();
    const previousShadow = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW;
    process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW = "true";
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [actorId] } }).where(eq(principalPermissionGrants.principalId, userId));
    await expect(save("denied", first.revision.id)).rejects.toMatchObject({ status: 403 });
    await db.update(principalPermissionGrants).set({ scope: null }).where(eq(principalPermissionGrants.principalId, userId));
    await db.update(agents).set({ permissions: { trustPreset: "low_trust_review" } }).where(eq(agents.id, actorId));
    await expect(save("restricted", first.revision.id)).rejects.toMatchObject({ status: 403 });
    if (previousShadow === undefined) delete process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW; else process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW = previousShadow;
  });
  it("keeps suggest-only protected-change consent and explicit configure scope restrictions", async () => {
    const first = await base();
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, actorId));
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: actorId, permissionKey: "agents:suggest-changes" });
    await expect(save("needs approval", first.revision.id)).rejects.toMatchObject({ status: 403 });
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, actorId));
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: actorId, permissionKey: "agents:configure", scope: { agentIds: [actorId] } });
    await expect(save("out of scope", first.revision.id)).rejects.toMatchObject({ status: 403 });
  });
  it("consumes accepted protected-change approval only with a successful CAS commit", async () => {
    const first = await base();
    const sourceRunId = randomUUID(), issueId = randomUUID(), interactionId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: actorId, status: "succeeded" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review instructions" });
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, actorId));
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: actorId, permissionKey: "agents:suggest-changes" });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation", status: "accepted", sourceRunId, createdByAgentId: actorId,
      payload: { version: 1, prompt: "Apply the instruction change?", detailsMarkdown: "```diff\n+approved\n```", target: { type: "custom", key: `agent:${agentId}:instructions`, revisionId: "proposal" } },
      result: { version: 1, outcome: "accepted" }, resolvedByUserId: userId, resolvedAt: new Date(),
    });
    expect((await service.readCurrent(target(), actor))?.revision.id).toBe(first.revision.id);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)))[0].result).not.toHaveProperty("consumedAt");
    await expect(save("approved", randomUUID())).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)))[0].result).not.toHaveProperty("consumedAt");
    const receipt = await save("approved", first.revision.id);
    expect(receipt.changed).toBe(true);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)))[0].result).toMatchObject({ consumedByRunId: runId });
    await expect(save("another unapproved change", receipt.revision.id)).rejects.toMatchObject({ status: 403 });
  });
  it("shares head/CAS and attribution between board and agent writers", async () => {
    const first = await base();
    const board = { type: "board", userId, source: "session" } as const;
    const saved = await service.commit({ ...target(), entryFile, content: "board edit", baseRevisionId: first.revision.id, source: "board" }, board);
    expect(saved.revision).toMatchObject({ actorUserId: userId, responsibleUserId: userId, actorAgentId: null, sourceRunId: null, source: "api" });
    await expect(save("stale agent edit", first.revision.id)).rejects.toMatchObject({ status: 409 });
  });
  it("seeds a nested legacy managed entry and never imports a different AGENTS.md", async () => {
    await fs.writeFile(path.join(root, "AGENTS.md"), "unrelated");
    await db.update(agents).set({ adapterConfig: { instructionsFilePath: path.join(root, entryFile) } }).where(eq(agents.id, agentId));
    const first = await base();
    expect(first.content).toBe(initial);
    expect(first.revision.entryFile).toBe(entryFile);
    await db.update(agents).set({ adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "missing.md" } }).where(eq(agents.id, agentId));
    expect(await service.readCurrent(target(), actor)).toBeNull();
    await expect(save("wrong entry", first.revision.id)).rejects.toMatchObject({ status: 409, details: { code: "INSTRUCTION_ENTRY_CHANGED" } });
  });
  it("rejects cross-company targets, foreign revisions, and revoked API keys", async () => {
    const first = await base();
    await expect(service.readRevision({ ...target(), entryFile, revisionId: randomUUID() }, actor)).rejects.toMatchObject({ status: 404 });
    await expect(service.readCurrent({ companyId: randomUUID(), agentId }, actor)).rejects.toMatchObject({ status: 404 });
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: keyId, companyId, agentId: actorId, name: "test", keyHash: randomUUID(), responsibleUserId: userId, revokedAt: new Date() });
    await expect(service.commit({ ...target(), entryFile, content: "key", baseRevisionId: first.revision.id, source: "api" }, { ...actor, keyId })).rejects.toMatchObject({ status: 403 });
    await expect(db.insert(agentInstructionHeads).values({ companyId: randomUUID(), agentId, entryFile, revisionId: first.revision.id })).rejects.toThrow();
  });
  it("rejects invalid content, symlinks, traversal and external bundles without changing canonical bytes", async () => {
    const first = await base();
    expect(() => instructionBytes("\ud800")).toThrow("UTF-8");
    expect(() => instructionBytes(new Uint8Array([0xff]))).toThrow("UTF-8");
    expect(() => instructionBytes("a".repeat(1024 * 1024 + 1))).toThrow("1 MiB");
    for (const value of ["../AGENTS.md", "/etc/passwd", "a/../AGENTS.md", "a\\b", "a//b"]) expect(() => instructionPath(value)).toThrow();
    await fs.unlink(path.join(root, entryFile));
    await fs.symlink(path.join(home, "outside"), path.join(root, entryFile));
    await expect(save("symlink", first.revision.id)).rejects.toMatchObject({ status: 422 });
    await fs.unlink(path.join(root, entryFile));
    await fs.rm(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.symlink(home, path.dirname(path.join(root, entryFile)));
    await expect(readInstructionBytes(root, entryFile)).rejects.toMatchObject({ status: 422 });
    await db.update(agents).set({ adapterConfig: { instructionsBundleMode: "external", instructionsRootPath: home } }).where(eq(agents.id, agentId));
    await expect(save("external", first.revision.id)).rejects.toMatchObject({ details: { code: "INSTRUCTION_MANAGED_BUNDLE_REQUIRED" } });
    expect((await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId)))).toHaveLength(0);
  });
  it.skipIf(process.platform !== "darwin")("accepts macOS temporary directory aliases while rejecting links within storage", async () => {
    const aliasRoot = home.replace(/^\/private\/(var|tmp)\//, "/$1/");
    expect(aliasRoot).not.toBe(home);
    await materializeInstructionBytes(aliasRoot, "alias/AGENTS.md", Buffer.from("persisted"));
    expect(await readInstructionBytes(aliasRoot, "alias/AGENTS.md")).toEqual(Buffer.from("persisted"));
    await fs.symlink(path.join(home, "alias"), path.join(home, "linked-agent"));
    await expect(readInstructionBytes(path.join(aliasRoot, "linked-agent"), "AGENTS.md"))
      .rejects.toMatchObject({ status: 422 });
  });
  it("requires the content API for the configured entry and rejects forged fields", async () => {
    await base();
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    await expect(agentInstructionsService(db).writeFile(agent, entryFile, "bypass")).rejects.toMatchObject({ details: { code: "INSTRUCTION_REVISION_REQUIRED" } });
    await expect(agentInstructionsService(db).deleteFile(agent, entryFile)).rejects.toMatchObject({ status: 422 });
    expect(upsertAgentInstructionsFileSchema.safeParse({ path: entryFile, content: "bad", responsibleUserId: userId }).success).toBe(false);
  });
});
