import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { retainPreparedSourceSdk } from "./source-sdk-evidence.js";

export async function prepareSourceServerDependencies(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  installed: boolean,
  evidence?: { temporaryRoot: string; executionIds: readonly string[]; sourceRevision: string | null },
) {
  if (installed) return;
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, "scripts/ensure-plugin-build-deps.mjs")], {
    cwd: repositoryRoot,
    env: environment,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (evidence) await retainPreparedSourceSdk({ repositoryRoot, ...evidence, installed });
}
