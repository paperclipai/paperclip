import { describe, expect, it } from "vitest";
import { models, WORKERS_AI_OPENAI_BASE_URL_TEMPLATE } from "../index.js";

describe("cursor-local Workers AI catalog", () => {
  it("exposes the Workers AI OpenAI-compatible base URL template with an account placeholder", () => {
    expect(WORKERS_AI_OPENAI_BASE_URL_TEMPLATE).toBe(
      "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1",
    );
  });

  it("includes at least one selectable Workers AI (@cf/) model", () => {
    const cfModels = models.filter((m) => m.id.startsWith("@cf/"));
    expect(cfModels.length).toBeGreaterThan(0);
    expect(cfModels.some((m) => m.id === "@cf/moonshotai/kimi-k2.7-code")).toBe(true);
  });
});
