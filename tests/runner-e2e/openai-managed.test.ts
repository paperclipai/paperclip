import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { prepareOpenAiHostedFixture, readOpenAiHostedArtifact } from "./openai-managed-fixture.js";
import { runnerSuites } from "./catalog.js";
import { evaluateMatcher } from "./matchers.js";
it("checks binary contents rather than only their existence", async () => {
  const suite = runnerSuites.find((entry) => entry.id === "openai-managed-hosted")!;
  const matchers = suite.tasks[0]!.buildMatchers("nonce", {} as never);
  const matcher = matchers.find((entry) => entry.kind === "file_sha256")!;
  expect(matcher).toMatchObject({ path: "binary.bin" });
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  expect((await evaluateMatcher(matcher, { fileHashes: { "binary.bin": hash(Buffer.from([0,1,2,255])) } })).passed).toBe(true);
  expect((await evaluateMatcher(matcher, { fileHashes: { "binary.bin": hash(Buffer.from([0,1,2,254])) } })).passed).toBe(false);
  expect((await evaluateMatcher(matcher, { fileHashes: {} })).passed).toBe(false);
});
it("creates an isolated Git worktree with a committed input fixture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openai-e2e-fixture-"));
  try {
    const workspace = path.join(root, "workspace"); await mkdir(workspace);
    await prepareOpenAiHostedFixture(workspace);
    expect(await readFile(path.join(workspace, ".git"), "utf8")).toContain("gitdir:");
    expect(await readFile(path.join(workspace, "seed.txt"), "utf8")).toBe("OpenAI hosted fixture baseline\n");
    await expect(prepareOpenAiHostedFixture(workspace)).rejects.toThrow("empty disposable workspace");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("requires a matching run-bound downloadable hosted artifact, not just a claimed filename", async () => {
  const bytes = Buffer.from(JSON.stringify({ schema: "paperclip.openai-workspace-export.v1", entries: [] }));
  const attachment = { id: "attachment", issueId: "issue", originatingRunId: "run", originalFilename: "paperclip-workspace.json", contentType: "application/json", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const download = vi.fn().mockResolvedValue({ ok: () => true, body: async () => bytes });
  const list = vi.fn().mockResolvedValue([attachment]);
  const api = { get: list, request: { get: download } } as never;
  expect(await readOpenAiHostedArtifact(api, "issue", "run")).toMatchObject({ name: attachment.originalFilename, mimeType: "application/json", sha256: attachment.sha256 });
  expect(download).toHaveBeenCalledWith("/api/attachments/attachment/content?download=1");
  list.mockResolvedValue([{ ...attachment, originatingRunId: "other-run" }]);
  await expect(readOpenAiHostedArtifact(api, "issue", "run")).rejects.toThrow("observed 0");
  expect(download).toHaveBeenCalledTimes(1);
  list.mockResolvedValue([attachment]);
  download.mockResolvedValue({ ok: () => true, body: async () => Buffer.from("tampered") });
  await expect(readOpenAiHostedArtifact(api, "issue", "run")).rejects.toThrow("disagrees");
});
