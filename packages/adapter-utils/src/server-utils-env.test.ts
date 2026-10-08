import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
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

  it("strips control-plane database and signing secrets from inherited env", () => {
    expect(
      sanitizeInheritedPaperclipEnv({
        DATABASE_URL: "postgres://synthetic-user:synthetic-pass@example.test/db",
        BETTER_AUTH_SECRET: "synthetic-auth-secret",
        PAPERCLIP_AGENT_JWT_SECRET: "synthetic-jwt-secret",
        PATH: "/usr/bin",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });
});
