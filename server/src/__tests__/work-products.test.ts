import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workProductService } from "../services/work-products.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("workProductService", () => {
  it("uses a transaction when creating a new primary work product", async () => {
    const issueRow = {
      id: "issue-1",
      companyId: "company-1",
      status: "in_progress",
      executionContract: null,
    };
    const txSelect = vi.fn(() => ({
      from: () => ({
        where: () => ({
          for: () => Promise.resolve([issueRow]),
        }),
      }),
    }));
    const updatedWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updatedWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertedRow = createWorkProductRow();
    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = {
      select: txSelect,
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.createForIssue("issue-1", "company-1", {
      type: "pull_request",
      provider: "github",
      title: "PR 1",
      status: "open",
      reviewState: "draft",
      isPrimary: true,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("work-product-1");
  });

  it("uses a transaction when promoting an existing work product to primary", async () => {
    const existingRow = createWorkProductRow({ isPrimary: false, projectId: null });
    const issueRow = {
      id: "issue-1",
      companyId: "company-1",
      status: "in_progress",
      executionContract: null,
    };
    const txSelect = vi.fn()
      .mockImplementationOnce(() => ({
        from: () => {
          const query = {
            innerJoin: () => query,
            leftJoin: () => query,
            where: () => Promise.resolve([existingRow]),
          };
          return query;
        },
      }))
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({ for: () => Promise.resolve([issueRow]) }),
        }),
      }));

    const updateReturning = vi
      .fn()
      .mockResolvedValue([createWorkProductRow({ reviewState: "ready_for_review" })]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = {
      select: txSelect,
      update: txUpdate,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.update("work-product-1", {
      isPrimary: true,
      reviewState: "ready_for_review",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(2);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(result?.reviewState).toBe("ready_for_review");
  });
});

describeEmbeddedPostgres("workProductService company isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-products-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("hides legacy rows whose issue or linked resource belongs to another company", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const issueId = randomUUID();
    const otherProjectId = randomUUID();

    await db.insert(companies).values([
      { id: companyId, name: "Company A", issuePrefix: `A${companyId.slice(0, 5)}` },
      { id: otherCompanyId, name: "Company B", issuePrefix: `B${otherCompanyId.slice(0, 5)}` },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Company A issue",
      status: "in_progress",
    });
    await db.insert(projects).values({
      id: otherProjectId,
      companyId: otherCompanyId,
      name: "Company B project",
    });

    const [valid, foreignCompany, foreignProject] = await db
      .insert(issueWorkProducts)
      .values([
        {
          companyId,
          issueId,
          type: "artifact",
          provider: "internal",
          title: "Valid artifact",
          status: "ready",
        },
        {
          companyId: otherCompanyId,
          issueId,
          type: "artifact",
          provider: "internal",
          title: "Mismatched parent company",
          status: "ready",
        },
        {
          companyId,
          issueId,
          projectId: otherProjectId,
          type: "artifact",
          provider: "internal",
          title: "Mismatched project company",
          status: "ready",
        },
      ])
      .returning();

    const svc = workProductService(db);

    await expect(svc.listForIssue(issueId, companyId)).resolves.toEqual([
      expect.objectContaining({ id: valid.id, companyId }),
    ]);
    await expect(svc.listForIssue(issueId, otherCompanyId)).resolves.toEqual([]);
    await expect(svc.getById(foreignCompany.id)).resolves.toBeNull();
    await expect(svc.getById(foreignProject.id)).resolves.toBeNull();
    await expect(svc.update(foreignCompany.id, { title: "Should not update" })).resolves.toBeNull();
    await expect(svc.remove(foreignCompany.id)).resolves.toBeNull();

    const [persistedForeignRow] = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, foreignCompany.id));
    expect(persistedForeignRow?.title).toBe("Mismatched parent company");
  });
});
