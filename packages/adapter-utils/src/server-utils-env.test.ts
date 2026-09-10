import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("removes Plain server credentials without mutating the host environment", () => {
    const host = { PLAIN_CHAT_EMAIL_HMAC_SECRET: "test-signing-secret", PLAIN_API_KEY: "test-api-key", PATH: "/usr/bin" };
    expect(sanitizeInheritedPaperclipEnv(host)).toEqual({ PATH: "/usr/bin" });
    expect(host.PLAIN_API_KEY).toBe("test-api-key");
    expect(host.PLAIN_CHAT_EMAIL_HMAC_SECRET).toBe("test-signing-secret");
  });

  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});
