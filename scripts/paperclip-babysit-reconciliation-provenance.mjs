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
  if (!input?.sourceRevision || !input?.build || input.artifactBytes == null) {
    throw new TypeError("sourceRevision, build provenance, and retained artifact bytes are required");
  }
  const artifactBytes = Buffer.isBuffer(input.artifactBytes)
    ? input.artifactBytes
    : Buffer.from(input.artifactBytes);
  if (artifactBytes.length === 0 || !input.mediaType) {
    throw new TypeError("a non-empty artifact and mediaType are required");
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
    contentDigest: `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`,
  };
  return {
    ...artifact,
    sourceRevisionDigest: digest(sourceRevision),
    buildDigest: digest(build),
    artifactInstanceDigest: digest(artifact),
  };
}
