export interface VitestRootConfigContext {
  sourceRoot: string;
  projects: string[];
  exclude: string[];
  alias: Record<string, string>;
}

export declare function resolveVitestSourceRoot(options?: {
  repoRoot?: string;
  fileExists?: (candidatePath: string) => boolean;
}): string;

export declare function resolveVitestRootConfigContext(options?: {
  repoRoot?: string;
  fileExists?: (candidatePath: string) => boolean;
}): VitestRootConfigContext;
