import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureCommandResolvable,
  ensurePathInEnv,
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
});

describe("Windows search path casing", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
  });

  function stubPlatform(value: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }

  it("preserves a lowercase-only path on Windows", () => {
    stubPlatform("win32");
    expect(ensurePathInEnv({ path: "C:\\tools", PATHEXT: ".CMD" })).toEqual({
      path: "C:\\tools",
      PATHEXT: ".CMD",
      PATH: "C:\\tools",
    });
  });

  it("keeps PATH precedence and defaults empty values on Windows", () => {
    stubPlatform("win32");
    const withPath = { PATH: "C:\\a", path: "C:\\b" };
    expect(ensurePathInEnv(withPath)).toBe(withPath);
    expect(ensurePathInEnv({ path: "" }).PATH).toBeTruthy();
  });

  it("keeps environment keys case-sensitive on Unix", () => {
    stubPlatform("linux");
    expect(ensurePathInEnv({ path: "/custom/bin" }).PATH).not.toBe("/custom/bin");
  });

  it("resolves a command through a lowercase-only path on Windows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-path-case-"));
    try {
      await fs.writeFile(path.join(dir, "codex.CMD"), "");
      stubPlatform("win32");
      await expect(
        ensureCommandResolvable("codex", dir, { path: dir, PATHEXT: ".CMD" }),
      ).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", realPlatform);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
