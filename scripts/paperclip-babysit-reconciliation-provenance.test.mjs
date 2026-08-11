import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createBabysitterArtifactInstance } from "./paperclip-babysit-reconciliation-provenance.mjs";

const reviewedSourcePath = "scripts/paperclip-babysit-reconciliation.mjs";
const reviewedSourceBytes = readFileSync(reviewedSourcePath);
// Simulate the retained output emitted by the BuildExecution, rather than
// treating the source file itself as the deployable ArtifactInstance.
const retainedBuildOutputBytes = Buffer.from(`built:${reviewedSourceBytes.toString("base64")}`);
const input = {
  sourceRevision: {
    repository: "paperclipai/paperclip",
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    path: reviewedSourcePath,
  },
  build: { tool: process.execPath, version: process.versions.node, inputsDigest: `sha256:${createHash("sha256").update(readFileSync("package.json")).digest("hex")}` },
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
    const reread = createBabysitterArtifactInstance({ ...input, sourceBytes: Buffer.from("source re-read") });
    expect(reread.contentDigest).toBe(original.contentDigest);
    expect(reread.artifactInstanceDigest).not.toBe(original.artifactInstanceDigest);
  });
});
