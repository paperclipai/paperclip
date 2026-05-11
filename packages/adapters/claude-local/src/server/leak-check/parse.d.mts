export type ScanTarget =
  | { kind: "string"; source: string; value: string }
  | { kind: "file"; source: string; path: string }
  | { kind: "stdin"; source: string };

export interface ParsedShimRequest {
  command: "gh" | "git";
  subCommand: string | null;
  verb: string | null;
  scanTargets: ScanTarget[];
  hasAllowOverride: boolean;
  unsupported: boolean;
}

export function parseGhArgs(argv: readonly string[]): ParsedShimRequest;
export function parseGitArgs(argv: readonly string[]): ParsedShimRequest;
