import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(here, "../dist/ui/index.js");
const source = fs.readFileSync(bundlePath, "utf8");

const requiredExports = [
  "CkApprovalsPage",
  "CkCrmPage",
  "CkDivinoPage",
  "CkEvaluationPage",
  "CkMemoryPage",
  "MeetingRoomPage",
];

const relativeModulePattern =
  /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']\.{1,2}\//;

if (relativeModulePattern.test(source)) {
  throw new Error(
    "CK Office UI entry is not self-contained: a relative ESM import/export remains",
  );
}

for (const exportName of requiredExports) {
  if (!source.includes(exportName)) {
    throw new Error(`CK Office UI bundle is missing ${exportName}`);
  }
}

console.log(
  `verified self-contained CK Office UI bundle (${source.length} bytes, ${requiredExports.length} page exports)`,
);
