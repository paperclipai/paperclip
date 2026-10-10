#!/usr/bin/env npx tsx
/**
 * Standalone org chart image generator.
 *
 * Renders each of the 5 org chart styles to PNG using Playwright (headless Chromium).
 * This gives us browser-native emoji rendering, full CSS support, and pixel-perfect output.
 *
 * Usage:
 *   npx tsx scripts/generate-org-chart-images.ts
 *
 * Output: tmp/org-chart-images/<style>-<size>.png
 */
import { chromium } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

// ── Org data (same as index.html) ──────────────────────────────

interface OrgNode {
  name: string;
  role: string;
  icon?: string;
  tag: string;
  children?: OrgNode[];
}

const ORGS: Record<string, OrgNode> = {
  sm: {
    name: "CEO",
    role: "Chief Executive",
    icon: "👑",
    tag: "ceo",
    children: [
      { name: "Engineer", role: "Engineer", icon: "⌨️", tag: "eng" },
      { name: "Designer", role: "Design", icon: "🪄", tag: "des" },
    ],
  },
  med: {
    name: "CEO",
    role: "Chief Executive",
    icon: "👑",
    tag: "ceo",
    children: [
      {
        name: "CTO",
        role: "Technology",
        icon: "💻",
        tag: "cto",
        children: [
          { name: "ClaudeCoder", role: "Engineer", tag: "eng" },
          { name: "CodexCoder", role: "Engineer", tag: "eng" },
          { name: "SparkCoder", role: "Engineer", tag: "eng" },
          { name: "CursorCoder", role: "Engineer", tag: "eng" },
          { name: "QA", role: "Quality", tag: "qa" },
        ],
      },
      {
        name: "CMO",
        role: "Marketing",
        icon: "🌐",
        tag: "cmo",
        children: [{ name: "Designer", role: "Design", tag: "des" }],
      },
    ],
  },
  lg: {
    name: "CEO",
    role: "Chief Executive",
    icon: "👑",
    tag: "ceo",
    children: [
      {
        name: "CTO",
        role: "Technology",
        icon: "💻",
        tag: "cto",
        children: [
          { name: "Eng 1", role: "Eng", tag: "eng" },
          { name: "Eng 2", role: "Eng", tag: "eng" },
          { name: "Eng 3", role: "Eng", tag: "eng" },
          { name: "QA", role: "QA", tag: "qa" },
        ],
      },
      {
        name: "CMO",
        role: "Marketing",
        icon: "🌐",
        tag: "cmo",
        children: [
          { name: "Designer", role: "Design", tag: "des" },
          { name: "Content", role: "Writer", tag: "eng" },
        ],
      },
      {
        name: "CFO",
        role: "Finance",
        icon: "📊",
        tag: "fin",
        children: [{ name: "Analyst", role: "Finance", tag: "fin" }],
      },
      {
        name: "COO",
        role: "Operations",
        icon: "⚙️",
        tag: "ops",
        children: [
          { name: "Ops 1", role: "Ops", tag: "ops" },
          { name: "Ops 2", role: "Ops", tag: "ops" },
          { name: "DevOps", role: "Infra", tag: "ops" },
        ],
      },
    ],
  },
};

// OG collapsed org
const OG_ORG: OrgNode = {
  name: "CEO",
  role: "Chief Executive",
  tag: "ceo",
  children: [
    { name: "CTO", role: "×5 reports", tag: "cto" },
    { name: "CMO", role: "×1 report", tag: "cmo" },
  ],
};

// ── Style definitions ──────────────────────────────────────────

interface StyleDef {
  key: string;
  name: string;
  css: string;
  renderCard: (node: OrgNode, isOg: boolean) => string;
}

const COMMON_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  -webkit-font-smoothing: antialiased;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 0;
}

.org-tree {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: max-content;
  --line-color: #3f3f46;
  --line-w: 1.5px;
  --drop-h: 20px;
  --child-gap: 14px;
}

