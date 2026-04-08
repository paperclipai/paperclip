import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  departmentMemberships,
  departments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { departmentService } from "../services/departments.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres department service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("departmentService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof departmentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-departments-service-");
    db = createDb(tempDb.connectionString);
    svc = departmentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(departmentMemberships);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(departments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompany(companyId = randomUUID()) {
    await db.insert(companies).values({
      id: companyId,
      name: `Paperclip ${companyId.slice(0, 6)}`,
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("builds a department tree with nested member counts", async () => {
    const companyId = await insertCompany();
    const root = await svc.create(companyId, { name: "Engineering" });
    const child = await svc.create(companyId, { name: "Platform", parentId: root.id });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      departmentId: child.id,
      name: "Agent Platform",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await svc.addMember(child.id, companyId, {
      principalType: "agent",
      principalId: agentId,
      role: "member",
    });

    const tree = await svc.tree(companyId);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe("Engineering");
    expect(tree[0]?.memberCount).toBe(0);
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.name).toBe("Platform");
    expect(tree[0]?.children[0]?.memberCount).toBe(1);
  });

  it("rejects agents that do not belong to the same company", async () => {
    const companyId = await insertCompany();
    const department = await svc.create(companyId, { name: "Finance" });

    await expect(
      svc.addMember(department.id, companyId, {
        principalType: "agent",
        principalId: randomUUID(),
      }),
    ).rejects.toThrow(/same company/i);
  });

  it("allows active company users to join a department", async () => {
    const companyId = await insertCompany();
    const department = await svc.create(companyId, { name: "Operations" });

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "user-1",
      status: "active",
      membershipRole: "member",
    });

    const membership = await svc.addMember(department.id, companyId, {
      principalType: "user",
      principalId: "user-1",
      role: "manager",
    });

    expect(membership.principalType).toBe("user");
    expect(membership.principalId).toBe("user-1");
    expect(membership.role).toBe("manager");
  });
});
