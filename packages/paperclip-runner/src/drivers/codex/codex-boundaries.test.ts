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
  it("accepts assigned workspaces below HOME while rejecting host-state and containment escapes", () => {
    const fixture = mkdtempSync(join(tmpdir(), "paperclip-codex-boundaries-"));
    try {
      const hostRoot = join(fixture, "host");
      const hostHome = join(hostRoot, "home");
      const workspaceRoot = join(hostHome, ".paperclip", "workspaces");
      const workspace = join(workspaceRoot, "run-1");
      const ordinaryHomeWorkspace = join(hostHome, "projects", "app");
      const outside = join(fixture, "outside");
      const protectedHomeDirectory = join(hostHome, ".ssh");
      const codexHome = join(fixture, "codex-home");
      const codexWorkspace = join(codexHome, "run");
      for (const directory of [
        workspace,
        ordinaryHomeWorkspace,
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
        validateCodexWorkingDirectory(ordinaryHomeWorkspace, {
          HOME: hostHome,
          CODEX_HOME: codexHome,
        }),
      ).toThrow("inside the host HOME requires an assigned workspace");
      expect(
        validateCodexWorkingDirectory(ordinaryHomeWorkspace, {
          HOME: hostHome,
          CODEX_HOME: codexHome,
          PAPERCLIP_WORKSPACE_CWD: join(hostHome, "projects"),
        }),
      ).toBe(realpathSync.native(ordinaryHomeWorkspace));
      expect(() =>
        validateCodexWorkingDirectory(protectedHomeDirectory, {
          HOME: hostHome,
          CODEX_HOME: codexHome,
        }),
      ).toThrow("cannot overlap sensitive host HOME state");
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
        validateCodexWorkingDirectory(hostHome, { HOME: hostHome }),
      ).toThrow("cannot contain the host HOME");
      expect(() =>
        validateCodexWorkingDirectory(protectedHomeDirectory, {
          HOME: hostHome,
          PAPERCLIP_WORKSPACE_CWD: workspaceRoot,
        }),
      ).toThrow("cannot overlap sensitive host HOME state");
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

  it("defers provider-owned workspace existence without weakening its assignment", () => {
    const remoteWorkspace = "/home/daytona/paperclip-workspace";
    const remoteEnvironment = {
      HOME: remoteWorkspace,
      CODEX_HOME: `${remoteWorkspace}/.codex`,
      PAPERCLIP_WORKSPACE_CWD: remoteWorkspace,
    };

    expect(
      validateCodexWorkingDirectory(
        remoteWorkspace,
        remoteEnvironment,
        "remote_runner",
      ),
    ).toBe(remoteWorkspace);
    expect(() =>
      validateCodexWorkingDirectory(remoteWorkspace, remoteEnvironment),
    ).toThrow("must exist before provider admission");
    expect(() =>
      validateCodexWorkingDirectory(
        `${remoteWorkspace}/nested`,
        remoteEnvironment,
        "remote_runner",
      ),
    ).toThrow("does not match the assigned workspace");
    expect(() =>
      validateCodexWorkingDirectory(
        `${remoteWorkspace}/../escape`,
        remoteEnvironment,
        "remote_runner",
      ),
    ).toThrow("must be a normalized absolute path");
    expect(() =>
      validateCodexWorkingDirectory(
        "/",
        { PAPERCLIP_WORKSPACE_CWD: "/" },
        "remote_runner",
      ),
    ).toThrow("filesystem root");
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
