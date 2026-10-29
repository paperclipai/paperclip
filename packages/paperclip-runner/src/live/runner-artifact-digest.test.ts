import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const { readRunnerdArtifactBinding } = await import("./runnerd-codex-transport.js");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("runner artifact digest", () => {
  it("hashes an unchanged binary once and rehashes a replaced one", () => {
    const root = mkdtempSync(join(tmpdir(), "runner-digest-")); roots.push(root);
    const binary = join(root, "paperclip-runnerd");
    writeFileSync(binary, "first");
    const reads = () => vi.mocked(fs.readFileSync).mock.calls.filter(([path]) => path === binary).length;
    expect(readRunnerdArtifactBinding(binary).digest).toBe(digest("first"));
    expect(readRunnerdArtifactBinding(binary).digest).toBe(digest("first"));
    expect(reads()).toBe(1);
    writeFileSync(binary, "second, replaced");
    expect(readRunnerdArtifactBinding(binary).digest).toBe(digest("second, replaced"));
    expect(reads()).toBe(2);
  });
});
