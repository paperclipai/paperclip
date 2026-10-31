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
  it("inherits only system execution settings in declarative mode", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIP_DECLARATIVE: "true", PATH: "/bin", HOME: "/state", LANG: "C.UTF-8",
      DATABASE_URL: "postgres://server-only", DATABASE_MIGRATION_URL: "postgres://migration-only",
      BETTER_AUTH_SECRET: "server-only", PROVIDER_API_KEY: "unrelated-worker",
      PAPERCLIP_API_KEY: "parent-task-token", PAPERCLIP_RUNTIME_API_URL: "parent-task-url",
    })).toEqual({ PATH: "/bin", HOME: "/state", LANG: "C.UTF-8" });
  });
});
