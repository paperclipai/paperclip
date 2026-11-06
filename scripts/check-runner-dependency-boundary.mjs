import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Default workspace manifests and the resolved transitive closure stay vendor-free. */
export async function checkRunnerDependencyBoundary(root) {
  // Inspect dependency metadata, not model names or documentation. This also
  // catches aliases, third-party wrappers, and unscoped packages.
  const forbidden = /deep[-_]?seek/i;
  const violations = [];
  async function inspectManifest(file) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
        if (forbidden.test(`${name} ${specifier}`)) violations.push(`${file}: ${section}.${name}`);
      }
    }
  }
  await inspectManifest(join(root, "package.json"));
  for (const directory of ["packages", "packages/adapters", "packages/plugins", "packages/plugins/examples"]) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(root, directory, entry.name, "package.json");
      try { await inspectManifest(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  for (const directory of ["server", "ui", "cli"]) await inspectManifest(join(root, directory, "package.json"));
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  if (forbidden.test(lockfile)) violations.push("pnpm-lock.yaml: DeepSeek dependency in the default workspace closure");
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = await checkRunnerDependencyBoundary(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (violations.length) {
    process.stderr.write(`External harness dependency boundary failed:\n${violations.join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("Default workspace dependency closure excludes DeepSeek packages.\n");
}
