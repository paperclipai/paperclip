import { beforeAll, describe, expect, it, vi } from "vitest";

let resolveDynamicForbiddenTokens: typeof import("../../../scripts/check-forbidden-tokens-lib.mjs").resolveDynamicForbiddenTokens;
let resolveForbiddenTokens: typeof import("../../../scripts/check-forbidden-tokens-lib.mjs").resolveForbiddenTokens;
let runForbiddenTokenCheck: typeof import("../../../scripts/check-forbidden-tokens-lib.mjs").runForbiddenTokenCheck;
const forbiddenTokensScriptUrl = new URL("../../../scripts/check-forbidden-tokens-lib.mjs", import.meta.url).href;

beforeAll(async () => {
  return import(/* @vite-ignore */ forbiddenTokensScriptUrl).then((mod) => {
    resolveDynamicForbiddenTokens = mod.resolveDynamicForbiddenTokens;
    resolveForbiddenTokens = mod.resolveForbiddenTokens;
    runForbiddenTokenCheck = mod.runForbiddenTokenCheck;
  });
});

describe("forbidden token check", () => {
  it("derives username tokens without relying on whoami", () => {
    const tokens = resolveDynamicForbiddenTokens(
      { USER: "paperclip", LOGNAME: "paperclip", USERNAME: "pc" },
      {
        userInfo: () => ({ username: "paperclip" }),
      },
    );

    expect(tokens).toEqual(["paperclip", "pc"]);
  });

  it("falls back cleanly when user resolution fails", () => {
    const tokens = resolveDynamicForbiddenTokens(
      {},
      {
        userInfo: () => {
          throw new Error("missing user");
        },
      },
    );

    expect(tokens).toEqual([]);
  });

  it("merges dynamic and file-based forbidden tokens", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tokensFile = path.join(os.tmpdir(), `forbidden-tokens-${Date.now()}.txt`);
    fs.writeFileSync(tokensFile, "# comment\npaperclip\ncustom-token\n");

    try {
      const tokens = resolveForbiddenTokens(tokensFile, { USER: "paperclip" }, {
        userInfo: () => ({ username: "paperclip" }),
      });

      expect(tokens).toEqual(["paperclip", "custom-token"]);
    } finally {
      fs.unlinkSync(tokensFile);
    }
  });

  it("reports matches without leaking which token was searched", () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce("server/file.ts:1:found\n")
      .mockImplementation(() => {
        throw new Error("not found");
      });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["paperclip", "custom-token"],
      exec,
      log,
      error,
    });

    expect(exitCode).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("ERROR: Forbidden tokens found in tracked files:\n");
    expect(error).toHaveBeenCalledWith("  server/file.ts:1:found");
    expect(error).toHaveBeenCalledWith("\nBuild blocked. Remove the forbidden token(s) before publishing.");
  });
});
