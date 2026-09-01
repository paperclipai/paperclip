import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const runtimeIndex = await readFile(resolve(packageRoot, "src/index.ts"), "utf8");

const violations = [];
if (runnerManifest.exports?.["./testing"] === undefined) {
  violations.push("runner package must declare the ./testing export");
}
for (const privatePath of ["mock-core", "conformance", "scenarios", "src/tools", "./tools/"]) {
  if (runtimeIndex.includes(privatePath)) {
    violations.push(`runtime root must not export test/eval path: ${privatePath}`);
  }
}

const runtimeDependencyGroups = [
  runnerManifest.dependencies ?? {},
  runnerManifest.optionalDependencies ?? {},
  runnerManifest.peerDependencies ?? {},
];
for (const dependency of runtimeDependencyGroups.flatMap((group) => Object.keys(group))) {
  if (dependency.includes("eval")) {
    violations.push(`runner runtime must not depend on eval package: ${dependency}`);
  }
}
if (runnerManifest.dependencies?.ajv === undefined || runnerManifest.devDependencies?.ajv !== undefined) {
  violations.push("ajv must be declared as a runtime dependency because the public dispatcher imports it");
}

if (violations.length > 0) {
  process.stderr.write(`Package boundary check failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Package boundary check passed: runtime and testing ownership is acyclic.\n");
}
