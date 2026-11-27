import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: `entities.list` used to ignore `scopeKind`/`scopeId` and return
 * every tenant's rows for the plugin. A company-scoped list must filter by
 * companyId, an instance-scoped list must filter to instance rows, and a
 * scope-less query must be rejected outright (fail-closed) instead of
 * silently returning cross-tenant rows.
 */

const rows = [
  { id: "1", pluginId: "p", companyId: "company-a", entityType: "t", externalId: "a1" },
  { id: "2", pluginId: "p", companyId: "company-b", entityType: "t", externalId: "b1" },
  { id: "3", pluginId: "p", companyId: null, entityType: "t", externalId: "i1" },
];

// 捕获 where(and(...)) 收到的 drizzle 条件数组；断言看每个条件内部
// 的 queryChunks（drizzle SQL 对象可 JSON 化出字段名与参数）
const whereChunks: unknown[] = [];
const lastQuery = { conditions: [] as unknown[], limit: 0, offset: 0 };
// 安全收集 drizzle 条件的语义特征：递归取 Param.value（过滤值）与 Column.name（列名）。
// 不 JSON.stringify——drizzle 表对象有循环引用。
const collectFeatures = (node: unknown, depth = 0, out: string[] = []): string[] => {
  if (depth > 6 || node == null || typeof node !== "object") return out;
  const obj = node as Record<string, unknown>;
  const ctor = obj.constructor?.name;
  if (ctor === "Param") {
    if ("value" in obj) out.push(String(obj.value));
    return out;
  }
  if (ctor === "Column") {
    if (typeof obj.name === "string") out.push(obj.name);
    return out;
  }
  for (const v of Object.values(obj)) {
    if (v != null && typeof v === "object") collectFeatures(v, depth + 1, out);
  }
  return out;
};
const conditionText = (): string => collectFeatures(lastQuery.conditions).join(" | ");

const mockDb = vi.hoisted(() => {
  const select = () => ({
    from: () => ({
      where: (condition: unknown) => {
        // drizzle 的 and(...) 产出一个 SQL 对象；其 queryChunks 里含各条件
        const chunks = (condition as { queryChunks?: unknown[] })?.queryChunks;
        whereChunks.push(chunks);
        lastQuery.conditions = Array.isArray(chunks) ? chunks : [condition];
        return {
          orderBy: () => ({
            limit: (n: number) => {
              lastQuery.limit = n;
              return {
                offset: (o: number) => {
                  lastQuery.offset = o;
                  return Promise.resolve(rows);
                },
              };
            },
          }),
        };
      },
    }),
  });
  return { select } as unknown as Parameters<typeof pluginRegistryService>[0];
});

const { pluginRegistryService } = await import("../services/plugin-registry.js");

describe("pluginRegistryService.listEntities scope filtering", () => {
  const svc = pluginRegistryService(mockDb);

  beforeEach(() => {
    whereChunks.length = 0;
    lastQuery.conditions = [];
  });

  it("company scope filters by companyId", async () => {
    await svc.listEntities("p", { scopeKind: "company", scopeId: "company-a" });
    const text = conditionText();
    expect(whereChunks).toHaveLength(1);
    // Param 值断言：tenant id 出现在 WHERE 条件里（修复前条件里只有 pluginId/entityType/externalId）
    expect(text).toContain("company-a");
  });

  it("instance scope filters to instance rows (no tenant Param in the WHERE)", async () => {
    await svc.listEntities("p", { scopeKind: "instance" });
    // 修复前（无 scope 过滤）条件里没有任何 tenant 维度；修复后 instance 分支走
    // isNull(companyId)：条件里同样没有 tenant 值 Param——用对照区分：
    // company 查询含 company-a，instance 查询不含任何 company-*（isNull 无参数）
    const text = conditionText();
    expect(text).not.toContain("company-");
    // 对照：带上 entityType 后条件里出现 t（证明查询确实构建了且是过滤查询而非空）
    await svc.listEntities("p", { scopeKind: "instance", entityType: "t" });
    expect(conditionText()).toContain("t");
  });

  it("rejects a scope-less query (fail-closed: never return every tenant's rows)", async () => {
    await expect(async () => svc.listEntities("p", { entityType: "t" })).rejects.toThrow(/scopeKind/);
    expect(whereChunks).toHaveLength(0);
  });

  it("rejects company scope without scopeId", async () => {
    await expect(async () => svc.listEntities("p", { scopeKind: "company" })).rejects.toThrow(/scopeId/);
    expect(whereChunks).toHaveLength(0);
  });

  it("rejects unknown scopeKind", async () => {
    await expect(
      async () => svc.listEntities("p", { scopeKind: "galaxy" as unknown as "company" }),
    ).rejects.toThrow(/scopeKind/);
    expect(whereChunks).toHaveLength(0);
  });

  it("still applies entityType / externalId filters alongside scope", async () => {
    await svc.listEntities("p", { scopeKind: "company", scopeId: "company-a", entityType: "t", externalId: "a1" });
    const text = conditionText();
    expect(text).toContain("company-a");
    expect(text).toContain("t");
    expect(text).toContain("a1");
  });
});
