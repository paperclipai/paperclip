import { describe, expect, it } from "vitest";
import { wrapWindowsUtf8 } from "./execute.js";

describe("wrapWindowsUtf8 (VOG-330)", () => {
  it("returns the command unchanged on non-Windows platforms", () => {
    const result = wrapWindowsUtf8("opencode", ["run", "--format", "json"], false, "linux");
    expect(result).toEqual({ command: "opencode", args: ["run", "--format", "json"] });
  });

  it("returns the command unchanged on darwin", () => {
    const result = wrapWindowsUtf8("opencode", ["run"], false, "darwin");
    expect(result).toEqual({ command: "opencode", args: ["run"] });
  });

  it("returns the command unchanged when remote (sandbox/SSH) on win32", () => {
    const result = wrapWindowsUtf8("opencode", ["run"], true, "win32");
    expect(result).toEqual({ command: "opencode", args: ["run"] });
  });

  it("wraps with cmd.exe /D /S /C and chcp 65001 on local win32", () => {
    const result = wrapWindowsUtf8("opencode", ["run", "--format", "json"], false, "win32");
    expect(result.command).toBe("cmd.exe");
    expect(result.args.slice(0, 3)).toEqual(["/D", "/S", "/C"]);
    expect(result.args[3]).toBe(
      `chcp 65001 >nul && "opencode" "run" "--format" "json"`,
    );
  });

  it("escapes embedded double quotes in args using cmd.exe doubled-quote rule", () => {
    const result = wrapWindowsUtf8(
      `C:\\Program Files\\opencode.exe`,
      [`--prompt`, `say "hi"`],
      false,
      "win32",
    );
    expect(result.command).toBe("cmd.exe");
    expect(result.args[3]).toBe(
      `chcp 65001 >nul && "C:\\Program Files\\opencode.exe" "--prompt" "say ""hi"""`,
    );
  });

  it("preserves UTF-8 characters in arg list (no transcoding)", () => {
    const result = wrapWindowsUtf8("opencode", ["run", "--prompt", "你好世界"], false, "win32");
    expect(result.args[3]).toContain("你好世界");
  });
});
