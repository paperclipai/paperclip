import { scenarios } from "./inventory.mjs";
export function summarize(laneResults) {
  return scenarios.map((scenario) => ({
    ...scenario,
    coverage: scenario.coverage.map((ref) => {
      const lane = laneResults[ref.lane];
      if (!lane) return { ...ref, status: "not_run", assertions: [] };
      const file = lane.testResults?.find((file) =>
        file.name.replaceAll("\\", "/").endsWith("/" + ref.file),
      );
      const assertions = (file?.assertionResults ?? []).filter((a) =>
        new RegExp(ref.pattern, "i").test(a.fullName),
      );
      const status =
        !file || assertions.length === 0
          ? "harness_evidence_failure"
          : assertions.some((a) => a.status === "failed")
            ? "assertion_failure"
            : assertions.some((a) => a.status !== "passed")
              ? "unavailable_prerequisite"
              : file.status === "failed" &&
                  !file.assertionResults.some((a) => a.status === "failed")
                ? "harness_evidence_failure"
                : "pass";
      return {
        ...ref,
        status,
        assertions: assertions.map((a) => ({
          name: a.fullName,
          status: a.status,
          duration: a.duration,
          failureMessages: a.failureMessages,
        })),
      };
    }),
    live: scenario.live.map((id) => ({ id, status: "not_run" })),
  }));
}
export function markdown(report) {
  const lines = [
    "# Lifecycle behavior baseline",
    "",
    `Source: \`${report.commit}\``,
    `Source/test fingerprint: \`${report.fingerprint}\``,
    `Measured: ${report.measuredAt}`,
    "",
    "This is a diagnostic baseline. Assertions express intended behavior; failures are not accepted product contracts. Live cells below are not measured by this command.",
    "",
    "| Scenario | Layer | Result | Assertions |",
    "|---|---|---|---|",
  ];
  for (const s of report.scenarios)
    for (const c of s.coverage)
      lines.push(
        `| ${s.id} ${s.name} | ${c.lane} | ${c.status} | ${c.assertions.length} |`,
      );
  lines.push(
    "",
    "## Executed assertions (unique per layer)",
    "",
    "| Layer | Total | Passed | Failed | Pending | Exit |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const [layer, e] of Object.entries(report.execution ?? {}))
    lines.push(
      `| ${layer} | ${e.total} | ${e.passed} | ${e.failed} | ${e.pending} | ${e.exitCode} |`,
    );
  lines.push("", "## Failures and unavailable coverage", "");
  for (const s of report.scenarios)
    for (const c of s.coverage.filter(
      (c) => !["pass", "not_run"].includes(c.status),
    )) {
      lines.push(`- ${s.id}: ${c.file} — ${c.status}`);
      for (const a of c.assertions.filter((a) => a.status !== "passed"))
        lines.push(`  - ${a.name}: ${a.status}`);
    }
  lines.push("", "## Live coverage (not run)", "");
  for (const id of new Set(
    report.scenarios.flatMap((s) => s.live.map((c) => c.id)),
  ))
    lines.push(`- ${id}`);
  lines.push(
    "",
    "Raw per-lane Vitest JSON and observation JSONL are retained beside this report. Skips and missing evidence never count as a pass. Assertion failures require triage before attributing them to product behavior rather than the harness.",
    "",
  );
  return lines.join("\n");
}
