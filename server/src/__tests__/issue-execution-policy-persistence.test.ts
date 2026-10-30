import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { buildExecutionPolicy } from "../../../ui/src/lib/issue-execution-policy.ts";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("edited execution policy persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-policy-persistence-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it.each(["reviewer", "monitor"] as const)("retains the independent review limit after removing the last %s", async (removed) => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const original = normalizeIssueExecutionPolicy({
      maxReviewRounds: 4,
      ...(removed === "monitor"
        ? { monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z" } }
        : { stages: [{ type: "review", participants: [{ type: "user", userId: "board-reviewer" }] }] }),
    });
    await db.insert(companies).values({ id: companyId, name: "Policy fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review limit fixture", executionPolicy: original });
    const edited = buildExecutionPolicy({ existingPolicy: original, reviewerValues: [], approverValues: [] })!;
    // The monitor editor removes this key after building the unchanged stages.
    const { monitor: _removedMonitor, ...withoutMonitor } = edited;
    const normalized = normalizeIssueExecutionPolicy(removed === "monitor" ? withoutMonitor : edited);
    const service = issueService(db);
    await service.update(issueId, { executionPolicy: normalized, companyGuard: companyId });
    const saved = await service.getById(issueId);
    expect(saved?.executionPolicy).toEqual({ mode: "normal", commentRequired: true, stages: [], maxReviewRounds: 4 });

    const restored = normalizeIssueExecutionPolicy(buildExecutionPolicy({
      existingPolicy: saved?.executionPolicy,
      reviewerValues: ["user:board-reviewer"], approverValues: [],
    }));
    expect(restored).toMatchObject({ maxReviewRounds: 4, stages: [{ type: "review" }] });
  });
});
