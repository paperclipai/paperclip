import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstructionsFileSafe, instructionsFailureMessage } from "./instructions-file.js";

describe("readInstructionsFileSafe", () => {
  it("returns contents when path is a real file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "instr-"));
    const filePath = join(dir, "AGENTS.md");
    writeFileSync(filePath, "hello instructions\n");
    const result = await readInstructionsFileSafe(filePath);
    expect(result).toEqual({ ok: true, contents: "hello instructions\n" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns EISDIR when path is a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "instr-dir-"));
    const result = await readInstructionsFileSafe(dir);
    expect(result).toEqual({ ok: false, error: "EISDIR", path: dir });
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns ENOENT when path does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "instr-noent-"));
    const missing = join(dir, "does-not-exist.md");
    const result = await readInstructionsFileSafe(missing);
    expect(result).toEqual({ ok: false, error: "ENOENT", path: missing });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("instructionsFailureMessage", () => {
  it("includes the path and remediation hint", () => {
    const msg = instructionsFailureMessage("/tmp/bundle");
    expect(msg).toContain("/tmp/bundle");
    expect(msg).toContain("is a directory");
    expect(msg).toContain("AGENTS.md");
    expect(msg).toContain("instructionsRootPath + instructionsEntryFile");
  });
});
