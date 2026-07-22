import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, approvals, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const pluginId = "plugin-record-id";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: () => {},
        subscribe: () => {},
        clear: () => {},
      };
    },
  } as any;
}

describeEmbeddedPostgres("plugin host services — approvals", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-host-approvals-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix: string) {
    return db
      .insert(companies)
      .values({
        name: `${prefix} ${randomUUID()}`,
        issuePrefix: `${prefix}${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createApproval(companyId: string, requestedByAgentId?: string) {
    return db
      .insert(approvals)
      .values({
        companyId,
        type: "request_board_approval",
        status: "pending",
        payload: { title: "Test approval" },
        requestedByAgentId: requestedByAgentId ?? null,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("approves a pending approval scoped to the calling company and logs plugin attribution", async () => {
    const company = await createCompany("APX");
    const approval = await createApproval(company.id);
    const services = buildHostServices(db, pluginId, "slack", createEventBusStub());

    const result = await services.approvals.approve({
      approvalId: approval.id,
      companyId: company.id,
      decidedByUserId: "slack:U123",
      decisionNote: "Approved via Slack button",
    });

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("approved");
    expect(result.approval.decidedByUserId).toBe("slack:U123");

    const [logRow] = await db.select().from(activityLog);
    expect(logRow?.action).toBe("approval.approved");
    expect(logRow?.actorType).toBe("plugin");
    expect(logRow?.actorId).toBe(pluginId);
    expect((logRow?.details as Record<string, unknown> | null)?.sourcePluginKey).toBe("slack");

    services.dispose();
  });

  it("rejects a pending approval and does not queue a requester wakeup", async () => {
    const company = await createCompany("APY");
    const approval = await createApproval(company.id);
    const services = buildHostServices(db, pluginId, "slack", createEventBusStub());

    const result = await services.approvals.reject({
      approvalId: approval.id,
      companyId: company.id,
      decidedByUserId: "slack:U456",
    });

    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("rejected");

    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toEqual([]);

    services.dispose();
  });

  it("refuses to resolve an approval that belongs to a different company", async () => {
    const targetCompany = await createCompany("APZ");
    const otherCompany = await createCompany("APW");
    const approval = await createApproval(otherCompany.id);
    const services = buildHostServices(db, pluginId, "slack", createEventBusStub());

    await expect(
      services.approvals.approve({
        approvalId: approval.id,
        companyId: targetCompany.id,
        decidedByUserId: "slack:U789",
      }),
    ).rejects.toThrow("Approval not found");

    const [unchanged] = await db.select().from(approvals);
    expect(unchanged?.status).toBe("pending");

    services.dispose();
  });

  it("is a no-op on an already-resolved approval", async () => {
    const company = await createCompany("APV");
    const approval = await createApproval(company.id);
    const services = buildHostServices(db, pluginId, "slack", createEventBusStub());

    const first = await services.approvals.approve({
      approvalId: approval.id,
      companyId: company.id,
      decidedByUserId: "slack:U1",
    });
    expect(first.applied).toBe(true);

    const second = await services.approvals.approve({
      approvalId: approval.id,
      companyId: company.id,
      decidedByUserId: "slack:U2",
    });
    expect(second.applied).toBe(false);
    expect(second.approval.decidedByUserId).toBe("slack:U1");

    const logRows = await db.select().from(activityLog);
    expect(logRows).toHaveLength(1);

    services.dispose();
  });
});
