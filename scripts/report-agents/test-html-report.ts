// Quick test: generate HTML reports for each topic and save to files
import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import Database from "better-sqlite3";
import { buildContextReportHtml } from "./lib/html-report-builder.js";
import { renderReportToPng } from "./lib/report-html.js";
import fs from "fs";

const WHALES_DB_PATH = process.env.WHALES_DB_PATH!;
if (!WHALES_DB_PATH) { console.error("Missing WHALES_DB_PATH"); process.exit(1); }

const topics = ["top-tokens", "token-WLFI", "trend", "users", "mom", "settle", "diagnostic-volume"];

async function main() {
  const db = new Database(WHALES_DB_PATH, { readonly: true });
  const outDir = "reports/test-html";
  fs.mkdirSync(outDir, { recursive: true });

  for (const topic of topics) {
    console.log(`Generating: ${topic}...`);
    try {
      const html = buildContextReportHtml(topic, db);
      fs.writeFileSync(`${outDir}/${topic}.html`, html);
      console.log(`  → HTML saved: ${outDir}/${topic}.html`);

      const png = await renderReportToPng(html);
      fs.writeFileSync(`${outDir}/${topic}.png`, png);
      console.log(`  → PNG saved: ${outDir}/${topic}.png (${(png.length / 1024).toFixed(0)}KB)`);
    } catch (e: any) {
      console.error(`  ✗ ${topic}: ${e.message}`);
    }
  }
  db.close();
  console.log("\nDone! Check reports/test-html/");
}

main();
