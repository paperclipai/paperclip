import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createBabysitterArtifactInstance } from "./paperclip-babysit-reconciliation-provenance.mjs";

const reviewedSourcePath = "server/src/services/recovery/service.ts";
const retainedBuildOutputPath = "server/dist/services/recovery/service.js";
execFileSync("pnpm", ["--filter", "@paperclipai/server", "build"], { stdio: "inherit" });
const reviewedSourceBytes = readFileSync(reviewedSourcePath);
// Read the retained output emitted by the real server BuildExecution. The
// ArtifactInstance must describe deployable runtime bytes, not synthetic data
// derived from a source file or a test-only script.
const retainedBuildOutputBytes = readFileSync(retainedBuildOutputPath);
const input = {
  sourceRevision: {
    repository: "paperclipai/paperclip",
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
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
};

describe("babysitter artifact provenance", () => {
  it("records source, build, and immutable ArtifactInstance digests", () => {
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
});
