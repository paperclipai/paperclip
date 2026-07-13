import { describe, expect, it } from "vitest";
import { cursorLocalCredentialSetup } from "./credential-setup.js";

describe("cursorLocalCredentialSetup", () => {
  it("exports credential options with correct envKeys", () => {
    const envKeys = cursorLocalCredentialSetup.options.map(o => o.envKey);
    expect(envKeys).toEqual(["CURSOR_API_KEY"]);
  });

  it("configures api_key option with correct label and setupUrl", () => {
    const apiKeyOption = cursorLocalCredentialSetup.options.find(o => o.envKey === "CURSOR_API_KEY");
    expect(apiKeyOption).toBeDefined();
    expect(apiKeyOption?.kind).toBe("api_key");
    expect(apiKeyOption?.label).toBe("Cursor API key");
    expect(apiKeyOption?.setupUrl).toBe("https://cursor.com/settings");
    expect(apiKeyOption?.placeholder).toBe("key_…");
  });
});
