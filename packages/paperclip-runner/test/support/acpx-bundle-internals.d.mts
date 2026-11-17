export function acpxPackageRoot(): string;
export function acpxBundleChunks(names: readonly string[], root?: string): Promise<Map<string, { path: string; alias: string }>>;
// Internals are untyped bundle exports; callers narrow what they use.
export function acpxInternals(names: readonly string[], root?: string): Promise<Record<string, any>>;
export function acpxChunkSource(name: string, root?: string): Promise<string>;
