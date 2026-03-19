import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpLab(repos: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adlucy-test-"));
  for (const [name, claudeMd] of Object.entries(repos)) {
    const repoDir = path.join(dir, name);
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), claudeMd);
  }
  return dir;
}

function rmrf(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Group 1: Path resolution
// ---------------------------------------------------------------------------

describe("Group 1: Path resolution", () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeAll(() => {
    tmpDir = makeTmpLab({
      "repo-a": "# Repo A\nBackend service",
      "repo-b": "# Repo B\nFrontend app",
      "repo-c": "# Repo C\nShared library",
    });
  });

  afterAll(() => {
    rmrf(tmpDir);
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.ADLUCY_LAB_PATH = savedEnv;
    } else {
      delete process.env.ADLUCY_LAB_PATH;
    }
  });

  it("1.1 config.labPath takes priority over env", async () => {
    savedEnv = process.env.ADLUCY_LAB_PATH;
    process.env.ADLUCY_LAB_PATH = "/should/not/be/used";

    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("list-repos", {});
    const repos = (result.data as { repos: Array<{ name: string }> }).repos;
    expect(repos).toHaveLength(3);
  });

  it("1.2 falls back to ADLUCY_LAB_PATH env when config empty", async () => {
    savedEnv = process.env.ADLUCY_LAB_PATH;
    process.env.ADLUCY_LAB_PATH = tmpDir;

    const harness = createTestHarness({ manifest, config: {} });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("list-repos", {});
    const repos = (result.data as { repos: Array<{ name: string }> }).repos;
    expect(repos).toHaveLength(3);
  });

  it("1.3 falls back to $HOME/lab — health degraded if missing", async () => {
    savedEnv = process.env.ADLUCY_LAB_PATH;
    delete process.env.ADLUCY_LAB_PATH;

    // Only test if ~/lab doesn't actually exist (to avoid env pollution)
    const homeLabPath = path.join(os.homedir(), "lab");
    if (fs.existsSync(homeLabPath)) return; // skip — can't test without side effects

    const harness = createTestHarness({ manifest, config: {} });
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// Group 2: Scan behavior
// ---------------------------------------------------------------------------

describe("Group 2: Scan behavior", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adlucy-scan-"));

    // Normal repos with CLAUDE.md
    for (const name of ["alpha", "beta", "gamma"]) {
      const d = path.join(tmpDir, name);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, "CLAUDE.md"), `# ${name}\nDescription of ${name}`);
    }

    // Hidden repo (should be skipped)
    const hidden = path.join(tmpDir, ".hidden-repo");
    fs.mkdirSync(hidden);
    fs.writeFileSync(path.join(hidden, "CLAUDE.md"), "# hidden");

    // node_modules dir (should be skipped)
    const nm = path.join(tmpDir, "node_modules");
    fs.mkdirSync(nm);
    fs.writeFileSync(path.join(nm, "CLAUDE.md"), "# node_modules");

    // A plain file (not a directory)
    fs.writeFileSync(path.join(tmpDir, "README.md"), "not a repo");
  });

  afterAll(() => rmrf(tmpDir));

  it("2.1 indexes repos with CLAUDE.md", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("list-repos", {});
    const repos = (result.data as { repos: Array<{ name: string }> }).repos;
    expect(repos).toHaveLength(3);
    expect(repos.map((r) => r.name).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("2.2 skips .hidden-repo (dot-prefixed)", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("list-repos", {});
    const repos = (result.data as { repos: Array<{ name: string }> }).repos;
    expect(repos.map((r) => r.name)).not.toContain(".hidden-repo");
  });

  it("2.3 skips node_modules", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("list-repos", {});
    const repos = (result.data as { repos: Array<{ name: string }> }).repos;
    expect(repos.map((r) => r.name)).not.toContain("node_modules");
  });

  it("2.4 skips non-directory entries (files) — no crash", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    // If we got here without throwing, the test passes
    const result = await harness.executeTool<ToolResult>("list-repos", {});
    const repos = (result.data as { repos: Array<{ name: string }> }).repos;
    expect(repos.map((r) => r.name)).not.toContain("README.md");
  });

  it("2.5 unreadable lab dir — setup completes, health degraded", async () => {
    const badDir = path.join(os.tmpdir(), `adlucy-no-such-${Date.now()}`);
    const harness = createTestHarness({ manifest, config: { labPath: badDir } });
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");

    const result = await harness.executeTool<ToolResult>("list-repos", {});
    const repos = (result.data as { repos: Array<{ name: string }> }).repos;
    expect(repos).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Group 3: get-knowledge — repo only
// ---------------------------------------------------------------------------

describe("Group 3: get-knowledge — repo only", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = makeTmpLab({
      api: "# API Service\nApollo GraphQL backend\nHandles auth, billing, reporting",
      frontend: "# Frontend\nReact SPA",
    });
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);
  });

  afterAll(() => rmrf(tmpDir));

  it("3.1 valid repo returns content + data.repo, no data.path", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("get-knowledge", { repo: "api" });
    expect(result.content).toContain("API Service");
    const data = result.data as Record<string, unknown>;
    expect(data.repo).toBe("api");
    expect(data).not.toHaveProperty("path");
  });

  it("3.2 unknown repo returns error with available list", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("get-knowledge", { repo: "nonexistent" });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("nonexistent");
    expect(result.error).toContain("api");
  });

  it("3.3 large CLAUDE.md — truncated to MAX_CONTENT_LENGTH", async () => {
    // Create a repo with content > 8000 chars
    const bigContent = "# Big Repo\n" + "x".repeat(9000);
    const bigDir = path.join(tmpDir, "big-repo");
    fs.mkdirSync(bigDir, { recursive: true });
    fs.writeFileSync(path.join(bigDir, "CLAUDE.md"), bigContent);

    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("get-knowledge", { repo: "big-repo" });
    const data = result.data as { truncated: boolean };
    expect(data.truncated).toBe(true);
    expect(result.content!.length).toBeLessThanOrEqual(8000);
  });
});

