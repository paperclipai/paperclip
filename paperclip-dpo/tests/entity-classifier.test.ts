import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyEntities } from "../src/entity-classifier.js";

describe("classifyEntities", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("parst Klassifikator-Antwort und liefert Findings", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  findings: [
                    { type: "PERSON", value: "Max Mustermann", confidence: "high" },
                    { type: "FIRMA", value: "WHITESTAG GmbH", confidence: "high" },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const findings = await classifyEntities("Max Mustermann von WHITESTAG GmbH", {
      url: "http://localhost:1234",
      model: "gemma-4-26b",
      timeoutMs: 10000,
    });

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      type: "PERSON",
      value: "Max Mustermann",
      source: "llm",
      confidence: "high",
    });
    expect(findings[0].start).toBe(0);
    expect(findings[0].end).toBe("Max Mustermann".length);
  });

  it("wirft DpoUnavailableError wenn LM Studio nicht erreichbar", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("fetch failed"));
    await expect(
      classifyEntities("text", { url: "http://localhost:1234", model: "x", timeoutMs: 100 }),
    ).rejects.toThrow("dpo_unavailable");
  });

  it("wirft DpoUnavailableError bei ungültigem JSON in der Antwort", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "kein json" } }],
        }),
        { status: 200 },
      ),
    );
    await expect(
      classifyEntities("text", { url: "http://localhost:1234", model: "x", timeoutMs: 100 }),
    ).rejects.toThrow("dpo_unavailable");
  });
});
