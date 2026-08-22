import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createBabysitterArtifactInstance } from "./paperclip-babysit-reconciliation-provenance.mjs";

const reviewedSourcePath = "server/src/services/recovery/service.ts";
const retainedBuildOutputPath = "server/dist/services/recovery/service.js";
const manifestPath = "artifacts/babysitter-reconciliation/build-execution.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
execFileSync("pnpm", ["--filter", "@paperclipai/server", "build"], { stdio: "inherit" });
const reviewedSourceBytes = readFileSync(reviewedSourcePath);
const reviewedCommit = execFileSync("git", ["rev-parse", manifest.sourceRevision.commit], { encoding: "utf8" }).trim();
const reviewedTree = execFileSync("git", ["rev-parse", `${reviewedCommit}^{tree}`], { encoding: "utf8" }).trim();
const committedSourceBytes = execFileSync("git", ["show", `${reviewedCommit}:${reviewedSourcePath}`]);
// Read the retained output emitted by the real server BuildExecution. The
// ArtifactInstance must describe deployable runtime bytes, not synthetic data
// derived from a source file or a test-only script.
const retainedBuildOutputBytes = readFileSync(retainedBuildOutputPath);
const input = {
  sourceRevision: {
    repository: "paperclipai/paperclip",
    // The checked-in manifest records the reviewed source revision. Using the
    // mutable checkout HEAD here makes the manifest self-invalidating every
    // time this test or the manifest is committed after the reviewed build.
    commit: manifest.sourceRevision.commit,
    path: reviewedSourcePath,
  },
  build: {
    tool: "pnpm --filter @paperclipai/server build",
    version: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
    inputsDigest: `sha256:${createHash("sha256").update(Buffer.concat([
      readFileSync(reviewedSourcePath),
      readFileSync("server/tsconfig.json"),
      readFileSync("server/package.json"),
      readFileSync("pnpm-lock.yaml"),
    ])).digest("hex")}`,
  },
  sourceBytes: reviewedSourceBytes,
  buildOutputBytes: retainedBuildOutputBytes,
  mediaType: "application/javascript",
  contentPath: retainedBuildOutputPath,
  retention: {
    locator: "/api/attachments/92f92a99-87aa-49e9-9968-7a234595eada/content",
    mediaType: "application/javascript",
  },
  buildExecutionId: `build-eco-1123-${manifest.sourceRevision.commit}`,
};

