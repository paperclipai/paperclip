import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDpo } from "../src/index.js";

const RUN_INTEGRATION = process.env.DPO_INTEGRATION === "1";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dpo-it-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

(RUN_INTEGRATION ? describe : describe.skip)("integration: echter Gemma-Klassifikator", () => {
  it("anonymisiert PII + LLM-Entitäten + schreibt Audit-Log", async () => {
    const dpo = createDpo({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: {
        url: process.env.LM_STUDIO_URL ?? "http://localhost:1234",
        model: process.env.LM_STUDIO_MODEL ?? "gemma-4-26b",
        timeoutMs: 30000,
      },
    });

    const prompt = `Hallo Claude, bitte fasse zusammen: Max Mustermann von WHITESTAG GmbH
schreibt aus 03046 Cottbus an max@whitestag.de wegen IBAN DE89370400440532013000.
Unser Umsatz war letztes Jahr 1,2 Mio EUR.`;

    const result = await dpo.anonymize({
      text: prompt,
      targetLlm: "claude-opus-4-7",
      agent: "ceo",
    });

    if ("blocked" in result) throw new Error("unexpected block: " + result.reason);

    expect(result.anonymizedText).not.toContain("Max Mustermann");
    expect(result.anonymizedText).not.toContain("max@whitestag.de");
    expect(result.anonymizedText).not.toContain("DE89370400440532013000");
    expect(result.findings.length).toBeGreaterThan(0);

    const auditFiles = readdirSync(join(dir, "audit"));
    expect(auditFiles).toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(dir, "audit", auditFiles[0]), "utf8").trim());
    expect(entry.agent).toBe("ceo");
    expect(entry.promptHash).toMatch(/^sha256:/);

    dpo.close();
  }, 60000);
});
