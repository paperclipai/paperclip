import { describe, expect, it } from "vitest";
import { openCodeLocalCredentialSetup } from "./credential-setup.js";

describe("openCodeLocalCredentialSetup", () => {
  it("exports credential options with correct envKeys in order", () => {
    const envKeys = openCodeLocalCredentialSetup.options.map(o => o.envKey);
    expect(envKeys).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]);
  });

  it("configures ANTHROPIC_API_KEY option with correct label", () => {
    const anthropicOption = openCodeLocalCredentialSetup.options.find(o => o.envKey === "ANTHROPIC_API_KEY");
    expect(anthropicOption).toBeDefined();
    expect(anthropicOption?.kind).toBe("api_key");
    expect(anthropicOption?.label).toBe("Anthropic API key");
  });

  it("configures OPENAI_API_KEY option with correct label", () => {
    const openaiOption = openCodeLocalCredentialSetup.options.find(o => o.envKey === "OPENAI_API_KEY");
    expect(openaiOption).toBeDefined();
    expect(openaiOption?.kind).toBe("api_key");
    expect(openaiOption?.label).toBe("OpenAI API key");
  });

  it("configures OPENROUTER_API_KEY option with correct label", () => {
    const routerOption = openCodeLocalCredentialSetup.options.find(o => o.envKey === "OPENROUTER_API_KEY");
    expect(routerOption).toBeDefined();
    expect(routerOption?.kind).toBe("api_key");
    expect(routerOption?.label).toBe("OpenRouter API key");
  });

  it("includes hint on first option noting OpenCode uses whichever provider key matches the selected model", () => {
    const firstOption = openCodeLocalCredentialSetup.options[0];
    expect(firstOption?.hint).toContain("model");
  });
});