// ---------------------------------------------------------------------------
// Group 4: get-knowledge — repo + query
// ---------------------------------------------------------------------------

describe("Group 4: get-knowledge — repo + query", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = makeTmpLab({
      api: "# API Service\nApollo GraphQL backend\nHandles auth, billing, reporting\nUses TypeORM with MySQL",
      frontend: "# Frontend\nReact SPA\nUses Apollo Client",
    });
  });

  afterAll(() => rmrf(tmpDir));

  it("4.1 matching query returns matches", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("get-knowledge", { repo: "api", query: "GraphQL" });
    expect(result.content).toContain("GraphQL");
    const data = result.data as { matchCount: number };
    expect(data.matchCount).toBeGreaterThanOrEqual(1);
  });

  it("4.2 non-matching query returns no matches message", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("get-knowledge", { repo: "api", query: "zzz-nonexistent-zzz" });
    expect(result.content).toContain("No matches");
  });

  it("4.3 invalid repo + query returns error", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("get-knowledge", { repo: "nope", query: "anything" });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("nope");
  });
});

// ---------------------------------------------------------------------------
// Group 5: get-knowledge — query only (cross-repo)
// ---------------------------------------------------------------------------

describe("Group 5: get-knowledge — query only", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = makeTmpLab({
      api: "# API\nUses GraphQL and TypeORM",
      frontend: "# Frontend\nUses GraphQL client",
      worker: "# Worker\nBackground jobs with BullMQ",
    });
  });

  afterAll(() => rmrf(tmpDir));

  it("5.1 cross-repo search finds matches in multiple repos", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("get-knowledge", { query: "GraphQL" });
    const data = result.data as { matchedRepos: number };
    expect(data.matchedRepos).toBeGreaterThanOrEqual(1);
  });

  it("5.2 no hits anywhere returns no matches message", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("get-knowledge", { query: "zzz-impossible-match-zzz" });
    expect(result.content).toContain("No matches");
  });
});

// ---------------------------------------------------------------------------
// Group 6: get-knowledge — no params (overview)
// ---------------------------------------------------------------------------

describe("Group 6: get-knowledge — no params", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = makeTmpLab({
      api: "# API Service\nBackend",
      frontend: "# Frontend App\nSPA",
    });
  });

  afterAll(() => rmrf(tmpDir));

  it("6.1 returns overview listing all repos", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("get-knowledge", {});
    expect(result.content).toContain("Knowledge Base");
    expect(result.content).toContain("api");
    expect(result.content).toContain("frontend");
    expect(result.content).toContain("2 repos indexed");
  });
});

