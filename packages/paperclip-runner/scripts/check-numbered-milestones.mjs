import {
  checkNumberedMilestones,
  formatNumberedMilestoneViolation,
} from "./lib/numbered-milestones.mjs";

const violations = await checkNumberedMilestones();
if (violations.length > 0) {
  process.stderr.write(
    `Numbered milestone naming check failed:\n${violations
      .map((violation) => `- ${formatNumberedMilestoneViolation(violation)}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Numbered milestone naming check passed.\n");
}
