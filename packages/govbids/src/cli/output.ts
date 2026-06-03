import { writeFile } from "node:fs/promises";
import pc from "picocolors";
import ExcelJS from "exceljs";
import type {
  PipelineResult,
  PipelineStats,
  ScoredOpportunity,
  ServiceCategory,
} from "../core/types.js";
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

// ── Shared lawyer-output helpers ────────────────────────────────────

// US-5: all core implementation categories are GREEN-promotion eligible, not just
// MSP/cyber. A well-scoped engagement (serviceAlignment >=35) in any of these is a
// top opportunity even when the contract value is unstated (which deflates total
// score). Website/CMS work can't reach this band — it scores <=14 alignment by the
// scoring-prompt rule — so promotion doesn't undo the website down-rank.
const CORE_PROMOTION_CATEGORIES: ServiceCategory[] = [
  "managed-it",
  "cybersecurity",
  "erp",
  "cloud",
  "ai-data",
  "app-dev",
];

/**
 * Tier with core-category promotion: a strong service-alignment (>=35/40) in a
 * core category and no real disqualifier is GREEN regardless of value-fit
 * deductions.
 */
export function tierOf(opp: ScoredOpportunity): "GREEN" | "YELLOW" | "AMBER" {
  // Promote to GREEN only when alignment is strong AND the total score is already
  // YELLOW-grade (>=70). This keeps GREEN meaningful ("pursue first") — a strong-
  // alignment row that the value/readiness factors drag into AMBER (50-69) is NOT
  // auto-promoted. The Redwood-style well-scoped implementation (score ~75) gets
  // GREEN; a marginal AMBER license renewal does not.
  const promotable =
    CORE_PROMOTION_CATEGORIES.includes(opp.serviceCategory) &&
    opp.scoreBreakdown.serviceAlignment >= 35 &&
    opp.score >= 70 &&
    (opp.disqualifiers?.length ?? 0) === 0;
  if (promotable || opp.score >= 80) return "GREEN";
  if (opp.score >= 70) return "YELLOW";
  return "AMBER";
}

/** Human relative-day phrase vs `today` (e.g. "Tomorrow", "3 days", "2 days ago"). */
function relativeDays(target: Date, today: Date): string {
  const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diff < 0) return `${Math.abs(diff)} days ago`;
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return `${diff} days`;
}

function valueOf(opp: ScoredOpportunity): string {
  if (opp.extracted?.annualValue)
    return `$${opp.extracted.annualValue.toLocaleString()}/yr`;
  if (opp.estimatedValue) return `$${opp.estimatedValue.toLocaleString()}`;
  return "Not specified";
}

/** Sort freshest-first by agency release (postedDate); nulls sink to the bottom. */
function sortByReleasedDesc(opps: ScoredOpportunity[]): ScoredOpportunity[] {
  return [...opps].sort((a, b) => {
    const pa = a.postedDate ? new Date(a.postedDate).getTime() : 0;
    const pb = b.postedDate ? new Date(b.postedDate).getTime() : 0;
    return pb - pa;
  });
}

/**
 * Lawyer-friendly CSV: plain-English columns including agency release date
 * and staleness, sorted freshest-first. Drops technical fields.
 */
