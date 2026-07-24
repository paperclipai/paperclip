import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadActiveMemories, buildActiveMemorySection, buildMemorySelfCheckBlock } from "./active-memory.js";

describe("buildActiveMemorySection", () => {
  it("returns empty string for empty memories array", () => {
    expect(buildActiveMemorySection([])).toBe("");
  });

  it("returns a section with header and rule items", () => {
    const result = buildActiveMemorySection([
      {
        name: "No bare numbers",
        description: "Never report bare numbers to board.",
        trigger: "always-check",
        howToApply: "Always include units and context when reporting metrics.",
      },
    ]);
    expect(result).toContain("## Active Memories — Self-Check Before Each Action");
    expect(result).toContain("**No bare numbers**");
    expect(result).toContain("Never report bare numbers to board.");
    expect(result).toContain("→ Always include units and context when reporting metrics.");
  });

  it("omits howToApply line when null", () => {
    const result = buildActiveMemorySection([
      {
        name: "Rule A",
        description: "desc",
        trigger: "always-check",
        howToApply: null,
      },
    ]);
    expect(result).toContain("**Rule A**");
    expect(result).not.toContain("→");
  });

  it("includes all always-check memory entries", () => {
    const result = buildActiveMemorySection([
      { name: "Rule A", description: "desc A", trigger: "always-check", howToApply: null },
      { name: "Rule B", description: "desc B", trigger: "always-check", howToApply: "apply B" },
    ]);
    expect(result).toContain("**Rule A**");
    expect(result).toContain("**Rule B**");
  });
});

describe("buildMemorySelfCheckBlock", () => {
  it("returns empty string for empty memories array", () => {
    expect(buildMemorySelfCheckBlock([])).toBe("");
  });

  it("renders markdown table with header and self-check prompt", () => {
    const result = buildMemorySelfCheckBlock([
      { name: "Rule A", description: "Never skip deploy.", trigger: "always-check", howToApply: "check before done" },
    ]);
    expect(result).toContain("## Active Memory Self-Check");
    expect(result).toContain("| # | Memory | Description | How to Apply |");
    expect(result).toContain("Rule A");
    expect(result).toContain("Never skip deploy.");
    expect(result).toContain("check before done");
    expect(result).toContain("Self-check:");
  });

  it("escapes pipe characters in description and howToApply", () => {
    const result = buildMemorySelfCheckBlock([
      { name: "Rule B", description: "opt A | opt B", trigger: "always-check", howToApply: "x | y" },
    ]);
    expect(result).toContain("opt A \\| opt B");
    expect(result).toContain("x \\| y");
  });

  it("renders multiple rows with sequential numbering", () => {
    const result = buildMemorySelfCheckBlock([
      { name: "R1", description: "d1", trigger: "always-check", howToApply: "h1" },
      { name: "R2", description: "d2", trigger: "always-check", howToApply: null },
    ]);
    expect(result).toContain("| 1 |");
    expect(result).toContain("| 2 |");
    expect(result).toContain("R1");
    expect(result).toContain("R2");
  });

  it("handles null howToApply gracefully", () => {
    const result = buildMemorySelfCheckBlock([
      { name: "Rule C", description: "desc C", trigger: "always-check", howToApply: null },
    ]);
    expect(result).toContain("Rule C");
    expect(result).not.toContain("null");
  });
});

