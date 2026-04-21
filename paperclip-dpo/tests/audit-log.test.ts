import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, hashPrompt } from "../src/audit-log.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dpo-audit-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("hashPrompt", () => {
  it("liefert deterministischen sha256-Hex", () => {
    const h = hashPrompt("test");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashPrompt("test")).toBe(h);
  });
});

describe("AuditLog", () => {
  it("schreibt Eintrag als JSONL", () => {
    const log = new AuditLog({ dir });
    log.write({
      ts: "2026-04-20T10:00:00Z",
      agent: "ceo",
      targetLlm: "claude-opus-4-7",
      tenantId: "whitestag-internal",
      promptHash: "sha256:abc",
      findings: { PERSON: 1 },
      blocked: false,
    });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const content = readFileSync(join(dir, files[0]), "utf8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.agent).toBe("ceo");
  });

  it("rotiert Datei pro Tag im Format dpo-YYYY-MM-DD.jsonl", () => {
    const log = new AuditLog({ dir });
    log.write({
      ts: "2026-04-20T10:00:00Z",
      agent: "ceo",
      targetLlm: "x",
      tenantId: "t",
      promptHash: "h",
      findings: {},
      blocked: false,
    });
    const files = readdirSync(dir);
    expect(files[0]).toMatch(/^dpo-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  it("hängt mehrere Einträge desselben Tages aneinander", () => {
    const log = new AuditLog({ dir });
    log.write({ ts: "2026-04-20T10:00:00Z", agent: "a", targetLlm: "x", tenantId: "t", promptHash: "h1", findings: {}, blocked: false });
    log.write({ ts: "2026-04-20T11:00:00Z", agent: "b", targetLlm: "x", tenantId: "t", promptHash: "h2", findings: {}, blocked: false });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0]), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
