/**
 * Report formatting for memory upgrade quality filter (TECH-8572).
 */

import type { FilterReport } from "./filter-contract.js";

export function formatFilterTextReport(report: FilterReport): string {
  const lines: string[] = [
    "=== Memory Upgrade Quality Filter Report ===",
    `Mode:                         ${report.isDryRun ? "DRY RUN (no files written; pass --confirm <company-id> to write output)" : "CONFIRMED (files written)"}`,
    `Company ID:                   ${report.companyId}`,
    `Agent ID:                     ${report.agentId}`,
    `Upgrade ID:                   ${report.upgradeId}`,
    `Input records:                ${report.inputRecordCount}`,
    `Kept records:                 ${report.keptCount}`,
    `Dropped deterministic:        ${report.droppedDeterministicCount}`,
    `Dropped classified:           ${report.droppedClassifiedCount}`,
  ];

  lines.push("Deterministic rule drops:");
  const ruleEntries = Object.entries(report.ruleCounts);
  if (ruleEntries.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [ruleId, count] of ruleEntries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  - ${ruleId}: ${count}`);
    }
  }

  lines.push("Classifier decisions by reason:");
  const reasonEntries = Object.entries(report.classifiedReasons);
  if (reasonEntries.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [reason, count] of reasonEntries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  - ${reason}: ${count}`);
    }
  }

  lines.push(`Projected worst-case cost:   $${report.projectedCostUsd.toFixed(4)} USD`);
  lines.push(`Actual model spend:          $${report.actualCostUsd.toFixed(4)} USD`);

  if (!report.isDryRun && report.outputJsonlPath && report.outputManifestPath) {
    lines.push("Files written:");
    lines.push(`  - Rewritten JSONL:          ${report.outputJsonlPath} (SHA-256: ${report.outputJsonlSha256})`);
    lines.push(`  - Rewritten Manifest:       ${report.outputManifestPath}`);
    lines.push(`  - Filter Metadata:          ${report.metadataPath}`);
    lines.push(`  - Audit Report (TXT):       ${report.auditTxtPath}`);
    lines.push(`  - Audit Report (JSON):      ${report.auditJsonPath}`);
  }

  return lines.join("\n");
}
