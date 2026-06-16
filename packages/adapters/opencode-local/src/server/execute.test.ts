import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureReferencedSharedDocsMaterialized,
  ensureRemoteOpenCodeModelConfiguredAndAvailable,
  extractReferencedSharedDocPaths,
} from "./execute.js";

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("referenced shared docs materialization", () => {
  it("extracts unique docs/*.md references from instructions", () => {
    expect(extractReferencedSharedDocPaths([
      "Read: docs/definition-of-done.md",
      "Read `docs/architecture-template.md` before coding.",
      "Ignore ../docs/secret.md and docs/not-markdown.txt.",
      "Read: docs/definition-of-done.md",
    ].join("\n"))).toEqual([
      "docs/architecture-template.md",
      "docs/definition-of-done.md",
    ]);
  });

  it("copies referenced shared docs from the instructions bundle without overwriting workspace docs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-"));
    const cwd = path.join(root, "workspace");
    const instructionsRootPath = path.join(root, "instructions");
    await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
    await fs.mkdir(path.join(instructionsRootPath, "docs"), { recursive: true });
    await fs.writeFile(path.join(instructionsRootPath, "docs", "architecture-template.md"), "# Architecture\n", "utf8");
    await fs.writeFile(path.join(cwd, "docs", "definition-of-done.md"), "# Existing\n", "utf8");

    try {
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: [
          "Read: docs/architecture-template.md",
          "Read: docs/definition-of-done.md",
        ].join("\n"),
        onLog: async () => {},
      });

      await expect(fs.readFile(path.join(cwd, "docs", "architecture-template.md"), "utf8")).resolves.toBe("# Architecture\n");
      await expect(fs.readFile(path.join(cwd, "docs", "definition-of-done.md"), "utf8")).resolves.toBe("# Existing\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates a non-fatal placeholder for missing referenced shared docs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-docs-missing-"));
    const cwd = path.join(root, "workspace");
    const instructionsRootPath = path.join(root, "instructions");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(instructionsRootPath, { recursive: true });

    try {
      await ensureReferencedSharedDocsMaterialized({
        cwd,
        instructionsRootPath,
        instructionsContents: "Read: docs/backlog-process.md",
        onLog: async () => {},
      });

      const materialized = await fs.readFile(path.join(cwd, "docs", "backlog-process.md"), "utf8");
      expect(materialized).toContain("# Missing Shared Documentation: docs/backlog-process.md");
      expect(materialized).toContain("Continue the run without failing");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
