import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb } from "@paperclipai/db";
import { accessService } from "../services/access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping agent membership PostgreSQL test: ${support.reason ?? "unsupported host"}`);

describePostgres("board agent membership discovery on PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-board-agent-members-");
    db = createDb(database.connectionString);
  }, 20_000);
  afterAll(async () => { await database?.cleanup(); });

  it("joins UUID agents to text principals and returns only their same-company grants", async () => {
    const companyId = randomUUID(), foreignCompanyId = randomUUID();
    const agentId = randomUUID(), foreignAgentId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Board grant fixture", issuePrefix: `B${companyId.slice(0, 6)}` },
      { id: foreignCompanyId, name: "Foreign fixture", issuePrefix: `F${foreignCompanyId.slice(0, 6)}` },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Morgan", role: "engineer", status: "idle", adapterType: "codex_local" },
      { id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign", role: "engineer", status: "idle", adapterType: "codex_local" },
    ]);
    const [member] = await db.insert(companyMemberships).values([
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
      // A malformed/foreign text principal must not match an actual local agent.
      { companyId, principalType: "agent", principalId: foreignAgentId },
      { companyId, principalType: "agent", principalId: "not-a-uuid" },
      { companyId, principalType: "user", principalId: agentId },
      { companyId: foreignCompanyId, principalType: "agent", principalId: foreignAgentId },
    ]).returning();
    const service = accessService(db);
    await service.setMemberPermissions(companyId, member.id, [
      { permissionKey: "agents:configure", scope: { agentIds: [agentId] } },
      { permissionKey: "tasks:assign", scope: null },
    ], "board-fixture");
    const listed = await service.listAgentMembers(companyId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: member.id, companyId, principalType: "agent", principalId: agentId });
    expect(listed[0].grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ companyId, principalType: "agent", principalId: agentId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } }),
      expect.objectContaining({ permissionKey: "tasks:assign" }),
    ]));
    expect(listed[0].grants).toHaveLength(2);
    await service.setMemberPermissions(companyId, member.id, [], "board-fixture");
    expect((await service.listAgentMembers(companyId))[0].grants).toEqual([]);
  });
});
