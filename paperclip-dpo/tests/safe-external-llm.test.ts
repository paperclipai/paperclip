import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDpo } from "../src/index.js";
import { safeExternalLlm } from "../src/safe-external-llm.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dpo-safe-")); vi.restoreAllMocks(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("safeExternalLlm", () => {
  it("anonymisiert vor Call und de-anonymisiert die Antwort", async () => {
    const fetchMock = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({
          findings: [{ type: "PERSON", value: "Max", confidence: "high" }],
        }) } }],
      }), { status: 200 }));

    const dpo = createDpo({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://lmstudio", model: "g", timeoutMs: 1000 },
    });

    const externalCall = vi.fn(async (prompt: string) => {
      return `Antwort an ${prompt}`;
    });

    const result = await safeExternalLlm({
      dpo,
      prompt: "Max braucht Hilfe",
      targetLlm: "claude",
      agent: "ceo",
      externalCall,
    });

    expect(result.blocked).toBe(false);
    if (result.blocked) throw new Error();
    expect(externalCall).toHaveBeenCalledTimes(1);
    expect(externalCall.mock.calls[0][0]).not.toContain("Max");
    expect(result.text).toContain("Max");
    dpo.close();
    fetchMock.mockRestore();
  });

  it("gibt blocked zurück wenn DPO blockt — externer Call wird nicht ausgeführt", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify({
        findings: [{ type: "ART_9", value: "krank", confidence: "high" }],
      }) } }],
    }), { status: 200 }));
    const dpo = createDpo({
      mappingDbPath: join(dir, "m.db"),
      mappingKey: randomBytes(32),
      auditDir: join(dir, "audit"),
      classifier: { url: "http://x", model: "g", timeoutMs: 1000 },
    });
    const externalCall = vi.fn(async () => "should not be called");
    const result = await safeExternalLlm({
      dpo, prompt: "Patient ist krank", targetLlm: "claude", agent: "ceo", externalCall,
    });
    expect(result.blocked).toBe(true);
    expect(externalCall).not.toHaveBeenCalled();
    dpo.close();
  });
});
