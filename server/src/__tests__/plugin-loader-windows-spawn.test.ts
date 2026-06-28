import { describe, expect, it } from "vitest";
import {
  buildDevLoaderExecArgv,
  resolveNpmInvocation,
} from "../services/plugin-loader.js";

/**
 * Regression coverage for two Windows-only plugin-install bugs:
 *   1. `execFile("npm", ...)` throws `spawn npm ENOENT` because the launcher
 *      is `npm.cmd` and cannot be spawned without a shell.
 *   2. The tsx dev loader passed to `--import` as a bare `E:\...` path is read
 *      by Node's ESM loader as scheme `e:` → ERR_UNSUPPORTED_ESM_URL_SCHEME,
 *      crashing the plugin worker on init.
 */
describe("resolveNpmInvocation (Windows npm.cmd spawn fix)", () => {
  it("uses npm.cmd through a shell on Windows", () => {
    expect(resolveNpmInvocation("win32")).toEqual({
      command: "npm.cmd",
      execOptions: { shell: true },
    });
  });

  it("uses bare npm with no shell on POSIX", () => {
    expect(resolveNpmInvocation("linux")).toEqual({
      command: "npm",
      execOptions: {},
    });
    expect(resolveNpmInvocation("darwin")).toEqual({
      command: "npm",
      execOptions: {},
    });
  });

  it("never spawns a .cmd launcher without a shell (the ENOENT cause)", () => {
    const { command, execOptions } = resolveNpmInvocation("win32");
    if (command.endsWith(".cmd")) {
      expect((execOptions as { shell?: boolean }).shell).toBe(true);
    }
  });
});

describe("buildDevLoaderExecArgv (Windows ESM --import fix)", () => {
  it("passes the tsx loader as a file:// URL, not a bare Windows path", () => {
    const argv = buildDevLoaderExecArgv(
      "E:\\clones\\paperclip\\cli\\node_modules\\tsx\\dist\\loader.mjs",
    );
    expect(argv[0]).toBe("--import");
    expect(argv[1]!.startsWith("file://")).toBe(true);
    // A bare drive path (e.g. `E:\...`) is what triggers the
    // ERR_UNSUPPORTED_ESM_URL_SCHEME (protocol 'e:') crash.
    expect(argv[1]).not.toMatch(/^[a-zA-Z]:[\\/]/);
  });

  it("produces a URL Node's ESM loader accepts", () => {
    const argv = buildDevLoaderExecArgv("/home/user/app/loader.mjs");
    expect(() => new URL(argv[1]!)).not.toThrow();
    expect(new URL(argv[1]!).protocol).toBe("file:");
  });
});
