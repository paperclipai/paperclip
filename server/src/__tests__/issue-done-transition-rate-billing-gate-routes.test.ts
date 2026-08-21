import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres done-transition rate/billing gate route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("done transition rate-claim and billing-source gates (AGE-628)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: ReturnType<typeof createApp>;
  let companyId!: string;

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: async () => {
        throw new Error("Unexpected storage.putFile call in rate/billing gate route test");
      },
      getObject: async () => {
        throw new Error("Unexpected storage.getObject call in rate/billing gate route test");
      },
      headObject: async () => ({ exists: false }),
      deleteObject: async () => undefined,
    };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, createStorage()));
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-done-rate-billing-gate-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    app = createApp(companyId);

    await db.insert(companies).values({
      id: companyId,
      name: "Rate/billing gate tenant",
      issuePrefix: "RBG",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssue(title: string, description = "Fixture issue body, no PR reference.") {
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title,
        description,
        status: "in_progress",
        priority: "medium",
        assigneeUserId: "cloud-user-1",
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    return createRes.body.id as string;
  }

  // Gate A: single-sample rate claims (the actual AGE-333 failure shape).
  it("refuses done on a rate-claim-titled issue with no observation window / second sample", async () => {
    const issueId = await createIssue(
      `GitHub Copilot burn is running at $8,400/day (${randomUUID()})`,
      "One trailing-24h data point showed ~$8,396 spent. Extrapolated to a sustained run rate.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("rate claim");
    expect(res.body.details).toMatchObject({
      code: "done_transition_rate_claim_gate",
      reason: "missing_rate_claim_evidence",
    });
  });

  it("allows done on the same rate-claim fixture once two non-adjacent monthly samples (each with its own pasted figure) and a window are cited", async () => {
    const issueId = await createIssue(
      `GitHub Copilot burn is running at ~$623/day (${randomUUID()})`,
      "Observation window: trailing 30 days per month. July 2026 spend was $21,060.76. August 2026 spend was $19,300 (~$623/day), consistent with a sustained rate, not a single-sample spike.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("refuses done when a second month is mentioned only incidentally, with no pasted figure of its own", async () => {
    const issueId = await createIssue(
      `GitHub Copilot burn is running at ~$700/day (${randomUUID()})`,
      "Observation window: trailing 24h. The org started using Copilot back in March 2026, long before there was any billing dashboard or historical data available at all. Current burn is $700/day as of August 2026 -- only one real measured sample exists.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "done_transition_rate_claim_gate" });
  });

  it("refuses done when 'only one sample' is asserted with no reason given", async () => {
    const issueId = await createIssue(
      `Vendor Y burn is running at $900/day (${randomUUID()})`,
      "Observation window: trailing 24h. Only one sample was used.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "done_transition_rate_claim_gate" });
  });

  it("allows done on the same rate-claim fixture with an explicit single-sample justification", async () => {
    const issueId = await createIssue(
      `Vendor X burn is running at $500/day (${randomUUID()})`,
      "Observation window: one trailing-24h sample. Only one sample exists because the vendor's billing API only exposes the last 24h and the account is new (no prior history).",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("does not accept two dates within the same month as two non-adjacent samples", async () => {
    const issueId = await createIssue(
      `GitHub Copilot burn is running at $700/day (${randomUUID()})`,
      "Observation window: trailing 30 days. Aug 1, 2026 was one data point and Aug 15, 2026 was another data point within the same month.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "done_transition_rate_claim_gate" });
  });

  it("refuses done when one dollar figure sits between two adjacent months and would back both", async () => {
    const issueId = await createIssue(
      `GitHub Copilot burn is running at $800/day (${randomUUID()})`,
      "Observation window: trailing 60 days. Spend was roughly $800/day across July 2026 and August 2026 combined -- one blended figure, not two separate measured samples.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "done_transition_rate_claim_gate" });
  });

  it("does not gate an issue whose title has no rate-claim pattern", async () => {
    const issueId = await createIssue("Document the billing reconciliation architecture");

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
  });

  // Gate B: monetary claims must cite the vendor billing API, not Paperclip's internal /costs ledger.
  it("refuses done on an issue whose monetary claim cites Paperclip's internal /costs ledger", async () => {
    const issueId = await createIssue(
      `Reconcile agent cost overrun (${randomUUID()})`,
      "Per Paperclip's internal /costs ledger, spend this month is $4,200. That's the basis for this ticket.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("vendor's own billing API");
    expect(res.body.details).toMatchObject({
      code: "done_transition_billing_source_gate",
      reason: "internal_costs_ledger_cited_for_monetary_claim",
    });
  });

  it("refuses done when the internal-ledger citation lives only in a comment (not the description)", async () => {
    const issueId = await createIssue(
      `Reconcile agent cost overrun (${randomUUID()})`,
      "Investigating the cost overrun reported this week.",
    );
    const commentRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Per Paperclip's internal /costs ledger, spend this month is $4,200." });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "done_transition_billing_source_gate" });
  });

  it("refuses done when a bare 'billing API' phrase is cited with no command or pasted output", async () => {
    const issueId = await createIssue(
      `Reconcile agent cost overrun (${randomUUID()})`,
      "Per Paperclip's internal /costs ledger, spend this month is $4,200. Confirmed via the billing API.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "done_transition_billing_source_gate" });
  });

  it("refuses done when the vendor billing command runs but no dollar figure follows it as output", async () => {
    const issueId = await createIssue(
      `Reconcile agent cost overrun (${randomUUID()})`,
      "Per Paperclip's internal /costs ledger, spend this month is $4,200. " +
        "Also ran `gh api /orgs/VibeTechnologies/settings/billing/usage` to double check, but the output was not captured or pasted here yet.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "done_transition_billing_source_gate" });
  });

  it("refuses done when the vendor command output merely restates the internal-ledger amount", async () => {
    const issueId = await createIssue(
      `Reconcile agent cost overrun (${randomUUID()})`,
      "Per Paperclip's internal /costs ledger, spend this month is $4,200. " +
        "Ran `gh api /orgs/VibeTechnologies/settings/billing/usage` to double check -- output confirms $4,200, matches the ledger.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "done_transition_billing_source_gate" });
  });

  it("allows done on the same billing fixture once the vendor billing API command+output is also cited", async () => {
    const issueId = await createIssue(
      `Reconcile agent cost overrun (${randomUUID()})`,
      "Per Paperclip's internal /costs ledger, spend looked like $4,200 -- but that undercounts. " +
        "Ran `gh api /orgs/VibeTechnologies/settings/billing/usage` and the output shows July 2026 was $21,060.76.",
    );

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("does not gate an issue with no monetary claim at all", async () => {
    const issueId = await createIssue("Document the billing reconciliation architecture");

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
  });
});
