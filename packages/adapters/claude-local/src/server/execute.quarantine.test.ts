import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { quarantinePoisonedJsonl } from "./execute.js";

const TMP_DIRS: string[] = [];

async function makeTmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-local-quarantine-"));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(async () => {
  while (TMP_DIRS.length > 0) {
    const dir = TMP_DIRS.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

function poisonedJsonl(poisonId: string) {
  const good = JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_01abc",
      model: "claude-opus-4-7",
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    },
  });
  const synthetic = JSON.stringify({
    type: "assistant",
    message: {
      id: poisonId,
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      stop_sequence: "",
      content: [{ type: "text", text: "No response requested." }],
    },
  });
  return `${good}\n${synthetic}\n`;
}

function cleanJsonl() {
  return (
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_01good",
        model: "claude-opus-4-7",
        role: "assistant",
        content: [{ type: "text", text: "All good." }],
      },
    }) + "\n"
  );
}

describe("quarantinePoisonedJsonl", () => {
  it("quarantines a poisoned jsonl matched by sessionId", async () => {
    const tmpDir = await makeTmpDir();
    const cwd = "/test/workspace/one";
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = path.join(tmpDir, "projects", encodedCwd);
    await fs.mkdir(projectDir, { recursive: true });
    const sessionId = randomUUID();
    const poisonId = randomUUID();
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(jsonlPath, poisonedJsonl(poisonId));

    const runId = randomUUID();
    const result = await quarantinePoisonedJsonl({
      claudeConfigDir: tmpDir,
      cwd,
      sessionId,
      runId,
    });

    expect(result?.quarantined).toBe(true);
    expect(result?.poisonId).toBe(poisonId);
    expect(result?.path).toBe(jsonlPath);
    expect(result?.poisonedPath).toBe(`${jsonlPath}.poisoned-${runId}`);

    await expect(fs.access(jsonlPath)).rejects.toThrow();
    await expect(fs.access(result!.poisonedPath!)).resolves.toBeUndefined();
  });

  it("leaves a clean jsonl untouched", async () => {
    const tmpDir = await makeTmpDir();
    const cwd = "/test/workspace/two";
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = path.join(tmpDir, "projects", encodedCwd);
    await fs.mkdir(projectDir, { recursive: true });
    const sessionId = randomUUID();
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(jsonlPath, cleanJsonl());

    const result = await quarantinePoisonedJsonl({
      claudeConfigDir: tmpDir,
      cwd,
      sessionId,
      runId: randomUUID(),
    });

    expect(result?.quarantined).toBe(false);
    await expect(fs.access(jsonlPath)).resolves.toBeUndefined();
  });

  it("falls back to the latest jsonl when no sessionId is given", async () => {
    const tmpDir = await makeTmpDir();
    const cwd = "/test/workspace/three";
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = path.join(tmpDir, "projects", encodedCwd);
    await fs.mkdir(projectDir, { recursive: true });
    const poisonId = randomUUID();
    const latestPath = path.join(projectDir, `${randomUUID()}.jsonl`);
    await fs.writeFile(latestPath, poisonedJsonl(poisonId));

    const result = await quarantinePoisonedJsonl({
      claudeConfigDir: tmpDir,
      cwd,
      sessionId: null,
      runId: randomUUID(),
    });

    expect(result?.quarantined).toBe(true);
    expect(result?.poisonId).toBe(poisonId);
  });

  it("does not quarantine a synthetic entry with a msg_* id", async () => {
    const tmpDir = await makeTmpDir();
    const cwd = "/test/workspace/four";
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = path.join(tmpDir, "projects", encodedCwd);
    await fs.mkdir(projectDir, { recursive: true });
    const sessionId = randomUUID();
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    const safeEntry = JSON.stringify({
      type: "assistant",
      message: {
        id: `msg_${randomUUID().replace(/-/g, "")}`,
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    });
    await fs.writeFile(jsonlPath, `${safeEntry}\n`);

    const result = await quarantinePoisonedJsonl({
      claudeConfigDir: tmpDir,
      cwd,
      sessionId,
      runId: randomUUID(),
    });

    expect(result?.quarantined).toBe(false);
    await expect(fs.access(jsonlPath)).resolves.toBeUndefined();
  });

  it("returns null when the project directory does not exist", async () => {
    const tmpDir = await makeTmpDir();
    const result = await quarantinePoisonedJsonl({
      claudeConfigDir: tmpDir,
      cwd: "/no/such/dir",
      sessionId: null,
      runId: randomUUID(),
    });
    expect(result).toBeNull();
  });

  it("skips already-quarantined files when scanning latest jsonl", async () => {
    const tmpDir = await makeTmpDir();
    const cwd = "/test/workspace/five";
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = path.join(tmpDir, "projects", encodedCwd);
    await fs.mkdir(projectDir, { recursive: true });
    // Latest by mtime is a `.poisoned-*` from a previous run — must be ignored.
    const oldPoisoned = path.join(projectDir, `${randomUUID()}.jsonl.poisoned-prior-run`);
    await fs.writeFile(oldPoisoned, poisonedJsonl(randomUUID()));
    // The actual current jsonl is clean.
    const currentPath = path.join(projectDir, `${randomUUID()}.jsonl`);
    await fs.writeFile(currentPath, cleanJsonl());
    // Bump mtime on the prior-poisoned file so it sorts newest.
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(oldPoisoned, future, future);

    const result = await quarantinePoisonedJsonl({
      claudeConfigDir: tmpDir,
      cwd,
      sessionId: null,
      runId: randomUUID(),
    });

    expect(result?.quarantined).toBe(false);
    await expect(fs.access(currentPath)).resolves.toBeUndefined();
    await expect(fs.access(oldPoisoned)).resolves.toBeUndefined();
  });
});
