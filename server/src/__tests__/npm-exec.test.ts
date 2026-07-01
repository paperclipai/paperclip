import { describe, it, expect } from "vitest";
import { __test__ } from "../lib/npm-exec.js";

const { assertSafeWindowsArg, buildWindowsCommandLine } = __test__;

describe("npm-exec Windows argument safety", () => {
  it("accepts legitimate npm specs and paths", () => {
    const safe = [
      "left-pad",
      "@scope/pkg",
      "@scope/pkg@^1.2.0",
      "pkg@latest",
      "pkg@1.2.3-beta.1+build.5",
      "C:\\Users\\me\\.paperclip\\plugins",
      "/home/me/plugins",
    ];
    for (const arg of safe) {
      expect(() => assertSafeWindowsArg(arg)).not.toThrow();
    }
  });

  it("treats shell metacharacters as inert (they are neutralized by quoting)", () => {
    // These are dangerous unquoted but safe inside the double quotes we add,
    // so the validator must NOT reject them — that is the whole point of quoting.
    for (const arg of ["pkg&echo", "pkg|whoami", "pkg^1.0.0", "a<b>c", "(x)"]) {
      expect(() => assertSafeWindowsArg(arg)).not.toThrow();
    }
  });

  it("rejects characters that break out of a double-quoted cmd.exe argument", () => {
    // `%` enables env-var expansion, `"` ends the quoted span.
    for (const arg of ["pkg%PATH%", 'a"b']) {
      expect(() => assertSafeWindowsArg(arg)).toThrow(/Unsafe npm argument/);
    }
    // Control characters (NUL, tab, LF, CR, US, DEL) can smuggle commands.
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f]) {
      const arg = `pkg${String.fromCharCode(code)}x`;
      expect(() => assertSafeWindowsArg(arg)).toThrow(/Unsafe npm argument/);
    }
  });

  it("quotes non-flag tokens but passes flags through verbatim", () => {
    const line = buildWindowsCommandLine([
      "install",
      "@scope/pkg@1.2.3",
      "--prefix",
      "C:\\plugins dir",
      "--ignore-scripts",
    ]);
    expect(line).toBe(
      'npm.cmd "install" "@scope/pkg@1.2.3" --prefix "C:\\plugins dir" --ignore-scripts',
    );
  });

  it("refuses to build a command line containing an injection attempt", () => {
    expect(() => buildWindowsCommandLine(["install", "evil%USERPROFILE%"])).toThrow(
      /Unsafe npm argument/,
    );
  });

  it("validates flag-position arguments too (no validation bypass)", () => {
    // A flag carrying a control character must be rejected even though flags
    // are passed verbatim — validation is not skipped for `-`-prefixed args.
    const sneakyFlag = `--registry=${String.fromCharCode(0x0a)}evil`;
    expect(() => buildWindowsCommandLine([sneakyFlag])).toThrow(/Unsafe npm argument/);
  });
});
