import { afterEach, describe, expect, it, vi } from "vitest";
import { getTableColumns, type SQL, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agents, type Db } from "@paperclipai/db";
import { notifyHireApproved } from "../services/hire-hook.js";

// Mock the registry so we control whether the adapter has onHireApproved and what it does.
vi.mock("../adapters/registry.js", () => ({
  findActiveServerAdapter: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

const { findActiveServerAdapter } = await import("../adapters/registry.js");
const { logActivity } = await import("../services/activity-log.js");

type SeededAgent = {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
};

type AgentRow = Required<SeededAgent>;

function toRow(agent: SeededAgent): AgentRow {
  return {
    id: agent.id,
    companyId: agent.companyId,
    name: agent.name,
    adapterType: agent.adapterType,
    adapterConfig: agent.adapterConfig ?? {},
  };
}

/** Maps each `agents` SQL column name to the field drizzle returns it under. */
const agentFieldByColumn = new Map(
  Object.entries(getTableColumns(agents)).map(([field, col]) => [(col as { name: string }).name, field]),
);

/**
 * Compiles a drizzle `where` clause to `column = value` pairs through the real
 * Pg compiler, so the pairs come from the SQL the database would actually run.
 * Only a conjunction of column equalities is supported; any other shape throws.
 */
function wherePredicates(where: SQLWrapper | undefined): { column: string; value: unknown }[] {
  if (where === undefined) return [];
  const { sql, params } = new PgDialect().sqlToQuery(where as SQL);
  const conjunction = sql.startsWith("(") && sql.endsWith(")") ? sql.slice(1, -1) : sql;

  return conjunction.split(" and ").map((term) => {
    const match = /^(?:"[^"]+"\.)?"([^"]+)" = \$(\d+)$/.exec(term);
    if (!match || !agentFieldByColumn.has(match[1])) {
      throw new Error(`mock db: unsupported where clause: ${sql}`);
    }
    return { column: match[1], value: params[Number(match[2]) - 1] };
  });
}

/** Records the operands each `where` call received so tests can pin the tenant predicate directly. */
const whereOperands: { column: string; value: unknown }[][] = [];

function mockDbWithAgents(rows: SeededAgent[]): Db {
  const seeded = rows.map(toRow);
  const query = {
    from: () => query,
    where: (clause: SQLWrapper | undefined) => {
      const predicates = wherePredicates(clause);
      whereOperands.push(predicates);
      return Promise.resolve(
        seeded.filter((row) =>
          predicates.every((p) => row[agentFieldByColumn.get(p.column) as keyof AgentRow] === p.value),
        ),
      );
    },
  };
  return {
    select: () => query,
  } as unknown as Db;
}

function mockDbWithAgent(agent: SeededAgent): Db {
  return mockDbWithAgents([agent]);
}

afterEach(() => {
  vi.clearAllMocks();
  whereOperands.length = 0;
});

describe("notifyHireApproved", () => {
  it("writes success activity when adapter hook returns ok", async () => {
    const onHireApproved = vi.fn().mockResolvedValue({ ok: true });
    vi.mocked(findActiveServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved,
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
      adapterConfig: { url: "https://gateway.example" },
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
      }),
    ).resolves.toBeUndefined();

    expect(onHireApproved).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "a1", agentName: "OpenClaw Agent" }),
      { url: "https://gateway.example" },
    );
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.succeeded",
        entityId: "a1",
        details: expect.objectContaining({ source: "approval", sourceId: "ap1", adapterType: "openclaw_gateway" }),
      }),
    );
  });

  it("does nothing when agent is not found", async () => {
    const db = mockDbWithAgents([]);

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    expect(findActiveServerAdapter).not.toHaveBeenCalled();
  });

  it("refuses to notify when the agent belongs to another company", async () => {
    const onHireApproved = vi.fn().mockResolvedValue({ ok: true });
    vi.mocked(findActiveServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved,
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c2",
      name: "Other Tenant Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
      }),
    ).resolves.toBeUndefined();

    expect(whereOperands.at(-1)).toEqual(
      expect.arrayContaining([{ column: "company_id", value: "c1" }]),
    );
    expect(findActiveServerAdapter).not.toHaveBeenCalled();
    expect(onHireApproved).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("does nothing when adapter has no onHireApproved", async () => {
    vi.mocked(findActiveServerAdapter).mockReturnValue({ type: "process" } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "Agent",
      adapterType: "process",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
      }),
    ).resolves.toBeUndefined();

    expect(findActiveServerAdapter).toHaveBeenCalledWith("process");
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("logs failed result when adapter onHireApproved returns ok=false", async () => {
    vi.mocked(findActiveServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockResolvedValue({ ok: false, error: "HTTP 500", detail: { status: 500 } }),
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.failed",
        entityId: "a1",
        details: expect.objectContaining({ source: "join_request", sourceId: "jr1", error: "HTTP 500" }),
      }),
    );
  });

  it("does not throw when adapter onHireApproved throws (non-fatal)", async () => {
    vi.mocked(findActiveServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockRejectedValue(new Error("Network error")),
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.error",
        entityId: "a1",
        details: expect.objectContaining({ source: "join_request", sourceId: "jr1", error: "Network error" }),
      }),
    );
  });
});
