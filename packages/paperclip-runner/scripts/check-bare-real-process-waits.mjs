import {
  checkBareRealProcessWaits,
  formatBareRealProcessWaitViolation,
} from "./lib/bare-real-process-wait.mjs";

const violations = await checkBareRealProcessWaits();
if (violations.length > 0) {
  process.stderr.write(
    `Bare real-process wait check failed:\n${violations
      .map((violation) => `- ${formatBareRealProcessWaitViolation(violation)}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Bare real-process wait check passed.\n");
}
