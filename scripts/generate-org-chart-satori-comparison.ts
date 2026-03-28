#!/usr/bin/env npx tsx
/**
 * Standalone org chart comparison generator — pure SVG (no Playwright).
 *
 * Generates SVG files for all 5 styles × 3 org sizes, plus a comparison HTML page.
 * Uses the server-side SVG renderer directly — same code that powers the routes.
 *
 * Usage:
 *   npx tsx scripts/generate-org-chart-satori-comparison.ts
 *
 * Output: tmp/org-chart-svg-comparison/
 */
import * as fs from "fs";
import * as path from "path";
import {
  renderOrgChartSvg,
  renderOrgChartPng,
  type OrgNode,
  type OrgChartStyle,
  ORG_CHART_STYLES,
} from "../server/src/routes/org-chart-svg.js";

// ── Sample org data ──────────────────────────────────────────────

const ORGS: Record<string, OrgNode> = {
  sm: {
    id: "ceo",
    name: "CEO",
    role: "Chief Executive",
    status: "active",
    reports: [
      { id: "eng1", name: "Engineer", role: "Engineering", status: "active", reports: [] },
      { id: "des1", name: "Designer", role: "Design", status: "active", reports: [] },
    ],
  },
  med: {
    id: "ceo",
    name: "CEO",
    role: "Chief Executive",
    status: "active",
    reports: [
      {
        id: "cto",
        name: "CTO",
        role: "Technology",
        status: "active",
        reports: [
          { id: "eng1", name: "ClaudeCoder", role: "Engineering", status: "active", reports: [] },
          { id: "eng2", name: "CodexCoder", role: "Engineering", status: "active", reports: [] },
          { id: "eng3", name: "SparkCoder", role: "Engineering", status: "active", reports: [] },
          { id: "eng4", name: "CursorCoder", role: "Engineering", status: "active", reports: [] },
          { id: "qa1", name: "QA", role: "Quality", status: "active", reports: [] },
        ],
      },
      {
        id: "cmo",
        name: "CMO",
        role: "Marketing",
        status: "active",
        reports: [
          { id: "des1", name: "Designer", role: "Design", status: "active", reports: [] },
        ],
      },
    ],
  },
  lg: {
    id: "ceo",
    name: "CEO",
    role: "Chief Executive",
    status: "active",
    reports: [
      {
        id: "cto",
        name: "CTO",
        role: "Technology",
        status: "active",
        reports: [
          { id: "eng1", name: "Eng 1", role: "Engineering", status: "active", reports: [] },
          { id: "eng2", name: "Eng 2", role: "Engineering", status: "active", reports: [] },
          { id: "eng3", name: "Eng 3", role: "Engineering", status: "active", reports: [] },
          { id: "qa1", name: "QA", role: "Quality", status: "active", reports: [] },
        ],
      },
      {
        id: "cmo",
        name: "CMO",
        role: "Marketing",
        status: "active",
        reports: [
          { id: "des1", name: "Designer", role: "Design", status: "active", reports: [] },
          { id: "wrt1", name: "Content", role: "Engineering", status: "active", reports: [] },
        ],
      },
      {
        id: "cfo",
        name: "CFO",
        role: "Finance",
        status: "active",
        reports: [
          { id: "fin1", name: "Analyst", role: "Finance", status: "active", reports: [] },
        ],
      },
      {
        id: "coo",
        name: "COO",
        role: "Operations",
        status: "active",
        reports: [
          { id: "ops1", name: "Ops 1", role: "Operations", status: "active", reports: [] },
          { id: "ops2", name: "Ops 2", role: "Operations", status: "active", reports: [] },
          { id: "devops1", name: "DevOps", role: "Operations", status: "active", reports: [] },
        ],
      },
    ],
  },
};

