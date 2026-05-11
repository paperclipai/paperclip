import { writeFile } from "node:fs/promises";
import pc from "picocolors";
import type { PipelineResult, PipelineStats, ScoredOpportunity } from "../core/types.js";
import { SERVICE_CATEGORY_LABELS } from "../core/constants.js";

/**
 * Write scored opportunities to a JSON file.
 */
export async function writeJson(
  data: PipelineResult,
  filepath: string,
): Promise<void> {
  await writeFile(filepath, JSON.stringify(data, null, 2));
}

/**
 * Write separate CSV files for qualified and rejected opportunities.
 */
export async function writeQualifiedCsv(
  opportunities: ScoredOpportunity[],
  minScore: number,
  qualifiedPath: string,
  rejectedPath: string,
): Promise<void> {
  const qualified = opportunities.filter((o) => o.score >= minScore);
  const rejected = opportunities.filter((o) => o.score < minScore);
  await writeCsv(qualified, qualifiedPath);
  await writeCsv(rejected, rejectedPath);
}

/**
 * Write scored opportunities to a CSV file.
 */
export async function writeCsv(
  opportunities: ScoredOpportunity[],
  filepath: string,
): Promise<void> {
  const headers = [
    "Rank",
    "Score",
    "Title",
    "Agency",
    "State",
    "Value",
    "Annual Value",
    "Term (yrs)",
    "Due Date",
    "Pre-Bid",
    "Q&A Due",
    "Set-Aside",
    "Submission",
    "Contact Email",
    "Service Category",
    "NAICS",
    "Reasoning",
    "Disqualifiers",
    "ID",
    "URL",
  ];

  const rows = opportunities.map((opp, i) => [
    String(i + 1),
    String(opp.score),
    csvEscape(opp.title),
    csvEscape(opp.agency),
    opp.state ?? "",
    opp.estimatedValue ? `$${opp.estimatedValue.toLocaleString()}` : "",
    opp.extracted?.annualValue ? `$${opp.extracted.annualValue.toLocaleString()}` : "",
    opp.extracted?.contractTermYears ? String(opp.extracted.contractTermYears) : "",
    opp.dueDate ? new Date(opp.dueDate).toLocaleDateString() : "",
    opp.extracted?.prebidConferenceDate ?? "",
    opp.extracted?.questionsDueDate ?? "",
    csvEscape(opp.setAsideType ?? opp.extracted?.setAsideType ?? ""),
    csvEscape(opp.extracted?.submissionPortal ?? ""),
    csvEscape(opp.extracted?.primaryContactEmail ?? ""),
    SERVICE_CATEGORY_LABELS[opp.serviceCategory] ?? opp.serviceCategory,
    opp.naicsCode ?? "",
    csvEscape(opp.reasoning),
    csvEscape(opp.disqualifiers.join("; ")),
    opp.id,
    opp.sourceUrl ?? "",
  ]);

  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  await writeFile(filepath, csv);
}

/**
 * Print a summary of the pipeline run to the console.
 */
export function printSummary(result: PipelineResult): void {
  const { stats } = result;

  console.log("");
  console.log(pc.bold("Pipeline Run Summary"));
  console.log(pc.dim("─".repeat(50)));
  console.log(`  Fetched:       ${pc.cyan(String(stats.totalFetched))}`);
  console.log(`  After dedup:   ${pc.cyan(String(stats.afterDedup))}`);
  console.log(`  After filter:  ${pc.cyan(String(stats.afterHardFilter))}`);
  console.log(`  Scored:        ${pc.cyan(String(stats.scored))}`);
  console.log(
    `  Above threshold: ${pc.green(pc.bold(String(stats.aboveThreshold)))}`,
  );
  console.log(pc.dim("─".repeat(50)));
  console.log(
    `  API calls used: ${pc.yellow(String(stats.apiCallsUsed))} (HigherGov) / ${pc.yellow(String(stats.claudeCallsUsed))} (Claude)`,
  );
  console.log("");

  if (result.scored.length > 0) {
    console.log(pc.bold("Top Opportunities:"));
    console.log("");

    for (const opp of result.scored.slice(0, 10)) {
      const scoreColor =
        opp.score >= 80
          ? pc.green
          : opp.score >= 60
            ? pc.yellow
            : pc.red;

      console.log(
        `  ${scoreColor(pc.bold(String(opp.score).padStart(3)))}  ${opp.title.slice(0, 70)}`,
      );
      console.log(
        `       ${pc.dim(opp.agency)} | ${pc.dim(opp.state ?? "N/A")} | ${pc.dim(SERVICE_CATEGORY_LABELS[opp.serviceCategory] ?? opp.serviceCategory)}`,
      );
      if (opp.estimatedValue) {
        console.log(
          `       Value: ${pc.cyan(`$${opp.estimatedValue.toLocaleString()}`)} | Due: ${pc.cyan(opp.dueDate ? new Date(opp.dueDate).toLocaleDateString() : "N/A")}`,
        );
      }
      console.log(`       ${pc.dim(opp.reasoning)}`);
      if (opp.disqualifiers.length > 0) {
        console.log(
          `       ${pc.red("Flags: " + opp.disqualifiers.join(", "))}`,
        );
      }
      console.log("");
    }
  }
}

/**
 * Print quota information.
 */
export function printQuota(
  monthlyUsed: number,
  monthlyLimit: number,
  resetDate: string,
): void {
  const remaining = monthlyLimit - monthlyUsed;
  const pct = Math.round((monthlyUsed / monthlyLimit) * 100);

  console.log("");
  console.log(pc.bold("HigherGov API Quota"));
  console.log(pc.dim("─".repeat(50)));
  console.log(`  Used:      ${pc.yellow(String(monthlyUsed))} / ${monthlyLimit}`);
  console.log(`  Remaining: ${remaining > 1000 ? pc.green(String(remaining)) : pc.red(String(remaining))}`);
  console.log(`  Usage:     ${pct}%`);
  console.log(`  Resets:    ${new Date(resetDate).toLocaleDateString()}`);
  console.log("");
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
