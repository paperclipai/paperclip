import {
  checkTrackedImports,
  checkTrackedScriptEntryPoints,
  formatTrackedImportViolation,
} from "./lib/tracked-imports.mjs";

const violations = [
  ...(await checkTrackedImports()),
  ...(await checkTrackedScriptEntryPoints()),
];
if (violations.length > 0) {
  process.stderr.write(
    `Tracked import check failed:\n${violations
      .map((violation) => `- ${formatTrackedImportViolation(violation)}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Tracked import check passed.\n");
}
