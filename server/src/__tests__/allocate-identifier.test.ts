// Phase 2.2 follow-up tests for the identifier allocator
// (onprem-k8s commit 9979d0d / .planning/linear-id-unification.md).
//
// Covers:
//   - Paperclip path mints `${prefix}-N` from issueCounter (regression guard
//     for the refactor in PR #47).
//   - Linear path error envelope:
//       * paperclip-plugin-linear not installed
//       * plugin installed but no plugin_company_settings row for the company
//       * settings exist but missing teamId
//       * settings exist but missing linearTokenRef
//
// Out of scope (separate follow-up): the happy-path mocked fetch +
// company_secrets resolution, which requires a fake `inline` SecretProvider
// to exercise the full secretService path. The error envelope below is the
// most-common production-time error surface (a company flips
// identifier_provider='linear' without configuring the plugin first), so
// tightening the messages here is what shields operators from confusion.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issues,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { allocateIdentifier } from "../services/identifier-allocator.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("allocateIdentifier", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-allocate-id-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  async function createTestCompany(opts?: { identifierProvider?: "paperclip" | "linear" }) {
    const [row] = await db
      .insert(companies)
      .values({
        name: `alloc-id ${randomUUID()}`,
        issuePrefix: `AL${randomUUID().slice(0, 6).toUpperCase()}`,
        ...(opts?.identifierProvider ? { identifierProvider: opts.identifierProvider } : {}),
      })
      .returning();
    return row;
  }

  async function installLinearPlugin() {
    const [row] = await db
      .insert(plugins)
      .values({
        pluginKey: "paperclip-plugin-linear",
        packageName: "@kkroo/paperclip-plugin-linear",
        version: "0.9.3",
        // manifest_json is jsonb<PaperclipPluginManifestV1> — empty object
        // is enough to satisfy the NOT NULL; tests don't exercise manifest
        // semantics. Cast through unknown so we don't pin to the full type
        // surface (which has many required fields).
        manifestJson: {} as never,
      })
      .returning();
    return row;
  }

  it("paperclip path mints `${prefix}-1` for the first issue in a fresh company", async () => {
    const company = await createTestCompany();
    const result = await allocateIdentifier({ db, companyId: company.id, title: "first" });
    expect(result.source).toBe("paperclip");
    expect(result.identifier).toBe(`${company.issuePrefix}-1`);
    expect(result.issueNumber).toBe(1);
  });

  it("paperclip path increments issueCounter on each call", async () => {
    const company = await createTestCompany();
    const a = await allocateIdentifier({ db, companyId: company.id, title: "a" });
    const b = await allocateIdentifier({ db, companyId: company.id, title: "b" });
    expect(a.issueNumber).toBe(1);
    expect(b.issueNumber).toBe(2);
    expect(b.identifier).toBe(`${company.issuePrefix}-2`);
  });

  it("linear path errors when paperclip-plugin-linear is not installed", async () => {
    const company = await createTestCompany({ identifierProvider: "linear" });
    await expect(
      allocateIdentifier({ db, companyId: company.id, title: "x" }),
    ).rejects.toThrow(/paperclip-plugin-linear is not installed/);
  });

  it("linear path errors when the plugin has no settings for the company", async () => {
    // PR #53 collapsed the per-field "is not configured" error into a
    // single OAuth-aware "has no teamId" error: when no settings row
    // exists AND no plugin_state oauth-team-id exists, the function
    // throws on the missing teamId before even looking at tokens.
    const company = await createTestCompany({ identifierProvider: "linear" });
    await installLinearPlugin();
    await expect(
      allocateIdentifier({ db, companyId: company.id, title: "x" }),
    ).rejects.toThrow(/has no teamId for company/);
  });

  it("linear path errors when settings are missing teamId", async () => {
    // settingsTokenRef present, settingsTeamId null → PAT path requires
    // both, falls through to OAuth fallback. With no plugin_state
    // oauth-team-id seeded either, throws "has no teamId for company".
    const company = await createTestCompany({ identifierProvider: "linear" });
    const plugin = await installLinearPlugin();
    await db.insert(pluginCompanySettings).values({
      companyId: company.id,
      pluginId: plugin.id,
      settingsJson: { linearTokenRef: "00000000-0000-0000-0000-000000000000" },
    });
    await expect(
      allocateIdentifier({ db, companyId: company.id, title: "x" }),
    ).rejects.toThrow(/has no teamId for company/);
  });

  it("linear path errors when settings have a teamId but no PAT or OAuth token", async () => {
    // PR #53 added the OAuth fallback: settingsTeamId present but no
    // tokenRef → falls through PAT path, oauthTeamId resolves to the
    // settingsTeamId, but neither plugin_state secret-token-ref nor
    // legacy oauth-token is seeded → throws "is not authenticated".
    const company = await createTestCompany({ identifierProvider: "linear" });
    const plugin = await installLinearPlugin();
    await db.insert(pluginCompanySettings).values({
      companyId: company.id,
      pluginId: plugin.id,
      settingsJson: { teamId: "fake-linear-team-id" },
    });
    await expect(
      allocateIdentifier({ db, companyId: company.id, title: "x" }),
    ).rejects.toThrow(/is not authenticated for company/);
  });
});
