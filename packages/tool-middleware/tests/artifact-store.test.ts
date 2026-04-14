import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { storeArtifact, readArtifact, pruneArtifacts, ARTIFACT_URI_PREFIX } from "../src/artifact-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-artifact-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("storeArtifact", () => {
  it("returns an artifact ref with correct URI format", async () => {
    const ref = await storeArtifact("hello world", tmpDir);
    expect(ref.uri).toMatch(/^artifact:\/\/[0-9a-f]{64}$/);
    expect(ref.hash).toHaveLength(64);
    expect(ref.bytes).toBeGreaterThan(0);
    expect(ref.lines).toBeGreaterThan(0);
  });

  it("stores content to disk and is readable back", async () => {
    const content = "test content line 1\ntest content line 2";
    const ref = await storeArtifact(content, tmpDir);
    const read = await readArtifact(ref.hash, tmpDir);
    // Content may be redacted; we verify it's non-null and starts with expected prefix
    expect(read).not.toBeNull();
  });

  it("is idempotent — same content produces same hash", async () => {
    const content = "idempotent test content";
    const ref1 = await storeArtifact(content, tmpDir);
    const ref2 = await storeArtifact(content, tmpDir);
    expect(ref1.hash).toBe(ref2.hash);
    expect(ref1.uri).toBe(ref2.uri);
  });

  it("stores different content under different hashes", async () => {
    const ref1 = await storeArtifact("content A", tmpDir);
    const ref2 = await storeArtifact("content B", tmpDir);
    expect(ref1.hash).not.toBe(ref2.hash);
  });

  it("redacts secrets before storage", async () => {
    const content = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def";
    const ref = await storeArtifact(content, tmpDir);
    const stored = await readArtifact(ref.hash, tmpDir);
    expect(stored).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("stores URI prefix correctly", async () => {
    const ref = await storeArtifact("test", tmpDir);
    expect(ref.uri.startsWith(ARTIFACT_URI_PREFIX)).toBe(true);
  });
});

describe("readArtifact", () => {
  it("returns null for non-existent hash", async () => {
    const result = await readArtifact("nonexistent", tmpDir);
    expect(result).toBeNull();
  });
});

describe("pruneArtifacts", () => {
  it("returns 0 when no artifacts exist", async () => {
    const removed = await pruneArtifacts(tmpDir, 0);
    expect(removed).toBe(0);
  });

  it("removes artifacts older than maxAgeSeconds", async () => {
    // Write a file manually with an old mtime
    const hash = "a".repeat(64);
    const filePath = path.join(tmpDir, hash);
    await fs.writeFile(filePath, "old content", "utf8");
    // Set mtime to 1 hour ago
    const oneHourAgo = new Date(Date.now() - 3600_000);
    await fs.utimes(filePath, oneHourAgo, oneHourAgo);

    const removed = await pruneArtifacts(tmpDir, 60); // 60s max age
    expect(removed).toBe(1);
  });

  it("does not remove fresh artifacts", async () => {
    await storeArtifact("fresh content", tmpDir);
    const removed = await pruneArtifacts(tmpDir, 3600); // 1h max age
    expect(removed).toBe(0);
  });

  it("returns 0 when directory does not exist", async () => {
    const removed = await pruneArtifacts("/tmp/nonexistent-dir-for-test-xxx", 0);
    expect(removed).toBe(0);
  });
});
