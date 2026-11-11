import { recorder } from "./record.mjs";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

recorder("profile")({ kind: "job", start: Date.now() });

if (process.env.PAPERCLIP_CI_PROFILE_JOB === "policy" && process.env.GITHUB_STEP_SUMMARY) {
  const key = `${process.env.GITHUB_REPOSITORY}:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`;
  const traceId = createHash("sha256").update(key).digest("hex").slice(0, 32);
  // This job does not know when the last parallel lane will finish. A bounded
  // search window includes queued jobs; the exporter writes the exact range.
  const now = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({ trace_id: traceId, trace_start_ts: String(now - 86400), trace_end_ts: String(now + 86400) });
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Full CI profile\n\n[Open the Honeycomb waterfall](https://ui.honeycomb.io/paperclip/environments/test/datasets/paperclip-ci/trace?${params})\n\n` +
    "The trace becomes available after this attempt completes and the CI profile exporter finishes. Keep the profile-ci label on the PR until then.\n");
}
