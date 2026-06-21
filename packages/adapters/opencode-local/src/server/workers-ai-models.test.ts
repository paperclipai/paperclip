import { describe, expect, it } from "vitest";
import { models, WORKERS_AI_OPENAI_BASE_URL_TEMPLATE } from "../index.js";
describe("opencode-local Workers AI catalog", () => {
  it("exposes the Workers AI base URL template with an account placeholder", () => {
    expect(WORKERS_AI_OPENAI_BASE_URL_TEMPLATE).toBe("https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1");
  });
  it("includes provider-prefixed Workers AI models", () => {
    expect(models.some((m) => m.id === "cloudflare/@cf/moonshotai/kimi-k2.7-code")).toBe(true);
  });
});