const STYLE_META: Record<OrgChartStyle, { name: string; vibe: string; bestFor: string }> = {
  monochrome: { name: "Monochrome", vibe: "Vercel — zero color noise, dark", bestFor: "GitHub READMEs, developer docs" },
  nebula: { name: "Nebula", vibe: "Glassmorphism — cosmic gradient", bestFor: "Hero sections, marketing" },
  circuit: { name: "Circuit", vibe: "Linear/Raycast — indigo traces", bestFor: "Product pages, dev tools" },
  warmth: { name: "Warmth", vibe: "Airbnb — light, colored avatars", bestFor: "Light-mode READMEs, presentations" },
  schematic: { name: "Schematic", vibe: "Blueprint — grid bg, monospace", bestFor: "Technical docs, infra diagrams" },
};

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const outDir = path.resolve("tmp/org-chart-svg-comparison");
  fs.mkdirSync(outDir, { recursive: true });

  const sizes = ["sm", "med", "lg"] as const;
  const results: string[] = [];

  for (const style of ORG_CHART_STYLES) {
    for (const size of sizes) {
      const svg = renderOrgChartSvg([ORGS[size]], style);
      const svgFile = `${style}-${size}.svg`;
      fs.writeFileSync(path.join(outDir, svgFile), svg);
      results.push(svgFile);
      console.log(`  ✓ ${svgFile}`);

      // Also generate PNG
      try {
        const png = await renderOrgChartPng([ORGS[size]], style);
        const pngFile = `${style}-${size}.png`;
        fs.writeFileSync(path.join(outDir, pngFile), png);
        results.push(pngFile);
        console.log(`  ✓ ${pngFile}`);
      } catch (e) {
        console.log(`  ⚠ PNG failed for ${style}-${size}: ${(e as Error).message}`);
      }
    }
  }

  // Build comparison HTML
  let html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Org Chart Style Comparison — Pure SVG (No Playwright)</title>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; background: #050505; color: #eee; padding: 40px; }
  h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.03em; }
  p.sub { color: #888; font-size: 14px; margin-bottom: 16px; }
  .badge { display: inline-block; background: #1a1a2e; border: 1px solid #333; border-radius: 4px; padding: 4px 10px; font-size: 12px; color: #6366f1; margin-bottom: 32px; }
  .style-section { margin-bottom: 60px; }
  .style-section h2 { font-size: 20px; font-weight: 600; margin-bottom: 4px; letter-spacing: -0.02em; }
  .style-meta { font-size: 13px; color: #666; margin-bottom: 16px; }
  .style-meta em { color: #888; font-style: normal; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  .grid img, .grid object { width: 100%; border-radius: 8px; border: 1px solid #222; background: #111; }
  .label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; font-weight: 500; }
  .size-label { font-size: 10px; color: #555; text-align: center; margin-top: 4px; }
  .note { background: #111; border: 1px solid #222; border-radius: 6px; padding: 16px 20px; margin-top: 40px; font-size: 13px; color: #999; line-height: 1.6; }
  .note h3 { font-size: 14px; color: #ccc; margin-bottom: 8px; }
  .note code { background: #1a1a1a; padding: 2px 6px; border-radius: 3px; font-size: 12px; color: #6366f1; }
</style>
</head><body>
<h1>Org Chart Export — Style Comparison</h1>
<p class="sub">5 styles × 3 org sizes. Pure SVG — no Playwright, no Satori, no browser needed.</p>
<div class="badge">Server-side compatible — works on any route</div>
`;

  for (const style of ORG_CHART_STYLES) {
    const meta = STYLE_META[style];
    html += `<div class="style-section">
  <h2>${meta.name}</h2>
  <div class="style-meta"><em>${meta.vibe}</em> — Best for: ${meta.bestFor}</div>
  <div class="label">Small / Medium / Large</div>
  <div class="grid">
    <div><img src="${style}-sm.png" onerror="this.outerHTML='<object data=\\'${style}-sm.svg\\' type=\\'image/svg+xml\\' style=\\'width:100%;border-radius:8px;border:1px solid #222\\'></object>'" /><div class="size-label">3 agents</div></div>
    <div><img src="${style}-med.png" onerror="this.outerHTML='<object data=\\'${style}-med.svg\\' type=\\'image/svg+xml\\' style=\\'width:100%;border-radius:8px;border:1px solid #222\\'></object>'" /><div class="size-label">8 agents</div></div>
    <div><img src="${style}-lg.png" onerror="this.outerHTML='<object data=\\'${style}-lg.svg\\' type=\\'image/svg+xml\\' style=\\'width:100%;border-radius:8px;border:1px solid #222\\'></object>'" /><div class="size-label">14 agents</div></div>
  </div>
</div>`;
  }

  html += `
<div class="note">
  <h3>Why Pure SVG instead of Satori?</h3>
  <p>
    <strong>Satori</strong> converts JSX → SVG using Yoga (flexbox). It's great for OG cards but has limitations for org charts:
    no <code>::before/::after</code> pseudo-elements, no CSS grid, limited gradient support,
    and connector lines between nodes would need post-processing.
  </p>
  <p>
    <strong>Pure SVG rendering</strong> (what we're using here) gives us full control over layout, connectors,
    gradients, filters, and patterns — with zero runtime dependencies beyond <code>sharp</code> for PNG.
    It runs on any Node.js route, generates in &lt;10ms, and produces identical output every time.
  </p>
  <p>
    Routes: <code>GET /api/companies/:id/org.svg?style=monochrome</code> and <code>GET /api/companies/:id/org.png?style=circuit</code>
  </p>
</div>
</body></html>`;

  fs.writeFileSync(path.join(outDir, "comparison.html"), html);
  console.log(`\n✓ All done! ${results.length} files generated.`);
  console.log(`  Open: tmp/org-chart-svg-comparison/comparison.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
