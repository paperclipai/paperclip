// md-to-html-report.ts
// Parse .md report file → build HTML report with charts
// Extracts tables, metrics, sections from Claude's markdown output

import { readFileSync } from "fs";
import {
  header, kpiGrid, section, dataTable, analysisBox, chartCanvas, htmlPage,
  fmtUSD, fmtNum, fmtPct,
} from "./html-report-builder.js";

// ============================================================
// MARKDOWN PARSER
// ============================================================

interface MdSection {
  level: number;    // 1=h1, 2=h2, 3=h3
  title: string;
  content: string;  // raw content under this heading
  tables: MdTable[];
}

interface MdTable {
  headers: string[];
  rows: string[][];
}

function parseMd(md: string): MdSection[] {
  const lines = md.split("\n");
  const sections: MdSection[] = [];
  let current: MdSection | null = null;
  let contentLines: string[] = [];

  function flush() {
    if (current) {
      current.content = contentLines.join("\n").trim();
      current.tables = extractTables(current.content);
      sections.push(current);
    }
    contentLines = [];
  }

  for (const line of lines) {
    const h1 = line.match(/^# (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h3 = line.match(/^### (.+)/);

    if (h1 || h2 || h3) {
      flush();
      const match = h1 || h2 || h3;
      current = {
        level: h1 ? 1 : h2 ? 2 : 3,
        title: match![1].trim(),
        content: "",
        tables: [],
      };
    } else {
      contentLines.push(line);
    }
  }
  flush();
  return sections;
}

function extractTables(content: string): MdTable[] {
  const tables: MdTable[] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Detect table: line with | separators
    if (lines[i].includes("|") && lines[i].trim().startsWith("|")) {
      const headerLine = lines[i];
      // Next line should be separator (|---|---|)
      if (i + 1 < lines.length && /^\|[\s\-:|]+\|/.test(lines[i + 1])) {
        const headers = headerLine.split("|").map(s => s.trim()).filter(s => s);
        const rows: string[][] = [];
        i += 2; // skip header + separator
        while (i < lines.length && lines[i].includes("|") && lines[i].trim().startsWith("|")) {
          const cells = lines[i].split("|").map(s => s.trim()).filter(s => s);
          if (cells.length > 0) rows.push(cells);
          i++;
        }
        tables.push({ headers, rows });
        continue;
      }
    }
    i++;
  }
  return tables;
}

/** Extract bullet points from content */
function extractBullets(content: string): string[] {
  return content.split("\n")
    .filter(l => /^[-*•]\s/.test(l.trim()))
    .map(l => l.trim().replace(/^[-*•]\s+/, "").replace(/\*\*/g, ""));
}

/** Extract key-value pairs from "**key**: value" or "**key** value" patterns */
function extractMetrics(content: string): Array<{ label: string; value: string }> {
  const metrics: Array<{ label: string; value: string }> = [];
  const re = /\*\*(.+?)\*\*[:\s]+(.+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    metrics.push({ label: m[1].trim(), value: m[2].trim() });
  }
  return metrics;
}

/** Try to parse a number from a string like "$140.6K" or "162" or "19.8%" */
function parseNum(s: string): number {
  const clean = s.replace(/[,$%]/g, "").trim();
  const m = clean.match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const suffix = (m[2] || "").toUpperCase();
  if (suffix === "K") return n * 1e3;
  if (suffix === "M") return n * 1e6;
  if (suffix === "B") return n * 1e9;
  return n;
}

// ============================================================
// SECTION COLOR MAPPING
// ============================================================

const SECTION_COLORS: Array<{ keywords: string[]; color: string; icon: string }> = [
  { keywords: ["summary", "overview", "tổng"], color: "cy", icon: "\uD83D\uDCCA" },
  { keywords: ["volume", "token", "breakdown"], color: "cy", icon: "\uD83D\uDCCA" },
  { keywords: ["user", "trader", "wallet", "acquisition"], color: "gn", icon: "\uD83D\uDC65" },
  { keywords: ["order", "size", "characteristic"], color: "pu", icon: "\uD83D\uDCCB" },
  { keywords: ["pattern", "behavior", "trading"], color: "or", icon: "\uD83D\uDD0D" },
  { keywords: ["settle", "settlement"], color: "gn", icon: "\u2696\uFE0F" },
  { keywords: ["insight"], color: "yl", icon: "\uD83D\uDCA1" },
  { keywords: ["recommend", "priority", "action"], color: "pk", icon: "\uD83C\uDFAF" },
  { keywords: ["risk", "caveat", "warning"], color: "rd", icon: "\u26A0\uFE0F" },
  { keywords: ["whale", "concentration"], color: "or", icon: "\uD83D\uDC0B" },
  { keywords: ["trend", "time", "daily"], color: "cy", icon: "\uD83D\uDCC8" },
  { keywords: ["exit", "position"], color: "rd", icon: "\uD83D\uDEAA" },
];

function getSectionStyle(title: string): { color: string; icon: string } {
  const lower = title.toLowerCase();
  for (const s of SECTION_COLORS) {
    if (s.keywords.some(k => lower.includes(k))) return { color: s.color, icon: s.icon };
  }
  return { color: "cy", icon: "\uD83D\uDCCB" };
}

// ============================================================
// BUILD HTML FROM PARSED MD
// ============================================================

