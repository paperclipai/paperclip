import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

// TSMC-21543. A card titled "BOARD ACTION REQUIRED" with NEITHER an agent nor a
// user owner matches none of the Console's three surfacing paths (pending
// interaction, approval, board-owned unblock_descriptor on a `blocked` issue),
// so it is asked of nobody and seen by nobody -- while its dependents sit
// correctly `blocked` behind it and look healthy. Measured 2026-08-25: four such
// cards blocking eight dependents, one blocking five on its own.
//
// The invariant is enforced at the single create path, not at the ~5 mint sites.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping board-ask ownership tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("a minted board ask always has an operator owner", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-ask-owned-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({
      id: "local-board",
      email: "local@paperclip.local",
      name: "Board",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("defaults an ownerless BOARD ACTION REQUIRED card to the local board operator", async () => {
    const svc = issueService(db);
    const companyId = await seedCompany();

    // Exactly the shape recovery/service.ts mints: critical, todo, no owner.
    const issue = await svc.create(companyId, {
      title: "BOARD ACTION REQUIRED: Stranded recovery needs a board decision — no_invokable_recovery_owner",
      description: "Automatic recovery has escalated to the board.",
      status: "todo",
      priority: "critical",
      assigneeAgentId: null,
    } as any);

    expect(issue.assigneeUserId).toBe("local-board");
  });

  it("does not override an explicit owner on a board ask", async () => {
    const svc = issueService(db);
    const companyId = await seedCompany();
    await db.insert(authUsers).values({
      id: "someone-else",
      email: "someone@paperclip.local",
      name: "Someone",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    // assertAssignableUser requires an ACTIVE company membership, not just an
    // auth row -- the first cut of this test asserted on a user the service
    // rightly refused.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "someone-else",
      status: "active",
    } as any).onConflictDoNothing();

    const issue = await svc.create(companyId, {
      title: "BOARD ACTION REQUIRED: already owned",
      status: "todo",
      priority: "critical",
      assigneeUserId: "someone-else",
    } as any);

    expect(issue.assigneeUserId).toBe("someone-else");
  });

  it("leaves an ordinary ownerless card unassigned", async () => {
    const svc = issueService(db);
    const companyId = await seedCompany();

    const issue = await svc.create(companyId, {
      title: "Produce 2 long-form videos for TSM",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
    } as any);

    // The invariant must be narrow: only board asks get the fallback owner.
    expect(issue.assigneeUserId).toBeNull();
  });
});
