import { createHash } from "node:crypto";

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/**
 * Produces the immutable lineage record attached to a babysitter build.
 * The source revision and build inputs are explicit; the ArtifactInstance
 * digest is content-addressed and cannot be changed by later reconciliation.
 */
export function createBabysitterArtifactInstance(input) {
  if (!input?.sourceRevision || !input?.build || input.sourceBytes == null || input.buildOutputBytes == null) {
    throw new TypeError("sourceRevision, build provenance, source bytes, and retained build output bytes are required");
  }
  const sourceBytes = Buffer.isBuffer(input.sourceBytes) ? input.sourceBytes : Buffer.from(input.sourceBytes);
  const buildOutputBytes = Buffer.isBuffer(input.buildOutputBytes)
    ? input.buildOutputBytes
    : Buffer.from(input.buildOutputBytes);
  if (sourceBytes.length === 0 || buildOutputBytes.length === 0 || !input.mediaType) {
    throw new TypeError("non-empty source and retained build output bytes plus mediaType are required");
  }
  for (const [name, value] of [
    ["repository", input.sourceRevision.repository],
    ["commit", input.sourceRevision.commit],
    ["path", input.sourceRevision.path],
    ["tool", input.build.tool],
    ["version", input.build.version],
    ["inputsDigest", input.build.inputsDigest],
    ["mediaType", input.mediaType],
    ["buildExecutionId", input.buildExecutionId],
    ["contentPath", input.contentPath],
    ["retention.locator", input.retention?.locator],
    ["retention.mediaType", input.retention?.mediaType],
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`${name} provenance must be a non-empty string`);
    }
  }
  const sourceRevision = {
    repository: input.sourceRevision.repository,
    commit: input.sourceRevision.commit,
    path: input.sourceRevision.path,
  };
  const build = {
    tool: input.build.tool,
    version: input.build.version,
    inputsDigest: input.build.inputsDigest,
  };
  const artifact = {
    kind: "ArtifactInstance",
    sourceRevision,
    build,
    mediaType: input.mediaType,
    buildExecutionId: input.buildExecutionId,
    sourceContentDigest: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`,
    // ArtifactInstance identity is the retained BuildExecution output, not
    // the source bytes. This prevents a source-only digest from masquerading
    // as deployable artifact provenance.
    contentDigest: `sha256:${createHash("sha256").update(buildOutputBytes).digest("hex")}`,
    contentPath: input.contentPath,
    contentLength: buildOutputBytes.length,
    retention: {
      locator: input.retention.locator,
      mediaType: input.retention.mediaType,
    },
  };
  const sourceRevisionDigest = digest(sourceRevision);
  const buildDigest = digest(build);
  // Hash the complete persisted ArtifactInstance, including its lineage
  // anchors. The manifest stores this exact object, so hashing the partial
  // pre-anchor shape would permit a declared digest mismatch.
  const persistedArtifact = {
    kind: artifact.kind,
    sourceRevision: artifact.sourceRevision,
    build: artifact.build,
    mediaType: artifact.mediaType,
    buildExecutionId: artifact.buildExecutionId,
    sourceContentDigest: artifact.sourceContentDigest,
    contentDigest: artifact.contentDigest,
    sourceRevisionDigest,
    buildDigest,
    contentPath: artifact.contentPath,
    contentLength: artifact.contentLength,
    retention: artifact.retention,
  };
  return {
    ...persistedArtifact,
    artifactInstanceDigest: digest(persistedArtifact),
  };
}
