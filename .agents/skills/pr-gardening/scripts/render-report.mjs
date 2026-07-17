#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs, readJson } from "./lib.mjs";

const LABELS = { high: "High", medium: "Medium", low: "Low" };

function issueLabel(issue) {
  if (!issue) return "No originating issue";
  return issue.identifier ? `${issue.identifier} (${issue.status})` : `${issue.issueId} (${issue.status})`;
}

function reasonText(entry) {
  if (entry.reasons.length === 0) return "All mechanical readiness gates passed.";
  return entry.reasons.map((entryReason) => entryReason.message).join("; ");
}

export function renderReport(readiness) {
  const lines = [
    "# PR Gardening Report",
    "",
    `Repository: \`${readiness.repository}\`  `,
    `Generated: ${readiness.generatedAt}  `,
    `Head-SHA verification: every verdict below was computed from the recorded current head SHA.`,
    "",
    `Summary: **${readiness.summary.ready} ready**, **${readiness.summary.needsGardening} need gardening**, **${readiness.summary.reportOnly} report-only drafts**.`,
    "",
  ];

  for (const confidence of ["high", "medium", "low"]) {
    const entries = readiness.pullRequests.filter((entry) => entry.confidence === confidence && entry.state === "open");
    lines.push(`## ${LABELS[confidence]} Confidence`, "");
    if (entries.length === 0) {
      lines.push("_None._", "");
      continue;
    }
    for (const entry of entries) {
      const draft = entry.isDraft ? " — draft (report only)" : "";
      lines.push(
        `### [#${entry.number}](${entry.url}) — ${entry.title}${draft}`,
        "",
        `- Verdict: \`${entry.verdict}\``,
        `- Head: \`${entry.headSha}\``,
        `- Originating issue: ${issueLabel(entry.originatingIssue)}`,
        `- Checks: ${entry.checks.checks.length - entry.checks.pending.length - entry.checks.failing.length} green, ${entry.checks.pending.length} pending, ${entry.checks.failing.length} failing`,
        `- Greptile: ${entry.greptile.clean ? "clean" : entry.greptile.present ? "not clean/current" : "missing"}`,
        `- Base distance: ${entry.behindBy} commit(s) behind \`${entry.baseRefName}\``,
        `- Reasons: ${reasonText(entry)}`,
        "",
      );
    }
  }

  lines.push(
    "## Guardrail",
    "",
    "This report is advisory. The gardening workflow never merges, approves, or closes pull requests and never instructs anyone to merge them.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2), { input: "readiness.json", output: "gardening-report.md" });
  const report = renderReport(readJson(options.input));
  if (options.output === "-") process.stdout.write(report);
  else writeFileSync(options.output, report);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
