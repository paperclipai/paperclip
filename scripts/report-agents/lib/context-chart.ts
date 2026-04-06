// context-chart.ts
// Generate HTML report from .md analysis file
// Parses Claude's markdown output → builds interactive HTML with Chart.js

import { readFileSync, writeFileSync } from "fs";
import { buildHtmlFromMd } from "./md-to-html-report.js";

/** Generate HTML report from .md file, return path to HTML file */
export async function generateContextHtml(
  reportPath: string,
  _dbPath: string
): Promise<string> {
  const mdContent = readFileSync(reportPath, "utf-8");
  const html = buildHtmlFromMd(mdContent);
  const htmlPath = reportPath.replace(/\.md$/, ".html");
  writeFileSync(htmlPath, html);
  return htmlPath;
}