// ---------------------------------------------------------------------------
// Group 7: Path leak prevention
// ---------------------------------------------------------------------------

describe("Group 7: Path leak prevention", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = makeTmpLab({
      api: "# API\nBackend service",
    });
  });

  afterAll(() => rmrf(tmpDir));

  it("7.1 get-knowledge data has no path key and no tmpDir in JSON", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("get-knowledge", { repo: "api" });
    const data = result.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("path");
    expect(JSON.stringify(result)).not.toContain(tmpDir);
  });

  it("7.2 list-repos entries have name + summary only, no path", async () => {
    const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<ToolResult>("list-repos", {});
    const repos = (result.data as { repos: Array<Record<string, unknown>> }).repos;
    for (const repo of repos) {
      expect(repo).toHaveProperty("name");
      expect(repo).toHaveProperty("summary");
      expect(repo).not.toHaveProperty("path");
    }
    expect(JSON.stringify(result)).not.toContain(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Group 8: list-repos
// ---------------------------------------------------------------------------

describe("Group 8: list-repos", () => {
  it("8.1 returns all repos with name/summary, count matches", async () => {
    const tmpDir = makeTmpLab({
      svc1: "# Service 1\nFirst",
      svc2: "# Service 2\nSecond",
    });
    try {
      const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
      await plugin.definition.setup(harness.ctx);

      const result = await harness.executeTool<ToolResult>("list-repos", {});
      const repos = (result.data as { repos: Array<{ name: string; summary: string }> }).repos;
      expect(repos).toHaveLength(2);
      for (const repo of repos) {
        expect(repo.name).toBeDefined();
        expect(repo.summary).toBeDefined();
      }
    } finally {
      rmrf(tmpDir);
    }
  });

  it("8.2 empty dir — repos array empty", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "adlucy-empty-"));
    try {
      const harness = createTestHarness({ manifest, config: { labPath: emptyDir } });
      await plugin.definition.setup(harness.ctx);

      const result = await harness.executeTool<ToolResult>("list-repos", {});
      const repos = (result.data as { repos: Array<{ name: string }> }).repos;
      expect(repos).toHaveLength(0);
    } finally {
      rmrf(emptyDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 9: onHealth()
// ---------------------------------------------------------------------------

describe("Group 9: onHealth()", () => {
  it("9.1 clean scan — status ok, message has repo count + timestamp", async () => {
    const tmpDir = makeTmpLab({ a: "# A\nOk" });
    try {
      const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
      await plugin.definition.setup(harness.ctx);

      const health = await plugin.definition.onHealth!();
      expect(health.status).toBe("ok");
      expect(health.message).toContain("1 repos indexed");
      expect(health.message).toMatch(/last scan: \d{4}-/);
    } finally {
      rmrf(tmpDir);
    }
  });

  it("9.2 unreadable dir — status degraded, message mentions errors", async () => {
    const badDir = path.join(os.tmpdir(), `adlucy-missing-${Date.now()}`);
    const harness = createTestHarness({ manifest, config: { labPath: badDir } });
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
    expect(health.message).toContain("scan errors");
  });
});

// ---------------------------------------------------------------------------
// Group 10: onConfigChanged()
// ---------------------------------------------------------------------------

describe("Group 10: onConfigChanged()", () => {
  it("10.1 change to dir with 1 repo — list-repos returns 1", async () => {
    // Start with 3 repos
    const dir3 = makeTmpLab({ a: "# A", b: "# B", c: "# C" });
    const dir1 = makeTmpLab({ only: "# Only repo" });
    try {
      const harness = createTestHarness({ manifest, config: { labPath: dir3 } });
      await plugin.definition.setup(harness.ctx);

      // Verify initial state
      let result = await harness.executeTool<ToolResult>("list-repos", {});
      expect((result.data as { repos: unknown[] }).repos).toHaveLength(3);

      // Change config
      await plugin.definition.onConfigChanged!({ labPath: dir1 });

      result = await harness.executeTool<ToolResult>("list-repos", {});
      expect((result.data as { repos: unknown[] }).repos).toHaveLength(1);
    } finally {
      rmrf(dir3);
      rmrf(dir1);
    }
  });

  it("10.2 change to non-existent dir — health degraded, list-repos returns 0", async () => {
    const dir = makeTmpLab({ a: "# A" });
    try {
      const harness = createTestHarness({ manifest, config: { labPath: dir } });
      await plugin.definition.setup(harness.ctx);

      await plugin.definition.onConfigChanged!({ labPath: "/no/such/dir" });

      const health = await plugin.definition.onHealth!();
      expect(health.status).toBe("degraded");

      const result = await harness.executeTool<ToolResult>("list-repos", {});
      expect((result.data as { repos: unknown[] }).repos).toHaveLength(0);
    } finally {
      rmrf(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 11: onValidateConfig()
// ---------------------------------------------------------------------------

describe("Group 11: onValidateConfig()", () => {
  it("11.1 valid readable directory — ok: true", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adlucy-valid-"));
    try {
      // Need setup to have been called at least once for cachedLogger
      const harness = createTestHarness({ manifest, config: { labPath: dir } });
      await plugin.definition.setup(harness.ctx);

      const result = await plugin.definition.onValidateConfig!({ labPath: dir });
      expect(result.ok).toBe(true);
    } finally {
      rmrf(dir);
    }
  });

  it("11.2 non-existent path — ok: false, errors populated", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    await plugin.definition.setup(harness.ctx);

    const result = await plugin.definition.onValidateConfig!({ labPath: "/no/such/directory" });
    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("11.3 path is a file, not directory — ok: false", async () => {
    const tmpFile = path.join(os.tmpdir(), `adlucy-file-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "I am a file");
    try {
      const harness = createTestHarness({ manifest, config: {} });
      await plugin.definition.setup(harness.ctx);

      const result = await plugin.definition.onValidateConfig!({ labPath: tmpFile });
      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.toLowerCase().includes("not a directory"))).toBe(true);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 12: Edge cases
// ---------------------------------------------------------------------------

describe("Group 12: Edge cases", () => {
  it("12.1 CLAUDE.md > 50KB — repo skipped silently", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adlucy-big-"));
    const bigRepo = path.join(tmpDir, "huge");
    fs.mkdirSync(bigRepo);
    // 51KB content
    fs.writeFileSync(path.join(bigRepo, "CLAUDE.md"), "x".repeat(51 * 1024));

    // Also add a normal repo to verify scan still works
    const normalRepo = path.join(tmpDir, "normal");
    fs.mkdirSync(normalRepo);
    fs.writeFileSync(path.join(normalRepo, "CLAUDE.md"), "# Normal\nOk");

    try {
      const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
      await plugin.definition.setup(harness.ctx);

      const result = await harness.executeTool<ToolResult>("list-repos", {});
      const repos = (result.data as { repos: Array<{ name: string }> }).repos;
      expect(repos).toHaveLength(1);
      expect(repos[0].name).toBe("normal");
    } finally {
      rmrf(tmpDir);
    }
  });

  it("12.2 unreadable CLAUDE.md (chmod 000) — other repos still indexed, health degraded", async () => {
    // Skip if running as root (chmod 000 is still readable)
    if (process.getuid?.() === 0) return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adlucy-perm-"));
    const badRepo = path.join(tmpDir, "bad-perms");
    fs.mkdirSync(badRepo);
    fs.writeFileSync(path.join(badRepo, "CLAUDE.md"), "# Secret");
    fs.chmodSync(path.join(badRepo, "CLAUDE.md"), 0o000);

    const goodRepo = path.join(tmpDir, "good");
    fs.mkdirSync(goodRepo);
    fs.writeFileSync(path.join(goodRepo, "CLAUDE.md"), "# Good\nAccessible");

    try {
      const harness = createTestHarness({ manifest, config: { labPath: tmpDir } });
      await plugin.definition.setup(harness.ctx);

      const result = await harness.executeTool<ToolResult>("list-repos", {});
      const repos = (result.data as { repos: Array<{ name: string }> }).repos;
      expect(repos).toHaveLength(1);
      expect(repos[0].name).toBe("good");

      const health = await plugin.definition.onHealth!();
      expect(health.status).toBe("degraded");
    } finally {
      // Restore permissions before cleanup
      try {
        fs.chmodSync(path.join(badRepo, "CLAUDE.md"), 0o644);
      } catch { /* ignore */ }
      rmrf(tmpDir);
    }
  });
});
