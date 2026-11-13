import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { agents, authUsers, companyMemberships, companies, createDb } from "@paperclipai/db";
import { createAgentSchema, sendChatMessageSchema } from "@paperclipai/shared";
import { assertAgentReportsToPrincipal, hybridOrgForCompany } from "../services/company-org.js";
import { companyStaffProfileService } from "../services/company-staff-profiles.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("company org and staff", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("company-org-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temporary?.cleanup();
  });

  it("builds a hybrid org chart with humans and agents", async () => {
    const [company] = await db.insert(companies).values({ name: "Acorn", issuePrefix: "ACORN" }).returning();
    const now = new Date();
    const [humanCeo] = await db.insert(authUsers).values({ id: "ceo-user", email: "ceo@example.com", name: "Avery", createdAt: now, updatedAt: now }).returning();
    const [humanOps] = await db.insert(authUsers).values({ id: "ops-user", email: "ops@example.com", name: "Riley", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values([
      { companyId: company!.id, principalType: "user", principalId: humanCeo!.id, status: "active", membershipRole: "owner" },
      { companyId: company!.id, principalType: "user", principalId: humanOps!.id, status: "active", membershipRole: "operator" },
    ]);
    const [agentCoo] = await db.insert(agents).values({
      companyId: company!.id, name: "Morgan", role: "coo", title: "COO", adapterType: "process", reportsToUserId: humanCeo!.id,
    }).returning();
    await db.insert(agents).values({
      companyId: company!.id, name: "Jules", role: "engineer", title: "Engineer", adapterType: "process", reportsTo: agentCoo!.id,
    });
    await companyStaffProfileService(db).upsertForMember(company!.id, humanCeo!.id, {
      jobTitle: "Chief Executive",
      orgRole: "ceo",
      reportsTo: null,
    });
    await companyStaffProfileService(db).upsertForMember(company!.id, humanOps!.id, {
      jobTitle: "Operations",
      orgRole: "operator",
      reportsTo: { type: "user", id: humanCeo!.id },
    });

    const tree = await hybridOrgForCompany(db, company!.id);
    const ceo = tree.find((node) => node.kind === "user" && node.id === humanCeo!.id);
    expect(ceo).toMatchObject({ name: "Avery", role: "ceo", title: "Chief Executive" });
    expect(ceo?.reports.some((node) => node.kind === "user" && node.id === humanOps!.id)).toBe(true);
    expect(ceo?.reports.some((node) => node.kind === "agent" && node.id === agentCoo!.id)).toBe(true);
    const coo = ceo?.reports.find((node) => node.kind === "agent" && node.id === agentCoo!.id);
    expect(coo?.reports[0]).toMatchObject({ name: "Jules" });
  });

  it("allows agents to report to a human manager", async () => {
    const [company] = await db.insert(companies).values({ name: "Pine", issuePrefix: "PINE" }).returning();
    const now = new Date();
    const [humanLead] = await db.insert(authUsers).values({ id: "lead-user", email: "lead@example.com", name: "Lead", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: humanLead!.id, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ companyId: company!.id, name: "Worker", role: "engineer", adapterType: "process", reportsToUserId: humanLead!.id });
    const tree = await hybridOrgForCompany(db, company!.id);
    expect(tree[0]).toMatchObject({ kind: "user", id: humanLead!.id });
    expect(tree[0]?.reports[0]).toMatchObject({ kind: "agent", name: "Worker" });
  });

  it("accepts recipientUserId on send_chat_message", () => {
    expect(sendChatMessageSchema.safeParse({
      body: "Need your sign-off.",
      idempotencyKey: "staff-question",
      recipientUserId: "ops-user",
    }).success).toBe(true);
  });

  it("rejects reporting to both agent and human on create", () => {
    expect(createAgentSchema.safeParse({
      name: "Worker",
      adapterType: "process",
      reportsTo: "11111111-1111-4111-8111-111111111111",
      reportsToUserId: "lead-user",
    }).success).toBe(false);
  });

  it("accepts non-UUID human manager ids when validating reportsToUserId", async () => {
    const [company] = await db.insert(companies).values({ name: "Oak", issuePrefix: "OAK" }).returning();
    const now = new Date();
    const [humanLead] = await db.insert(authUsers).values({ id: "oak-lead", email: "lead2@example.com", name: "Lead", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: humanLead!.id, status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Worker", role: "engineer", adapterType: "process" }).returning();
    await expect(assertAgentReportsToPrincipal(db, company!.id, agent!.id, null, humanLead!.id)).resolves.toBeUndefined();
  });

  it("rejects a human-and-agent reporting cycle", async () => {
    const [company] = await db.insert(companies).values({ name: "Maple", issuePrefix: "MAP" }).returning();
    const now = new Date();
    const [humanLead] = await db.insert(authUsers).values({ id: "lead-cycle", email: "cycle@example.com", name: "Lead", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: humanLead!.id, status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "Worker", role: "engineer", adapterType: "process", reportsToUserId: humanLead!.id,
    }).returning();
    await expect(companyStaffProfileService(db).upsertForMember(company!.id, humanLead!.id, {
      orgRole: "ceo",
      reportsTo: { type: "agent", id: agent!.id },
    })).rejects.toThrow("cycle");
  });

  it("excludes suspended members from the org chart", async () => {
    const [company] = await db.insert(companies).values({ name: "Elm", issuePrefix: "ELM" }).returning();
    const now = new Date();
    const [human] = await db.insert(authUsers).values({ id: "suspended-user", email: "s@example.com", name: "Suspended", createdAt: now, updatedAt: now }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: human!.id, status: "suspended", membershipRole: "operator" });
    const tree = await hybridOrgForCompany(db, company!.id);
    expect(tree.some((node) => node.kind === "user" && node.id === human!.id)).toBe(false);
  });
});
