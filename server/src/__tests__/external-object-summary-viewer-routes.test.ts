import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  externalObjectMentions,
  externalObjects,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("external object summary viewer access", () => {
  const ctx = useEmbeddedPostgres("paperclip-external-object-summary-viewer-");
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;

  beforeAll(async () => {
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    await instanceSettingsService(ctx.db).updateExperimental({ enableExternalObjects: true });
  }, 120_000);

  afterAll(() => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
  });

  function app(actor: Express.Request["actor"]) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    result.use("/api", issueRoutes(ctx.db, {} as never));
    result.use(errorHandler);
    return result;
  }

  async function fixture() {
    const companyId = randomUUID();
    const userId = `viewer-${randomUUID()}`;
    const now = new Date();
    await ctx.db.insert(companies).values({
      id: companyId,
      name: "Viewer summaries",
      issuePrefix: `V${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await ctx.db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "viewer",
      createdAt: now,
      updatedAt: now,
    });
    await ensureHumanRoleDefaultGrants(ctx.db, {
      companyId,
      principalId: userId,
      membershipRole: "viewer",
      grantedByUserId: null,
    });
    const [readableIssue] = await ctx.db.insert(issues).values({
      companyId,
      title: "Readable task",
      status: "todo",
      priority: "medium",
    }).returning();
    const [externalObject] = await ctx.db.insert(externalObjects).values({
      companyId,
      providerKey: "url",
      objectType: "link",
      externalId: `external-${randomUUID()}`,
      sanitizedCanonicalUrl: "https://example.invalid/external",
      canonicalIdentityHash: `hash-${randomUUID()}`,
      displayTitle: "Readable external object",
    }).returning();
    await ctx.db.insert(externalObjectMentions).values({
      companyId,
      sourceIssueId: readableIssue!.id,
      sourceKind: "description",
      objectId: externalObject!.id,
      providerKey: "url",
      detectorKey: "test",
      objectType: "link",
    });
    const privateIssueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: privateIssueId,
      companyId,
      title: "Private task",
      status: "todo",
      priority: "medium",
      visibility: "private",
      privacyRootIssueId: privateIssueId,
      responsibleUserId: "someone-else",
      createdByUserId: "someone-else",
    });
    await ctx.db.insert(externalObjectMentions).values({
      companyId,
      sourceIssueId: privateIssueId,
      sourceKind: "description",
      objectId: externalObject!.id,
      providerKey: "url",
      detectorKey: "test",
      objectType: "link",
    });
    const actor: Express.Request["actor"] = {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "viewer", status: "active" }],
      isInstanceAdmin: false,
    };
    return {
      companyId,
      readableIssueId: readableIssue!.id,
      privateIssueId,
      actor,
    };
  }

  it("allows a viewer to read summaries without widening a normal viewer POST", async () => {
    const f = await fixture();
    const server = app(f.actor);

    const summaries = await request(server)
      .post(`/api/companies/${f.companyId}/issues/external-object-summaries`)
      .send({ issueIds: [f.readableIssueId, f.privateIssueId] });

    expect(summaries.status, JSON.stringify(summaries.body)).toBe(200);
    expect(summaries.body.summaries[f.readableIssueId]).toMatchObject({ total: 1 });
    expect(summaries.body.summaries[f.privateIssueId]).toBeUndefined();

    const foreign = await fixture();
    const foreignSummaries = await request(server)
      .post(`/api/companies/${foreign.companyId}/issues/external-object-summaries`)
      .send({ issueIds: [foreign.readableIssueId] });
    expect(foreignSummaries.status).toBe(403);

    const staleMembership = await request(app({ ...f.actor, memberships: [] }))
      .post(`/api/companies/${f.companyId}/issues/external-object-summaries`)
      .send({ issueIds: [f.readableIssueId] });
    expect(staleMembership.status).toBe(403);

    const refresh = await request(server)
      .post(`/api/issues/${f.readableIssueId}/external-objects/refresh`)
      .send({});
    expect(refresh.status).toBe(403);
    expect(refresh.body.error).toBe("Viewer access is read-only");
  });
});
