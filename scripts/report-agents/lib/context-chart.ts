// context-chart.ts
// Generate topic-specific HTML report file from report .md + SQLite data
// Returns path to HTML file for sending via Telegram

import Database from "better-sqlite3";
import { basename, dirname, join } from "path";
import { writeFileSync } from "fs";
import { buildContextReportHtml } from "./html-report-builder.js";

function detectTopic(reportPath: string): string {
  const name = basename(reportPath, ".md");
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

/** Generate HTML report file, return its path */
export async function generateContextHtml(
  reportPath: string,
  dbPath: string
): Promise<string> {
  const topic = detectTopic(reportPath);
  const db = new Database(dbPath, { readonly: true });

  try {
    const html = buildContextReportHtml(topic, db);
    // Save HTML next to the .md report file
    const htmlPath = reportPath.replace(/\.md$/, ".html");
    writeFileSync(htmlPath, html);
    return htmlPath;
  } finally {
    db.close();
  }
}
