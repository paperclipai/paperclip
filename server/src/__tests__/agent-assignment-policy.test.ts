import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { RESERVED_AGENT_BOARD_UI_ONLY_CODE } from "../services/agent-assignment-policy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("board-ui-only agent assignment admission", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-ui-assignment-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Reserved Assignment Co",
      issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reserved Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {
        authorizationPolicy: {
          assignmentPolicy: {
            mode: "board_ui_create_only",
            allowedUserIds: [ownerUserId],
          },
        },
      },
    });
    return { companyId, agentId, ownerUserId, svc: issueService(db) };
  }

  function validAdmission(ownerUserId: string, surface: "board_ui_issue_create" | "board_ui_issue_update") {
    return {
      surface,
      actorType: "user" as const,
      actorSource: "session" as const,
      actorUserId: ownerUserId,
    };
  }

  it("allows only an allowlisted board session to create a manual issue for the reserved agent", async () => {
    const { companyId, agentId, ownerUserId, svc } = await seed();
    const issue = await svc.create(companyId, {
      title: "Owner-created task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "manual",
      createdByUserId: ownerUserId,
      assignmentAdmission: validAdmission(ownerUserId, "board_ui_issue_create"),
    });

    expect(issue.assigneeAgentId).toBe(agentId);
    expect(issue.createdByUserId).toBe(ownerUserId);
  });

  it.each([
    ["missing admission", undefined, "manual", null],
    ["local implicit board", "local_implicit", "manual", null],
    ["board api key", "board_key", "manual", null],
    ["generated origin", "session", "issue_productivity_review", null],
    ["agent attribution", "session", "manual", "agent-created"],
  ] as const)("rejects reserved-agent create from %s", async (_label, source, originKind, createdByAgentId) => {
    const { companyId, agentId, ownerUserId, svc } = await seed();
    const admission = source
      ? {
        surface: "board_ui_issue_create" as const,
        actorType: "user" as const,
        actorSource: source,
        actorUserId: ownerUserId,
      }
      : undefined;

    await expect(svc.create(companyId, {
      title: `Rejected ${randomUUID()}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind,
      createdByAgentId: createdByAgentId ? agentId : null,
      createdByUserId: ownerUserId,
      assignmentAdmission: admission,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: RESERVED_AGENT_BOARD_UI_ONLY_CODE },
    });
  });

  it("mediates reassignment centrally while allowing later non-assignment updates", async () => {
    const { companyId, agentId, ownerUserId, svc } = await seed();
    const issue = await svc.create(companyId, {
      title: "Initially unassigned owner task",
      status: "todo",
      priority: "medium",
      originKind: "manual",
      createdByUserId: ownerUserId,
    });

    await expect(svc.update(issue.id, {
      assigneeAgentId: agentId,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: RESERVED_AGENT_BOARD_UI_ONLY_CODE },
    });

    const assigned = await svc.update(issue.id, {
      assigneeAgentId: agentId,
      assignmentAdmission: validAdmission(ownerUserId, "board_ui_issue_update"),
    });
    expect(assigned?.assigneeAgentId).toBe(agentId);

    const progressed = await svc.update(issue.id, { status: "in_progress" });
    expect(progressed?.status).toBe("in_progress");
  });

  it("rejects board reassignment when the persisted issue provenance is not owner-created manual work", async () => {
    const { companyId, agentId, ownerUserId, svc } = await seed();
    const issue = await svc.create(companyId, {
      title: "Generated task",
      status: "todo",
      priority: "medium",
      originKind: "stranded_issue_recovery",
      createdByUserId: ownerUserId,
    });

    await expect(svc.update(issue.id, {
      assigneeAgentId: agentId,
      assignmentAdmission: validAdmission(ownerUserId, "board_ui_issue_update"),
    })).rejects.toMatchObject({
      status: 422,
      details: { code: RESERVED_AGENT_BOARD_UI_ONLY_CODE },
    });
  });

  it("mediates assignment performed by checkout before mutating issue state", async () => {
    const { companyId, agentId, ownerUserId, svc } = await seed();
    const generated = await svc.create(companyId, {
      title: "Generated checkout target",
      status: "todo",
      priority: "medium",
      originKind: "stranded_issue_recovery",
      createdByUserId: ownerUserId,
    });

    await expect(svc.checkout(
      generated.id,
      agentId,
      ["todo"],
      null,
      validAdmission(ownerUserId, "board_ui_issue_update"),
    )).rejects.toMatchObject({
      status: 422,
      details: { code: RESERVED_AGENT_BOARD_UI_ONLY_CODE },
    });
    await expect(svc.getById(generated.id)).resolves.toMatchObject({
      status: "todo",
      assigneeAgentId: null,
    });

    const manual = await svc.create(companyId, {
      title: "Manual checkout target",
      status: "todo",
      priority: "medium",
      originKind: "manual",
      createdByUserId: ownerUserId,
    });
    await expect(svc.checkout(
      manual.id,
      agentId,
      ["todo"],
      null,
      validAdmission(ownerUserId, "board_ui_issue_update"),
    )).resolves.toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
    });
  });

  it("rejects imported assignments to a board-ui-only agent", async () => {
    const { companyId, agentId, svc } = await seed();

    await expect(svc.importIssues(companyId, [{
      id: randomUUID(),
      ref: "reserved-import",
      projectId: null,
      projectWorkspaceId: null,
      title: "Imported reserved assignment",
      description: null,
      assigneeAgentId: agentId,
      status: "todo",
      priority: "medium",
      billingCode: null,
      assigneeAdapterOverrides: null,
      executionWorkspaceSettings: null,
      labelIds: [],
      monitorNotes: null,
      monitorScheduledBy: null,
    }])).rejects.toMatchObject({
      status: 422,
      details: { code: RESERVED_AGENT_BOARD_UI_ONLY_CODE },
    });
    await expect(svc.list(companyId)).resolves.toEqual([]);
  });
});
