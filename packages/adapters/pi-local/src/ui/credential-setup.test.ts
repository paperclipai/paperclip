import { describe, expect, it } from "vitest";
import { piLocalCredentialSetup } from "./credential-setup.js";

describe("piLocalCredentialSetup", () => {
  it("exports credential options with correct envKeys", () => {
    const envKeys = piLocalCredentialSetup.options.map(o => o.envKey);
    expect(envKeys).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("configures api_key option with correct label and setupUrl", () => {
    const apiKeyOption = piLocalCredentialSetup.options.find(o => o.envKey === "ANTHROPIC_API_KEY");
    expect(apiKeyOption).toBeDefined();
    expect(apiKeyOption?.kind).toBe("api_key");
    expect(apiKeyOption?.label).toBe("Anthropic API key");
    expect(apiKeyOption?.setupUrl).toBe("https://console.anthropic.com/settings/keys");
    expect(apiKeyOption?.placeholder).toBe("sk-ant-…");
  });
});
