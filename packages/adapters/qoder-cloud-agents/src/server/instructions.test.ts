import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractInstructionReferences, readReferencedInstructionFiles } from "./instructions.js";

describe("extractInstructionReferences", () => {
  it("keeps whole link targets and quoted paths, including spaces and non-English letters", () => {
    const text = [
      "Read [the review](playbooks/code review.md) and [规则](规则/编码规范.md).",
      "Also [angled](<docs/release notes.md>) and [titled](guide.md \"Guide\").",
      "Encoded: [enc](docs/team%20charter.md#scope).",
      "Quoted: `notes/meeting notes.txt`, \"config/app settings.yaml\", 'Überblick.md'.",
      "Bare: SOUL.md, 团队/介绍.md and checklists/daily.md.",
      "Ignored: [site](https://example.com/readme.md), [image](logo.png), mailto:a@b.md.",
    ].join("\n");
    const references = extractInstructionReferences(text);
    expect(references.map((reference) => reference.path)).toEqual([
      "playbooks/code review.md",
      "规则/编码规范.md",
      "docs/release notes.md",
      "guide.md",
      "docs/team charter.md",
      "notes/meeting notes.txt",
      "config/app settings.yaml",
      "Überblick.md",
      "SOUL.md",
      "团队/介绍.md",
      "checklists/daily.md",
    ]);
    // Bare words left over from a link target are not read as separate paths.
    expect(references.some((reference) => reference.path === "review.md")).toBe(false);
    expect(references.filter((reference) => reference.explicit).map((reference) => reference.path)).toHaveLength(8);
  });
});

describe("readReferencedInstructionFiles", () => {
  it("reads referenced files whose names contain spaces or non-English letters, and reports explicit misses", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-references-"));
    try {
      await fs.mkdir(path.join(dir, "playbooks"));
      await fs.mkdir(path.join(dir, "规则"));
      await fs.writeFile(path.join(dir, "playbooks", "code review.md"), "Code review body.");
      await fs.writeFile(path.join(dir, "规则", "编码规范.md"), "编码规范正文。");
      await fs.writeFile(path.join(dir, "review.md"), "A different file that must not be picked by mistake.");
      const entryText = "See [review](playbooks/code review.md), [规范](规则/编码规范.md) and [gone](missing file.md).";
      await fs.writeFile(path.join(dir, "AGENTS.md"), entryText);
      const result = await readReferencedInstructionFiles(path.join(dir, "AGENTS.md"), entryText);
      expect(result.files).toEqual([
        { relativePath: "playbooks/code review.md", text: "Code review body." },
        { relativePath: "规则/编码规范.md", text: "编码规范正文。" },
      ]);
      expect(result.missing).toEqual(["missing file.md"]);
      expect(result.omitted).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not report bare words that merely look like file names", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-references-"));
    try {
      const entryText = "Update package.json and keep a CHANGELOG.md in each repository.";
      await fs.writeFile(path.join(dir, "AGENTS.md"), entryText);
      const result = await readReferencedInstructionFiles(path.join(dir, "AGENTS.md"), entryText);
      expect(result).toEqual({ files: [], omitted: [], missing: [] });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
