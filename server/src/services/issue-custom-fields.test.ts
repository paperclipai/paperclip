import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createDb,
  applyPendingMigrations,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { companies, plugins, issues } from "@paperclipai/db";
import { issueCustomFieldService } from "./issue-custom-fields.js";

let db: ReturnType<typeof createDb>;
let cleanup: () => Promise<void>;
let embeddedPostgresSupported = false;

beforeAll(async () => {
  const support = await getEmbeddedPostgresTestSupport();
  embeddedPostgresSupported = support.supported;
  if (!embeddedPostgresSupported) return;

  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-icf-svc-");
  cleanup = testDb.cleanup;
  await applyPendingMigrations(testDb.connectionString);
  db = createDb(testDb.connectionString);
});

afterAll(async () => {
  await (db?.$client as any)?.end?.();
  await cleanup?.();
});

type TestParents = { companyId: string; issueId: string; pluginId: string };

async function insertParents(): Promise<TestParents> {
  if (!embeddedPostgresSupported) throw new Error("embedded postgres not supported");
  const prefix = Math.random().toString(36).slice(2, 5).toUpperCase();
  const [company] = await db.insert(companies).values({ name: "test-co", issuePrefix: prefix }).returning({ id: companies.id });
  const [plugin] = await db.insert(plugins).values({
    pluginKey: `test.plugin.${Math.random().toString(36).slice(2)}`,
    packageName: "test-plugin",
    version: "1.0.0",
    apiVersion: 1,
    manifestJson: { customFields: [{ key: "workstream", label: "Workstream", type: "text", scope: "issue" }] } as unknown as typeof plugins.$inferInsert["manifestJson"],
  }).returning({ id: plugins.id });
  const [issue] = await db.insert(issues).values({
    companyId: company.id,
    title: "Test issue",
    status: "backlog",
    priority: "medium",
    originKind: "manual",
    requestDepth: 0,
    originFingerprint: "default",
  }).returning({ id: issues.id });
  return { companyId: company.id, issueId: issue.id, pluginId: plugin.id };
}

