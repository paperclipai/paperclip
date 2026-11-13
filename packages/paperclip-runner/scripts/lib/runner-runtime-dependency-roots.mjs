import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

/** Seed every installed runtime root before traversing its dependency graph. */
export async function collectRunnerRuntimeDependencyRoots(runnerRoot) {
  const manifest = JSON.parse(await readFile(resolve(runnerRoot, "package.json"), "utf8"));
  const required = manifest.dependencies ?? {};
  const optional = manifest.optionalDependencies ?? {};
  const roots = [];
  for (const dependencyName of Object.keys({ ...required, ...optional }).sort()) {
    let packageRoot;
    try {
      packageRoot = await realpath(resolve(runnerRoot, "node_modules", dependencyName));
    } catch (error) {
      // Platform-filtered optional packages may be absent. Malformed installed
      // roots and required dependencies must still fail the distribution check.
      if (!Object.hasOwn(required, dependencyName) && Object.hasOwn(optional, dependencyName) && error?.code === "ENOENT") continue;
      throw error;
    }
    roots.push({ dependencyName, packageRoot });
  }
  return roots;
}
