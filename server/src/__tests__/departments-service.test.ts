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

  it("creates a department with valid data", async () => {
    const companyId = await insertCompany();
    const dept = await svc.create(companyId, { name: "Sales", description: "Revenue team" });

    expect(dept.name).toBe("Sales");
    expect(dept.companyId).toBe(companyId);
    expect(dept.status).toBe("active");
    expect(dept.description).toBe("Revenue team");
  });

  it("rejects duplicate department names within the same company", async () => {
    const companyId = await insertCompany();
    await svc.create(companyId, { name: "Marketing" });

    await expect(svc.create(companyId, { name: "Marketing" })).rejects.toThrow(/already exists/i);
  });

  it("allows same department name in different companies", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();

    const deptA = await svc.create(companyA, { name: "Engineering" });
    const deptB = await svc.create(companyB, { name: "Engineering" });

    expect(deptA.companyId).toBe(companyA);
    expect(deptB.companyId).toBe(companyB);
    expect(deptA.name).toBe(deptB.name);
  });

  it("updates department name and description", async () => {
    const companyId = await insertCompany();
    const dept = await svc.create(companyId, { name: "Old Name", description: "Old desc" });

    const updated = await svc.update(dept.id, { name: "New Name", description: "New desc" });

    expect(updated.name).toBe("New Name");
    expect(updated.description).toBe("New desc");
  });

  it("detects self-parent cycle", async () => {
    const companyId = await insertCompany();
    const dept = await svc.create(companyId, { name: "Lone Dept" });

    await expect(svc.update(dept.id, { parentId: dept.id })).rejects.toThrow(/cannot be its own parent/i);
  });

  it("detects two-node cycle (A→B→A)", async () => {
    const companyId = await insertCompany();
    const a = await svc.create(companyId, { name: "Dept A" });
    const b = await svc.create(companyId, { name: "Dept B", parentId: a.id });

    await expect(svc.update(a.id, { parentId: b.id })).rejects.toThrow(/circular/i);
  });

  it("detects three-node cycle (A→B→C→A)", async () => {
    const companyId = await insertCompany();
    const a = await svc.create(companyId, { name: "Dept A" });
    const b = await svc.create(companyId, { name: "Dept B", parentId: a.id });
    const _c = await svc.create(companyId, { name: "Dept C", parentId: b.id });

    await expect(svc.update(a.id, { parentId: _c.id })).rejects.toThrow(/circular/i);
  });

  it("allows valid reparenting", async () => {
    const companyId = await insertCompany();
    const a = await svc.create(companyId, { name: "Dept A" });
    const b = await svc.create(companyId, { name: "Dept B" });
    const c = await svc.create(companyId, { name: "Dept C", parentId: a.id });

    const updated = await svc.update(c.id, { parentId: b.id });

    expect(updated.parentId).toBe(b.id);
  });

  it("archives a department without children", async () => {
    const companyId = await insertCompany();
    const dept = await svc.create(companyId, { name: "Temp Dept" });

    const archived = await svc.archive(dept.id);

    expect(archived.status).toBe("archived");
  });

  it("rejects archiving department with active children", async () => {
    const companyId = await insertCompany();
    const parent = await svc.create(companyId, { name: "Parent" });
    await svc.create(companyId, { name: "Child", parentId: parent.id });

    await expect(svc.archive(parent.id)).rejects.toThrow(/active sub-departments/i);
  });

  it("removes a member", async () => {
    const companyId = await insertCompany();
    const dept = await svc.create(companyId, { name: "HR" });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      departmentId: dept.id,
      name: "Agent HR",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await svc.addMember(dept.id, companyId, { principalType: "agent", principalId: agentId });
    await svc.removeMember(dept.id, "agent", agentId);

    const members = await svc.listMembers(dept.id);
    expect(members).toHaveLength(0);
  });

  it("rejects duplicate membership", async () => {
    const companyId = await insertCompany();
    const dept = await svc.create(companyId, { name: "Legal" });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      departmentId: dept.id,
      name: "Agent Legal",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await svc.addMember(dept.id, companyId, { principalType: "agent", principalId: agentId });

    await expect(
      svc.addMember(dept.id, companyId, { principalType: "agent", principalId: agentId }),
    ).rejects.toThrow(/already a member/i);
  });

  it("lists departments flat", async () => {
    const companyId = await insertCompany();
    await svc.create(companyId, { name: "Dept One" });
    await svc.create(companyId, { name: "Dept Two" });

    const all = await svc.list(companyId);

    expect(all).toHaveLength(2);
  });
});
