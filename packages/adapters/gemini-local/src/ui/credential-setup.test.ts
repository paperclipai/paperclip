import { describe, expect, it } from "vitest";
import { geminiLocalCredentialSetup } from "./credential-setup.js";

describe("geminiLocalCredentialSetup", () => {
  it("exports credential options with correct envKeys", () => {
    const envKeys = geminiLocalCredentialSetup.options.map(o => o.envKey);
    expect(envKeys).toEqual(["GEMINI_API_KEY"]);
  });

  it("configures api_key option with correct label and setupUrl", () => {
    const apiKeyOption = geminiLocalCredentialSetup.options.find(o => o.envKey === "GEMINI_API_KEY");
    expect(apiKeyOption).toBeDefined();
    expect(apiKeyOption?.kind).toBe("api_key");
    expect(apiKeyOption?.label).toBe("Gemini API key");
    expect(apiKeyOption?.setupUrl).toBe("https://aistudio.google.com/apikey");
    expect(apiKeyOption?.placeholder).toBe("AIza…");
  });
});
