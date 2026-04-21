import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDpo } from "../src/index.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dpo-rt-")); vi.restoreAllMocks(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function mockClassifier(findings: Array<{ type: string; value: string; confidence: string }>) {
  vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({ findings }) } }],
      }),
      { status: 200 },
    ),
  );
}

describe("Round-Trip anonymize → deanonymize", () => {
  it("liefert Originaltext zurück, wenn Pseudonyme unverändert in der Antwort stehen", async () => {
    mockClassifier([{ type: "PERSON", value: "Max", confidence: "high" }]);
    const dpo = createDpo({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
    });
    const a = await dpo.anonymize({
      text: "Max ruft an unter +49 30 12345678",
      targetLlm: "claude",
      agent: "ceo",
    });
    if ("blocked" in a) throw new Error("blocked");
    const llmResponse = `Vermerkt: ${a.anonymizedText}`;
    const back = dpo.deanonymize({ mappingId: a.mappingId, text: llmResponse });
    expect(back.text).toContain("Max");
    expect(back.text).toContain("+49 30 12345678");
    dpo.close();
  });

  it("liefert leeren Mapping-Lookup für unbekannte mappingId — Text bleibt unverändert", () => {
    const dpo = createDpo({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
    });
    const r = dpo.deanonymize({ mappingId: "unknown", text: "[PERSON_A] hallo" });
    expect(r.text).toBe("[PERSON_A] hallo");
    dpo.close();
  });
});
