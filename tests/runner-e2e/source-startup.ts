import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export async function prepareSourceServerDependencies(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  installed: boolean,
) {
  if (installed) return;
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, "scripts/ensure-plugin-build-deps.mjs")], {
    cwd: repositoryRoot,
    env: environment,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}
