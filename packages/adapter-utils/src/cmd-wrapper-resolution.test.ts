import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCmdWrapperContent,
  DP0_PATTERN_NPM,
  DP0_PATTERN_DIRECT,
  TILDE_PATTERN_NPM,
  TILDE_PATTERN_DIRECT,
  SET_PATTERN,
} from "./cmd-wrapper-resolution.js";

/**
 * Tests for the .cmd wrapper resolution logic used in resolveSpawnTarget.
 *
 * On Windows, spawning .cmd files via cmd.exe creates visible console windows.
 * This test verifies the regex patterns and SET-command parsing that allow
 * Paperclip to resolve the real executable from npm .cmd wrappers.
 */

// Real-world npm .cmd wrapper patterns
const NPM_GENERATED_CMD = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
IF EXIST "%NODE_EXE%" (
  "%NODE_EXE%"  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*
)`;

const OPENCODE_CMD = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
"%dp0%\\node_modules\\@anthropic-ai\\opencode\\bin\\opencode.exe" %*`;

const TILDE_DP0_CMD = `@echo off
SETLOCAL
%~dp0\\bin\\my-tool.exe %*
ENDLOCAL`;

const WITH_ENV_SET_CMD = `@ECHO off
SETLOCAL
SET NODE_ENV=production
SET PATH=C:\\custom;%PATH%
%dp0%\\node_modules\\.bin\\my-tool.exe %*
ENDLOCAL`;

const WITH_DP0_SET_CMD = `@ECHO off
SETLOCAL
SET dp0=%~dp0
SET NODE_ENV=development
%dp0%\\node_modules\\.bin\\tool.exe %*
ENDLOCAL`;

describe(".cmd wrapper resolution", () => {
  it("resolves exe from npm-generated .cmd wrapper (%dp0% with quotes)", () => {
    const result = parseCmdWrapperContent(OPENCODE_CMD);
    expect(result.exeRelativePath).toBe(
      "node_modules\\@anthropic-ai\\opencode\\bin\\opencode.exe",
    );
  });

  it("resolves exe from %~dp0 pattern (no quotes)", () => {
    const result = parseCmdWrapperContent(TILDE_DP0_CMD);
    expect(result.exeRelativePath).toBe("bin\\my-tool.exe");
  });

  it("extracts SET commands as env overrides (excluding dp0)", () => {
    const result = parseCmdWrapperContent(WITH_ENV_SET_CMD);
    expect(result.exeRelativePath).toBe("node_modules\\.bin\\my-tool.exe");
    expect(result.envOverrides).toEqual({
      NODE_ENV: "production",
      PATH: "C:\\custom;%PATH%",
    });
  });

  it("filters out dp0 SET command from env overrides", () => {
    const result = parseCmdWrapperContent(WITH_DP0_SET_CMD);
    expect(result.exeRelativePath).toBe("node_modules\\.bin\\tool.exe");
    expect(result.envOverrides).toEqual({
      NODE_ENV: "development",
    });
  });

  it("skips SET assignment lines when matching exe paths (NPM_GENERATED_CMD)", () => {
    // SET "NODE_EXE=%~dp0\node.exe" looks like a %~dp0 exe match
    // but is just a variable assignment. The parser must skip it and
    // return null since no real exe invocation is present.
    const result = parseCmdWrapperContent(NPM_GENERATED_CMD);
    expect(result.exeRelativePath).toBeNull();
  });

  it("returns null exeRelativePath for non-matching .cmd content", () => {
    const content = `@ECHO off\nECHO Hello World\n`;
    const result = parseCmdWrapperContent(content);
    expect(result.exeRelativePath).toBeNull();
    expect(result.envOverrides).toEqual({});
  });

  it("returns empty envOverrides when no SET commands present", () => {
    const result = parseCmdWrapperContent(TILDE_DP0_CMD);
    expect(result.envOverrides).toEqual({});
  });

  it("resolves exe path with spaces in directory names", () => {
    const content = `"%dp0%\\Program Files\\my tool\\bin\\app.exe" %*`;
    const result = parseCmdWrapperContent(content);
    expect(result.exeRelativePath).toBe(
      "Program Files\\my tool\\bin\\app.exe",
    );
  });

  it("handles case-insensitive .exe matching", () => {
    const content = `"%dp0%\\bin\\tool.EXE" %*`;
    const result = parseCmdWrapperContent(content);
    expect(result.exeRelativePath).toBe("bin\\tool.EXE");
  });

  it("handles multiple SET commands with various casing", () => {
    const content = `SET foo=bar\nSET Baz=qux\nSET DP0=skip\nSET my_var=123`;
    const result = parseCmdWrapperContent(content);
    expect(result.envOverrides).toEqual({
      foo: "bar",
      Baz: "qux",
      my_var: "123",
    });
  });

  it("produces a real executable path when joined with .cmd directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-wrapper-test-"));
    try {
      const fakeExe = path.join(tmpDir, "real.exe");
      const fakeCmd = path.join(tmpDir, "wrapper.cmd");
      await fs.writeFile(fakeExe, "");
      await fs.writeFile(
        fakeCmd,
        `@ECHO off\n"%dp0%\\real.exe" %*`,
      );

      const content = await fs.readFile(fakeCmd, "utf8");
      const result = parseCmdWrapperContent(content);
      expect(result.exeRelativePath).toBe("real.exe");

      const resolved = path.resolve(tmpDir, result.exeRelativePath!);
      // On any platform, the resolved path should point to the exe
      await expect(fs.access(resolved)).resolves.toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