describe("babysitter artifact provenance", () => {
  it("records source, build, and immutable ArtifactInstance digests", () => {
    expect(reviewedSourceBytes).toEqual(committedSourceBytes);
    const result = createBabysitterArtifactInstance(input);
    expect(result).toMatchObject({
      kind: "ArtifactInstance",
      sourceRevision: input.sourceRevision,
      build: input.build,
      mediaType: input.mediaType,
      contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      sourceContentDigest: `sha256:${createHash("sha256").update(reviewedSourceBytes).digest("hex")}`,
      contentDigest: `sha256:${createHash("sha256").update(retainedBuildOutputBytes).digest("hex")}`,
    });
    expect(result.sourceRevisionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.buildDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.artifactInstanceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes the ArtifactInstance digest when source or build provenance changes", () => {
    const original = createBabysitterArtifactInstance(input);
    const changed = createBabysitterArtifactInstance({
      ...input,
      build: { ...input.build, version: "23" },
    });
    expect(changed.artifactInstanceDigest).not.toBe(original.artifactInstanceDigest);
  });

  it("requires both lineage anchors", () => {
    expect(() => createBabysitterArtifactInstance({ sourceRevision: input.sourceRevision })).toThrow();
    expect(() => createBabysitterArtifactInstance({ build: input.build })).toThrow();
    expect(() => createBabysitterArtifactInstance({ ...input, buildOutputBytes: Buffer.alloc(0) })).toThrow();
    expect(() => createBabysitterArtifactInstance({ ...input, sourceBytes: Buffer.alloc(0) })).toThrow();
  });

  it("rejects placeholder source and build provenance", () => {
    for (const field of [
      ["sourceRevision", "commit"],
      ["sourceRevision", "path"],
      ["build", "tool"],
      ["build", "version"],
      ["build", "inputsDigest"],
    ]) {
      const [section, key] = field;
      const value = structuredClone(input);
      value[section][key] = "";
      expect(() => createBabysitterArtifactInstance(value)).toThrow();
    }
  });

  it("is content-addressed by retained BuildExecution output bytes", () => {
    const original = createBabysitterArtifactInstance(input);
    const changed = createBabysitterArtifactInstance({ ...input, buildOutputBytes: Buffer.from("different") });
    expect(changed.contentDigest).not.toBe(original.contentDigest);
    expect(changed.artifactInstanceDigest).not.toBe(original.artifactInstanceDigest);
  });

  it("keeps artifact identity stable when only the source bytes are re-read", () => {
    const original = createBabysitterArtifactInstance(input);
    const reread = createBabysitterArtifactInstance({ ...input, sourceBytes: readFileSync(reviewedSourcePath) });
    expect(reread.contentDigest).toBe(original.contentDigest);
    expect(reread.artifactInstanceDigest).toBe(original.artifactInstanceDigest);
  });

  it("verifies the checked-in manifest and links BuildExecution to retained attachments", () => {
    const result = createBabysitterArtifactInstance(input);
    expect(manifest.sourceRevision.commit).toBe(input.sourceRevision.commit);
    expect(manifest.reviewedTree).toBe(reviewedTree);
    expect(manifest.buildExecution.workflowRevision).toBe(reviewedCommit);
    expect(manifest.buildExecution.dependencyLockDigest).toBe(
      `sha256:${createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex")}`,
    );
    expect(manifest.sourceRevision.contentDigest).toBe(result.sourceContentDigest);
    expect(manifest.buildExecution.id).toBe(`build-eco-1123-${input.sourceRevision.commit}`);
    expect(manifest.buildExecution.inputsDigest).toBe(input.build.inputsDigest);
    expect(manifest.buildExecution.workflow).toBe("paperclip-babysitter-reconciliation");
    expect(manifest.buildExecution.inputs).toEqual([
      reviewedSourcePath,
      "server/tsconfig.json",
      "server/package.json",
      "pnpm-lock.yaml",
    ]);
    expect(manifest.buildExecution.environment).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      builder: "paperclip-local-build",
    });
    expect(manifest.buildExecution.executionIdentity).toBe(manifest.buildExecution.id);
    expect(manifest.artifactInstance).toMatchObject({
      kind: result.kind,
      sourceRevision: result.sourceRevision,
      build: result.build,
      mediaType: result.mediaType,
      buildExecutionId: result.buildExecutionId,
      sourceContentDigest: result.sourceContentDigest,
      contentDigest: result.contentDigest,
      contentPath: result.contentPath,
      contentLength: result.contentLength,
      retention: result.retention,
      sourceRevisionDigest: result.sourceRevisionDigest,
      buildDigest: result.buildDigest,
    });
    expect(manifest.artifactInstance.buildExecutionId).toBe(manifest.buildExecution.id);
    expect(manifest.artifactInstanceDigest).toBe(result.artifactInstanceDigest);
    expect(manifest.artifactInstance.contentPath).toBe(retainedBuildOutputPath);
    expect(manifest.artifactInstance.contentLength).toBe(retainedBuildOutputBytes.length);
    expect(manifest.artifactInstance.retention).toEqual({
      locator: "/api/attachments/92f92a99-87aa-49e9-9968-7a234595eada/content",
      mediaType: input.mediaType,
    });
    expect(manifest.retainedAttachments).toEqual([
      {
        id: "6be16e9d-8c4f-42c7-b7af-b43e08d6f35f",
        role: "source-revision",
        path: reviewedSourcePath,
        mediaType: "application/javascript",
        contentDigest: result.sourceContentDigest,
        buildExecutionId: manifest.buildExecution.id,
      },
      {
        id: "92f92a99-87aa-49e9-9968-7a234595eada",
        role: "build-output",
        path: retainedBuildOutputPath,
        mediaType: input.mediaType,
        contentDigest: result.contentDigest,
        buildExecutionId: manifest.buildExecution.id,
      },
    ]);
  });
});