describe("loadActiveMemories", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeMemoryDir(parent: string, memories: Array<{
    filename: string;
    content: string;
  }>): Promise<{ memoryDir: string; cwd: string }> {
    const cwd = await fs.mkdtemp(path.join(parent, "cwd-"));
    cleanupDirs.push(cwd);
    const memoryDir = path.join(cwd, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    // Write each memory file
    for (const { filename, content } of memories) {
      await fs.writeFile(path.join(memoryDir, filename), content, "utf-8");
    }

    // Build MEMORY.md index
    const links = memories.map(({ filename }) => {
      const name = path.basename(filename, ".md");
      return `- [${name}](${filename}) — description`;
    });
    await fs.writeFile(
      path.join(memoryDir, "MEMORY.md"),
      `# Memory Index\n\n${links.join("\n")}\n`,
      "utf-8",
    );

    return { memoryDir, cwd };
  }

  it("returns empty array when no memory directory exists", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "am-test-no-dir-"));
    cleanupDirs.push(tmp);
    const result = await loadActiveMemories(tmp);
    expect(result).toEqual([]);
  });

  it("returns only always-check memories", async () => {
    const tmp = os.tmpdir();
    const { cwd } = await makeMemoryDir(tmp, [
      {
        filename: "rule_a.md",
        content: [
          "---",
          "name: Rule A",
          "description: Always-check rule",
          "type: feedback",
          "trigger: always-check",
          "---",
          "",
          "Do X always.",
          "",
          "**Why:** reason",
          "**How to apply:** do X before every action",
        ].join("\n"),
      },
      {
        filename: "rule_b.md",
        content: [
          "---",
          "name: Rule B",
          "description: Optional rule",
          "type: feedback",
          "trigger: optional",
          "---",
          "",
          "Do Y sometimes.",
        ].join("\n"),
      },
      {
        filename: "rule_c.md",
        content: [
          "---",
          "name: Rule C",
          "description: Default (no trigger field)",
          "type: feedback",
          "---",
          "",
          "Do Z.",
        ].join("\n"),
      },
    ]);

    const result = await loadActiveMemories(cwd);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Rule A");
    expect(result[0]!.trigger).toBe("always-check");
    expect(result[0]!.howToApply).toBe("do X before every action");
  });

  it("returns empty array when all memories are optional or triggered", async () => {
    const tmp = os.tmpdir();
    const { cwd } = await makeMemoryDir(tmp, [
      {
        filename: "rule_a.md",
        content: "---\nname: Rule A\ntrigger: triggered\n---\nContent.",
      },
      {
        filename: "rule_b.md",
        content: "---\nname: Rule B\ntrigger: optional\n---\nContent.",
      },
    ]);

    const result = await loadActiveMemories(cwd);
    expect(result).toEqual([]);
  });

  it("falls back to Claude Code auto-memory path when no in-repo memory", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "am-test-home-"));
    cleanupDirs.push(fakeHome);

    const fakeCwd = path.join(fakeHome, "my-cwd");
    await fs.mkdir(fakeCwd, { recursive: true });

    const projectId = fakeCwd.replace(/[:\\/\.]/g, "-");
    const claudeMemoryDir = path.join(fakeHome, ".claude", "projects", projectId, "memory");
    await fs.mkdir(claudeMemoryDir, { recursive: true });

    const memContent = [
      "---",
      "name: Claude Memory Rule",
      "description: Auto-memory rule",
      "type: feedback",
      "trigger: always-check",
      "---",
      "",
      "Rule body.",
      "**How to apply:** apply this rule.",
    ].join("\n");
    await fs.writeFile(path.join(claudeMemoryDir, "rule.md"), memContent, "utf-8");
    await fs.writeFile(
      path.join(claudeMemoryDir, "MEMORY.md"),
      "# Memory Index\n\n- [rule](rule.md) — rule\n",
      "utf-8",
    );

    // Inject fakeHome so the loader checks our controlled directory instead of ~/.claude
    const result = await loadActiveMemories(fakeCwd, { homeDir: fakeHome });
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Claude Memory Rule");
    expect(result[0]!.trigger).toBe("always-check");
    expect(result[0]!.howToApply).toBe("apply this rule.");
  });

  it("rejects path traversal links in MEMORY.md without throwing", async () => {
    const tmp = os.tmpdir();
    const cwd = await fs.mkdtemp(path.join(tmp, "am-test-traversal-"));
    cleanupDirs.push(cwd);
    const memoryDir = path.join(cwd, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await fs.writeFile(
      path.join(memoryDir, "MEMORY.md"),
      "# Memory Index\n\n- [Evil](../../etc/passwd.md) — evil traversal\n",
      "utf-8",
    );

    const result = await loadActiveMemories(cwd);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("reads legacy enforcement field for backward compatibility (VOG-5838)", async () => {
    const tmp = os.tmpdir();
    const { cwd } = await makeMemoryDir(tmp, [
      {
        filename: "legacy_rule.md",
        content: [
          "---",
          "name: Legacy Rule",
          "description: Old-format rule using enforcement field",
          "type: feedback",
          "enforcement: always-check",
          "---",
          "",
          "Legacy body.",
          "**How to apply:** apply legacy.",
        ].join("\n"),
      },
    ]);

    const result = await loadActiveMemories(cwd);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Legacy Rule");
    expect(result[0]!.trigger).toBe("always-check");
  });
});
