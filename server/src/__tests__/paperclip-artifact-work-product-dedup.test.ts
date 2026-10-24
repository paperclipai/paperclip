import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, assets, issueAttachments, issues, issueWorkProducts } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("artifact work product dedup", () => {
  const ctx = useEmbeddedPostgres("paperclip-artifact-dedup-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(issueWorkProducts);
      await db.delete(issueAttachments);
      await db.delete(assets);
      await db.delete(issues);
      await resetCompanyIssueFixtures(db);
    },
  });

  it("reuses the work product of an attachment that a board action stores twice", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(
      ctx.db,
      "Artifact dedup",
    );
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Board artifact",
      status: "todo",
      originKind: "manual",
      createdByUserId: userId,
    });
    const assetId = randomUUID();
    await ctx.db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local_disk",
      objectKey: `${companyId}/issues/${issueId}/${assetId}.txt`,
      contentType: "text/plain",
      byteSize: 12,
      sha256: "c".repeat(64),
      originalFilename: "artifact.txt",
      createdByUserId: userId,
    });
    const attachmentId = randomUUID();
    await ctx.db.insert(issueAttachments).values({
      id: attachmentId,
      companyId,
      issueId,
      assetId,
      originatingRunId: null,
    });

    const app = routeApp(ctx.db, actor, issueRoutes);
    const payload = {
      type: "artifact",
      provider: "paperclip",
      title: "Artifact",
      status: "ready_for_review",
      metadata: { attachmentId },
    };

    const first = await request(app)
      .post(`/api/issues/${issueId}/work-products`)
      .send(payload)
      .expect(201);
    const second = await request(app)
      .post(`/api/issues/${issueId}/work-products`)
      .send(payload)
      .expect(201);

    expect(first.body.createdByRunId).toBeNull();
    expect(first.body.externalId).toBe(attachmentId);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.createdByRunId).toBeNull();
    expect(second.body.externalId).toBe(attachmentId);
    const rows = await ctx.db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toHaveLength(1);
  });
});
