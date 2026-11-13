export function inspectNativeCompletionSourceMetadata(input: {
  repositoryRoot: string; sourceFiles: string[]; baseSha: string; variant: string;
  shallowParentAnchors?: Record<string, string>;
}): {
  sha: string | null; layering: boolean; immutable: boolean;
  sourceMetadata: unknown; sourceMetadataErrors: string[]; sourceMetadataFingerprint: string;
};
export function inspectNativeCompletionRunnerd(input: {
  repositoryRoot: string; sourceSha: string; sourceFingerprint: string; environment: NodeJS.ProcessEnv;
}): {
  passed: boolean; errors: string[]; [key: string]: unknown;
};
