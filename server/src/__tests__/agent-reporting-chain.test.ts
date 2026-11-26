import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies } from "@paperclipai/db";
import { getAgentWorkEligibility } from "@paperclipai/shared";
import { readAgentReportingChain } from "../lib/agent-reporting-chain.js";
import { evaluateAgentInvokability, evaluateAgentInvokabilityFromDb, type AgentOrgRow } from "../services/agent-invokability.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

const STATUSES = ["active", "idle", "running", "error", "paused", "terminated", "pending_approval", "retired"];

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describeEmbeddedPostgres("agent reporting chain", () => {
  const ctx = useEmbeddedPostgres("agent-reporting-chain-");

  async function company(name: string) {
    const id = randomUUID();
    await ctx.db.insert(companies).values({ id, name, issuePrefix: `C${id.slice(0, 7).toUpperCase()}` });
    return id;
  }

  async function generateOrgChart(seed: number) {
    const next = random(seed);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    const home = await company(`Home ${seed}`), other = await company(`Other ${seed}`);
    const shape = (["deep", "tree", "cycle", "mixed"] as const)[seed % 4]!;
    const size = shape === "deep" ? 45 : 2 + Math.floor(next() * 45);
    const homeRows: AgentOrgRow[] = Array.from({ length: size }, (_, index) => ({ id: randomUUID(), companyId: home,
      name: `agent-${seed}-${index}`, reportsTo: null, status: next() < 0.6 ? "idle" : pick(STATUSES) }));
    const otherRows: AgentOrgRow[] = Array.from({ length: 4 }, (_, index) => ({ id: randomUUID(), companyId: other,
      name: `other-${seed}-${index}`, reportsTo: null, status: pick(STATUSES) }));
    for (const [index, row] of homeRows.entries()) {
      const roll = next();
      if (shape === "deep") row.reportsTo = index === 0 ? null : homeRows[index - 1]!.id;
      else if (shape === "cycle") row.reportsTo = homeRows[(index + 1) % homeRows.length]!.id;
      else if (roll < 0.12) row.reportsTo = null;
      else if (roll < 0.2) row.reportsTo = pick(otherRows).id;
      else if (roll < 0.27) row.reportsTo = randomUUID();
      else if (roll < 0.35 || shape === "mixed") row.reportsTo = pick(homeRows).id;
      else row.reportsTo = index === 0 ? null : homeRows[Math.floor(next() * index)]!.id;
    }
    for (const row of otherRows) row.reportsTo = next() < 0.5 ? pick(homeRows).id : null;
    await ctx.db.transaction(async tx => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.insert(agents).values([...homeRows, ...otherRows].map(row => ({ ...row, role: "engineer", adapterType: "process",
        adapterConfig: {} })));
    });
    return { home, other, shape, rows: [...homeRows, ...otherRows] };
  }

  it("gives the same invokability and org-chain health as the whole-company list for generated org charts", async () => {
    const seen = { shapes: new Set<string>(), reasons: new Set<string>(), healths: new Set<string>(), maxDepth: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const chart = await generateOrgChart(seed);
      seen.shapes.add(chart.shape);
      for (const companyId of [chart.home, chart.other]) {
        const companyRows = await ctx.db.select({ id: agents.id, companyId: agents.companyId, name: agents.name,
          reportsTo: agents.reportsTo, status: agents.status }).from(agents).where(eq(agents.companyId, companyId));
        for (const agent of companyRows) {
          const listBased = evaluateAgentInvokability(agent, companyRows);
          expect(await evaluateAgentInvokabilityFromDb(ctx.db, agent), `${chart.shape} ${seed} ${agent.name}`).toEqual(listBased);
          const chain = await readAgentReportingChain(ctx.db, agent);
          const listHealth = getAgentWorkEligibility({ agent, agents: companyRows });
          expect(getAgentWorkEligibility({ agent, agents: chain }), `${chart.shape} ${seed} ${agent.name}`).toEqual(listHealth);
          seen.reasons.add(listBased.invokable ? "invokable" : listBased.reason);
          seen.healths.add(listHealth.orgChainHealth.reason);
          seen.maxDepth = Math.max(seen.maxDepth, listHealth.orgChainHealth.fullChain.length - 1);
        }
      }
    }
    expect([...seen.shapes].sort()).toEqual(["cycle", "deep", "mixed", "tree"]);
    expect([...seen.healths].sort()).toEqual(["cycle", "healthy", "missing_manager", "terminated_ancestor"]);
    for (const reason of ["invokable", "paused", "terminated", "pending_approval", "unknown_status", "manager_missing",
      "manager_terminated", "reporting_cycle"]) expect(seen.reasons).toContain(reason);
    expect(seen.maxDepth).toBeGreaterThanOrEqual(40);
  }, 300_000);

  it("reads only the agent's own managers, and nothing for a root agent", async () => {
    const home = await company("Chain only");
    const ids = Array.from({ length: 50 }, () => randomUUID());
    await ctx.db.insert(agents).values(ids.map((id, index) => ({ id, companyId: home, name: `a${index}`, role: "engineer",
      adapterType: "process", adapterConfig: {}, status: "idle", reportsTo: index === 0 ? null : ids[index < 10 ? index - 1 : 0] })));
    const [deep] = await ctx.db.select().from(agents).where(eq(agents.id, ids[9]!));
    expect((await readAgentReportingChain(ctx.db, deep!)).map(row => row.id)).toEqual(ids.slice(0, 9).reverse());
    const [root] = await ctx.db.select().from(agents).where(eq(agents.id, ids[0]!));
    const execute = ctx.db.execute.bind(ctx.db);
    let statements = 0;
    const counted = Object.assign(Object.create(ctx.db), { execute: (...args: Parameters<typeof execute>) => {
      statements += 1; return execute(...args);
    } });
    expect(await evaluateAgentInvokabilityFromDb(counted, root!)).toEqual({ invokable: true });
    expect(await evaluateAgentInvokabilityFromDb(counted, { ...deep!, status: "paused" })).toMatchObject({ reason: "paused" });
    expect(statements).toBe(0);
    expect(evaluateAgentInvokability(deep!, [])).toMatchObject({ reason: "manager_missing" });
  });
});
