import { appendFileSync } from "node:fs";
/** Only fixture state; never provider transcripts or credentials. */
export function observe(scenario: string, variant: string, actual: unknown) {
  if (process.env.LIFECYCLE_BASELINE_OBSERVATIONS) {
    appendFileSync(
      process.env.LIFECYCLE_BASELINE_OBSERVATIONS,
      JSON.stringify({ scenario, variant, actual }) + "\n",
    );
  }
}
