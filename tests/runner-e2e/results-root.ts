import { lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const RUNNER_E2E_RESULTS_ROOT = "PAPERCLIP_RUNNER_E2E_RESULTS_ROOT";

function contains(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export function resolveRunnerE2EResultsRoot(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment[RUNNER_E2E_RESULTS_ROOT];
  if (configured === undefined)
    return path.join(repositoryRoot, "tests/runner-e2e/results");
  if (!configured || configured.trim() !== configured || /[\u0000-\u001f]/u.test(configured)
    || !path.isAbsolute(configured) || path.normalize(configured) !== configured)
    throw new Error(`${RUNNER_E2E_RESULTS_ROOT} requires a normalized absolute directory`);
  const repository = path.resolve(repositoryRoot);
  if (path.dirname(configured) === configured || contains(configured, repository)
    || contains(repository, configured) || contains(configured, os.homedir()))
    throw new Error(`${RUNNER_E2E_RESULTS_ROOT} requires a dedicated directory outside the checkout and home roots`);

  let ancestor = configured;
  while (true) {
    try {
      const metadata = lstatSync(ancestor);
      if (!metadata.isDirectory() || realpathSync(ancestor) !== ancestor)
        throw new Error(`${RUNNER_E2E_RESULTS_ROOT} must not use files or symbolic-link paths`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  return configured;
}

export async function prepareRunnerE2ECampaignDirectory(resultsRoot: string, campaignId: string) {
  if (!/^[A-Za-z0-9_.-]+$/u.test(campaignId) || campaignId === "." || campaignId === "..")
    throw new Error("Runner E2E campaign requires one safe path segment");
  const directory = path.join(resultsRoot, campaignId);
  await assertRunnerE2EResultsPath(resultsRoot, directory);
  await mkdir(resultsRoot, { recursive: true, mode: 0o700 });
  await chmod(resultsRoot, 0o700);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertRunnerE2EResultsPath(resultsRoot, directory);
  return directory;
}

export async function assertRunnerE2EResultsPath(resultsRoot: string, directory: string) {
  if (!path.isAbsolute(resultsRoot) || path.normalize(resultsRoot) !== resultsRoot
    || !path.isAbsolute(directory) || path.normalize(directory) !== directory
    || directory === resultsRoot || !contains(resultsRoot, directory))
    throw new Error("Runner E2E output must remain beneath its results root");
  let ancestor = directory;
  while (true) {
    try {
      const metadata = await lstat(ancestor);
      if (!metadata.isDirectory() || await realpath(ancestor) !== ancestor)
        throw new Error("Runner E2E output must use physical directories without symbolic links");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
}
