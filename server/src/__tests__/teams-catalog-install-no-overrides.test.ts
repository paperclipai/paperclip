import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { teamsCatalogService } from "../services/teams-catalog.js";

vi.mock("../services/agent-runner-selection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/agent-runner-selection.js")>();
  return { ...actual, resolveNewAgentRunnerForCompany: async (_db: unknown, _companyId: string, input: Parameters<typeof actual.resolveNewAgentRunnerForCompany>[2]) =>
    actual.resolveNewAgentRunner({ ...input, target: { driver: "local", platform: "linux", architecture: "x64", libc: "glibc", glibcVersion: "2.39" } }) };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres teams catalog no-overrides install tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("teams catalog install with no caller adapter overrides", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempHome: string | null = null;
  let oldPaperclipHome: string | undefined;

  beforeAll(async () => {
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-teams-catalog-no-overrides-"));
    process.env.PAPERCLIP_HOME = tempHome;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-catalog-no-overrides-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (tempHome) await fs.rm(tempHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function seedEmptyCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Clean install company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function listAdapterTypesByName(companyId: string, expectedOpenCodeName?: string) {
    const rows = await db
      .select({
        name: agents.name,
        role: agents.role,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        permissions: agents.permissions,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    for (const row of rows.filter(row => row.adapterType === "paperclip_runner")) {
      expect(row.adapterConfig).toMatchObject(row.name === expectedOpenCodeName
        ? { provider: "opencode", model: "anthropic/claude-opus-4" }
        : { provider: "acpx", acpxAgent: "claude" });
    }
    return new Map(rows.map((row) => [row.name, row]));
  }

  it("installs core-exec-team end-to-end with no caller overrides and creates 3 native Claude agents", async () => {
    const companyId = await seedEmptyCompany();
    const svc = teamsCatalogService(db);

    await svc.installCatalogTeam(companyId, "core-exec-team", {
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
    });

    const byName = await listAdapterTypesByName(companyId);
    expect(byName.size).toBe(3);

    const adapterTypes = Array.from(byName.values()).map((row) => row.adapterType);
    expect(adapterTypes).toEqual(["paperclip_runner", "paperclip_runner", "paperclip_runner"]);
    expect(adapterTypes).not.toContain("process");
    expect(adapterTypes).not.toContain("http");
  });

  it("installs product-design end-to-end with no caller overrides and uses native Claude", async () => {
    const companyId = await seedEmptyCompany();
    const svc = teamsCatalogService(db);

    await svc.installCatalogTeam(companyId, "product-design", {
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
    });

    const byName = await listAdapterTypesByName(companyId);
    expect(byName.size).toBe(1);
    const adapterTypes = Array.from(byName.values()).map((row) => row.adapterType);
    expect(adapterTypes).toEqual(["paperclip_runner"]);
    expect(adapterTypes).not.toContain("process");
  });

  it("installs product-engineering end-to-end with no caller overrides and uses native Claude for every agent", async () => {
    const companyId = await seedEmptyCompany();
    const svc = teamsCatalogService(db);

    await svc.installCatalogTeam(companyId, "product-engineering", {
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
    });

    const byName = await listAdapterTypesByName(companyId);
    expect(byName.size).toBe(3);
    const adapterTypes = Array.from(byName.values()).map((row) => row.adapterType);
    expect(adapterTypes).toEqual(["paperclip_runner", "paperclip_runner", "paperclip_runner"]);
    expect(adapterTypes).not.toContain("process");
    expect(byName.get("CTO")?.permissions).toMatchObject({ canCreateAgents: true });
  });

  it("honors an explicit caller adapter override for a single slug while defaulting the rest to native Claude", async () => {
    const companyId = await seedEmptyCompany();
    const svc = teamsCatalogService(db);

    await svc.installCatalogTeam(companyId, "core-exec-team", {
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
      adapterOverrides: {
        cto: { adapterType: "opencode_local", adapterConfig: { model: "anthropic/claude-opus-4" } },
      },
    });

    const byName = await listAdapterTypesByName(companyId, "CTO");
    expect(byName.size).toBe(3);
    const ctoRow = Array.from(byName.values()).find((row) => row.role === "engineering-manager" || row.name === "CTO");
    expect(ctoRow?.adapterType).toBe("paperclip_runner");
    const otherAdapters = Array.from(byName.values())
      .filter((row) => row !== ctoRow)
      .map((row) => row.adapterType);
    expect(otherAdapters).toEqual(["paperclip_runner", "paperclip_runner"]);
  });
});
