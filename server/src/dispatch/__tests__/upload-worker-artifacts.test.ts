/**
 * Phase 3.5 Step 2 -- `uploadWorkerArtifacts` unit tests.
 *
 * Uses a real temp directory and a fake `ArtifactUploadClient` injection
 * so there is no real HTTP and no dependency on env vars.
 *
 * Coverage:
 *   - Happy path: all files uploaded, result lists all in `uploaded`.
 *   - Empty dir: returns uploaded:[], failed:[], skipped:null.
 *   - Missing dir (ENOENT): returns skipped:{reason:'no-artifacts-dir'}.
 *   - Mixed: one file throws on upload, ends up in `failed`.
 *   - .partial files are skipped.
 *   - Hidden dotfiles are skipped.
 *   - Subdirectories are skipped.
 *   - Fake client receives correct requestId, stage, filename, body.
 *   - [Fix 3] file-too-large: file exceeding maxFileBytes ends in failed[].
 *   - [Fix 5] malformed JSON: invalid JSON body lands in failed[].
 *   - [Fix 6] cleanup: uploaded files deleted after all-success; intact when any failed.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArtifactUploadClient } from "../artifacts-client.js";
import { uploadWorkerArtifacts } from "../upload-worker-artifacts.js";

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

interface UploadCall {
  requestId: string;
  stage: string;
  filename: string;
  body: Buffer;
}

class FakeUploadClient implements ArtifactUploadClient {
  public readonly calls: UploadCall[] = [];
  constructor(private readonly throwFor: Set<string> = new Set()) {}

  async uploadArtifact(
    requestId: string,
    stage: string,
    filename: string,
    body: Buffer,
  ): Promise<void> {
    if (this.throwFor.has(filename)) {
      throw new Error(`fake upload error for ${filename}`);
    }
    this.calls.push({ requestId, stage, filename, body });
  }
}

const noopLogger = { warn: () => {} };

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

async function makeAgentHomeWithFiles(
  tmpRoot: string,
  files: Array<{ name: string; content: string | Buffer }>,
): Promise<string> {
  const agentHome = await fsp.mkdtemp(path.join(tmpRoot, "agent-home-"));
  const outDir = path.join(agentHome, "artifacts", "out");
  await fsp.mkdir(outDir, { recursive: true });
  for (const f of files) {
    await fsp.writeFile(
      path.join(outDir, f.name),
      typeof f.content === "string" ? f.content : f.content,
    );
  }
  return agentHome;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("uploadWorkerArtifacts", () => {
  let tmpRoot: string;
  const createdDirs: string[] = [];

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "upload-worker-artifacts-test-"));
    createdDirs.push(tmpRoot);
  });

  afterEach(async () => {
    for (const dir of createdDirs) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    createdDirs.length = 0;
  });

  it("happy path: uploads all files, returns them all in uploaded[]", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "research-bundle.json", content: '{"result":"ok"}' },
      { name: "insights.json", content: '{"key":"val"}' },
      { name: "notes.txt", content: "some notes" },
      { name: "logo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: "captions.srt", content: "1\n00:00:00,000 --> 00:00:01,000\nHello" },
    ]);
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-happy",
      stage: "research",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.skipped).toBeNull();
    expect(result.failed).toHaveLength(0);
    expect(result.uploaded).toHaveLength(5);
    expect(result.uploaded.sort()).toEqual([
      "captions.srt",
      "insights.json",
      "logo.png",
      "notes.txt",
      "research-bundle.json",
    ]);
    expect(client.calls).toHaveLength(5);
    // Check one call's requestId + stage forwarding.
    const jsonCall = client.calls.find((c) => c.filename === "research-bundle.json")!;
    expect(jsonCall.requestId).toBe("req-happy");
    expect(jsonCall.stage).toBe("research");
    expect(jsonCall.body.toString("utf-8")).toBe('{"result":"ok"}');
    // All succeeded -- cleanup should have run.
    expect(result.artifactsOutCleaned).toBe(true);
  });

  it("empty dir: returns uploaded:[], failed:[], skipped:null", async () => {
    const agentHome = await fsp.mkdtemp(path.join(tmpRoot, "agent-home-empty-"));
    const outDir = path.join(agentHome, "artifacts", "out");
    await fsp.mkdir(outDir, { recursive: true });
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-empty",
      stage: "strategy",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result).toEqual({ uploaded: [], failed: [], skipped: null, artifactsOutCleaned: false });
    expect(client.calls).toHaveLength(0);
  });

  it("missing dir (ENOENT): returns skipped:{reason:'no-artifacts-dir'}", async () => {
    const agentHome = await fsp.mkdtemp(path.join(tmpRoot, "agent-home-nodir-"));
    // Do NOT create artifacts/out; leave it absent.
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-nodir",
      stage: "copy",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.skipped).toEqual({ reason: "no-artifacts-dir" });
    expect(result.uploaded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(client.calls).toHaveLength(0);
  });

  it("mixed: 3 files, client throws on bad.mp4, result has 2 uploaded + 1 failed", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "script.json", content: '{"script":"text"}' },
      { name: "good.mp4", content: Buffer.from([0x00, 0x01]) },
      { name: "bad.mp4", content: Buffer.from([0xff]) },
    ]);
    const client = new FakeUploadClient(new Set(["bad.mp4"]));

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-mixed",
      stage: "edit",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.skipped).toBeNull();
    expect(result.uploaded.sort()).toEqual(["good.mp4", "script.json"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].filename).toBe("bad.mp4");
    expect(result.failed[0].reason).toContain("fake upload error");
  });

  it("skips .partial files", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "output.mp4", content: Buffer.from([0x00]) },
      { name: "output.mp4.partial", content: Buffer.from([0x01]) },
    ]);
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-partial",
      stage: "edit",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.uploaded).toEqual(["output.mp4"]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].filename).toBe("output.mp4");
  });

  it("skips hidden dotfiles", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "visible.json", content: "{}" },
      { name: ".hidden", content: "secret" },
      { name: ".DS_Store", content: "mac cruft" },
    ]);
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-hidden",
      stage: "research",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.uploaded).toEqual(["visible.json"]);
    expect(client.calls).toHaveLength(1);
  });

  it("skips non-file directory entries (subdirectories)", async () => {
    const agentHome = await fsp.mkdtemp(path.join(tmpRoot, "agent-home-subdir-"));
    const outDir = path.join(agentHome, "artifacts", "out");
    await fsp.mkdir(outDir, { recursive: true });
    // Create a file and a subdirectory.
    await fsp.writeFile(path.join(outDir, "real.json"), "{}");
    await fsp.mkdir(path.join(outDir, "subdir"), { recursive: true });
    await fsp.writeFile(path.join(outDir, "subdir", "nested.json"), "{}");

    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-subdir",
      stage: "research",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.uploaded).toEqual(["real.json"]);
    expect(client.calls).toHaveLength(1);
    // The nested file inside subdir should NOT be uploaded.
    expect(client.calls[0].filename).toBe("real.json");
  });

  // ---------------------------------------------------------------------------
  // Fix 3: file-size guard
  // ---------------------------------------------------------------------------

  it("[Fix 3] file exceeding maxFileBytes lands in failed[] with file-too-large reason", async () => {
    const agentHome = await fsp.mkdtemp(path.join(tmpRoot, "agent-home-toolarge-"));
    const outDir = path.join(agentHome, "artifacts", "out");
    await fsp.mkdir(outDir, { recursive: true });

    // Create a sparse file that appears to be 250 MB without allocating real
    // disk space: write an empty file then truncate it to the target size.
    const hugeFile = path.join(outDir, "huge.mp4");
    const fd = await fsp.open(hugeFile, "w");
    await fd.close();
    await fsp.truncate(hugeFile, 250 * 1024 * 1024);

    // Also add a small file that should still succeed.
    await fsp.writeFile(path.join(outDir, "small.json"), "{}");

    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-toolarge",
      stage: "edit",
      uploadClient: client,
      // Use 200 MB limit (the default; passing explicitly for clarity).
      maxFileBytes: 200 * 1024 * 1024,
      logger: noopLogger,
    });

    expect(result.skipped).toBeNull();
    // huge.mp4 must be in failed with a file-too-large reason.
    const failedEntry = result.failed.find((f) => f.filename === "huge.mp4");
    expect(failedEntry).toBeDefined();
    expect(failedEntry!.reason).toMatch(/file-too-large/i);
    // small.json should have succeeded.
    expect(result.uploaded).toContain("small.json");
    // Since one file failed, cleanup should NOT have run.
    expect(result.artifactsOutCleaned).toBe(false);
  });

  it("[Fix 3] file exactly at maxFileBytes is allowed through", async () => {
    const agentHome = await fsp.mkdtemp(path.join(tmpRoot, "agent-home-atcap-"));
    const outDir = path.join(agentHome, "artifacts", "out");
    await fsp.mkdir(outDir, { recursive: true });

    // Create a 10-byte file; set maxFileBytes = 10 (exactly at cap).
    await fsp.writeFile(path.join(outDir, "atcap.bin"), Buffer.alloc(10, 0x00));

    const client = new FakeUploadClient();
    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-atcap",
      stage: "copy",
      uploadClient: client,
      maxFileBytes: 10,
      logger: noopLogger,
    });

    expect(result.failed).toHaveLength(0);
    expect(result.uploaded).toContain("atcap.bin");
  });

  // ---------------------------------------------------------------------------
  // Fix 5: malformed JSON
  // ---------------------------------------------------------------------------

  it("[Fix 5] malformed JSON file body lands in failed[] with a clear reason", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "bad.json", content: "{not json" },
      { name: "good.json", content: '{"ok":true}' },
    ]);

    // The upload client will try to call uploadArtifact. For bad.json the
    // JSON parse inside httpArtifactUploadClient throws; our FakeUploadClient
    // does NOT parse, so to test the guard we need a client that simulates
    // the real JSON parse error. Inject a client that throws on bad.json.
    const client = new FakeUploadClient(new Set(["bad.json"]));
    // Override the throw to mimic a JSON parse error message.
    const uploadClientWithJsonError: import("../artifacts-client.js").ArtifactUploadClient = {
      async uploadArtifact(
        _requestId: string,
        _stage: string,
        filename: string,
        body: Buffer,
      ): Promise<void> {
        if (filename.endsWith(".json")) {
          // Simulate what httpArtifactUploadClient does: parse the body.
          JSON.parse(body.toString("utf-8"));
        }
        client.calls.push({ requestId: _requestId, stage: _stage, filename, body });
      },
    };

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-badjson",
      stage: "copy",
      uploadClient: uploadClientWithJsonError,
      logger: noopLogger,
    });

    // bad.json should appear in failed with a parse-related reason.
    const failedEntry = result.failed.find((f) => f.filename === "bad.json");
    expect(failedEntry).toBeDefined();
    // The error message comes from JSON.parse; it always mentions parsing.
    expect(failedEntry!.reason).toBeTruthy();
    // good.json should have succeeded.
    expect(result.uploaded).toContain("good.json");
    // One file failed -- cleanup should NOT have run.
    expect(result.artifactsOutCleaned).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Fix 6: post-upload cleanup
  // ---------------------------------------------------------------------------

  it("[Fix 6] all-success: uploaded files are deleted from artifacts/out/ after upload", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "file1.json", content: '{"a":1}' },
      { name: "file2.txt", content: "hello" },
      { name: "file3.mp4", content: Buffer.from([0x00, 0x01]) },
    ]);
    const outDir = path.join(agentHome, "artifacts", "out");
    const client = new FakeUploadClient();

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-cleanup",
      stage: "edit",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.uploaded.sort()).toEqual(["file1.json", "file2.txt", "file3.mp4"]);
    expect(result.failed).toHaveLength(0);
    expect(result.artifactsOutCleaned).toBe(true);

    // Verify all three files are gone from artifacts/out/.
    for (const filename of ["file1.json", "file2.txt", "file3.mp4"]) {
      await expect(fsp.access(path.join(outDir, filename))).rejects.toThrow();
    }
  });

  it("[Fix 6] any-failed: artifacts/out/ dir is left intact when a file failed", async () => {
    const agentHome = await makeAgentHomeWithFiles(tmpRoot, [
      { name: "ok.json", content: '{"ok":true}' },
      { name: "fail.mp4", content: Buffer.from([0xff]) },
    ]);
    const outDir = path.join(agentHome, "artifacts", "out");
    const client = new FakeUploadClient(new Set(["fail.mp4"]));

    const result = await uploadWorkerArtifacts({
      agentHomeDir: agentHome,
      requestId: "req-cleanup-fail",
      stage: "edit",
      uploadClient: client,
      logger: noopLogger,
    });

    expect(result.uploaded).toContain("ok.json");
    expect(result.failed).toHaveLength(1);
    expect(result.artifactsOutCleaned).toBe(false);

    // ok.json should still be on disk (cleanup skipped because a file failed).
    await expect(fsp.access(path.join(outDir, "ok.json"))).resolves.toBeUndefined();
  });
});
