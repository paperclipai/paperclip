import { describe, expect, it } from "vitest";
import { computeAgentsStatus, type AgentStatusEntry } from "../services/dashboard.js";

// ---------------------------------------------------------------------------
// Minimal drizzle-compatible db stub.
// computeAgentsStatus issues 3–4 sequential .select() calls; we return
// each batch from a queue.
// ---------------------------------------------------------------------------

function makeDrizzleStub(batches: unknown[][]) {
  const queue = [...batches];
  const makeQuery = () => {
    const terminal = { then: (res: (v: unknown[]) => unknown) => Promise.resolve(res(queue.shift() ?? [])) };
    const query: Record<string, () => typeof query & typeof terminal> = {} as never;
    const wrap = () => Object.assign({ ...query, ...terminal });
    query.from = wrap;
    query.where = wrap;
    query.orderBy = wrap;
    query.innerJoin = wrap;
    return wrap();
  };
  return { select: () => makeQuery() } as never;
}

const NOW = new Date("2026-06-22T12:00:00.000Z");

// Convenience factory for an agent row
function ag(id: string, overrides: Partial<{
  name: string; status: string; lastHeartbeatAt: Date | null
}> = {}) {
  return {
    id,
    name: overrides.name ?? `Agent-${id}`,
    status: overrides.status ?? "idle",
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
  };
}

// Convenience factory for a run row
function run(agentId: string, status: string, finishedAt: Date) {
  return { agentId, status, finishedAt };
}

