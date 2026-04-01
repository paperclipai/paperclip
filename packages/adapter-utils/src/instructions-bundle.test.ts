import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkspaceInstructionsBundle } from "./server-utils.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (target) => {
      await fs.rm(target, { recursive: true, force: true });
      cleanupPaths.delete(target);
    }),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.add(root);
  return root;
}

describe("prepareWorkspaceInstructionsBundle", () => {
  it("stages external instruction bundles into the workspace", async () => {
    const workspaceRoot = await makeTempDir("paperclip-workspace-");
    const sourceRoot = await makeTempDir("paperclip-instructions-");
    const sourceInstructions = path.join(sourceRoot, "AGENTS.md");
    await fs.writeFile(sourceInstructions, "# AGENTS\n", "utf8");
    await fs.writeFile(path.join(sourceRoot, "HEARTBEAT.md"), "# HEARTBEAT\n", "utf8");

    const logLines: string[] = [];
    const prepared = await prepareWorkspaceInstructionsBundle({
      cwd: workspaceRoot,
      instructionsFilePath: sourceInstructions,
      agentId: "agent-123",
      onLog: async (_stream, text) => {
        logLines.push(text);
      },
    });

    expect(prepared.sourceInstructionsFilePath).toBe(sourceInstructions);
    expect(prepared.stagedBundleRoot).toBe(
      path.join(workspaceRoot, ".agents", "instructions", "agent-123"),
    );
    expect(prepared.effectiveInstructionsFilePath).toBe(
      path.join(workspaceRoot, ".agents", "instructions", "agent-123", "AGENTS.md"),
    );
    await expect(
      fs.readFile(path.join(workspaceRoot, ".agents", "instructions", "agent-123", "HEARTBEAT.md"), "utf8"),
    ).resolves.toBe("# HEARTBEAT\n");
    expect(logLines.join("")).toContain("Staged agent instructions bundle");
  });

  it("keeps instruction bundles in place when they are already inside the workspace", async () => {
    const workspaceRoot = await makeTempDir("paperclip-workspace-");
    const instructionsRoot = path.join(workspaceRoot, "config", "instructions");
    await fs.mkdir(instructionsRoot, { recursive: true });
    const instructionsFilePath = path.join(instructionsRoot, "AGENTS.md");
    await fs.writeFile(instructionsFilePath, "# AGENTS\n", "utf8");

    const prepared = await prepareWorkspaceInstructionsBundle({
      cwd: workspaceRoot,
      instructionsFilePath: "config/instructions/AGENTS.md",
      agentId: "agent-123",
    });

    expect(prepared.sourceInstructionsFilePath).toBe(instructionsFilePath);
    expect(prepared.effectiveInstructionsFilePath).toBe(instructionsFilePath);
    expect(prepared.effectiveInstructionsDir).toBe(`${instructionsRoot}/`);
    expect(prepared.stagedBundleRoot).toBeNull();
    await expect(
      fs.access(path.join(workspaceRoot, ".agents", "instructions", "agent-123")),
    ).rejects.toThrow();
  });
});
