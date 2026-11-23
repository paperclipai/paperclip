import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueInboxArchives, issues } from "../../packages/db/src/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/test-embedded-postgres.js";
import { issueService } from "../../server/src/services/issues.js";
import { armArchiveStorageFault, archiveStorageFaultSql, type ArchiveFaultBinding } from "./chat-archive-storage-fault.js";

it("refuses every execution except its own single selected case", async () => {
  const binding = { companyId: randomUUID(), agentId: randomUUID(), personId: "person-0001", taskIds: [randomUUID(), randomUUID(), randomUUID()] };
  await expect(armArchiveStorageFault({ executionId: "chat-features.runner-opencode.local.inbox-search.archive-done", binding, env: { PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: JSON.stringify(["chat-features.runner-opencode.local.inbox-search.archive-done"]) } })).rejects.toThrow("single selected");
  const own = "chat-features.runner-opencode.local.inbox-search.archive-partial-failure";
  await expect(armArchiveStorageFault({ executionId: own, binding, env: { PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: JSON.stringify([own, "other"]) } })).rejects.toThrow("single selected");
  await expect(armArchiveStorageFault({ executionId: own, binding, env: { PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: JSON.stringify([own]) } })).rejects.toThrow("owned runner instance");
  expect(() => archiveStorageFaultSql("abcdefabcdef", { ...binding, personId: "x'; drop table issues; --" })).toThrow("exact owned binding");
  expect(() => archiveStorageFaultSql("abcdefabcdef", { ...binding, taskIds: binding.taskIds.slice(0, 2) })).toThrow("exact owned binding");
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
describeEmbedded("archive storage fault against the product's own archive write", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-archive-storage-fault-"); db = createDb(database.connectionString); }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), personId = `person-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: `Fault ${companyId}`, issuePrefix: `AF${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values([agentId, otherAgentId].map(id => ({ id, companyId, name: `Agent ${id.slice(0, 4)}`, role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })));
    const taskIds: string[] = [randomUUID(), randomUUID(), randomUUID()], unrelated = randomUUID();
    await db.insert(issues).values([...taskIds, unrelated].map((id, index) => ({ id, companyId, title: `Delivered ${index}`, status: "done", priority: "medium" })));
    return { binding: { companyId, agentId, personId, taskIds } satisfies ArchiveFaultBinding, otherAgentId, unrelated };
  }
  async function install(binding: ArchiveFaultBinding) {
    const statements = archiveStorageFaultSql(randomUUID().replaceAll("-", "").slice(0, 12), binding);
    await db.$client.begin(async tx => { for (const statement of statements.install) await tx.unsafe(statement); });
    return {
      statements,
      failures: async () => Promise.all(statements.failures.map(async statement => Number((await db.$client.unsafe(statement))[0]?.hits ?? 0))),
      run: async (list: string[]) => { for (const statement of list) await db.$client.unsafe(statement); },
    };
  }
  const svc = () => issueService(db);
  const asAgent = (agentId: string) => ({ archivedByActorType: "agent" as const, archivedByAgentId: agentId, archivedByRunId: null });
  const outcome = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { code?: string; cause?: { code?: string } }) => error.code ?? error.cause?.code ?? "error");

  it("fails only the third agent archive in storage, counts it, and clears on release", async () => {
    const { binding, otherAgentId, unrelated } = await seed(); const fault = await install(binding);
    const archive = (issueId: string, userId = binding.personId, agentId = binding.agentId) => outcome(svc().archiveInbox(binding.companyId, issueId, userId, new Date(), asAgent(agentId)));
    expect(await archive(binding.taskIds[0]!)).toBe("ok");
    expect(await archive(binding.taskIds[1]!)).toBe("ok");
    expect(await archive(binding.taskIds[2]!)).toBe("58030");
    expect(await archive(binding.taskIds[2]!)).toBe("58030");
    expect(await fault.failures()).toEqual([0, 0, 2]);
    // Scope: another person, another agent, a human write and an unrelated task are untouched.
    expect(await archive(binding.taskIds[2]!, "someone-else")).toBe("ok");
    expect(await archive(binding.taskIds[2]!, binding.personId, otherAgentId)).toBe("ok");
    expect(await archive(unrelated)).toBe("ok");
    const saved = await db.select().from(issueInboxArchives);
    expect(saved.filter(row => row.userId === binding.personId && binding.taskIds.includes(row.issueId)).map(row => row.archivedByAgentId)).toEqual(expect.arrayContaining([binding.agentId, binding.agentId, otherAgentId]));
    await fault.run(fault.statements.release);
    expect(await archive(binding.taskIds[2]!)).toBe("ok");
    expect(await fault.failures()).toEqual([0, 0, 2]);
    await fault.run(fault.statements.remove);
    expect(Number((await db.$client.unsafe(`select count(*) as n from pg_proc where proname like 'paperclip_e2e_archive_fault_%'`))[0]?.n)).toBe(0);
  });

  it("still lets exactly two of three parallel archives commit", async () => {
    const { binding } = await seed(); const fault = await install(binding);
    const results = await Promise.all(binding.taskIds.map(issueId => outcome(svc().archiveInbox(binding.companyId, issueId, binding.personId, new Date(), asAgent(binding.agentId)))));
    expect(results.filter(result => result === "ok")).toHaveLength(2);
    expect(results.filter(result => result === "58030")).toHaveLength(1);
    expect((await fault.failures()).reduce((a, b) => a + b, 0)).toBe(1);
    await fault.run(fault.statements.remove);
  });
});