export async function writeLawyerCsv(
  opportunities: ScoredOpportunity[],
  filepath: string,
): Promise<void> {
  const headers = [
    "Rank",
    "Score",
    "Tier",
    "Title",
    "Agency",
    "State",
    "Estimated Value",
    "Released",
    "Days Since Released",
    "Due Date",
    "Days Until Due",
    "Submission Method",
    "Why It Matched",
    "Concerns",
    "Link",
  ];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sorted = sortByReleasedDesc(opportunities);
  const rows = sorted.map((opp, i) => {
    const dueDate = opp.dueDate ? new Date(opp.dueDate) : null;
    const releasedDate = opp.postedDate ? new Date(opp.postedDate) : null;
    return [
      String(i + 1),
      String(opp.score),
      tierOf(opp),
      csvEscape(opp.title),
      csvEscape(opp.agency),
      opp.state ?? "",
      csvEscape(valueOf(opp)),
      releasedDate ? releasedDate.toLocaleDateString("en-US") : "",
      releasedDate ? relativeDays(releasedDate, today) : "",
      dueDate ? dueDate.toLocaleDateString("en-US") : "",
      dueDate ? relativeDays(dueDate, today) : "",
      csvEscape(opp.extracted?.submissionPortal ?? ""),
      csvEscape(opp.reasoning),
      csvEscape(opp.disqualifiers.join("; ")),
      opp.sourceUrl ?? "",
    ];
  });

  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  await writeFile(filepath, csv);
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

/**
 * Lawyer-friendly Excel (.xlsx) workbook with formatting:
 *   - Frozen header row (bold, gray background)
 *   - Auto-filter on the header
 *   - Tier cell colored by value (GREEN/YELLOW/AMBER) with white bold text
 *   - Link column rendered as a clickable "Open RFP" hyperlink
 *   - Sized columns + wrap text on long-form fields
 *
 * Tier promotion for clear MSP/IT-Services/Cybersecurity bids matches the
 * rule in writeLawyerCsv.
 */
const TIER_COLORS: Record<string, { bg: string; fg: string }> = {
  GREEN: { bg: "FF00B050", fg: "FFFFFFFF" },
  YELLOW: { bg: "FFFFC000", fg: "FF1F1F1F" },
  AMBER: { bg: "FFC65911", fg: "FFFFFFFF" },
};

/** Populate one worksheet (used for both the main sheet and the Addenda tab). */
function populateLawyerSheet(
  ws: ExcelJS.Worksheet,
  opportunities: ScoredOpportunity[],
  today: Date,
): void {
  ws.columns = [
    { header: "Rank", key: "rank", width: 6 },
    { header: "Score", key: "score", width: 8 },
    { header: "Tier", key: "tier", width: 10 },
    { header: "Title", key: "title", width: 55 },
    { header: "Agency", key: "agency", width: 34 },
    { header: "State", key: "state", width: 8 },
    { header: "Estimated Value", key: "value", width: 18 },
    { header: "Released", key: "released", width: 12 },
    { header: "Days Since Released", key: "age", width: 16 },
    { header: "Due Date", key: "due", width: 12 },
    { header: "Days Until Due", key: "days", width: 14 },
    { header: "Submission Method", key: "method", width: 18 },
    { header: "Why It Matched", key: "why", width: 55 },
    { header: "Concerns", key: "concerns", width: 32 },
    { header: "Link", key: "link", width: 14 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FF1F1F1F" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE8E8E8" },
  };
  headerRow.alignment = { vertical: "middle", horizontal: "left" };
  headerRow.height = 22;

  const sorted = sortByReleasedDesc(opportunities);
  for (let i = 0; i < sorted.length; i++) {
    const opp = sorted[i];
    const tier = tierOf(opp);
    const dueDate = opp.dueDate ? new Date(opp.dueDate) : null;
    const releasedDate = opp.postedDate ? new Date(opp.postedDate) : null;

    const row = ws.addRow({
      rank: i + 1,
      score: opp.score,
      tier,
      title: opp.title,
      agency: opp.agency,
      state: opp.state ?? "",
      value: valueOf(opp),
      released: releasedDate ?? "",
      age: releasedDate ? relativeDays(releasedDate, today) : "",
      due: dueDate ?? "",
      days: dueDate ? relativeDays(dueDate, today) : "",
      method: opp.extracted?.submissionPortal ?? "",
      why: opp.reasoning,
      concerns: opp.disqualifiers.join("; "),
      link: opp.sourceUrl
        ? { text: "Open RFP", hyperlink: opp.sourceUrl }
        : "",
    });

    const tierCell = row.getCell("tier");
    const colors = TIER_COLORS[tier];
    tierCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: colors.bg },
    };
    tierCell.font = { bold: true, color: { argb: colors.fg } };
    tierCell.alignment = { horizontal: "center", vertical: "middle" };

    if (dueDate) row.getCell("due").numFmt = "m/d/yyyy";
    if (releasedDate) row.getCell("released").numFmt = "m/d/yyyy";

    if (opp.sourceUrl) {
      row.getCell("link").font = {
        color: { argb: "FF0563C1" },
        underline: true,
      };
    }

    row.getCell("rank").alignment = { horizontal: "center" };
    row.getCell("score").alignment = { horizontal: "center" };
    row.getCell("state").alignment = { horizontal: "center" };
    row.getCell("age").alignment = { horizontal: "center" };
    row.getCell("days").alignment = { horizontal: "center" };
  }

  for (const colKey of ["title", "agency", "why", "concerns"] as const) {
    ws.getColumn(colKey).alignment = { wrapText: true, vertical: "top" };
  }

  const lastCol = String.fromCharCode(64 + ws.columns.length);
  ws.autoFilter = { from: "A1", to: `${lastCol}${sorted.length + 1}` };
  ws.views = [{ state: "frozen", ySplit: 1, zoomScale: 100 }];
}

/**
 * Lawyer-friendly Excel workbook. Main "Qualified RFPs" sheet plus an optional
 * "Addenda & Updates" sheet for re-posts / deadline changes so they don't
 * inflate the new-RFP count. Both sheets: frozen header, auto-filter,
 * color-coded tier, clickable links, freshness columns, sorted newest-first.
 */
export async function writeLawyerXlsx(
  opportunities: ScoredOpportunity[],
  filepath: string,
  addenda: ScoredOpportunity[] = [],
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "govbids daily";
  wb.created = new Date();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const main = wb.addWorksheet("Qualified RFPs", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  populateLawyerSheet(main, opportunities, today);

  if (addenda.length > 0) {
    const addendaSheet = wb.addWorksheet("Addenda & Updates", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    populateLawyerSheet(addendaSheet, addenda, today);
  }

  await wb.xlsx.writeFile(filepath);
}
