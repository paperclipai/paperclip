import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createParaMemoryAdapter } from "../services/memory-adapters/para.js";
import type { MemoryScope, MemorySourceRef } from "@paperclipai/plugin-sdk";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "para-test-"));
}

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const scope: MemoryScope = { companyId: COMPANY_ID, agentId: "00000000-0000-4000-8000-a00000000001" };
const source: MemorySourceRef = { kind: "manual_note", companyId: COMPANY_ID };

describe("ParaMemoryAdapter", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("has key 'para' and declares no optional capabilities", () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });
    expect(adapter.key).toBe("para");
    expect(adapter.capabilities).toEqual({
      profile: false,
      browse: false,
      correction: false,
      asyncIngestion: false,
      multimodal: false,
      providerManagedExtraction: false,
    });
  });

  // ── Write ────────────────────────────────────────────────────────────

  it("write: creates a daily note by default", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });
    const result = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Shipped the feature",
      metadata: { date: "2026-04-07" },
    });

    expect(result.records).toHaveLength(1);
    expect(result.records![0].providerKey).toBe("para");
    expect(result.records![0].providerRecordId).toContain("memory/2026-04-07.md");
    expect(result.usage).toHaveLength(1);
    expect(result.usage![0].provider).toBe("para");

    const content = readFileSync(join(dir, COMPANY_ID, "memory", "2026-04-07.md"), "utf8");
    expect(content).toContain("Shipped the feature");
  });

  it("write: creates an entity fact in items.yaml", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });
    const result = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Works on infrastructure team",
      metadata: { layer: "entity", entityPath: "areas/people/alice", category: "status" },
    });

    expect(result.records).toHaveLength(1);
    expect(result.records![0].providerRecordId).toContain("#");

    const yaml = readFileSync(join(dir, COMPANY_ID, "life", "areas", "people", "alice", "items.yaml"), "utf8");
    expect(yaml).toContain("Works on infrastructure team");
    expect(yaml).toContain("status: active");
  });

  it("write: upserts an existing entity fact", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });

    // First write
    await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Original fact",
      metadata: { layer: "entity", entityPath: "areas/people/bob", factId: "bob-001" },
    });

    // Upsert same factId
    await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Updated fact",
      metadata: { layer: "entity", entityPath: "areas/people/bob", factId: "bob-001" },
      mode: "upsert",
    });

    const yaml = readFileSync(join(dir, COMPANY_ID, "life", "areas", "people", "bob", "items.yaml"), "utf8");
    expect(yaml).toContain("Updated fact");
    // Should not have duplicated the fact
    expect(yaml.match(/bob-001/g)?.length).toBe(1);
  });

  it("write: appends to tacit knowledge (MEMORY.md)", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });

    await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "User prefers terse output",
      metadata: { layer: "tacit" },
    });

    await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "User is a morning person",
      metadata: { layer: "tacit" },
    });

    const content = readFileSync(join(dir, COMPANY_ID, "MEMORY.md"), "utf8");
    expect(content).toContain("User prefers terse output");
    expect(content).toContain("User is a morning person");
  });

  // ── Get ──────────────────────────────────────────────────────────────

  it("get: retrieves a daily note by handle", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });
    const { records } = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Met with client",
      metadata: { date: "2026-04-07" },
    });

    const snippet = await adapter.get(records![0], scope);
    expect(snippet).not.toBeNull();
    expect(snippet!.text).toContain("Met with client");
  });

  it("get: retrieves a single entity fact by handle", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });
    const { records } = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Leads the platform team",
      metadata: { layer: "entity", entityPath: "areas/people/carol", factId: "carol-001" },
    });

    const snippet = await adapter.get(records![0], scope);
    expect(snippet).not.toBeNull();
    expect(snippet!.text).toBe("Leads the platform team");
    expect(snippet!.metadata?.id).toBe("carol-001");
    expect(snippet!.metadata?.status).toBe("active");
  });

  it("get: returns null for missing file", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });
    const snippet = await adapter.get(
      { providerKey: "para", providerRecordId: "nonexistent.md" },
      scope,
    );
    expect(snippet).toBeNull();
  });

  // ── Query ────────────────────────────────────────────────────────────

  it("query: keyword search finds matching content", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });

    await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Deployed the authentication service",
      metadata: { date: "2026-04-06" },
    });
    await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Fixed database migration bug",
      metadata: { date: "2026-04-07" },
    });

    const result = await adapter.query({
      bindingKey: "default",
      scope,
      query: "authentication service",
      topK: 5,
    });

    expect(result.snippets.length).toBeGreaterThanOrEqual(1);
    expect(result.snippets[0].text).toContain("authentication");
    expect(result.usage).toHaveLength(1);
  });

  it("query: returns empty for no matches", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });
    const result = await adapter.query({
      bindingKey: "default",
      scope,
      query: "quantum entanglement",
      topK: 5,
    });
    expect(result.snippets).toHaveLength(0);
  });

  // ── Forget ───────────────────────────────────────────────────────────

  it("forget: supersedes an entity fact (never deletes)", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });
    const { records } = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Outdated fact",
      metadata: { layer: "entity", entityPath: "areas/people/dave", factId: "dave-001" },
    });

    const result = await adapter.forget(records!, scope);
    expect(result.usage).toHaveLength(1);
    expect(result.usage![0].details?.factsSuperseded).toBe(1);

    // The fact should still exist but be superseded
    const snippet = await adapter.get(records![0], scope);
    expect(snippet).not.toBeNull();
    expect(snippet!.metadata?.status).toBe("superseded");

    // The file should still exist
    expect(existsSync(join(dir, COMPANY_ID, "life", "areas", "people", "dave", "items.yaml"))).toBe(true);
  });

  it("forget: is idempotent for already-superseded facts", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });
    const { records } = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Old info",
      metadata: { layer: "entity", entityPath: "resources/misc", factId: "misc-001" },
    });

    await adapter.forget(records!, scope);
    const result = await adapter.forget(records!, scope);
    expect(result.usage![0].details?.factsSuperseded).toBe(0);
  });

  // ── Full roundtrip ──────────────────────────────────────────────────

  it("validates full path: write → get → query → forget", async () => {
    const adapter = createParaMemoryAdapter({ basePath: dir });

    // Write
    const { records } = await adapter.write({
      bindingKey: "default",
      scope,
      source,
      content: "Paperclip memory integration works end-to-end",
      metadata: { layer: "entity", entityPath: "projects/paperclip", factId: "pap-001" },
    });
    expect(records).toHaveLength(1);

    // Get
    const snippet = await adapter.get(records![0], scope);
    expect(snippet!.text).toBe("Paperclip memory integration works end-to-end");

    // Query
    const queryResult = await adapter.query({
      bindingKey: "default",
      scope,
      query: "paperclip memory integration",
    });
    expect(queryResult.snippets.length).toBeGreaterThanOrEqual(1);

    // Forget
    const forgetResult = await adapter.forget(records!, scope);
    expect(forgetResult.usage![0].details?.factsSuperseded).toBe(1);

    // Verify superseded
    const after = await adapter.get(records![0], scope);
    expect(after!.metadata?.status).toBe("superseded");
  });
});