.org-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
}

.org-children {
  display: flex;
  justify-content: center;
  padding-top: calc(var(--drop-h) * 2);
  position: relative;
  gap: var(--child-gap);
}

.org-children::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: var(--line-w);
  height: calc(var(--drop-h) * 2);
  background: var(--line-color);
}

.org-children > .org-node {
  padding-top: var(--drop-h);
  position: relative;
}

.org-children > .org-node::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: var(--line-w);
  height: var(--drop-h);
  background: var(--line-color);
}

.org-children > .org-node::after {
  content: '';
  position: absolute;
  top: 0;
  left: calc(-0.5 * var(--child-gap));
  right: calc(-0.5 * var(--child-gap));
  height: var(--line-w);
  background: var(--line-color);
}

.org-children > .org-node:first-child::after { left: 50%; }
.org-children > .org-node:last-child::after { right: 50%; }
.org-children > .org-node:only-child::after { display: none; }

.org-card {
  text-align: center;
  position: relative;
}
.org-card .name { white-space: nowrap; }
.org-card .role { white-space: nowrap; }
.org-card .icon-wrap { margin-bottom: 8px; font-size: 18px; line-height: 1; }

/* OG compact overrides */
.og-compact .org-card { padding: 10px 14px !important; min-width: 80px !important; }
.og-compact .org-card .name { font-size: 11px !important; }
.og-compact .org-card .role { font-size: 9px !important; }
.og-compact .org-card .icon-wrap { font-size: 14px !important; margin-bottom: 5px !important; }
.og-compact .org-card .avatar { width: 24px !important; height: 24px !important; font-size: 11px !important; margin-bottom: 6px !important; }
.og-compact .org-children { padding-top: 20px !important; gap: 8px !important; }
.og-compact .org-tree { --drop-h: 10px; --child-gap: 8px; }

/* Watermark */
.watermark {
  position: absolute;
  bottom: 12px;
  right: 16px;
  font-size: 11px;
  font-weight: 500;
  color: rgba(128,128,128,0.4);
  font-family: 'Inter', sans-serif;
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  gap: 5px;
}
.watermark svg { opacity: 0.4; }
`;

const STYLES: StyleDef[] = [
  {
    key: "mono",
    name: "Monochrome",
    css: `
