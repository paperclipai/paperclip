import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readCache,
  writeCache,
  buildCacheKey,
  resolveTtlMs,
  hashCommand,
  computeCacheKeyHash,
} from "../src/result-cache.js";
import type { ToolResultSummary } from "../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-cache-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeSummary = (tool = "Bash"): ToolResultSummary => ({
  tool,
  status: "success",
  exit_code: 0,
  duration_ms: 100,
  stdout_ref: "artifact://abc",
  stderr_ref: "artifact://def",
  preview: "output preview",
  parsed: null,
  truncation_flag: false,
  original_bytes: 100,
  original_lines: 5,
});

const makeKey = () => ({
  commandHash: hashCommand("kubectl get pods -n production"),
  cwd: "/workspace",
  gitSha: "abc1234",
});

describe("writeCache + readCache", () => {
  it("returns cached result for identical command within TTL", async () => {
    const key = makeKey();
    const summary = makeSummary();
    await writeCache(key, summary, 60_000, tmpDir);

    const result = await readCache(key, tmpDir);
    expect(result).not.toBeNull();
    expect(result?.tool).toBe("Bash");
    expect(result?.status).toBe("success");
  });

  it("returns null for missing cache entry", async () => {
    const key = makeKey();
    const result = await readCache(key, tmpDir);
    expect(result).toBeNull();
  });

  it("returns null after TTL expires", async () => {
    const key = makeKey();
    const summary = makeSummary();
    // Write with a 1ms TTL (already expired by the time we read)
    await writeCache(key, summary, 1, tmpDir);
    // Wait a bit to ensure TTL expires
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await readCache(key, tmpDir);
    expect(result).toBeNull();
  });

  it("different commands have different cache keys", async () => {
    const key1 = { commandHash: hashCommand("ls -la"), cwd: "/workspace", gitSha: "abc" };
    const key2 = { commandHash: hashCommand("git status"), cwd: "/workspace", gitSha: "abc" };
    const hash1 = computeCacheKeyHash(key1);
    const hash2 = computeCacheKeyHash(key2);
    expect(hash1).not.toBe(hash2);
  });

  it("same command different cwd has different cache key", async () => {
    const cmd = hashCommand("ls -la");
    const key1 = { commandHash: cmd, cwd: "/workspace/a", gitSha: "abc" };
    const key2 = { commandHash: cmd, cwd: "/workspace/b", gitSha: "abc" };
    expect(computeCacheKeyHash(key1)).not.toBe(computeCacheKeyHash(key2));
  });
});

describe("resolveTtlMs", () => {
  it("returns short TTL for volatile commands", () => {
    expect(resolveTtlMs("kubectl get pods -n production")).toBe(60_000);
    expect(resolveTtlMs("git status")).toBe(60_000);
    expect(resolveTtlMs("git diff")).toBe(60_000);
    expect(resolveTtlMs("docker ps")).toBe(60_000);
  });

  it("returns long TTL for stable commands", () => {
    expect(resolveTtlMs("cat package.json")).toBe(300_000);
    expect(resolveTtlMs("npm list --json")).toBe(300_000);
    expect(resolveTtlMs("terraform plan -out=tfplan")).toBe(300_000);
  });
});

describe("buildCacheKey", () => {
  it("returns a key with commandHash, cwd, and gitSha", async () => {
    const key = await buildCacheKey("ls -la", process.cwd());
    expect(key.commandHash).toHaveLength(16);
    expect(key.cwd).toBe(process.cwd());
    expect(typeof key.gitSha).toBe("string");
  });
});

describe("hashCommand", () => {
  it("produces consistent hashes", () => {
    const h1 = hashCommand("kubectl get pods");
    const h2 = hashCommand("kubectl get pods");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different commands", () => {
    expect(hashCommand("ls")).not.toBe(hashCommand("pwd"));
  });

  it("returns a 16-char hex string", () => {
    const h = hashCommand("test");
    expect(h).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });
});
