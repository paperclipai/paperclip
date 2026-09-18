import { describe, expect, it } from "vitest";
import {
  isForbiddenConfigEnvKey,
  sanitizeInheritedPaperclipEnv,
} from "./server-utils.js";

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

  it("drops the agent signing master and Better Auth fallback by name", () => {
    const sanitized = sanitizeInheritedPaperclipEnv({
      PAPERCLIP_AGENT_JWT_SECRET: "synthetic-signing-master",
      BETTER_AUTH_SECRET: "synthetic-better-auth",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
    expect(Object.hasOwn(sanitized, "PAPERCLIP_AGENT_JWT_SECRET")).toBe(false);
    expect(Object.hasOwn(sanitized, "BETTER_AUTH_SECRET")).toBe(false);
    expect(sanitized.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3100");
    expect(sanitized.PATH).toBe("/usr/bin");
  });
});

describe("isForbiddenConfigEnvKey", () => {
  it("rejects the run bearer and server signing secrets from config env", () => {
    expect(isForbiddenConfigEnvKey("PAPERCLIP_API_KEY")).toBe(true);
    expect(isForbiddenConfigEnvKey("PAPERCLIP_AGENT_JWT_SECRET")).toBe(true);
    expect(isForbiddenConfigEnvKey("BETTER_AUTH_SECRET")).toBe(true);
    expect(isForbiddenConfigEnvKey("PAPERCLIP_TASK_ID")).toBe(false);
  });
});
