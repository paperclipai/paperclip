import { afterEach, expect, it, vi } from "vitest";
import { deleteOpenAiQualificationSession } from "./cleanup.js";
import { estimateOpenAiManagedCost } from "../../evals/model-pricing.js";
afterEach(() => vi.unstubAllGlobals());
it("preserves unexpected artifacts instead of deleting their session", async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "artifact_file" }], has_more: false }));
  vi.stubGlobal("fetch", request);
  await expect(deleteOpenAiQualificationSession("sess_owned", "test-only")).rejects.toThrow("must be downloaded");
  expect(request).toHaveBeenCalledTimes(1);
});
it("deletes an empty completed qualification session only at the fixed API origin", async () => {
  const request = vi.fn().mockResolvedValueOnce(Response.json({ data: [], has_more: false })).mockResolvedValueOnce(Response.json({ deleted: true }));
  vi.stubGlobal("fetch", request);
  await deleteOpenAiQualificationSession("sess_owned", "test-only");
  expect(request.mock.calls[1]).toEqual(["https://api.openai.com/v1/agents/sessions/sess_owned", expect.objectContaining({ method: "DELETE", redirect: "error" })]);
  await expect(deleteOpenAiQualificationSession("../unrelated", "test-only")).rejects.toThrow("verified session");
  expect(request).toHaveBeenCalledTimes(2);
});
it("includes long context/cache-write rates and a hosted hour reservation without claiming billing", () => {
  expect(estimateOpenAiManagedCost({ inputTokens: 1_000, outputTokens: 100 }, { type: "openai_hosted", container_size: "medium" })).toMatchObject({
    estimatedCostNanodollars: 392_500_000, containerReservationNanodollars: 360_000_000,
    pricingVersion: "openai-managed-conservative-2026-09-30-v2", ratesUsdPerMillionTokens: { input: 25, cachedInput: 2, output: 75 },
  });
});
it("uses the reported cache-hit subset without discounting unknown or inconsistent cache accounting", () => {
  const usage = { inputTokens: 121_636, outputTokens: 594, cachedInputTokens: 108_819 };
  expect(estimateOpenAiManagedCost(usage, { type: "none" }).estimatedCostNanodollars).toBe(582_613_000);
  for (const cachedInputTokens of [undefined, -1, 121_637, NaN, 0.5]) {
    expect(estimateOpenAiManagedCost({ ...usage, cachedInputTokens }, { type: "none" }).estimatedCostNanodollars).toBe(3_085_450_000);
  }
});
