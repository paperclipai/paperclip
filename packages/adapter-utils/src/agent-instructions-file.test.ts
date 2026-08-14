import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readAdapterInstructionsFile } from "./agent-instructions-file.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-instructions-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("readAdapterInstructionsFile", () => {
  it("returns contents and no failure when the configured file is readable", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsPath, "You are an agent.\n", "utf8");

    const logs: string[] = [];
    const result = await readAdapterInstructionsFile({
      instructionsFilePath: instructionsPath,
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(result.contents).toBe("You are an agent.\n");
    expect(result.failure).toBeNull();
    expect(result.resolvedPath).toBe(instructionsPath);
    expect(result.directory).toBe(`${root}/`);
    expect(logs).toEqual([]);
  });

  it("returns a structured failure (not just a log line) when the file is missing", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "missing", "AGENTS.md");

    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await readAdapterInstructionsFile({
      instructionsFilePath: instructionsPath,
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });

    expect(result.contents).toBeNull();
    expect(result.failure).toMatchObject({ path: instructionsPath, code: "ENOENT" });
    expect(result.failure?.reason).toContain("ENOENT");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.stream).toBe("stdout");
    expect(logs[0]?.chunk).toContain("could not read agent instructions file");
  });

  it("reports a read failure when the file exists but cannot be opened", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsPath, "unreadable", "utf8");
    await fs.chmod(instructionsPath, 0o000);

    const result = await readAdapterInstructionsFile({ instructionsFilePath: instructionsPath });

    // Root can read 0o000 files, so only assert the failure path where the mode
    // is actually enforced; either way the helper must not throw.
    if (result.failure) {
      expect(result.failure.path).toBe(instructionsPath);
      expect(result.failure.code).toBe("EACCES");
    } else {
      expect(result.contents).toBe("unreadable");
    }
    await fs.chmod(instructionsPath, 0o600);
  });

  it("resolves a relative configured path against cwd when one is supplied", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "AGENTS.md"), "relative", "utf8");

    const result = await readAdapterInstructionsFile({
      instructionsFilePath: "AGENTS.md",
      cwd: root,
    });

    expect(result.resolvedPath).toBe(path.join(root, "AGENTS.md"));
    expect(result.contents).toBe("relative");
  });

  it("is a no-op when no instructions file is configured", async () => {
    const logs: string[] = [];
    const result = await readAdapterInstructionsFile({
      instructionsFilePath: "   ",
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(result).toEqual({
      configuredPath: "",
      resolvedPath: "",
      directory: "",
      contents: null,
      failure: null,
    });
    expect(logs).toEqual([]);
  });

  it("honours the adapter's log stream and prefix", async () => {
    const root = await makeTempRoot();
    const logs: Array<{ stream: string; chunk: string }> = [];

    await readAdapterInstructionsFile({
      instructionsFilePath: path.join(root, "nope.md"),
      logStream: "stderr",
      logPrefix: "[hermes]",
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });

    expect(logs[0]?.stream).toBe("stderr");
    expect(logs[0]?.chunk.startsWith("[hermes] Warning:")).toBe(true);
  });
});
