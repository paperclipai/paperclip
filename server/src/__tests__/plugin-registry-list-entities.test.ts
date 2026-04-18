import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture filters produced by the service. We mock drizzle-orm's eq() and
// and() so that every call is a plain object we can inspect. The service
// uses asc(col) for orderBy which we also stub to avoid touching drizzle.
type EqNode = { _tag: "eq"; colName: string; value: unknown };
type AndNode = { _tag: "and"; children: EqNode[] };

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (col: { name?: string } | unknown, value: unknown): EqNode => {
      const c = (col as { name?: string } | undefined)?.name ?? "unknown";
      return { _tag: "eq", colName: c, value };
    },
    and: (...children: EqNode[]): AndNode => ({
      _tag: "and",
      children: children.filter((c) => c && typeof c === "object") as EqNode[],
    }),
    asc: (col: unknown) => col,
    ne: (col: unknown, val: unknown) => ({ _tag: "ne", colName: (col as { name?: string })?.name, value: val }),
    sql: Object.assign(() => ({ _tag: "sql" }), {
      raw: () => ({ _tag: "sql" }),
    }),
    isNull: (col: unknown) => ({ _tag: "isNull", colName: (col as { name?: string })?.name }),
  };
});

// Import AFTER mock.
import { pluginEntities } from "@paperclipai/db";
import { pluginRegistryService } from "../services/plugin-registry.ts";

type Row = {
  id: string;
  pluginId: string;
  entityType: string;
  scopeKind: string;
  scopeId: string | null;
  externalId: string | null;
  createdAt: Date;
};

function extractFilters(node: unknown): Array<[string, unknown]> {
  if (!node || typeof node !== "object") return [];
  const n = node as { _tag?: string; children?: EqNode[]; colName?: string; value?: unknown };
  if (n._tag === "and" && Array.isArray(n.children)) {
    return n.children.flatMap((c) => extractFilters(c));
  }
  if (n._tag === "eq" && typeof n.colName === "string") {
    return [[n.colName, n.value]];
  }
  return [];
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function applyFilters(rows: Row[], filters: Array<[string, unknown]>): Row[] {
  return rows.filter((r) =>
    filters.every(([colName, val]) => {
      const key = snakeToCamel(colName);
      return (r as unknown as Record<string, unknown>)[key] === val;
    }),
  );
}

function makeDbStub(rows: Row[]) {
  let lastWhere: unknown = null;
  let lastLimit = 100;
  let lastOffset = 0;

  const offset = vi.fn(async (nVal: number) => {
    lastOffset = nVal;
    const filters = extractFilters(lastWhere);
    const filtered = applyFilters(rows, filters);
    return filtered.slice(lastOffset, lastOffset + lastLimit);
  });
  const limit = vi.fn((nVal: number) => {
    lastLimit = nVal;
    return { offset };
  });
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn((cond: unknown) => {
    lastWhere = cond;
    return { orderBy };
  });
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return {
    db: { select } as unknown as Parameters<typeof pluginRegistryService>[0],
    getLastWhere: () => lastWhere,
  };
}

/**
 * SCOPE_FILTER_PATCH_V1 — coverage for plugin-registry.listEntities()
 *
 * Pre-patch: listEntities silently dropped scopeKind and scopeId filters from
 * the SDK's PluginEntityQuery, so every plugin tool that stored entities
 * under a run/issue/project scope was leaking cross-scope data. These tests
 * verify the patched filter honors scopeKind and scopeId while preserving
 * back-compat when those fields are omitted.
 */
describe("pluginRegistryService.listEntities — scope filter (SCOPE_FILTER_PATCH_V1)", () => {
  const PLUGIN_ID = "11111111-1111-1111-1111-111111111111";
  const RUN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const RUN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const RUN_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

  const seed: Row[] = [
    { id: "ent-a", pluginId: PLUGIN_ID, entityType: "cos-prefinding", scopeKind: "run", scopeId: RUN_A, externalId: null, createdAt: new Date("2026-04-17T00:00:00Z") },
    { id: "ent-b", pluginId: PLUGIN_ID, entityType: "cos-prefinding", scopeKind: "run", scopeId: RUN_B, externalId: null, createdAt: new Date("2026-04-17T00:00:01Z") },
    { id: "ent-c", pluginId: PLUGIN_ID, entityType: "cos-prefinding", scopeKind: "run", scopeId: RUN_C, externalId: null, createdAt: new Date("2026-04-17T00:00:02Z") },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pluginEntities schema exposes scopeKind and scopeId columns", () => {
    expect(pluginEntities.scopeKind).toBeDefined();
    expect(pluginEntities.scopeId).toBeDefined();
  });

  it("filters to 1 row per distinct scopeId", async () => {
    const { db, getLastWhere } = makeDbStub(seed);
    const svc = pluginRegistryService(db);

    const resA = await svc.listEntities(PLUGIN_ID, {
      entityType: "cos-prefinding",
      scopeKind: "run",
      scopeId: RUN_A,
    });

    const filters = extractFilters(getLastWhere());
    const filterCols = filters.map(([c]) => c);
    expect(filterCols).toContain("scope_kind");
    expect(filterCols).toContain("scope_id");
    const scopeIdFilter = filters.find(([c]) => c === "scope_id");
    expect(scopeIdFilter?.[1]).toBe(RUN_A);

    expect(resA.map((r) => r.id)).toEqual(["ent-a"]);

    const resB = await svc.listEntities(PLUGIN_ID, {
      entityType: "cos-prefinding",
      scopeKind: "run",
      scopeId: RUN_B,
    });
    expect(resB.map((r) => r.id)).toEqual(["ent-b"]);
  });

  it("returns empty when scopeId has no match", async () => {
    const { db } = makeDbStub(seed);
    const svc = pluginRegistryService(db);

    const res = await svc.listEntities(PLUGIN_ID, {
      entityType: "cos-prefinding",
      scopeKind: "run",
      scopeId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res).toEqual([]);
  });

  it("returns all rows when no scope filter applied (back-compat)", async () => {
    const { db, getLastWhere } = makeDbStub(seed);
    const svc = pluginRegistryService(db);

    const res = await svc.listEntities(PLUGIN_ID, { entityType: "cos-prefinding" });

    const filterCols = extractFilters(getLastWhere()).map(([c]) => c);
    expect(filterCols).not.toContain("scope_kind");
    expect(filterCols).not.toContain("scope_id");

    expect(res.map((r) => r.id).sort()).toEqual(["ent-a", "ent-b", "ent-c"]);
  });

  it("rejects invalid scopeKind at query time", () => {
    const { db } = makeDbStub(seed);
    const svc = pluginRegistryService(db);

    expect(() =>
      svc.listEntities(PLUGIN_ID, {
        entityType: "cos-prefinding",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scopeKind: "not-a-real-kind" as any,
      }),
    ).toThrow(/invalid scopeKind/);
  });

  it("rejects empty-string scopeId at query time", () => {
    const { db } = makeDbStub(seed);
    const svc = pluginRegistryService(db);

    expect(() =>
      svc.listEntities(PLUGIN_ID, {
        entityType: "cos-prefinding",
        scopeKind: "run",
        scopeId: "",
      }),
    ).toThrow(/non-empty string/);
  });
});
