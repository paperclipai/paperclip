import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  joinInstructionFragments,
  loadInstructionFragments,
} from "./instructions.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-agent-instructions-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("loadInstructionFragments", () => {
  it("returns empty list when no files exist", async () => {
    const fragments = await loadInstructionFragments({ cwd: tmp });
    expect(fragments).toEqual([]);
  });

  it("loads AGENTS.md and HEARTBEAT.md from cwd in order", async () => {
    await fs.writeFile(path.join(tmp, "AGENTS.md"), "agents body\n");
    await fs.writeFile(path.join(tmp, "HEARTBEAT.md"), "heartbeat body\n");

    const fragments = await loadInstructionFragments({ cwd: tmp });
    expect(fragments).toHaveLength(2);
    expect(fragments[0].source).toBe(path.join(tmp, "AGENTS.md"));
    expect(fragments[1].source).toBe(path.join(tmp, "HEARTBEAT.md"));
  });

  it("places explicit instructionsFilePath before bundle defaults", async () => {
    const explicit = path.join(tmp, "explicit.md");
    await fs.writeFile(explicit, "explicit body\n");
    await fs.writeFile(path.join(tmp, "AGENTS.md"), "agents body\n");

    const fragments = await loadInstructionFragments({
      cwd: tmp,
      instructionsFilePath: explicit,
    });
    expect(fragments.map((f) => f.source)).toEqual([
      explicit,
      path.join(tmp, "AGENTS.md"),
    ]);
  });

  it("skips empty files", async () => {
    await fs.writeFile(path.join(tmp, "AGENTS.md"), "   \n  \n");
    const fragments = await loadInstructionFragments({ cwd: tmp });
    expect(fragments).toEqual([]);
  });

  it("dedupes the explicit path against the bundle filenames", async () => {
    const agentsPath = path.join(tmp, "AGENTS.md");
    await fs.writeFile(agentsPath, "agents body\n");
    const fragments = await loadInstructionFragments({
      cwd: tmp,
      instructionsFilePath: agentsPath,
    });
    expect(fragments).toHaveLength(1);
    expect(fragments[0].source).toBe(agentsPath);
  });

  it("propagates non-ENOENT read errors for the explicit file", async () => {
    // Pointing instructionsFilePath at a directory should yield EISDIR,
    // which we treat as missing rather than throwing.
    const subdir = path.join(tmp, "instructions-dir");
    await fs.mkdir(subdir);
    const fragments = await loadInstructionFragments({
      cwd: tmp,
      instructionsFilePath: subdir,
    });
    expect(fragments).toEqual([]);
  });
});

describe("joinInstructionFragments", () => {
  it("returns empty string for empty input", () => {
    expect(joinInstructionFragments([])).toBe("");
  });

  it("joins fragments with rule separators and source comments", () => {
    const joined = joinInstructionFragments([
      { source: "/a.md", contents: "alpha\n" },
      { source: "/b.md", contents: "beta\n" },
    ]);
    expect(joined).toContain("<!-- source: /a.md -->");
    expect(joined).toContain("<!-- source: /b.md -->");
    expect(joined).toContain("\n\n---\n\n");
  });
});
