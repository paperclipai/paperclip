import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTemplateRegistry } from "../services/template-registry.js";

function writeRegistry(dir: string, payload: unknown) {
  writeFileSync(path.join(dir, "registry.json"), JSON.stringify(payload));
}

describe("createTemplateRegistry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "tpl-registry-"));
  });

  it("loads a valid registry file", async () => {
    writeRegistry(dir, {
      version: 1,
      generated_at: "2026-04-16T14:00:00Z",
      source: "https://github.com/paperclipai/companies",
      companies: [
        { slug: "a", name: "A", description: "x", agents_count: 1, skills_count: 0, tags: [], url: "https://example.com" },
      ],
    });
    const registry = createTemplateRegistry(path.join(dir, "registry.json"));
    const loaded = await registry.get();
    expect(loaded.companies).toHaveLength(1);
    expect(loaded.companies[0].slug).toBe("a");
  });

  it("throws when file missing", async () => {
    const registry = createTemplateRegistry(path.join(dir, "missing.json"));
    await expect(registry.get()).rejects.toThrow(/not found/i);
  });

  it("throws when schema invalid", async () => {
    writeRegistry(dir, { version: 99, companies: [] });
    const registry = createTemplateRegistry(path.join(dir, "registry.json"));
    await expect(registry.get()).rejects.toThrow();
  });

  it("caches the parsed result between calls", async () => {
    writeRegistry(dir, {
      version: 1,
      generated_at: "2026-04-16T14:00:00Z",
      source: "https://github.com/paperclipai/companies",
      companies: [],
    });
    const registry = createTemplateRegistry(path.join(dir, "registry.json"));
    const first = await registry.get();
    // Corrupt the file; cached result must still return.
    writeFileSync(path.join(dir, "registry.json"), "not json");
    const second = await registry.get();
    expect(second).toBe(first);
  });

  it("invalidate() forces a fresh read", async () => {
    writeRegistry(dir, { version: 1, generated_at: "x", source: "https://x.example", companies: [] });
    const registry = createTemplateRegistry(path.join(dir, "registry.json"));
    await registry.get();
    writeRegistry(dir, {
      version: 1,
      generated_at: "y",
      source: "https://x.example",
      companies: [{ slug: "b", name: "B", description: "x", agents_count: 0, skills_count: 0, tags: [], url: "https://example.com" }],
    });
    registry.invalidate();
    const fresh = await registry.get();
    expect(fresh.companies).toHaveLength(1);
  });
});
