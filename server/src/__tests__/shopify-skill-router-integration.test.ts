import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveRoutedShopifyConfig } from "../services/shopify-skill-router.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Shopify router tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("resolveRoutedShopifyConfig", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-shopify-router-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("merges routed skill keys with existing desired skills", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PLU",
      requireBoardApprovalForNewAgents: false,
    });

    const result = await resolveRoutedShopifyConfig({
      db,
      companyId,
      issueId: randomUUID(),
      agent: { role: "lead_engineer", capabilities: null },
      resolvedConfig: {
        paperclipSkillSync: {
          desiredSkills: ["garrytan/gstack/plan-eng-review"],
        },
      },
      resolver: vi.fn().mockResolvedValue({
        skillKeys: [
          "shopify/shopify-ai-toolkit/shopify-dev",
          "shopify/shopify-ai-toolkit/shopify-liquid",
        ],
        matchedRules: ["liquid"],
        gated: false,
      }),
    });

    expect((result.config.paperclipSkillSync as { desiredSkills: string[] }).desiredSkills).toEqual([
      "garrytan/gstack/plan-eng-review",
      "shopify/shopify-ai-toolkit/shopify-dev",
      "shopify/shopify-ai-toolkit/shopify-liquid",
    ]);
  });

  it("keeps the resolved config byte-identical when the router gates out", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PLU",
      requireBoardApprovalForNewAgents: false,
    });

    const resolvedConfig = {
      env: { HOME: "/tmp/test-home" },
      paperclipSkillSync: {
        desiredSkills: ["garrytan/gstack/plan-eng-review"],
      },
    } satisfies Record<string, unknown>;

    const result = await resolveRoutedShopifyConfig({
      db,
      companyId,
      issueId: randomUUID(),
      agent: { role: "lead_engineer", capabilities: null },
      resolvedConfig,
      resolver: vi.fn().mockResolvedValue({
        skillKeys: [],
        matchedRules: [],
        gated: true,
      }),
    });

    expect(result.config).toBe(resolvedConfig);
  });

  it("preserves the baseline config and warns when routing throws", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PLU",
      requireBoardApprovalForNewAgents: false,
    });

    const onWarning = vi.fn();
    const resolvedConfig = {
      paperclipSkillSync: {
        desiredSkills: ["garrytan/gstack/plan-eng-review"],
      },
    } satisfies Record<string, unknown>;

    const result = await resolveRoutedShopifyConfig({
      db,
      companyId,
      issueId: randomUUID(),
      agent: { role: "lead_engineer", capabilities: null },
      resolvedConfig,
      onWarning,
      resolver: vi.fn().mockRejectedValue(new Error("boom")),
    });

    expect(result.config).toBe(resolvedConfig);
    expect(result.routing).toEqual({ skillKeys: [], matchedRules: [], gated: true });
    expect(onWarning).toHaveBeenCalledWith("[paperclip] Shopify skill router warning: boom\n");
  });

  it("skips routing entirely when the heartbeat has no issue id", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PLU",
      requireBoardApprovalForNewAgents: false,
    });

    const resolver = vi.fn();
    const resolvedConfig = {
      paperclipSkillSync: {
        desiredSkills: ["garrytan/gstack/plan-eng-review"],
      },
    } satisfies Record<string, unknown>;

    const result = await resolveRoutedShopifyConfig({
      db,
      companyId,
      issueId: null,
      agent: { role: "lead_engineer", capabilities: null },
      resolvedConfig,
      resolver,
    });

    expect(result.config).toBe(resolvedConfig);
    expect(result.routing).toEqual({ skillKeys: [], matchedRules: [], gated: true });
    expect(resolver).not.toHaveBeenCalled();
  });
});
