import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, expect, it } from "vitest";

import {
  boundedCodexPayload,
  codexToolAcceptsDisposition,
  isCodexSemanticTool,
  isRetainableCodexPayload,
  redactCodexValue,
  validateCodexWorkingDirectory,
} from "./codex-boundaries.js";

describe("Codex value and workspace boundaries", () => {
  it("accepts only an assigned non-root workspace that does not contain host state", () => {
    const fixture = mkdtempSync(join(tmpdir(), "paperclip-codex-boundaries-"));
    try {
      const workspaceRoot = join(fixture, "workspaces");
      const workspace = join(workspaceRoot, "run-1");
      const outside = join(fixture, "outside");
      const hostRoot = join(fixture, "host");
      const hostHome = join(hostRoot, "home");
      const protectedHomeDirectory = join(hostHome, ".ssh");
      const codexHome = join(fixture, "codex-home");
      const codexWorkspace = join(codexHome, "run");
      for (const directory of [
        workspace,
        outside,
        protectedHomeDirectory,
        codexWorkspace,
      ]) {
        mkdirSync(directory, { recursive: true });
      }

      expect(
        validateCodexWorkingDirectory(workspace, {
          HOME: hostHome,
          CODEX_HOME: codexHome,
          PAPERCLIP_WORKSPACE_CWD: workspaceRoot,
        }),
      ).toBe(realpathSync.native(workspace));
      expect(() =>
        validateCodexWorkingDirectory(join(workspaceRoot, "future-run"), {
          PAPERCLIP_WORKSPACE_CWD: workspaceRoot,
        }),
      ).toThrow("must exist before provider admission");

      expect(() =>
        validateCodexWorkingDirectory(parse(fixture).root, {}),
      ).toThrow("filesystem root");
      expect(() =>
        validateCodexWorkingDirectory(hostRoot, { HOME: hostHome }),
      ).toThrow("cannot contain the host HOME");
      expect(() =>
        validateCodexWorkingDirectory(protectedHomeDirectory, { HOME: hostHome }),
      ).toThrow("cannot overlap the host HOME");
      expect(() =>
        validateCodexWorkingDirectory(outside, {
          PAPERCLIP_WORKSPACE_CWD: workspaceRoot,
        }),
      ).toThrow("outside the assigned workspace");
      expect(() =>
        validateCodexWorkingDirectory(codexWorkspace, {
          CODEX_HOME: codexHome,
        }),
      ).toThrow("cannot overlap host CODEX_HOME");

      const escaped = join(workspaceRoot, "escaped");
      symlinkSync(outside, escaped, "dir");
      expect(() =>
        validateCodexWorkingDirectory(escaped, {
          PAPERCLIP_WORKSPACE_CWD: workspaceRoot,
        }),
      ).toThrow("outside the assigned workspace");

      const file = join(workspaceRoot, "not-a-directory");
      writeFileSync(file, "not a directory");
      expect(() =>
        validateCodexWorkingDirectory(file, {
          PAPERCLIP_WORKSPACE_CWD: workspaceRoot,
        }),
      ).toThrow("must be a directory");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("bounds retained values and redacts protected diagnostics", () => {
    const bounded = boundedCodexPayload({
      short: "ok",
      long: "x".repeat(40_000),
      many: Array.from({ length: 140 }, (_, index) => index),
    });
    expect(String(bounded.long)).toContain("[truncated]");
    expect(bounded.many).toHaveLength(129);
    expect(isRetainableCodexPayload({ value: "x".repeat(70_000) })).toBe(false);

    expect(
      redactCodexValue({
        token: "sensitive",
        message: "Authorization: Bearer abcdefghijklmnop",
      }),
    ).toEqual({
      token: "[REDACTED]",
      message: "Authorization: Bearer [REDACTED]",
    });
  });

  it("keeps completion and block dispositions distinct", () => {
    expect(isCodexSemanticTool("paperclip_finish")).toBe(true);
    expect(isCodexSemanticTool("paperclip_block")).toBe(true);
    expect(isCodexSemanticTool("shell")).toBe(false);
    expect(codexToolAcceptsDisposition("paperclip_finish", "done")).toBe(true);
    expect(codexToolAcceptsDisposition("paperclip_finish", "blocked")).toBe(
      false,
    );
    expect(codexToolAcceptsDisposition("paperclip_block", "blocked")).toBe(
      true,
    );
    expect(codexToolAcceptsDisposition("unknown_tool", "done")).toBe(false);
  });
});
