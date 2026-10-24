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

  it("drops server-only secrets while keeping unrelated and runtime keys", () => {
    expect(sanitizeInheritedPaperclipEnv({
      DATABASE_URL: "postgres://paperclip:secret@127.0.0.1:5432/paperclip",
      BETTER_AUTH_SECRET: "top-secret",
      PAPERCLIP_AGENT_JWT_SECRET: "also-secret",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      HOME: "/home/agent",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      HOME: "/home/agent",
    });
  });
});
