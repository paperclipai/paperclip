import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import addFormats from "ajv-formats";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const schemaPath = path.join(rootDir, "bench.schema.json");

async function main() {
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  const validateTask = ajv.compile(schema.$defs.taskV1);
  const validateSuite = ajv.compile(schema.$defs.suiteV1);

  const manifestPaths = [
    ...(await collectYamlFiles(path.join(rootDir, "suites"))),
    ...(await collectYamlFiles(path.join(rootDir, "benchmarks"))),
  ];

  if (manifestPaths.length === 0) {
    throw new Error("No YAML manifests found to validate.");
  }

  let failures = 0;

  for (const manifestPath of manifestPaths) {
    const relativePath = path.relative(rootDir, manifestPath);
    const doc = YAML.parse(await fs.readFile(manifestPath, "utf8"));
    if (!doc || typeof doc !== "object") {
      console.error(`FAIL ${relativePath}: expected YAML object`);
      failures += 1;
      continue;
    }

    const schemaName = doc.schema;
    if (schemaName === "paperclip-bench/task/v1") {
      if (!validateTask(doc)) {
        console.error(formatErrors(relativePath, validateTask.errors ?? []));
        failures += 1;
        continue;
      }
      console.log(`OK   ${relativePath} (task)`);
      continue;
    }

    if (schemaName === "paperclip-bench/suite/v1") {
      if (!validateSuite(doc)) {
        console.error(formatErrors(relativePath, validateSuite.errors ?? []));
        failures += 1;
        continue;
      }
      console.log(`OK   ${relativePath} (suite)`);
      continue;
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${manifestPaths.length} manifest(s).`);
}

async function collectYamlFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectYamlFiles(entryPath)));
      continue;
    }
    if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
      files.push(entryPath);
    }
  }
  return files;
}

function formatErrors(relativePath, errors) {
  const lines = [`FAIL ${relativePath}`];
  for (const error of errors) {
    const instancePath = error.instancePath || "/";
    lines.push(`  - ${instancePath}: ${error.message}`);
  }
  return lines.join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
