/**
 * Optional: run the same adapter surface against a real Ollama server.
 *
 * Gated behind `OLLAMA_INTEGRATION_BASE_URL` so local dev and PR CI stay
 * deterministic on the mock. The CI matrix (.github/workflows/ollama-integration.yml)
 * runs an `ollama/ollama` service container, pulls a small model, and sets
 * both env vars. If the env isn't configured, we skip instead of failing —
 * this file never blocks the normal test run.
 */

import { describe, expect, it } from "vitest";
import { execute } from "../execute.js";
import { testEnvironment } from "../test.js";
import { buildContext } from "./test-context.js";

const baseUrl = process.env.OLLAMA_INTEGRATION_BASE_URL;
const model = process.env.OLLAMA_INTEGRATION_MODEL ?? "qwen2.5:0.5b";

const describeIfConfigured = baseUrl ? describe : describe.skip;

describeIfConfigured("ollama_local against a real Ollama server", () => {
  it("testEnvironment reports pass/warn for a reachable server", async () => {
    const result = await testEnvironment({
      companyId: "real-ollama-smoke",
      adapterType: "ollama_local",
      config: { baseUrl, model },
    });
    // We tolerate "warn" (model missing) because the CI job pulls the model
    // out-of-band; the test above just asserts the adapter walked both
    // /api/version and /api/tags without failing.
    expect(result.status).not.toBe("fail");
    expect(result.adapterType).toBe("ollama_local");
  });

  it("execute() completes a heartbeat against a real model", async () => {
    const captured = buildContext({
      config: {
        baseUrl,
        model,
        // Short context window keeps the roundtrip cheap on slower runners.
        contextWindow: 2048,
        requestTimeoutSec: 120,
        maxOutputTokens: 32,
        promptTemplate: "Respond with the single word: READY.",
      },
      runContext: { paperclipWake: { reason: "real-ollama-smoke" } },
    });
    const result = await execute(captured.ctx);
    // Model output is non-deterministic: we only assert the adapter finished
    // cleanly and surfaced a non-empty summary.
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeFalsy();
    expect(typeof result.summary).toBe("string");
    expect((result.summary ?? "").length).toBeGreaterThan(0);
    expect(result.usage?.inputTokens ?? 0).toBeGreaterThan(0);
  }, 120_000);
});
