export interface AgentFileManifestEntry { kind: "dir" | "file"; size?: number; mode?: number; hash?: string; stamp?: string }
export interface AgentFileManifest { version?: number; entries: Array<[string, AgentFileManifestEntry]>; totalBytes?: number }
export interface AgentFileCheckpointStats { hashedBytes: number; copiedBytes: number; copiedFiles: number; scannedEntries: number }
export function checkpointPath(name: string): string;
export function captureAgentFiles(root: string, previous?: AgentFileManifest, output?: string, enforceLimits?: boolean, excludeTransportRuntime?: boolean): Promise<{ manifest: AgentFileManifest; stats: AgentFileCheckpointStats }>;
