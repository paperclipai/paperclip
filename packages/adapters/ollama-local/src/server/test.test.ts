import { describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

describe("ollama_local environment diagnostics", () => {
  it("probes the configured Ollama tags endpoint and reports the model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ models: [{ name: "qwen3:8b" }] }),
      { status: 200 },
    )));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "ollama_local",
      config: { baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "ollama_endpoint_reachable")).toBe(true);
    expect(result.checks.some((check) => check.code === "ollama_model_available")).toBe(true);
  });
});