describe("computeAgentsStatus", () => {
  it("returns empty array when company has no agents", async () => {
    const db = makeDrizzleStub([[/* agents */]]);
    const result = await computeAgentsStatus(db, "company-1", NOW);
    expect(result).toEqual([]);
  });

  it("returns lastRunOutcome=none when agent has no finished runs", async () => {
    const db = makeDrizzleStub([
      [ag("a1")],              // agents
      [],                      // heartbeat_runs (empty)
      [],                      // issue_relations blocked side (empty)
      // blockerStatus lookup skipped when no relation rows
    ]);
    const [entry] = await computeAgentsStatus(db, "company-1", NOW);
    expect(entry.lastRunOutcome).toBe("none");
    expect(entry.quietSince).toBeNull();
    expect(entry.quietForMs).toBeNull();
    expect(entry.blockersOpen).toBe(0);
    expect(entry.quiescenceMode).toBe("unknown");
  });

  it("maps succeeded run to lastRunOutcome=succeeded", async () => {
    const finishedAt = new Date("2026-06-22T10:00:00.000Z");
    const db = makeDrizzleStub([
      [ag("a1")],
      [run("a1", "succeeded", finishedAt)],
      [],
    ]);
    const [entry] = await computeAgentsStatus(db, "company-1", NOW);
    expect(entry.lastRunOutcome).toBe("succeeded");
  });

  it("maps failed run to lastRunOutcome=failed", async () => {
    const finishedAt = new Date("2026-06-22T10:00:00.000Z");
    const db = makeDrizzleStub([
      [ag("a1")],
      [run("a1", "failed", finishedAt)],
      [],
    ]);
    const [entry] = await computeAgentsStatus(db, "company-1", NOW);
    expect(entry.lastRunOutcome).toBe("failed");
  });

  it("maps crashed/timeout runs to lastRunOutcome=error", async () => {
    for (const status of ["crashed", "timeout", "error"]) {
      const finishedAt = new Date("2026-06-22T10:00:00.000Z");
      const db = makeDrizzleStub([
        [ag("a1")],
        [run("a1", status, finishedAt)],
        [],
      ]);
      const [entry] = await computeAgentsStatus(db, "company-1", NOW);
      expect(entry.lastRunOutcome).toBe("error");
    }
  });

  it("queued/running runs yield lastRunOutcome=none (no completed outcome)", async () => {
    for (const status of ["queued", "running", "cancelled"]) {
      const finishedAt = new Date("2026-06-22T10:00:00.000Z");
      const db = makeDrizzleStub([
        [ag("a1")],
        [run("a1", status, finishedAt)],
        [],
      ]);
      const [entry] = await computeAgentsStatus(db, "company-1", NOW);
      expect(entry.lastRunOutcome).toBe("none");
    }
  });

  it("prefers agents.lastHeartbeatAt as quietSince anchor when set", async () => {
    const lastHeartbeatAt = new Date("2026-06-22T08:00:00.000Z");
    const finishedAt = new Date("2026-06-22T06:00:00.000Z"); // older
    const db = makeDrizzleStub([
      [ag("a1", { lastHeartbeatAt })],
      [run("a1", "succeeded", finishedAt)],
      [],
    ]);
    const [entry] = await computeAgentsStatus(db, "company-1", NOW);
    expect(entry.quietSince).toBe(lastHeartbeatAt.toISOString());
    expect(entry.quietForMs).toBe(NOW.getTime() - lastHeartbeatAt.getTime());
  });

  it("falls back to finishedAt when lastHeartbeatAt is null", async () => {
    const finishedAt = new Date("2026-06-22T06:00:00.000Z");
    const db = makeDrizzleStub([
      [ag("a1", { lastHeartbeatAt: null })],
      [run("a1", "succeeded", finishedAt)],
      [],
    ]);
    const [entry] = await computeAgentsStatus(db, "company-1", NOW);
    expect(entry.quietSince).toBe(finishedAt.toISOString());
    expect(entry.quietForMs).toBe(NOW.getTime() - finishedAt.getTime());
  });

  it("counts only non-terminal blockers in blockersOpen", async () => {
    const db = makeDrizzleStub([
      [ag("a1")],
      [],
      // blocked side: two blocker issues for agent a1's issues
      [
        { blockerIssueId: "b1", blockedAgentId: "a1" },
        { blockerIssueId: "b2", blockedAgentId: "a1" },
        { blockerIssueId: "b3", blockedAgentId: "a1" },
      ],
      // blocker statuses: b1=blocked (open), b2=done (terminal), b3=cancelled (terminal)
      [
        { id: "b1", status: "blocked" },
        { id: "b2", status: "done" },
        { id: "b3", status: "cancelled" },
      ],
    ]);
    const [entry] = await computeAgentsStatus(db, "company-1", NOW);
    expect(entry.blockersOpen).toBe(1); // only b1
  });

  it("deduplicates blocker IDs when the same blocker appears via multiple blocked issues", async () => {
    const db = makeDrizzleStub([
      [ag("a1")],
      [],
      // same blocker b1 appears twice (blocks two different assigned issues of a1)
      [
        { blockerIssueId: "b1", blockedAgentId: "a1" },
        { blockerIssueId: "b1", blockedAgentId: "a1" },
      ],
      [{ id: "b1", status: "in_progress" }],
    ]);
    const [entry] = await computeAgentsStatus(db, "company-1", NOW);
    expect(entry.blockersOpen).toBe(1);
  });

  it("includes deprecated status alias matching agents.status", async () => {
    const db = makeDrizzleStub([
      [ag("a1", { status: "paused" })],
      [],
      [],
    ]);
    const [entry] = await computeAgentsStatus(db, "company-1", NOW);
    expect(entry.status).toBe("paused");
  });

  it("always returns quiescenceMode=unknown pending CMP-365 Children B+C", async () => {
    const db = makeDrizzleStub([
      [ag("a1")],
      [],
      [],
    ]);
    const [entry] = await computeAgentsStatus(db, "company-1", NOW);
    expect(entry.quiescenceMode).toBe("unknown");
  });

  it("handles multiple agents independently", async () => {
    const heartbeatAt1 = new Date("2026-06-22T09:00:00.000Z");
    const finishedAt2 = new Date("2026-06-22T07:00:00.000Z");
    const db = makeDrizzleStub([
      [ag("a1", { lastHeartbeatAt: heartbeatAt1 }), ag("a2", { lastHeartbeatAt: null })],
      [
        run("a1", "succeeded", new Date("2026-06-22T08:00:00.000Z")),
        run("a2", "error", finishedAt2),
      ],
      [],
    ]);
    const entries: AgentStatusEntry[] = await computeAgentsStatus(db, "company-1", NOW);
    expect(entries).toHaveLength(2);
    const e1 = entries.find((e) => e.agentId === "a1")!;
    const e2 = entries.find((e) => e.agentId === "a2")!;
    expect(e1.lastRunOutcome).toBe("succeeded");
    expect(e1.quietSince).toBe(heartbeatAt1.toISOString());
    expect(e2.lastRunOutcome).toBe("error");
    expect(e2.quietSince).toBe(finishedAt2.toISOString());
  });
});
