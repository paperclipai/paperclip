// Type declarations for check-forbidden-tokens.mjs.
//
// The script doubles as a build-time check (invoked from prepublish) and a
// unit-tested module (server/src/__tests__/forbidden-tokens.test.ts). The
// declarations here mirror the public API so the test can import the named
// exports without an implicit-any TS7016 error.

import type { ExecSyncOptions } from "node:child_process";

// The script only ever reads `userInfo().username`, so the shim accepts any
// `{ userInfo(): { username: string } }` shape. This lets tests inject a
// minimal stub without satisfying the full `os.UserInfo<T>` type.
export interface ForbiddenTokenOsModule {
  userInfo(): { username: string };
}

export function resolveDynamicForbiddenTokens(
  env?: NodeJS.ProcessEnv,
  osModule?: ForbiddenTokenOsModule,
): string[];

export function readForbiddenTokensFile(tokensFile: string): string[];

export function resolveForbiddenTokens(
  tokensFile: string,
  env?: NodeJS.ProcessEnv,
  osModule?: ForbiddenTokenOsModule,
): string[];

export interface RunForbiddenTokenCheckInput {
  repoRoot: string;
  tokens: string[];
  exec?: (command: string, options?: ExecSyncOptions) => Buffer | string;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export function runForbiddenTokenCheck(input: RunForbiddenTokenCheckInput): 0 | 1;
