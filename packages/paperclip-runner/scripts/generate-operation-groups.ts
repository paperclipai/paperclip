import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderOperationGroupsDocument } from "../src/catalog/operation-groups-doc.js";
import {
  loadOperationGroupsInput,
  operationGroupsPackageRoot,
} from "../src/catalog/operation-groups-inputs.js";

const outputPath = resolve(
  operationGroupsPackageRoot(),
  "spec/paperclip-agent-operation-groups.md",
);
const generated = renderOperationGroupsDocument(loadOperationGroupsInput());
const check = process.argv.includes("--check");

if (check) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== generated) {
    throw new Error(
      "paperclip-agent-operation-groups.md is stale; run the generator without --check.",
    );
  }
  process.stdout.write("operation-groups spec is current\n");
} else {
  writeFileSync(outputPath, generated);
  process.stdout.write(`wrote ${outputPath}\n`);
}