body { background: #18181b; }
.org-tree { --line-color: #3f3f46; }
.org-card {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 6px;
  padding: 16px 22px;
  min-width: 130px;
}
.org-card .name {
  font-size: 14px; font-weight: 600; color: #fafafa;
  letter-spacing: -0.01em; margin-bottom: 3px;
}
.org-card .role {
  font-size: 10px; color: #71717a;
  text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500;
}
.watermark { color: rgba(255,255,255,0.25); }
.watermark svg { stroke: rgba(255,255,255,0.25); }
`,
    renderCard: (node, isOg) => {
      const icon =
        node.icon && !isOg
          ? `<div class="icon-wrap">${node.icon}</div>`
          : "";
      return `<div class="org-card">${icon}<div class="name">${node.name}</div><div class="role">${node.role}</div></div>`;
    },
  },
  {
    key: "nebula",
    name: "Nebula",
    css: `
body { background: #0f0c29; }
.org-tree {
  background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
  border-radius: 6px;
  padding: 36px 28px;
  position: relative;
  overflow: hidden;
  --line-color: rgba(255,255,255,0.25);
  --line-w: 1.5px;
}
.org-tree::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 600px 400px at 25% 30%, rgba(99,102,241,0.12) 0%, transparent 70%),
    radial-gradient(ellipse 500px 350px at 75% 65%, rgba(168,85,247,0.08) 0%, transparent 70%);
  pointer-events: none;
}
.org-node { z-index: 1; }
.org-card {
  background: rgba(255,255,255,0.07);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px;
  padding: 16px 22px;
  min-width: 130px;
}
.org-card .name {
  font-size: 14px; font-weight: 600; color: #fff; margin-bottom: 3px;
}
.org-card .role {
  font-size: 10px; color: rgba(255,255,255,0.45);
  text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500;
}
.watermark { color: rgba(255,255,255,0.2); }
.watermark svg { stroke: rgba(255,255,255,0.2); }
`,
    renderCard: (node, isOg) => {
      const icon =
        node.icon && !isOg
          ? `<div class="icon-wrap">${node.icon}</div>`
          : "";
      return `<div class="org-card">${icon}<div class="name">${node.name}</div><div class="role">${node.role}</div></div>`;
    },
  },
  {
    key: "circuit",
    name: "Circuit",
    css: `
body { background: #0c0c0e; }
.org-tree {
  background: #0c0c0e;
  border-radius: 6px;
  padding: 36px 28px;
  --line-color: rgba(99,102,241,0.35);
  --line-w: 1.5px;
}
.org-card {
  background: linear-gradient(135deg, rgba(99,102,241,0.06), rgba(99,102,241,0.01));
  border: 1px solid rgba(99,102,241,0.18);
  border-radius: 5px;
  padding: 14px 20px;
  min-width: 120px;
}
.org-card.chief {
  border-color: rgba(168,85,247,0.35);
  background: linear-gradient(135deg, rgba(168,85,247,0.08), rgba(168,85,247,0.01));
}
.org-card .name {
  font-size: 13px; font-weight: 600; color: #e4e4e7;
  margin-bottom: 3px; letter-spacing: -0.005em;
}
.org-card .role {
  font-size: 10px; color: #6366f1;
  text-transform: uppercase; letter-spacing: 0.07em; font-weight: 500;
}
.watermark { color: rgba(99,102,241,0.3); }
.watermark svg { stroke: rgba(99,102,241,0.3); }
`,
    renderCard: (node, isOg) => {
      const cls = node.tag === "ceo" ? " chief" : "";
      const icon =
        node.icon && !isOg
          ? `<div class="icon-wrap">${node.icon}</div>`
          : "";
      return `<div class="org-card${cls}">${icon}<div class="name">${node.name}</div><div class="role">${node.role}</div></div>`;
    },
  },
  {
    key: "warm",
    name: "Warmth",
    css: `
body { background: #fafaf9; }
.org-tree {
  background: #fafaf9;
  border-radius: 6px;
  padding: 36px 28px;
  --line-color: #d6d3d1;
  --line-w: 2px;
}
.org-card {
  background: #fff;
  border: 1px solid #e7e5e4;
  border-radius: 6px;
  padding: 16px 22px;
  min-width: 130px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.03);
}
.org-card .avatar {
  width: 34px; height: 34px; border-radius: 50%;
  margin: 0 auto 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; line-height: 1;
}
.org-card .avatar.r-ceo { background: #fef3c7; }
.org-card .avatar.r-cto { background: #dbeafe; }
.org-card .avatar.r-cmo { background: #dcfce7; }
.org-card .avatar.r-eng { background: #f3e8ff; }
.org-card .avatar.r-qa  { background: #ffe4e6; }
.org-card .avatar.r-des { background: #fce7f3; }
.org-card .avatar.r-fin { background: #fef3c7; }
.org-card .avatar.r-ops { background: #e0f2fe; }
.org-card .name {
  font-size: 14px; font-weight: 600; color: #1c1917; margin-bottom: 2px;
}
.org-card .role {
  font-size: 11px; color: #78716c; font-weight: 500;
}
.watermark { color: rgba(0,0,0,0.25); }
.watermark svg { stroke: rgba(0,0,0,0.25); }
`,
    renderCard: (node, isOg) => {
      const icons: Record<string, string> = {
        ceo: "👑",
        cto: "💻",
        cmo: "🌐",
        eng: "⌨️",
        qa: "🔬",
        des: "🪄",
        fin: "📊",
        ops: "⚙️",
      };
      const ic = node.icon || icons[node.tag] || "";
      const sizeStyle = isOg
        ? "width:24px;height:24px;font-size:11px;margin-bottom:6px;"
        : "";
      const avatar = `<div class="avatar r-${node.tag}" style="${sizeStyle}">${ic}</div>`;
      return `<div class="org-card">${avatar}<div class="name">${node.name}</div><div class="role">${node.role}</div></div>`;
    },
  },
  {
    key: "schema",
    name: "Schematic",
    css: `
body { background: #0d1117; }
.org-tree {
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  background: #0d1117;
  background-image:
    linear-gradient(rgba(48,54,61,0.25) 1px, transparent 1px),
    linear-gradient(90deg, rgba(48,54,61,0.25) 1px, transparent 1px);
  background-size: 20px 20px;
  border-radius: 4px;
  padding: 36px 28px;
  border: 1px solid #21262d;
  --line-color: #30363d;
  --line-w: 1.5px;
}
.org-card {
  background: rgba(13,17,23,0.92);
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 12px 16px;
  min-width: 120px;
  position: relative;
}
.org-card::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  border-radius: 4px 4px 0 0;
}
.org-card.t-ceo::after { background: #f0883e; }
.org-card.t-cto::after { background: #58a6ff; }
.org-card.t-cmo::after { background: #3fb950; }
.org-card.t-eng::after { background: #bc8cff; }
.org-card.t-qa::after  { background: #f778ba; }
.org-card.t-des::after { background: #79c0ff; }
.org-card.t-fin::after { background: #f0883e; }
.org-card.t-ops::after { background: #58a6ff; }
.org-card .name {
  font-size: 12px; font-weight: 600; color: #c9d1d9; margin-bottom: 2px;
}
.org-card .role {
  font-size: 10px; color: #8b949e; letter-spacing: 0.02em;
}
.watermark { color: rgba(139,148,158,0.3); font-family: 'JetBrains Mono', monospace; }
.watermark svg { stroke: rgba(139,148,158,0.3); }
`,
    renderCard: (node, isOg) => {
      const schemaRoles: Record<string, string> = {
        ceo: "chief_executive",
        cto: "chief_technology",
        cmo: "chief_marketing",
        eng: "engineer",
        qa: "quality",
        des: "designer",
        fin: "finance",
        ops: "operations",
      };
      const icon =
        node.icon && !isOg
          ? `<div class="icon-wrap">${node.icon}</div>`
          : "";
      const roleText =
        isOg
          ? node.role
          : node.children
            ? node.role
            : schemaRoles[node.tag] || node.role;
      return `<div class="org-card t-${node.tag}">${icon}<div class="name">${node.name}</div><div class="role">${roleText}</div></div>`;
    },
  },
];

// ── HTML rendering ─────────────────────────────────────────────

function renderNode(
  node: OrgNode,
  style: StyleDef,
  isOg: boolean,
): string {
  const cardHtml = style.renderCard(node, isOg);
  if (!node.children || node.children.length === 0) {
    return `<div class="org-node">${cardHtml}</div>`;
  }
  const childrenHtml = node.children
    .map((c) => renderNode(c, style, isOg))
    .join("");
  return `<div class="org-node">${cardHtml}<div class="org-children">${childrenHtml}</div></div>`;
}

function renderTree(
  orgData: OrgNode,
  style: StyleDef,
  isOg: boolean,
): string {
  const compact = isOg ? " og-compact" : "";
  return `<div class="org-tree${compact}">${renderNode(orgData, style, isOg)}</div>`;
}

const PAPERCLIP_WATERMARK = `<div class="watermark">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m18 4-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>
  </svg>
  Paperclip
</div>`;

function buildHtml(
  style: StyleDef,
  orgData: OrgNode,
  isOg: boolean,
): string {
  const tree = renderTree(orgData, style, isOg);
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>${COMMON_CSS}${style.css}</style>
</head><body>
<div style="position:relative;display:inline-block;">
${tree}
${PAPERCLIP_WATERMARK}
</div>
</body></html>`;
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const outDir = path.resolve("tmp/org-chart-images");
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    deviceScaleFactor: 2, // retina quality
  });

  const sizes = ["sm", "med", "lg"] as const;
  const results: string[] = [];

  for (const style of STYLES) {
    // README sizes
    for (const size of sizes) {
      const page = await context.newPage();
      const html = buildHtml(style, ORGS[size], false);
      await page.setContent(html, { waitUntil: "networkidle" });

      // Wait for fonts to load
      await page.waitForFunction(() => document.fonts.ready);
      await page.waitForTimeout(300);

      // Fit to content
      const box = await page.evaluate(() => {
        const el = document.querySelector(".org-tree")!;
        const rect = el.getBoundingClientRect();
        return {
          width: Math.ceil(rect.width) + 32,
          height: Math.ceil(rect.height) + 32,
        };
      });

      await page.setViewportSize({
        width: Math.max(box.width, 400),
        height: Math.max(box.height, 300),
      });

      const filename = `${style.key}-${size}.png`;
      await page.screenshot({
        path: path.join(outDir, filename),
        clip: {
          x: 0,
          y: 0,
          width: Math.max(box.width, 400),
          height: Math.max(box.height, 300),
        },
      });
      await page.close();
      results.push(filename);
      console.log(`  ✓ ${filename}`);
    }

    // OG card (1200×630)
    {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1200, height: 630 });
      const html = buildHtml(style, OG_ORG, true);
      // For OG, center the tree in a fixed viewport
      const ogHtml = html.replace(
        "<body>",
        `<body style="width:1200px;height:630px;display:flex;align-items:center;justify-content:center;">`,
      );
      await page.setContent(ogHtml, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.fonts.ready);
      await page.waitForTimeout(300);

      const filename = `${style.key}-og.png`;
      await page.screenshot({
        path: path.join(outDir, filename),
        clip: { x: 0, y: 0, width: 1200, height: 630 },
      });
      await page.close();
      results.push(filename);
      console.log(`  ✓ ${filename}`);
    }
  }

  await browser.close();

  // Build an HTML comparison page
  let compHtml = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Org Chart Style Comparison</title>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; background: #050505; color: #eee; padding: 40px; }
  h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.03em; }
  p.sub { color: #888; font-size: 14px; margin-bottom: 40px; }
  .style-section { margin-bottom: 60px; }
  .style-section h2 { font-size: 20px; font-weight: 600; margin-bottom: 16px; letter-spacing: -0.02em; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  .grid img { width: 100%; border-radius: 8px; border: 1px solid #222; }
  .og-row { max-width: 600px; }
  .og-row img { width: 100%; border-radius: 8px; border: 1px solid #222; }
  .label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; font-weight: 500; }
</style>
</head><body>
<h1>Org Chart Export — Style Comparison</h1>
<p class="sub">5 styles × 3 org sizes + OG cards. All rendered via Playwright (browser-native emojis, full CSS).</p>
`;

  for (const style of STYLES) {
    compHtml += `<div class="style-section">
  <h2>${style.name}</h2>
  <div class="label">README — Small / Medium / Large</div>
  <div class="grid">
    <img src="${style.key}-sm.png" />
    <img src="${style.key}-med.png" />
    <img src="${style.key}-lg.png" />
  </div>
  <div class="label">OG Card (1200×630)</div>
  <div class="og-row"><img src="${style.key}-og.png" /></div>
</div>`;
  }

  compHtml += `</body></html>`;
  fs.writeFileSync(path.join(outDir, "comparison.html"), compHtml);
  console.log(`\n✓ All done! ${results.length} images generated.`);
  console.log(`  Open: tmp/org-chart-images/comparison.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
