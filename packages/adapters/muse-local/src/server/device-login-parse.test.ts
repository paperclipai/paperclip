import { describe, expect, it } from "vitest";
import { parseMuseDeviceLoginPrompt } from "./device-login-parse.js";

describe("parseMuseDeviceLoginPrompt", () => {
  it("extracts url and code from device login output", () => {
    const output = [
      "Open this page to sign in:",
      "  https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
      "confirm this code matches:",
      "  ABCD-EFGH",
      "",
      "Press Enter to open it in your browser:",
    ].join("\n");

    const prompt = parseMuseDeviceLoginPrompt(output);
    expect(prompt).not.toBeNull();
    expect(prompt?.url).toBe("https://auth.meta.com/oauth/device/?code=ABCD-EFGH");
    expect(prompt?.code).toBe("ABCD-EFGH");
  });

  it("returns null if no code is present", () => {
    expect(parseMuseDeviceLoginPrompt("Nothing here")).toBeNull();
  });
});
