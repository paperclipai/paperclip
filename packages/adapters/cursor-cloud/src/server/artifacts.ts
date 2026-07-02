import type { SDKArtifact } from "@cursor/sdk";

export type CursorCloudArtifactRef = {
  path: string;
  name?: string;
  sizeBytes?: number;
};

export function summarizeCursorArtifacts(artifacts: SDKArtifact[]): CursorCloudArtifactRef[] {
  return artifacts.map((artifact) => ({
    path: artifact.path,
    sizeBytes: artifact.sizeBytes,
  }));
}
