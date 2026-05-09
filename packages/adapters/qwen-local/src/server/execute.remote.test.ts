import { describe, expect, it } from "vitest";
import { listQwenModels } from "./models.js";

// Gated suite — runs only when both env vars are present. Targets a real
// vLLM endpoint (e.g. DGX over Tailscale) and exercises:
//   1. /v1/models discovery returns the configured model
//   2. (smoke) 20 parallel /v1/models fan-out completes — proxy for adapter
//      concurrency baseline. A full execute() smoke is a Phase 2.5 item once
//      the qwen-code CLI is provisioned in CI.
//
// Skipped silently in CI / dev unless the operator opts in.

const baseUrl = process.env.QWEN_LOCAL_BASE_URL ?? "";
const apiKey = process.env.QWEN_LOCAL_API_KEY ?? "";
const targetModel =
  process.env.QWEN_LOCAL_MODEL ?? "Qwen/Qwen3.6-35B-A3B-FP8";

const enabled = baseUrl.length > 0 && apiKey.length > 0;

describe.skipIf(!enabled)("execute.remote (gated)", () => {
  it("discovers the configured model via /v1/models", async () => {
    const models = await listQwenModels({ baseUrl, apiKey });
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain(targetModel);
  }, 30_000);

  it("handles 20 parallel /v1/models requests", async () => {
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => listQwenModels({ baseUrl, apiKey })),
    );
    const elapsedMs = Date.now() - start;
    expect(results).toHaveLength(20);
    for (const r of results) expect(r.length).toBeGreaterThan(0);
    // Soft signal — log for ops baseline; do not fail on slow runs.
    // eslint-disable-next-line no-console
    console.info(`[qwen-local] 20x /v1/models p_total=${elapsedMs}ms`);
  }, 60_000);
});
