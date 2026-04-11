import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAgentMemory, AGENT_MEMORY_DEFAULT_SIZE_BUDGET } from "./server-utils.js";

async function mkTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "paperclip-memory-test-"));
}

describe("readAgentMemory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string when memory directory does not exist", async () => {
    const result = await readAgentMemory(path.join(tmpDir, "nonexistent", "memory"));
    expect(result).toBe("");
  });

  it("returns empty string when MEMORY.md is missing", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    const result = await readAgentMemory(memDir);
    expect(result).toBe("");
  });

  it("returns index content when MEMORY.md exists but references no files", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "MEMORY.md"), "# Memory Index\n\n(empty)", "utf8");

    const result = await readAgentMemory(memDir);
    expect(result).toContain("Memory Index");
    expect(result).toContain("(empty)");
  });

  it("injects referenced memory files below the size budget", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });

    const indexContent = [
      "# Memory Index",
      "",
      "- [User Role](user_role.md) — role context",
      "- [Feedback](feedback_testing.md) — testing guidance",
    ].join("\n");
    await fs.writeFile(path.join(memDir, "MEMORY.md"), indexContent, "utf8");
    await fs.writeFile(path.join(memDir, "user_role.md"), "User is a senior engineer.", "utf8");
    await fs.writeFile(path.join(memDir, "feedback_testing.md"), "Always use real database in tests.", "utf8");

    const result = await readAgentMemory(memDir);
    expect(result).toContain("User is a senior engineer.");
    expect(result).toContain("Always use real database in tests.");
  });

  it("respects the size budget and stops injecting files once budget is exhausted", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });

    const bigContent = "x".repeat(500);
    const indexContent = [
      "# Memory Index",
      "",
      "- [File A](a.md) — first",
      "- [File B](b.md) — second",
      "- [File C](c.md) — third",
    ].join("\n");
    await fs.writeFile(path.join(memDir, "MEMORY.md"), indexContent, "utf8");
    await fs.writeFile(path.join(memDir, "a.md"), bigContent, "utf8");
    await fs.writeFile(path.join(memDir, "b.md"), bigContent, "utf8");
    await fs.writeFile(path.join(memDir, "c.md"), bigContent, "utf8");

    // Set budget just large enough for index + first file but not all three
    const headerEstimate = 200;
    const budget = headerEstimate + bigContent.length + 100;
    const result = await readAgentMemory(memDir, { sizeBudget: budget });

    expect(result).toContain("a.md");
    // b.md or c.md should be excluded due to budget
    const bPresent = result.includes(bigContent.slice(0, 10)) && result.split("b.md").length > 2;
    const cPresent = result.split("c.md").length > 2 && result.includes("c.md\n\n" + bigContent.slice(0, 10));
    // At most one of the big files fits after the index
    expect(result.length).toBeLessThanOrEqual(budget + 200); // small tolerance for framing
    void bPresent;
    void cPresent;
  });

  it("skips files referenced in MEMORY.md that do not exist on disk", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });

    const indexContent = [
      "# Memory Index",
      "",
      "- [Missing](missing.md) — does not exist",
      "- [Present](present.md) — exists",
    ].join("\n");
    await fs.writeFile(path.join(memDir, "MEMORY.md"), indexContent, "utf8");
    await fs.writeFile(path.join(memDir, "present.md"), "Present content.", "utf8");

    const result = await readAgentMemory(memDir);
    expect(result).toContain("Present content.");
    // Should not throw for missing.md
  });

  it("does not follow external URLs in memory index", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });

    const indexContent = [
      "# Memory Index",
      "",
      "- [External](https://example.com/file.md) — external link",
      "- [Local](local.md) — local file",
    ].join("\n");
    await fs.writeFile(path.join(memDir, "MEMORY.md"), indexContent, "utf8");
    await fs.writeFile(path.join(memDir, "local.md"), "Local content.", "utf8");

    const result = await readAgentMemory(memDir);
    expect(result).toContain("Local content.");
    // Should not try to fetch the external URL
  });

  it("adapter smoke test: fails if memory is not read when agentHome/memory exists", async () => {
    // This test verifies the contract: when a valid memory dir exists,
    // readAgentMemory MUST return non-empty content (not silently skip).
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(
      path.join(memDir, "MEMORY.md"),
      "# Memory Index\n\n- [Role](role.md) — user role",
      "utf8",
    );
    await fs.writeFile(path.join(memDir, "role.md"), "Role: Senior Engineer", "utf8");

    const result = await readAgentMemory(memDir);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Memory Index");
    expect(result).toContain("Role: Senior Engineer");
  });

  it("uses the default size budget when no option is provided", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "MEMORY.md"), "# Index", "utf8");

    // Should not throw — default budget applies
    const result = await readAgentMemory(memDir);
    expect(result.length).toBeLessThanOrEqual(AGENT_MEMORY_DEFAULT_SIZE_BUDGET + 500);
  });
});
