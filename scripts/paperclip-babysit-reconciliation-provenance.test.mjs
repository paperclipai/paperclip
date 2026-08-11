import { describe, expect, it } from "vitest";
import { createBabysitterArtifactInstance } from "./paperclip-babysit-reconciliation-provenance.mjs";

const input = {
  sourceRevision: {
    repository: "paperclipai/paperclip",
    commit: "8b09fd3117be9d62908360802820649c206ce7e2",
    path: "scripts/paperclip-babysit-reconciliation.mjs",
  },
  build: { tool: "node", version: "22", inputsDigest: "sha256:inputs" },
  artifactBytes: Buffer.from("reviewed babysitter artifact"),
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
    expect(() => createBabysitterArtifactInstance({ ...input, artifactBytes: Buffer.alloc(0) })).toThrow();
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

  it("is content-addressed by retained artifact bytes", () => {
    const original = createBabysitterArtifactInstance(input);
    const changed = createBabysitterArtifactInstance({ ...input, artifactBytes: Buffer.from("different") });
    expect(changed.contentDigest).not.toBe(original.contentDigest);
    expect(changed.artifactInstanceDigest).not.toBe(original.artifactInstanceDigest);
  });
});
