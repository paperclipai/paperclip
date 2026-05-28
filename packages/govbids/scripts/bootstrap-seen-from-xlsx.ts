/**
 * One-time bootstrap: extract IDs from an annotated v3 xlsx where the team
 * marked which rows are "already known" (un-highlighted = repeat).
 *
 * Reads the xlsx, finds rows that are NOT highlighted bright yellow in the
 * Title cell, looks up each row's id in the corresponding scored-{date}.json
 * by title match, and adds those ids to .seen-ids.json so future daily runs
 * suppress them.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-seen-from-xlsx.ts <xlsx-path> <scored-json-path>
 */
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { loadSeenStore, saveSeenStore, markSeen } from "../src/cli/seen-set.js";
import type { PipelineResult, ScoredOpportunity } from "../src/core/types.js";

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function isBrightYellow(argb: string | undefined): boolean {
  if (!argb) return false;
  const hex = argb.toUpperCase();
  // Bright yellow in macOS Numbers highlight often comes through as FFFFFF00 or similar.
  return /^FF[FE][FE]?[FE]?00$/.test(hex) || hex === "FFFFFF00" || hex === "FFFFFB00";
}

async function main() {
  const xlsxPath = process.argv[2];
  const scoredPath = process.argv[3];
  if (!xlsxPath || !scoredPath) {
    console.error(
      "Usage: tsx scripts/bootstrap-seen-from-xlsx.ts <xlsx> <scored-json>",
    );
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet(1);
  if (!ws) throw new Error("No worksheet found in xlsx");

  const scoredJson = JSON.parse(await readFile(scoredPath, "utf-8")) as PipelineResult;
  const byTitle = new Map<string, ScoredOpportunity>();
  for (const o of scoredJson.scored) {
    byTitle.set(norm(o.title), o);
  }

  const repeats: ScoredOpportunity[] = [];
  const uniqueByTeam: string[] = [];
  const unmatched: string[] = [];

  // Header is row 1; data starts at row 2
  const rowCount = ws.actualRowCount;
  for (let r = 2; r <= rowCount; r++) {
    const titleCell = ws.getCell(r, 4); // Column D = Title
    const title = String(titleCell.value ?? "").trim();
    if (!title) continue;

    const fill = titleCell.fill;
    const argb =
      fill && fill.type === "pattern" && fill.pattern === "solid"
        ? (fill as ExcelJS.FillPattern).fgColor?.argb
        : undefined;
    const highlighted = isBrightYellow(argb);

    if (highlighted) {
      uniqueByTeam.push(title);
      continue;
    }

    // Unhighlighted = team flagged as "repeat / already in HubSpot"
    const opp = byTitle.get(norm(title));
    if (opp) {
      repeats.push(opp);
    } else {
      unmatched.push(title);
    }
  }

  console.log(`xlsx data rows scanned: ${rowCount - 1}`);
  console.log(`  highlighted (unique to team): ${uniqueByTeam.length}`);
  console.log(`  unhighlighted (repeat):       ${repeats.length + unmatched.length}`);
  if (unmatched.length) {
    console.log(`  unmatched titles (could not find in scored json):`);
    for (const t of unmatched) console.log(`    - ${t.slice(0, 80)}`);
  }

  const store = await loadSeenStore();
  const before = Object.keys(store.entries).length;
  markSeen(repeats, store);
  await saveSeenStore(store);
  const after = Object.keys(store.entries).length;
  console.log(`\nseen-set: ${before} → ${after} (${after - before} new IDs marked from team's repeat list)`);
  console.log(`\nIDs added:`);
  for (const r of repeats) {
    console.log(`  ${r.id}  | ${r.title.slice(0, 70)}`);
  }
}

main().catch((err: Error) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