describe("issueCustomFieldService", () => {
  it("set and listForIssue round-trip", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await svc.set({ companyId, issueId, pluginId, key: "workstream", value: "clone-3", fieldType: "text", fieldLabel: "Workstream" });
    const fields = await svc.listForIssue({ companyId, issueId, pluginId });

    expect(fields).toHaveLength(1);
    expect(fields[0].key).toBe("workstream");
    expect(fields[0].valueText).toBe("clone-3");
    expect(fields[0].pluginId).toBe(pluginId);
  });

  it("unset soft-deletes the field row", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await svc.set({ companyId, issueId, pluginId, key: "workstream", value: "clone-3", fieldType: "text", fieldLabel: "Workstream" });
    await svc.unset({ companyId, issueId, pluginId, key: "workstream" });
    const fields = await svc.listForIssue({ companyId, issueId, pluginId });

    expect(fields).toHaveLength(0);
  });

  it("unset on non-existent row is noop (no error)", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await expect(svc.unset({ companyId, issueId, pluginId, key: "workstream" })).resolves.not.toThrow();
  });

  it("re-set after unset inserts new live row", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await svc.set({ companyId, issueId, pluginId, key: "workstream", value: "v1", fieldType: "text", fieldLabel: "Workstream" });
    await svc.unset({ companyId, issueId, pluginId, key: "workstream" });
    await svc.set({ companyId, issueId, pluginId, key: "workstream", value: "v2", fieldType: "text", fieldLabel: "Workstream" });

    const fields = await svc.listForIssue({ companyId, issueId, pluginId });
    expect(fields).toHaveLength(1);
    expect(fields[0].valueText).toBe("v2");
  });

  it("rejects invalid field key (dots)", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await expect(
      svc.set({ companyId, issueId, pluginId, key: "bad.key", value: "v1", fieldType: "text", fieldLabel: "Label" })
    ).rejects.toThrow(/invalid field key/i);
  });

  it("rejects invalid field key (uppercase)", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await expect(
      svc.set({ companyId, issueId, pluginId, key: "BadKey", value: "v1", fieldType: "text", fieldLabel: "Label" })
    ).rejects.toThrow(/invalid field key/i);
  });

  it("tenant guard: rejects set if issue not in company", async () => {
    if (!embeddedPostgresSupported) return;
    const { issueId, pluginId } = await insertParents();
    const { companyId: otherCompanyId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await expect(
      svc.set({ companyId: otherCompanyId, issueId, pluginId, key: "workstream", value: "v1", fieldType: "text", fieldLabel: "Label" })
    ).rejects.toThrow(/not found|unauthorized/i);
  });

  it("listForIssue scoped to pluginId only", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const { pluginId: otherPluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await svc.set({ companyId, issueId, pluginId, key: "workstream", value: "mine", fieldType: "text", fieldLabel: "Workstream" });
    await svc.set({ companyId, issueId, pluginId: otherPluginId, key: "workstream", value: "theirs", fieldType: "text", fieldLabel: "Workstream" });

    const fields = await svc.listForIssue({ companyId, issueId, pluginId });
    expect(fields).toHaveLength(1);
    expect(fields[0].valueText).toBe("mine");
  });

  it("set stores valueNumber for number type", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await svc.set({ companyId, issueId, pluginId, key: "score", value: "42.5", fieldType: "number", fieldLabel: "Score" });
    const fields = await svc.listForIssue({ companyId, issueId, pluginId });

    expect(fields).toHaveLength(1);
    expect(fields[0].valueText).toBe("42.5");
    expect(fields[0].valueNumber).toBe(42.5);
  });

  it("rejects invalid url type value (javascript: scheme)", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await expect(
      svc.set({ companyId, issueId, pluginId, key: "docs", value: "javascript:alert(1)", fieldType: "url", fieldLabel: "Docs" })
    ).rejects.toThrow(/invalid.*url|scheme/i);
  });

  it("rejects invalid url type value (data: scheme)", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await expect(
      svc.set({ companyId, issueId, pluginId, key: "docs", value: "data:text/html,<h1>xss</h1>", fieldType: "url", fieldLabel: "Docs" })
    ).rejects.toThrow(/invalid.*url|scheme/i);
  });

  it("rejects invalid number value (NaN string)", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await expect(
      svc.set({ companyId, issueId, pluginId, key: "score", value: "not-a-number", fieldType: "number", fieldLabel: "Score" })
    ).rejects.toThrow(/invalid.*number/i);
  });

  it("rejects number value with embedded XSS (partial number string)", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await expect(
      svc.set({ companyId, issueId, pluginId, key: "score", value: "1<script>", fieldType: "number", fieldLabel: "Score" })
    ).rejects.toThrow(/invalid.*number/i);
  });

  it("set accepts enum-ref type and stores value as text", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await svc.set({ companyId, issueId, pluginId, key: "status", value: "open", fieldType: "enum-ref", fieldLabel: "Status" });
    const fields = await svc.listForIssue({ companyId, issueId, pluginId });

    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe("enum-ref");
    expect(fields[0].valueText).toBe("open");
    expect(fields[0].valueNumber).toBeNull();
  });

  it("rejects url type with unparseable string", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await expect(
      svc.set({ companyId, issueId, pluginId, key: "docs", value: "not a url at all", fieldType: "url", fieldLabel: "Docs" })
    ).rejects.toThrow(/invalid.*url/i);
  });

  it("set accepts valid https url and stores value", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await svc.set({ companyId, issueId, pluginId, key: "docs", value: "https://example.com/path", fieldType: "url", fieldLabel: "Docs" });
    const fields = await svc.listForIssue({ companyId, issueId, pluginId });

    expect(fields).toHaveLength(1);
    expect(fields[0].valueText).toBe("https://example.com/path");
  });

  it("listForIssuesBatch returns empty map for empty issueIds", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    const result = await svc.listForIssuesBatch({ companyId, issueIds: [], pluginId });
    expect(result.size).toBe(0);
  });

  it("listForIssuesBatch returns fields grouped by issueId", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId: issueId1, pluginId } = await insertParents();
    // Insert a second issue in the same company
    const [issue2] = await db.insert(issues).values({
      companyId,
      title: "Second issue",
      status: "backlog",
      priority: "medium",
      originKind: "manual",
      requestDepth: 0,
      originFingerprint: "default2",
    }).returning({ id: issues.id });
    const issueId2 = issue2.id;

    const svc = issueCustomFieldService(db);
    await svc.set({ companyId, issueId: issueId1, pluginId, key: "score", value: "10", fieldType: "number", fieldLabel: "Score" });
    await svc.set({ companyId, issueId: issueId2, pluginId, key: "score", value: "20", fieldType: "number", fieldLabel: "Score" });

    const result = await svc.listForIssuesBatch({ companyId, issueIds: [issueId1, issueId2], pluginId });
    expect(result.size).toBe(2);
    expect(result.get(issueId1)?.[0]?.valueText).toBe("10");
    expect(result.get(issueId2)?.[0]?.valueText).toBe("20");
  });

  it("unset returns false for non-existent key (no-op detection)", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    const result = await svc.unset({ companyId, issueId, pluginId, key: "nonexistent" });
    expect(result).toBe(false);
  });

  it("unset returns true when a live row was deleted", async () => {
    if (!embeddedPostgresSupported) return;
    const { companyId, issueId, pluginId } = await insertParents();
    const svc = issueCustomFieldService(db);

    await svc.set({ companyId, issueId, pluginId, key: "tag", value: "active", fieldType: "text", fieldLabel: "Tag" });
    const result = await svc.unset({ companyId, issueId, pluginId, key: "tag" });
    expect(result).toBe(true);
  });
});
