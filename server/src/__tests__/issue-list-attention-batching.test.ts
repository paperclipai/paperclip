import { randomUUID } from "node:crypto";
import type { IssueBlockedInboxAttention } from "@paperclipai/shared";
import { agents, companies, heartbeatRuns, issueRelations, issues } from "@paperclipai/db";
import { expect, it } from "vitest";
import { issueService } from "../services/issues.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

const attentionOf = (row: unknown) => (row as { blockedInboxAttention?: IssueBlockedInboxAttention } | undefined)?.blockedInboxAttention;

describeEmbeddedPostgres("issue list attention batching", () => {
  const ctx = useEmbeddedPostgres("issue-list-attention-batching-");

  it.each(["rows", "index"] as const)("keeps %s blocker reads bounded for a page and preserves singleton attention", async (projection) => {
    const companyId = randomUUID();
    await ctx.db.insert(companies).values({ id: companyId, name: "Attention batch", issuePrefix: `B${companyId.slice(0, 7)}` });
    const [agent] = await ctx.db.insert(agents).values({ companyId, name: "Worker", adapterType: "process", status: "active" }).returning();
    const rootIds = Array.from({ length: 24 }, () => randomUUID());
    const children = rootIds.map(parentId => ({ id: randomUUID(), parentId }));
    await ctx.db.insert(issues).values(rootIds.map((id, i) => ({ id, companyId, title: `Root ${i}`, status: "blocked", assigneeAgentId: agent!.id })));
    await ctx.db.insert(issues).values(children.map((child, i) => ({ ...child, companyId, title: `Active child ${i}`, status: "in_progress", assigneeAgentId: agent!.id })));
    await ctx.db.insert(heartbeatRuns).values(children.map(child => ({ companyId, agentId: agent!.id, status: "running", contextSnapshot: { issueId: child.id } })));
    const client = ctx.db.$client as any;
    const unsafe = client.unsafe.bind(client);
    let selects: string[] = [];
    client.unsafe = (text: string, params?: unknown[], options?: unknown) => {
      if (/^\s*(select|with)\b/i.test(text)) selects.push(text);
      return unsafe(text, params, options);
    };
    try {
      const svc = issueService(ctx.db);
      const filters = { listProjection: projection, includeBlockedInboxAttention: true, includeLiveDescendantSummary: true, limit: 100 };
      const single = await svc.list(companyId, { ...filters, issueIds: [rootIds[0]!] });
      const singleCount = selects.length;
      selects = [];
      const page = await svc.list(companyId, { ...filters, issueIds: rootIds });
      expect(page).toHaveLength(rootIds.length);
      expect(attentionOf(page.find(row => row.id === rootIds[0]))).toEqual(attentionOf(single[0]));
      expect(page.map(row => attentionOf(row)?.reason)).toEqual(rootIds.map(() => "blocked_chain_stalled"));
      expect(selects.length, `24 rows used ${selects.length} queries versus ${singleCount} for one`).toBeLessThanOrEqual(singleCount + 12);
    } finally { client.unsafe = unsafe; }
  });
  it("keeps transitive blockers, off-page blocked dependents, and recovery references", async () => {
    const companyId = randomUUID();
    await ctx.db.insert(companies).values({ id: companyId, name: "Scoped graph", issuePrefix: `S${companyId.slice(0, 7)}` });
    const [agent] = await ctx.db.insert(agents).values({ companyId, name: "Worker", adapterType: "process", status: "active" }).returning();
    const [root, middle, leaf, review, dependent, recovery, source, badReference] = Array.from({ length: 8 }, () => randomUUID());
    await ctx.db.insert(issues).values([
      { id: root, companyId, title: "Page root", status: "blocked", assigneeAgentId: agent!.id },
      { id: middle, companyId, title: "Off-page intermediate blocker", status: "blocked", assigneeAgentId: agent!.id },
      { id: leaf, companyId, title: "Off-page unowned blocker", status: "todo" },
      { id: review, companyId, title: "Page review", status: "in_review", assigneeAgentId: agent!.id },
      { id: dependent, companyId, title: "Off-page blocked dependent", status: "blocked" },
      { id: source, companyId, title: "Off-page recovery source", status: "todo" },
      { id: recovery, companyId, title: "Page recovery", status: "todo", originKind: "stranded_issue_recovery", originId: source },
      { id: badReference, companyId, title: "Recovery without a leaf", status: "todo",
        originKind: "harness_liveness_escalation", originId: `harness_liveness:${companyId}:${source}:invalid_review_participant:none` },
    ]);
    await ctx.db.insert(issueRelations).values([
      { companyId, issueId: leaf!, relatedIssueId: middle!, type: "blocks" },
      { companyId, issueId: middle!, relatedIssueId: root!, type: "blocks" },
      { companyId, issueId: review!, relatedIssueId: dependent!, type: "blocks" },
    ]);

    const rows = await issueService(ctx.db).list(companyId, {
      issueIds: [root!, review!, recovery!, badReference!],
      listProjection: "rows",
      includeBlockedInboxAttention: true,
    });
    const attention = (id: string | undefined) => attentionOf(rows.find(row => row.id === id));
    expect(attention(root)).toMatchObject({ reason: "blocked_by_unassigned_issue", leafIssue: { id: leaf } });
    expect(attention(review)).toBeNull();
    expect(attention(recovery)).toMatchObject({ reason: "open_recovery_issue", sourceIssue: { id: source } });
    expect(attention(badReference)).toMatchObject({ reason: "open_recovery_issue", sourceIssue: { id: source }, leafIssue: null });
  });

  it("preserves singleton attention when the shared graph exceeds its node budget", async () => {
    const companyId = randomUUID();
    await ctx.db.insert(companies).values({ id: companyId, name: "Bounded attention", issuePrefix: `L${companyId.slice(0, 7)}` });
    const [agent] = await ctx.db.insert(agents).values({ companyId, name: "Worker", adapterType: "process", status: "active" }).returning();
    const rootIds = [randomUUID(), randomUUID()];
    await ctx.db.insert(issues).values(rootIds.map((id, i) => ({ id, companyId, title: `Wide root ${i}`, status: "blocked", assigneeAgentId: agent!.id })));
    const children = rootIds.flatMap(parentId => Array.from({ length: 1001 }, () => ({ id: randomUUID(), parentId, executionRunId: randomUUID() })));
    await ctx.db.insert(heartbeatRuns).values(children.map(child => ({ id: child.executionRunId, companyId, agentId: agent!.id, status: "running", contextSnapshot: { issueId: child.id } })));
    await ctx.db.insert(issues).values(children.map((child, i) => ({ ...child, companyId, title: `Live child ${i}`, status: "in_progress", assigneeAgentId: agent!.id })));
    const svc = issueService(ctx.db);
    const filters = { listProjection: "rows" as const, includeBlockedInboxAttention: true, limit: 100 };
    const expected = new Map<string, unknown>();
    for (const id of rootIds) {
      const single = await svc.list(companyId, { ...filters, issueIds: [id] });
      expected.set(id, attentionOf(single[0]));
    }
    const page = await svc.list(companyId, { ...filters, issueIds: rootIds });
    expect(page).toHaveLength(rootIds.length);
    for (const row of page) expect(attentionOf(row)).toEqual(expected.get(row.id));
  }, 120_000);

});
