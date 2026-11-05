// Emits the feature-catalog.json release artifact the cloud harness imports
// per app release and validates feature writes against. The catalog content
// is derived from the instance-settings schema metadata in
// packages/shared/src/feature-catalog.ts.
//
// Usage:
//   tsx scripts/generate-feature-catalog.ts --version 2026.720.0 [--out path/to/feature-catalog.json]
//
// Without --out, the artifact is written to stdout.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { renderFeatureCatalogArtifact } from "../packages/shared/src/feature-catalog.js";

function usage(): never {
  console.error(
    "Usage: tsx scripts/generate-feature-catalog.ts --version <catalogVersion> [--out <file>]",
  );
  process.exit(1);
}

let version = "";
let outPath = "";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  switch (args[i]) {
    case "--version":
      version = args[++i] ?? "";
      break;
    case "--out":
      outPath = args[++i] ?? "";
      break;
    case "-h":
    case "--help":
      usage();
      break;
    default:
      console.error(`Unknown argument: ${args[i]}`);
      usage();
  }
}

if (version.trim().length === 0) {
  console.error("Error: --version is required and must be non-empty.");
  usage();
}

const rendered = renderFeatureCatalogArtifact(version);

if (outPath) {
  const target = resolve(outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, rendered, "utf8");
  console.error(`Wrote feature catalog for version ${version} to ${target}`);
} else {
  process.stdout.write(rendered);
}
