import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const serverRoot = fileURLToPath(new URL("../", import.meta.url));

function compilerInputs(args) {
  const result = spawnSync(process.execPath, ["../scripts/run-tsc.mjs", ...args, "--listFilesOnly"], {
    cwd: serverRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout.split(/\r?\n/).filter((file) => file.startsWith(path.join(serverRoot, "src", path.sep)));
}

it("omits co-located tests from the build while retaining source typecheck coverage", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const command = scripts.build.split("&&").map((part) => part.trim())
    .find((part) => part.startsWith("node ../scripts/run-tsc.mjs"));
  expect(command).toBeDefined();
  const production = compilerInputs(command.split(/\s+/).slice(2));
  const source = compilerInputs(["-p", "tsconfig.json"]);
  const isTest = (file) => /\.test\.tsx?$/.test(file);

  expect(source.filter(isTest).length).toBeGreaterThan(0);
  expect(production.filter(isTest)).toEqual([]);
  const productionFiles = new Set(production);
  const testTree = path.join(serverRoot, "src", "__tests__", path.sep);
  expect(source.filter((file) => !isTest(file) && !file.startsWith(testTree) && !productionFiles.has(file))).toEqual([]);
}, 60_000);