export function buildHtmlFromMd(mdContent: string): string {
  const sections = parseMd(mdContent);
  if (sections.length === 0) return htmlPage("Report", "<p>No content</p>", "");

  // Extract title from h1
  const h1 = sections.find(s => s.level === 1);
  const title = h1?.title ?? "Report";

  // Extract Summary section for KPI cards
  const summarySection = sections.find(s => s.level === 2 && /summary/i.test(s.title));
  const summaryBullets = summarySection ? extractBullets(summarySection.content) : [];
  const summaryMetrics = summarySection ? extractMetrics(summarySection.content) : [];

  // Build KPI cards from summary metrics (first 5)
  const kpiCards = summaryMetrics.slice(0, 5).map(m => ({
    label: m.label,
    value: m.value.split("—")[0].split("(")[0].trim(),
    color: /volume|usd|\$/i.test(m.label) ? "var(--cyan)"
      : /user|trader|wallet/i.test(m.label) ? "var(--green)"
      : /rate|%/i.test(m.label) ? "var(--yellow)"
      : "var(--t1)",
  }));

  // Build body parts
  const bodyParts: string[] = [];

  // Header
  const today = new Date().toISOString().slice(0, 10);
  bodyParts.push(header(title, today, "Whales Market"));

  // KPI grid from summary
  if (kpiCards.length > 0) {
    bodyParts.push(kpiGrid(kpiCards));
  } else if (summaryBullets.length > 0) {
    // Fallback: show summary bullets as KPI-like cards
    bodyParts.push(kpiGrid(summaryBullets.slice(0, 5).map(b => ({
      label: b.slice(0, 30),
      value: "",
      color: "var(--t1)",
    }))));
  }

  // Chart tracking
  const chartIds: string[] = [];
  const chartScripts: string[] = [];

  // Process h2 sections (skip h1 title and Summary which is already in KPIs)
  const contentSections = sections.filter(s =>
    s.level === 2 && !/^summary$/i.test(s.title.replace(/[^a-zA-Z]/g, ""))
  );

  for (const sec of contentSections) {
    const style = getSectionStyle(sec.title);

    // Build section content
    let sectionContent = "";

    // Render tables
    for (const table of sec.tables) {
      // Check if table has numeric data for charting
      const numericCols = table.headers.map((_, ci) =>
        table.rows.filter(r => r[ci] && /[\d.$%KMB]/.test(r[ci])).length > table.rows.length / 2
      );
      const labelCol = 0;
      const valueCol = numericCols.findIndex((isNum, i) => i > 0 && isNum);

      // Generate chart if we have label + value columns and enough rows
      if (valueCol > 0 && table.rows.length >= 2 && table.rows.length <= 20) {
        const chartId = `chart_${chartIds.length}`;
        chartIds.push(chartId);
        sectionContent += chartCanvas(chartId, 220);

        const labels = table.rows.map(r => (r[labelCol] || "").replace(/\*\*/g, ""));
        const values = table.rows.map(r => parseNum(r[valueCol] || "0"));

        chartScripts.push(`
new Chart(document.getElementById('${chartId}'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(labels)},
    datasets: [{
      label: '${table.headers[valueCol]?.replace(/\*\*/g, "") || "Value"}',
      data: ${JSON.stringify(values)},
      backgroundColor: '#00e5ff88', borderRadius: 4
    }]
  },
  options: { indexAxis: ${table.rows.length > 5 ? "'y'" : "'x'"}, plugins: { legend: { display: false } },
    scales: { ${table.rows.length > 5 ? 'x' : 'y'}: { ticks: { callback: v => typeof v === 'number' && v >= 1000 ? '$'+(v/1000).toFixed(0)+'K' : v } } } }
});`);
      }

      // Always render the table
      sectionContent += dataTable(
        table.headers.map(h => h.replace(/\*\*/g, "")),
        table.rows.map(r => r.map(c => {
          const clean = c.replace(/\*\*/g, "");
          // Color code values
          if (/^\$/.test(clean)) return `<span class="cy">${clean}</span>`;
          if (/WHALE/i.test(clean)) return `<span class="o">${clean}</span>`;
          if (/100%/.test(clean)) return `<span class="g">${clean}</span>`;
          if (/<\s*[58]0%/.test(clean)) return `<span class="r">${clean}</span>`;
          return clean;
        }))
      );
    }

    // Render bullets and text (non-table content)
    const bullets = extractBullets(sec.content);
    if (bullets.length > 0) {
      sectionContent += analysisBox(bullets.map(b => b.replace(/\*\*/g, "")));
    }

    // Render h3 subsections within this h2
    const h3Sections = sections.filter(s =>
      s.level === 3 && sections.indexOf(s) > sections.indexOf(sec) &&
      (contentSections.indexOf(sec) === contentSections.length - 1 ||
       sections.indexOf(s) < sections.indexOf(contentSections[contentSections.indexOf(sec) + 1]))
    );

    for (const h3 of h3Sections) {
      const h3Style = getSectionStyle(h3.title);
      let h3Content = "";

      for (const table of h3.tables) {
        h3Content += dataTable(
          table.headers.map(h => h.replace(/\*\*/g, "")),
          table.rows.map(r => r.map(c => c.replace(/\*\*/g, "")))
        );
      }

      const h3Bullets = extractBullets(h3.content);
      if (h3Bullets.length > 0) {
        h3Content += analysisBox(h3Bullets.map(b => b.replace(/\*\*/g, "")));
      }

      if (h3Content) {
        sectionContent += `<div style="margin-top:16px"><div class="ant">${h3.title.replace(/\*\*/g, "").replace(/^\d+\.\s*/, "")}</div>${h3Content}</div>`;
      }
    }

    if (sectionContent) {
      // Count for badge
      const tableRows = sec.tables.reduce((s, t) => s + t.rows.length, 0);
      const badge = tableRows > 0 ? `${tableRows} rows` : `${bullets.length} points`;
      bodyParts.push(section(style.color, style.icon, sec.title.replace(/^Data\s*[—–-]\s*/i, ""), badge, sectionContent));
    }
  }

  return htmlPage(title, bodyParts.join("\n"), chartScripts.join("\n"));
}
