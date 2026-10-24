import { describe, expect, it } from "vitest";
import { defaultPathForPlatform, ensurePathInEnv, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

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
});

describe("ensurePathInEnv", () => {
  it("keeps a Windows search path stored under a lowercase key", () => {
    const env = { path: "C:\\Tools;C:\\Windows\\System32" };
    expect(ensurePathInEnv(env, "win32")).toBe(env);
  });

  it("adds the default PATH on Windows when the key that Windows uses is empty", () => {
    expect(ensurePathInEnv({ path: "C:\\Tools", PATH: "" }, "win32").PATH).toBe(defaultPathForPlatform());
  });

  it("keeps case-sensitive PATH keys on other platforms", () => {
    expect(ensurePathInEnv({ path: "/opt/tools" }, "linux").PATH).toBe(defaultPathForPlatform());
  });
});
