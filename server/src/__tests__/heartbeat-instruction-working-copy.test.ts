import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, heartbeatRunEvents, issues, principalPermissionGrants } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const cleanup = vi.hoisted(() => ({ failures: new Set<string>(), revocations: new Set<string>(), attempts: new Map<string, number>() }));
vi.mock("../services/agent-instruction-working-copies.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/agent-instruction-working-copies.js")>();
  return { ...actual, agentInstructionWorkingCopyService: (...args: Parameters<typeof actual.agentInstructionWorkingCopyService>) => {
    const copies = actual.agentInstructionWorkingCopyService(...args);
    return { ...copies, prepare: async (input: Parameters<typeof copies.prepare>[0]) => {
      if (cleanup.revocations.has(input.companyId)) {
        await args[0].update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, input.companyId));
      }
      return copies.prepare(input);
    }, release: async (companyId: string, runId: string) => {
      cleanup.attempts.set(runId, (cleanup.attempts.get(runId) ?? 0) + 1);
      if (cleanup.failures.has(companyId)) throw new Error("Fixture cleanup unavailable");
      return copies.release(companyId, runId);
    } };
  } };
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping heartbeat instruction copies tests: ${support.reason}`);

describePostgres("heartbeat instruction working-copy lifecycle", () => {
  const adapterType = "instruction_working_copy_test";
  const entryFile = "policy/INSTRUCTIONS.txt";
  const initial = "\uFEFF# Original\r\n☃\n", edited = "\uFEFF# Saved\r\nKeep across runs. ☃\n";
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const captured = new Map<string, { instructionPath: string | null; before: string | null; context: Record<string, unknown> }>();
  const failures = new Set<string>();

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-instruction-copies-")));
    process.env.PAPERCLIP_HOME = home;
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-instruction-copies-db-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false, supportsInstructionsBundle: true,
      execute: async input => {
        const instructionPath = typeof input.config.instructionsFilePath === "string" ? input.config.instructionsFilePath : null;
        captured.set(input.runId, { instructionPath, before: instructionPath ? await fs.readFile(instructionPath, "utf8") : null, context: structuredClone(input.context) });
        if (instructionPath) await fs.writeFile(instructionPath, edited);
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        await input.onProviderStopped?.();
        if (failures.has(input.agent.id)) throw new Error("Invalid fixture adapter configuration");
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (home) {
      const makeRemovable = async (directory: string): Promise<void> => {
        await fs.chmod(directory, 0o700);
        for (const child of await fs.readdir(directory, { withFileTypes: true })) if (child.isDirectory()) await makeRemovable(path.join(directory, child.name));
      };
      await makeRemovable(home);
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Instruction lifecycle fixture", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "operator" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    const root = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Editor", adapterConfig: {} });
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), initial);
    const cwd = await fs.mkdtemp(path.join(home, "workspace-"));
    await db.insert(agents).values({ id: agentId, companyId, name: "Editor", adapterType, status: "idle", adapterConfig: { cwd, instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, membershipRole: "member" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Save agent instructions", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId, root };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>) {
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual", payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run!.id));
    return { finished: finished!, events, input: captured.get(run!.id)! };
  }

  it("dispatches a private copy, saves exact bytes on provider stop, and restores them on the next run", async () => {
    const f = await seed();
    const first = await execute(f);
    expect(first.finished.status, first.finished.error ?? undefined).toBe("succeeded");
    expect(first.input.before).toBe(initial);
    expect(first.input.instructionPath).not.toBe(path.join(f.root, entryFile));
    expect(first.input.context.paperclipTaskMarkdown).toContain("Your persistent agent directory is");
    expect(first.finished.resultJson?.instructionSave).toMatchObject({ state: "saved", contract: "agent_files", entryFile });
    expect(first.events.some(event => event.eventType === "instruction_save" && event.payload?.state === "saved")).toBe(true);
    expect(await fs.readFile(path.join(f.root, entryFile), "utf8")).toBe(edited);
    await expect(fs.stat(first.input.instructionPath!)).rejects.toMatchObject({ code: "ENOENT" });
    const second = await execute(f);
    expect(second.finished.status, second.finished.error ?? undefined).toBe("succeeded");
    expect(second.input.before).toBe(edited);
    expect(second.finished.resultJson?.instructionSave).toMatchObject({ state: "unchanged" });
  });

  it("continues without a copy or save claim when access is revoked after dispatch admission", async () => {
    const f = await seed();
    cleanup.revocations.add(f.companyId);
    const { finished, input, events } = await execute(f);
    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    expect(input.instructionPath).toBeNull();
    expect(input.context.paperclipTaskMarkdown).toContain("No editable agent instruction working copy is registered");
    expect(finished.resultJson?.instructionSave).toBeUndefined();
    expect(events.some(event => event.eventType === "instruction_save" && event.payload?.state === "unavailable")).toBe(true);
    expect(await fs.readFile(path.join(f.root, entryFile), "utf8")).toBe(initial);
  });

  it("keeps the successful save and result when cleanup fails, without repeating that failure in outer teardown", async () => {
    const f = await seed();
    cleanup.failures.add(f.companyId);
    const { finished, events } = await execute(f);
    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    expect(finished.resultJson?.instructionSave).toMatchObject({ state: "saved" });
    expect(await fs.readFile(path.join(f.root, entryFile), "utf8")).toBe(edited);
    expect(cleanup.attempts.get(finished.id)).toBe(1);
    expect(events.filter(event => event.eventType === "instruction_cleanup")).toEqual([expect.objectContaining({ level: "warn", payload: { state: "deferred" } })]);
  });

  it("preserves stopped-provider edits and releases the copy even if adapter dispatch then fails", async () => {
    const f = await seed();
    failures.add(f.agentId);
    const { finished, input, events } = await execute(f);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("Invalid fixture adapter configuration");
    expect(events.some(event => event.eventType === "instruction_save" && event.payload?.state === "saved")).toBe(true);
    expect(await fs.readFile(path.join(f.root, entryFile), "utf8")).toBe(edited);
    await expect(fs.stat(input.instructionPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
