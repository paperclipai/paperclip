import { randomUUID } from "node:crypto";
import type { IssueBlockedInboxAttention } from "@paperclipai/shared";
import { agents, companies, heartbeatRuns, issues } from "@paperclipai/db";
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
