import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, principalPermissionGrants, heartbeatRuns, issues, agentInstructionRevisions, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveManagedInstructionsRoot } from "../agent-instructions.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("canonical instruction tools through native authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  let companyId: string, agentId: string, targetAgentId: string, userId: string, runId: string, issueId: string, root: string;
  let authority: PaperclipRunnerToolAuthority;
  const entryFile = "policy/ENTRY.md";
  const original = "\uFEFF# Original\r\n\0☃\n";
  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-tool-home-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("instruction-tool-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    [companyId, agentId, targetAgentId, userId, runId, issueId] = Array.from({ length: 6 }, () => randomUUID());
    await db.insert(companies).values({ id: companyId, name: "Tool scope", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ id: targetAgentId, companyId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Caller", status: "active" },
      { id: targetAgentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [targetAgentId] } },
      { companyId, principalType: "agent", principalId: agentId, permissionKey: "agents:configure", scope: { agentIds: [targetAgentId] } },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Maintain instructions", status: "in_progress", workMode: "standard", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "on_demand", responsibleUserId: userId });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), original);
  });
  const call = (tool: string, args: Record<string, unknown> = {}) => authority.execute({ tool, callId: randomUUID(), arguments: { targetAgentId, ...args } }) as Promise<any>;
  it("bridges old native instruction tools to current files without writing history", async () => {
    const first = await call("read_agent_instructions");
    expect(first).toMatchObject({ entryFile, content: original });
    const changed = await call("update_agent_instructions", { entryFile, content: "changed\r\n", baseRevisionId: first.revision.id });
    expect(changed.revision).toMatchObject({ responsibleUserId: userId, actorAgentId: agentId, sourceRunId: runId });
    expect((await call("get_agent_instruction_history", { entryFile })).revisions).toHaveLength(0);
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe("changed\r\n");
    await expect(call("update_agent_instructions", { entryFile, content: "stale", baseRevisionId: first.revision.id })).rejects.toMatchObject({ status: 409 });
    expect((await call("read_agent_instructions")).content).toBe("changed\r\n");
  });
  it("serializes duplicate writes at the filesystem commit and replays the exact receipt after restart", async () => {
    const first = await call("read_agent_instructions");
    const content = "\uFEFF# Instructions — 日本語 🦀\r\n".repeat(600) + "\nFINAL TAIL\n";
    const request = { tool: "update_agent_instructions", callId: randomUUID(), arguments: {
      targetAgentId, entryFile, content, baseRevisionId: first.revision.id,
    } };
    const originalRename = fs.rename.bind(fs);
    let reached!: () => void, release!: () => void;
    const atCommit = new Promise<void>((resolve) => { reached = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === path.join(root, entryFile)) {
        writes++;
        reached();
        await barrier;
      }
      return originalRename(source, destination);
    });
    try {
      const pending = authority.execute(request);
      await atCommit;
      const duplicate = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId }).execute(request);
      expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(original);
      release();
      const receipt = await pending as any;
      expect(await duplicate).toEqual(receipt);
      authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
      expect(await authority.execute(request)).toEqual(receipt);
      const bytes = await fs.readFile(path.join(root, entryFile));
      expect(bytes).toEqual(Buffer.from(content));
      expect(receipt.revision.byteLength).toBe(bytes.length);
      expect(receipt.revision.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(writes).toBe(1);
      expect((await db.select().from(activityLog).where(eq(activityLog.runId, runId))).filter((event) => event.action === "agent.files_updated")).toHaveLength(1);
      await expect(authority.execute({ ...request, arguments: { ...request.arguments, content: "conflicting replay" } })).rejects.toThrow("idempotency_conflict");
      expect(await fs.readFile(path.join(root, entryFile))).toEqual(bytes);
      await expect(call("update_agent_instructions", { entryFile, baseRevisionId: receipt.revision.id, content: "🦀".repeat(300_000) })).rejects.toMatchObject({ status: 422 });
      expect(writes).toBe(1);
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
      await expect(authority.execute(request)).rejects.toMatchObject({ status: 403 });
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it.each(["after_file_rename", "receipt_persistence"])("retains durable attempt evidence and refuses replay after rollback at %s", async (fault) => {
    const first = await call("read_agent_instructions");
    const request = { tool: "update_agent_instructions", callId: randomUUID(), arguments: {
      targetAgentId, entryFile, content: "written before database rollback\r\n", baseRevisionId: first.revision.id,
    } };
    const key = `instruction:${request.callId}`;
    if (fault === "receipt_persistence") {
      // This is an actual PostgreSQL transaction rollback, after the real
      // filesystem rename and attempted audit insert, before receipt commit.
      await db.execute(sql.raw(`CREATE FUNCTION reject_instruction_test_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.id = '${runId}' AND NEW.result_json->'semanticToolReceipts' ? '${key}' THEN
            RAISE EXCEPTION 'injected receipt persistence failure';
          END IF;
          RETURN NEW;
        END $$`));
      await db.execute(sql.raw(`CREATE TRIGGER reject_instruction_test_receipt BEFORE UPDATE ON heartbeat_runs
        FOR EACH ROW EXECUTE FUNCTION reject_instruction_test_receipt()`));
    }
    const originalRename = fs.rename.bind(fs);
    let writes = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await originalRename(source, destination);
      if (destination === path.join(root, entryFile)) {
        writes++;
        if (fault === "after_file_rename") throw new Error("injected failure after rename");
      }
    });
    try {
      await expect(authority.execute(request)).rejects.toMatchObject({ code: "semantic_tool_outcome_unknown" });
      expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(request.arguments.content);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect((run!.resultJson as any).instructionToolAttempts[key]).toMatchObject({
        operationId: request.tool, targetAgentId, inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect((run!.resultJson as any).semanticToolReceipts?.[key]).toBeUndefined();
      const audit = await db.select().from(activityLog).where(eq(activityLog.runId, runId));
      expect(audit.filter((event) => event.action === "agent.instruction_write_attempted")).toHaveLength(1);
      expect(audit.filter((event) => event.action === "agent.files_updated")).toHaveLength(0);
      authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
      await expect(authority.execute(request)).rejects.toMatchObject({ code: "semantic_tool_outcome_unknown" });
      await expect(authority.execute({ ...request, arguments: { ...request.arguments, content: "different" } }))
        .rejects.toThrow("idempotency_conflict");
      expect(writes).toBe(1);
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
      await expect(authority.execute(request)).rejects.toMatchObject({ status: 403 });
    } finally {
      spy.mockRestore();
      if (fault === "receipt_persistence") {
        await db.execute(sql.raw("DROP TRIGGER reject_instruction_test_receipt ON heartbeat_runs"));
        await db.execute(sql.raw("DROP FUNCTION reject_instruction_test_receipt()"));
      }
    }
  });

  it("replays a committed receipt after its database commit acknowledgement is lost", async () => {
    const first = await call("read_agent_instructions");
    const request = { tool: "update_agent_instructions", callId: randomUUID(), arguments: {
      targetAgentId, entryFile, content: "committed but acknowledgement lost\n", baseRevisionId: first.revision.id,
    } };
    const transaction = db.transaction.bind(db);
    let commits = 0;
    const spy = vi.spyOn(db, "transaction").mockImplementation(async (...args) => {
      const result = await transaction(...args);
      if (++commits === 2) throw new Error("injected lost commit acknowledgement");
      return result;
    });
    try {
      await expect(authority.execute(request)).rejects.toThrow("injected lost commit acknowledgement");
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const receipt = (run!.resultJson as any).semanticToolReceipts[`instruction:${request.callId}`].result;
      expect(receipt).toMatchObject({ changed: true, content: request.arguments.content });
      authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
      expect(await authority.execute(request)).toEqual(receipt);
      const audit = await db.select().from(activityLog).where(eq(activityLog.runId, runId));
      expect(audit.filter((event) => event.action === "agent.instruction_write_attempted")).toHaveLength(1);
      expect(audit.filter((event) => event.action === "agent.files_updated")).toHaveLength(1);
      expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(request.arguments.content);
    } finally { spy.mockRestore(); }
  });

  it.each(["validation", "stale_base", "oversized"])("replays a definite %s failure after restart without executing again", async (fault) => {
    const first = await call("read_agent_instructions");
    const request = { tool: "update_agent_instructions", callId: randomUUID(), arguments: {
      targetAgentId, entryFile, content: fault === "oversized" ? "🦀".repeat(300_000) : "requested update",
      baseRevisionId: first.revision.id, ...(fault === "validation" ? { unexpected: true } : {}),
    } };
    if (fault === "stale_base") await fs.writeFile(path.join(root, entryFile), "newer canonical bytes");
    const originalRename = fs.rename.bind(fs);
    let writes = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === path.join(root, entryFile)) writes++;
      return originalRename(source, destination);
    });
    try {
      const failure = await authority.execute(request).then(() => null, (error: unknown) => error) as any;
      expect(failure).toMatchObject({ status: fault === "validation" ? 400 : fault === "stale_base" ? 409 : 422 });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const saved = (run!.resultJson as any).instructionToolAttempts[`instruction:${request.callId}`].failure;
      expect(saved).toMatchObject({ status: failure.status, message: failure.message });
      // The stale request would now pass CAS if it were executed again.
      await fs.writeFile(path.join(root, entryFile), original);
      authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
      await expect(authority.execute(request)).rejects.toMatchObject(saved);
      await expect(authority.execute(request)).rejects.toMatchObject(saved);
      await expect(authority.execute({ ...request, arguments: { ...request.arguments, content: "different" } }))
        .rejects.toThrow("idempotency_conflict");
      expect(writes).toBe(0);
      expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(original);
      const audit = await db.select().from(activityLog).where(eq(activityLog.runId, runId));
      expect(audit.filter((event) => event.action === "agent.instruction_write_attempted")).toHaveLength(1);
      expect(audit.filter((event) => event.action === "agent.files_updated")).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });

  it("does not claim a final failure when its failure receipt cannot be persisted", async () => {
    const first = await call("read_agent_instructions");
    const request = { tool: "update_agent_instructions", callId: randomUUID(), arguments: {
      targetAgentId, entryFile, content: "invalid input", baseRevisionId: first.revision.id, unexpected: true,
    } };
    const transaction = db.transaction.bind(db);
    let attempts = 0;
    const spy = vi.spyOn(db, "transaction").mockImplementation(async (...args) => {
      if (++attempts === 3) throw new Error("injected failure receipt outage");
      return transaction(...args);
    });
    try {
      await expect(authority.execute(request)).rejects.toMatchObject({ code: "semantic_tool_outcome_unknown" });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect((run!.resultJson as any).instructionToolAttempts[`instruction:${request.callId}`].failure).toBeUndefined();
      authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
      await expect(authority.execute(request)).rejects.toMatchObject({ code: "semantic_tool_outcome_unknown" });
      expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(original);
    } finally { spy.mockRestore(); }
  });

  it("rejects supplied identity and missing CAS bases before changing content", async () => {
    const first = await call("read_agent_instructions");
    for (const identity of ["companyId", "agentId", "runId", "responsibleUserId", "onBehalfOfUserId", "actor"]) {
      await expect(call("update_agent_instructions", { entryFile, content: "forged", baseRevisionId: first.revision.id, [identity]: randomUUID() })).rejects.toMatchObject({ status: 400 });
    }
    await expect(call("update_agent_instructions", { entryFile, content: "missing base" })).rejects.toMatchObject({ status: 400 });
    expect((await call("read_agent_instructions")).content).toBe(original);
    expect(await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, targetAgentId))).toHaveLength(0);
  });
  it("rechecks responsible-user access and rejects a cross-company target", async () => {
    const first = await call("read_agent_instructions");
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
    await expect(call("update_agent_instructions", { entryFile, content: "revoked", baseRevisionId: first.revision.id })).rejects.toMatchObject({ status: 403 });
    const foreignCompanyId = randomUUID(), foreignAgentId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(agents).values({ id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign" });
    await expect(call("read_agent_instructions", { targetAgentId: foreignAgentId })).rejects.toMatchObject({ status: 404 });
    await expect(call("update_agent_instructions", { targetAgentId: foreignAgentId, entryFile, content: "foreign", baseRevisionId: null })).rejects.toMatchObject({ status: 404 });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
    await expect(call("read_agent_instructions")).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(original);
  });
});
