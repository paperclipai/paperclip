import { lstatSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const PRECONFIGURED_HOME_ENV = "PAPERCLIP_RUNNER_HOME_MODE";
export const PRECONFIGURED_HOME_KEYS = [
  "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
] as const;

export function usesPreconfiguredHome(environment: NodeJS.ProcessEnv | undefined): boolean {
  return environment?.[PRECONFIGURED_HOME_ENV] === "preconfigured";
}

/** A prepared harness home changes storage lifetime, never the execution's permission policy. */
export function preparedHarnessHome(environment: NodeJS.ProcessEnv | undefined, agent: string): string | null {
  const directory = environment?.PAPERCLIP_RUNNER_PREPARED_HARNESS_HOME;
  if (directory === undefined) return null;
  if (agent !== "claude" || !isAbsolute(directory) || /[\0\r\n]/.test(directory)
    || resolve(directory) !== directory
    || !lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) {
    throw new Error("prepared_harness_home_invalid");
  }
  return directory;
}

/** Resolve on the execution machine; never create or change a user's directory. */
export function preconfiguredHomeEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = source.HOME ?? userInfo().homedir;
  const result: Record<string, string> = { HOME: home };
  for (const key of PRECONFIGURED_HOME_KEYS) {
    const value = key === "CLAUDE_CONFIG_DIR" && source.PAPERCLIP_RUNNER_PREPARED_HARNESS_HOME !== undefined
      ? source.PAPERCLIP_RUNNER_PREPARED_HARNESS_HOME : source[key];
    if (value !== undefined) result[key] = value;
  }
  for (const value of Object.values(result)) {
    if (!isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error("preconfigured_home_invalid");
  }
  if (!statSync(home).isDirectory()) throw new Error("preconfigured_home_unavailable");
  result.HOME = realpathSync(home);
  return result;
}

export function preconfiguredCodexHome(source: NodeJS.ProcessEnv = process.env): string {
  return source.CODEX_HOME ?? join(source.HOME ?? userInfo().homedir, ".codex");
}
