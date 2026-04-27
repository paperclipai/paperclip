import { describe, expect, it, vi } from "vitest";
import type { Db } from "./client.js";
import { agents, companies, companySkills } from "./schema/index.js";
import {
  OREBIT_BOOTSTRAP_COMPANY,
  seedCanonicalOrebitCompany,
  seedCanonicalOrebitRoster,
  type CanonicalCompanyBootstrap,
} from "./seed.js";

function createDbMock() {
  const calls: Array<{ table: unknown; values: unknown }> = [];
  const state = {
    companies: [] as Array<Record<string, unknown>>,
    skills: [] as Array<Record<string, unknown>>,
    agents: [] as Array<Record<string, unknown>>,
  };

  function createOperation(table: unknown, values: unknown) {
    const operation = {
      onConflictDoUpdate() {
        return operation;
      },
      onConflictDoNothing() {
        return operation;
      },
      async returning() {
        calls.push({ table, values });

        if (table === companies) {
          const record = values as Record<string, unknown>;
          const issuePrefix = record.issuePrefix as string;
          const existing = state.companies.find((company) => company.issuePrefix === issuePrefix);
          if (existing) {
            Object.assign(existing, record, { id: existing.id });
            return [existing];
          }

          const created = { id: `company-${state.companies.length + 1}`, ...record };
          state.companies.push(created);
          return [created];
        }

        if (table === agents) {
          const record = values as Record<string, unknown>;
          const existing = state.agents.find((agent) => agent.id === record.id);
          if (existing) {
            Object.assign(existing, record);
            return [existing];
          }

          const created = { ...record };
          state.agents.push(created);
          return [created];
        }

        if (Array.isArray(values)) {
          return values.map((entry) => {
            const record = entry as Record<string, unknown>;
            const existing = state.skills.find(
              (skill) => skill.companyId === record.companyId && skill.key === record.key,
            );
            if (existing) {
              Object.assign(existing, record, { id: existing.id });
              return existing;
            }

            const created = {
              id: `skill-${state.skills.length + 1}`,
              ...record,
            };
            state.skills.push(created);
            return created;
          });
        }

        const created = { id: `row-${calls.length}`, ...(values as Record<string, unknown>) };
        if (table === companySkills) {
          const record = values as Record<string, unknown>;
          const existing = state.skills.find(
            (skill) => skill.companyId === record.companyId && skill.key === record.key,
          );
          if (existing) {
            Object.assign(existing, record, { id: existing.id });
            return [existing];
          }
          state.skills.push(created);
        }
        return [created];
      },
    };

    return operation;
  }

    const db = {
      insert: vi.fn((table: unknown) => ({
        values: (values: unknown) => ({
          ...createOperation(table, values),
        }),
      })),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            then: async (resolve: (rows: Array<Record<string, unknown>>) => unknown) => resolve([]),
          }),
        }),
      })),
    };

  return { db: db as unknown as Pick<Db, "insert">, calls, state };
}

describe("seedCanonicalOrebitCompany", () => {
  it("seeds the canonical Orebit company and taxonomy", async () => {
    const { db, calls, state } = createDbMock();

    const result = await seedCanonicalOrebitCompany(db);
    const companyCall = calls.find((call) => call.table === companies);
    const skillCalls = calls.filter((call) => call.table === companySkills);
    const agentCalls = calls.filter((call) => call.table === agents);

    expect(result.company).toMatchObject({
      id: "company-1",
      name: "Orebit",
      description: OREBIT_BOOTSTRAP_COMPANY.description,
      issuePrefix: "ORE",
      status: "active",
    });
    expect(result.taxonomy.map((entry) => entry.slug)).toEqual([
      "geology",
      "ai",
      "geostatistics",
      "saas",
      "research",
      "ops",
    ]);

    expect(companyCall?.values).toMatchObject({
      name: "Orebit",
      description: OREBIT_BOOTSTRAP_COMPANY.description,
      issuePrefix: "ORE",
      budgetMonthlyCents: 0,
    });
    expect(skillCalls).toHaveLength(6);
    expect(skillCalls[0]?.values).toMatchObject({
      companyId: "company-1",
      key: "taxonomy/geology",
      slug: "geology",
      name: "Geology",
      sourceType: "catalog",
      trustLevel: "markdown_only",
    });
    expect(skillCalls[5]?.values).toMatchObject({
      companyId: "company-1",
      key: "taxonomy/ops",
      slug: "ops",
      name: "Ops",
      sourceType: "catalog",
      trustLevel: "markdown_only",
    });
    expect(agentCalls).toHaveLength(8);
    expect(agentCalls[0]?.values).toMatchObject({
      companyId: "company-1",
      name: "Siro Hermes",
      role: "ceo",
      adapterType: "codex_local",
      adapterConfig: expect.objectContaining({
        cwd: expect.any(String),
      }),
      reportsTo: null,
      permissions: { canCreateAgents: true },
    });
    expect(agentCalls[1]?.values).toMatchObject({
      companyId: "company-1",
      name: "Luna",
      role: "cto",
      reportsTo: expect.any(String),
    });
    expect(agentCalls[7]?.values).toMatchObject({
      companyId: "company-1",
      name: "Shiro",
      role: "general",
      reportsTo: expect.any(String),
    });
    expect(state.companies).toHaveLength(1);
    expect(state.skills).toHaveLength(6);
    expect(state.agents).toHaveLength(8);
  });

  it("reuses the canonical company and taxonomy on rerun", async () => {
    const { db, state } = createDbMock();

    const first = await seedCanonicalOrebitCompany(db);
    const second = await seedCanonicalOrebitCompany(db);

    expect(first.company.id).toBe(second.company.id);
    expect(state.companies).toHaveLength(1);
    expect(state.skills).toHaveLength(6);
    expect(state.agents).toHaveLength(8);
    expect(new Set(state.agents.map((entry) => String(entry.id))).size).toBe(8);
    expect(new Set(state.skills.map((entry) => `${entry.companyId}:${entry.key}`)).size).toBe(6);
  });

  it("reuses the canonical roster on direct roster bootstrap reruns", async () => {
    const { db, state } = createDbMock();

    await seedCanonicalOrebitRoster(db, "company-1");
    await seedCanonicalOrebitRoster(db, "company-1");

    expect(state.agents).toHaveLength(8);
    expect(new Set(state.agents.map((entry) => String(entry.id))).size).toBe(8);
    expect(state.agents.some((entry) => entry.name === "Siro Hermes" && entry.role === "ceo")).toBe(true);
    expect(state.agents.some((entry) => entry.name === "Luna" && entry.role === "cto")).toBe(true);
    expect(state.agents.some((entry) => entry.name === "Nala" && entry.role === "cmo")).toBe(true);
  });

  it("fails closed when required bootstrap identity inputs are missing", async () => {
    const { db } = createDbMock();

    await expect(
      seedCanonicalOrebitCompany(db, {
        ...OREBIT_BOOTSTRAP_COMPANY,
        taxonomy: [{ ...OREBIT_BOOTSTRAP_COMPANY.taxonomy[0], markdown: "" }],
      } as CanonicalCompanyBootstrap),
    ).rejects.toThrow(/bootstrap company identity/i);

    await expect(
      seedCanonicalOrebitCompany(db, {
        ...OREBIT_BOOTSTRAP_COMPANY,
        name: "",
      } as CanonicalCompanyBootstrap),
    ).rejects.toThrow(/bootstrap company identity/i);
  });
});
