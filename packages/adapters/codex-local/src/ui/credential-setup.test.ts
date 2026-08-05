import { describe, expect, it } from "vitest";
import { codexLocalCredentialSetup } from "./credential-setup.js";

describe("codexLocalCredentialSetup", () => {
  it("exports credential options with correct envKeys", () => {
    const envKeys = codexLocalCredentialSetup.options.map(o => o.envKey);
    expect(envKeys).toEqual(["OPENAI_API_KEY"]);
  });

  it("configures api_key option with correct label and setupUrl", () => {
    const apiKeyOption = codexLocalCredentialSetup.options.find(o => o.envKey === "OPENAI_API_KEY");
    expect(apiKeyOption).toBeDefined();
    expect(apiKeyOption?.kind).toBe("api_key");
    expect(apiKeyOption?.label).toBe("OpenAI API key");
    expect(apiKeyOption?.setupUrl).toBe("https://platform.openai.com/api-keys");
    expect(apiKeyOption?.placeholder).toBe("sk-…");
  });

  it("includes hint mentioning codex login and CODEX_HOME sync as ChatGPT-subscription alternative", () => {
    const apiKeyOption = codexLocalCredentialSetup.options.find(o => o.envKey === "OPENAI_API_KEY");
    expect(apiKeyOption?.hint).toContain("codex login");
    expect(apiKeyOption?.hint).toContain("CODEX_HOME");
  });
});
