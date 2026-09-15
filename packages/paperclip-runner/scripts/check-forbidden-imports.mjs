import {
  checkForbiddenImports,
  formatForbiddenImportViolation,
} from "./lib/forbidden-imports.mjs";

const violations = await checkForbiddenImports();
if (violations.length > 0) {
  process.stderr.write(
    `Standalone boundary check failed:\n${violations
      .map((violation) => `- ${formatForbiddenImportViolation(violation)}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Standalone boundary check passed.\n");
}
