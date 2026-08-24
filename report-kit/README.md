# Report Kit

A reusable report template that produces Fable-5-quality reports from a simple JSON data contract. Stop hand-crafting reports — use the template.

Report Kit is the Paperclip fleet's standard for one-off, archival, and stakeholder-facing reports. It is used to render fleet health checks, audit narratives, telemetry summaries, and any report that needs to look like it was authored by a professional technical writer rather than an LLM dump.

## Table of Contents

- [Quick Start](#quick-start)
- [Files](#files)
- [API Reference](#api-reference)
  - [Data Contract](#data-contract)
  - [Status Values](#status-values)
  - [Table Cell Status](#table-cell-status)
  - [Manifest](#manifest)
  - [Guardrail](#guardrail)
- [Section Types](#section-types)
  - [Choosing a Section Type](#choosing-a-section-type)
- [Common Report Templates](#common-report-templates)
  - [Fleet Health Report](#fleet-health-report)
  - [Audit Narrative](#audit-narrative)
  - [Telemetry Summary](#telemetry-summary)
- [Design System](#design-system)
- [Deployment](#deployment)
  - [Static Hosting](#static-hosting)
  - [Paperclip Integration](#paperclip-integration)
  - [Headless / CI-CD](#headless--ci-cd)
  - [Cron Automation](#cron-automation)
- [Schema Validation](#schema-validation)
- [Troubleshooting](#troubleshooting)
  - [ES Module Import Errors](#es-module-import-errors)
  - [Unstyled Output](#unstyled-output)
  - [SVG Icons Not Rendering](#svg-icons-not-rendering)
  - [Font Loading Issues](#font-loading-issues)
  - [Schema Validation Errors](#schema-validation-errors)
  - [Template Placeholders Not Replaced](#template-placeholders-not-replaced)
  - [Empty Metrics or Sections](#empty-metrics-or-sections)
  - [Invalid Row Structure in Tables](#invalid-row-structure-in-tables)
- [Changelog](#changelog)
- [License](#license)

## Quick Start

### Option 1: Use `template.html` (fastest)

1. Copy `template.html` to your output location.
2. Replace the `REPORT_DATA` object with your data (matching `report-data.schema.json`).
3. Open in a browser or save as HTML.

For automated substitution, see [Template Placeholders Not Replaced](#template-placeholders-not-replaced).

### Option 2: Programmatic (Node.js or browser)

```html
<script type="module">
import { renderReport } from './report-renderer.js';

const data = {
  title: "My Report",
  generatedAt: new Date().toISOString(),
  metrics: [
    { label: "Items", value: "42", status: "healthy" }
  ],
  sections: [
    {
      title: "Details",
      type: "table",
      headers: ["Name", "Status"],
      rows: [
        ["Alpha", { value: "OK", status: "healthy" }],
        ["Beta", { value: "Degraded", status: "warning" }]
      ]
    }
  ]
};

document.body.innerHTML = renderReport(data);
</script>
```

### Option 3: Server-side (Node.js — no DOM required)

```js
import { renderReport } from './report-kit/report-renderer.js';
import { writeFileSync } from 'fs';

const html = renderReport(data);
writeFileSync('report.html', html);
```

### Option 4: Open the sample

Open `sample-report.html` in a browser to see a complete fleet health report with real fleet data.

## Files

| File | Purpose |
|------|---------|
| `report-renderer.js` | ES module — call `renderReport(data)` to get a complete HTML document string |
| `report-data.schema.json` | JSON Schema (draft-07) for the data contract |
| `template.html` | Standalone HTML template with placeholder data — copy and fill in |
| `sample-report.html` | Working sample (fleet health report with real fleet data) |
| `sample-data-devin-deepwiki.json` | Machine-readable sample data contract (Devin/DeepWiki research report) |
| `report-kit.test.mjs` | QA regression test suite (Node.js native `node:test` runner) — validates renderer syntax, schema, sample data, template placeholders, zip integrity, and README presence |
| `README.md` | This file |
| `report-kit.zip` | Archive of all 6 content files (excludes the QA test suite `report-kit.test.mjs`) for distribution |

## Running Tests

The QA regression suite uses Node.js native `node:test` (no external deps required):

```sh
node --test report-kit/report-kit.test.mjs
```

All 12 tests should pass. This validates:

1. `report-renderer.js` valid JS syntax and ES module exports
2. `escapeHtml` is pure-JS (no DOM dependency)
3. XSS prevention — `<script>` tags are HTML-escaped in output
4. JSON Schema draft-07 validity and required fields
5. Sample data validates against schema
6. Template placeholder tokens (9 occurrences, 8 unique)
7. End-to-end render from sample data (16,581 chars, div-balanced)
8. End-to-end render from fleetHealthData (19,706 chars)
9. Deterministic output for varying inputs
10. ZIP archive signature validation
11. ZIP contents match on-disk source files (prevents stale zip)
12. README documentation coverage

## API Reference

### `renderReport(data)`

```ts
renderReport(data: ReportData): string
```

Renders a complete HTML document (including `<!DOCTYPE html>`, `<html>`, `<head>`, and `<body>`) from a `ReportData` object matching `report-data.schema.json`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | `string` | Yes | Report heading, displayed as the main `<h1>` |
| `generatedAt` | `string` | Yes | ISO 8601 timestamp; rendered in the header |
| `metrics` | `MetricCard[]` | Yes | Key-value metric cards displayed in a responsive grid at the top of the report (minItems: 1) |
| `sections` | `Section[]` | Yes | Array of content sections forming the report body (minItems: 1) |
| `subtitle` | `string` | No | Subtext shown below the title |
| `version` | `string` | No | Report version string (default: `"1.0.0"`) |
| `manifest` | `Manifest` | No | Manifest ledger strip (generatedBy, source, checksum, counts) |
| `guardrail` | `Guardrail` | No | Guardrail footer (version, environment, notes) |

**Returns:** A complete HTML document string (1,400–20,000+ chars depending on data).

**Error behavior:** `renderReport` does not validate input against the schema. Missing required fields produce empty output in the affected areas (e.g., an empty `metrics` array renders no metric cards). Unknown section types are silently skipped. Always validate data with the schema before rendering — see [Schema Validation](#schema-validation).

### Data Contract

Full schema: `report-data.schema.json` (JSON Schema draft-07, `$id: https://paperclip.nousresearch.com/schemas/report-data.json`).

#### `MetricCard`

| Field | Type | Required | Status Values |
|-------|------|----------|---------------|
| `label` | `string` | Yes | Metric label (e.g. `"Agents"`, `"Uptime (7d)"`) |
| `value` | `string \| number` | Yes | Metric value (e.g. `"22"`, `"99.7%"`) |
| `status` | `enum` | Yes | `healthy`, `warning`, `critical`, `unknown` |
| `detail` | `string` | No | Sub-text shown below the value in smaller font |

#### `Section`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Section heading |
| `type` | `enum` | Yes | One of: `table`, `list`, `text`, `metrics-grid` |
| `description` | `string` | No | Explanatory text above the content |
| `headers` | `string[]` | Table only | Column headers |
| `rows` | `Cell[][]` | Table only | Table rows — each cell is a string or `{ value, status }` |
| `items` | `{ label, value, status }[]` | list/metrics-grid | List items or metric grid items |
| `body` | `string` | text only | Paragraph text (separate paragraphs with `\n\n`) |

#### Status Values

| Status | Visual | Use case |
|--------|--------|----------|
| `healthy` | Green checkmark circle | Everything is operational |
| `warning` | Amber warning triangle | Degraded but functional |
| `critical` | Red X circle | Requires immediate attention |
| `unknown` | Gray question circle | State could not be determined (fail-open default) |

When `status` is omitted or unrecognized, the renderer falls back to `unknown` (gray question circle). This is a deliberate fail-open default — never omit `status` if you know the real state.

#### Table Cell Status

For table cells, pass `{ value: "text", status: "healthy" }` instead of a plain string to get a status-colored dot indicator. Plain strings are rendered as-is without a dot.

Cells that are plain strings (no `{ value, status }` object) render without any status dot — useful for columns like "Agent" or "Role" where status isn't meaningful.

#### `Manifest`

Optional ledger strip at the bottom of the report, above the guardrail footer.

| Field | Type | Description |
|-------|------|-------------|
| `generatedBy` | `string` | Agent/person who generated the report |
| `source` | `string` | Data source (e.g. `"Paperclip API · Fleet Health Check"`) |
| `checksum` | `string` | SHA-256 or other hash of the source payload |
| `counts` | `object` | Key-value pairs shown as compact ledger items |

If `counts` is provided, its keys are rendered as uppercase labels in the ledger strip. Values are rendered in monospace font.

#### `Guardrail`

Optional footer with provenance metadata.

| Field | Type | Description |
|-------|------|-------------|
| `version` | `string` | Report kit version (rendered as `vX.X.X`) |
| `environment` | `string` | Environment context (e.g. `"Aegis · macOS 26.4"`) |
| `notes` | `string` | Free-form notes (rendered in italics) |

All three fields are optional. If none are provided, no guardrail footer renders.

## Section Types

### `table`

Renders a styled table with status-colored cell dots.

```js
{
  title: "Agent Status",
  type: "table",
  description: "Current status of all fleet agents by role",
  headers: ["Agent", "Role", "Status", "Uptime", "Last Active"],
  rows: [
    ["Coordinator", "PM", { value: "Active", status: "healthy" }, "14d", "2 min ago"],
    ["Press", "WordPress", { value: "Idle", status: "warning" }, "2d", "45 min ago"]
  ]
}
```

### `list`

Renders a status list with botanical SVG icons.

```js
{
  title: "Memory Plane Health",
  type: "list",
  description: "Status of all active memory planes",
  items: [
    { label: "OB1", value: "Online · 1,024 dim", status: "healthy" },
    { label: "Honcho", value: "Online · API v3", status: "healthy" }
  ]
}
```

### `text`

Renders paragraph text (supports `\n\n` paragraph separation).

```js
{
  title: "Recent Activity",
  type: "text",
  description: "Summary of the last hour of fleet operations",
  body: "The fleet processed 14 task heartbeats in the last hour.\n\nProvider auth failures are expected in the cron environment."
}
```

### `metrics-grid`

Renders a grid of small metric cards (same as top-level metrics but in a section).

```js
{
  title: "Issue Distribution by Priority",
  type: "metrics-grid",
  description: "Open issues broken down by priority level",
  items: [
    { label: "Critical", value: "2", status: "critical" },
    { label: "High", value: "4", status: "warning" },
    { label: "Medium", value: "4", status: "healthy" },
    { label: "Low", value: "2", status: "healthy" }
  ]
}
```

### Choosing a Section Type

Use this decision guide to pick the right section type for your content:

| When you need to show… | Use this type | Why |
|------------------------|---------------|-----|
| Tabular data with columns (agent names, provider names, etc.) | `table` | Best for structured data with headers; supports status dots in cells |
| A simple list of labeled items with status | `list` | Compact, botanical icons convey status at a glance; good for key-value-style lists |
| Multi-paragraph narrative text | `text` | Supports `\n\n` paragraph breaks; ideal for summary narratives and descriptions |
| A small set of related metric cards | `metrics-grid` | Same card styling as top-level metrics; good for breakdowns (by priority, by region, etc.) |

**Composition tips:**
- `metrics` (top-level) + `metrics-grid` sections: Use top-level metrics for the 3–6 headline numbers, and `metrics-grid` sections for breakdowns of those numbers.
- `table` + `list` mixed: Tables for "what is broken," lists for "what is healthy."
- `text` sections as glue: Insert text sections between data-heavy sections to provide narrative context.

## Common Report Templates

### Fleet Health Report

A top-level metrics summary followed by detail sections:

```js
const data = {
  title: "Fleet Health Report",
  subtitle: "Aegis Cluster · 22 agents · 2026-08-04",
  generatedAt: new Date().toISOString(),
  version: "1.0.0",
  metrics: [
    { label: "Agents", value: "22", status: "healthy", detail: "21 active · 1 idle" },
    { label: "Uptime (7d)", value: "99.7%", status: "healthy", detail: "3 min downtime" },
    { label: "Queue Depth", value: "8", status: "critical", detail: "5 unassigned" }
  ],
  sections: [
    {
      title: "Agent Status",
      type: "table",
      description: "Current status of all fleet agents by role",
      headers: ["Agent", "Role", "Status", "Uptime", "Last Active"],
      rows: [
        ["Coordinator", "PM", { value: "Active", status: "healthy" }, "14d", "2 min ago"],
        ["Forge", "Backend", { value: "Active", status: "healthy" }, "14d", "5 min ago"]
      ]
    },
    {
      title: "Memory Plane Health",
      type: "list",
      description: "Status of all active memory planes",
      items: [
        { label: "OB1", value: "Online · 1,024 dim", status: "healthy" },
        { label: "Hindsight", value: "Online · bank: hermes", status: "healthy" }
      ]
    }
  ],
  manifest: {
    generatedBy: "Quill (hermes_local) · Paperclip Agent d839443a",
    source: "Paperclip API · Fleet Health Check",
    checksum: "sha256:a1b2c3d4e5f6...",
    counts: {
      "Total Agents": "22",
      "Open Issues": "12"
    }
  },
  guardrail: {
    version: "1.0.0",
    environment: "Aegis · macOS 26.4",
    notes: "Auto-generated from cron heartbeat"
  }
};
```

### Audit Narrative

A text-heavy report with a summary at the top:

```js
const data = {
  title: "Audit Narrative — JAC-3929",
  subtitle: "Fleet-wide AI Token & Run Observatory",
  generatedAt: new Date().toISOString(),
  metrics: [
    { label: "Findings", value: "12", status: "warning", detail: "3 require Jack approval" },
    { label: "Open Questions", value: "5", status: "critical" },
    { label: "Recommendations", value: "8", status: "healthy" }
  ],
  sections: [
    {
      title: "Executive Summary",
      type: "text",
      body: "This audit covers the token & run observatory initiative. Three findings require Jack's explicit approval before proceeding.\n\nThe remaining items can be resolved by existing agents without escalation."
    },
    {
      title: "Finding Severity",
      type: "metrics-grid",
      items: [
        { label: "P0 — Critical", value: "2", status: "critical" },
        { label: "P1 — High", value: "4", status: "warning" },
        { label: "P2 — Medium", value: "3", status: "healthy" },
        { label: "P3 — Low", value: "3", status: "healthy" }
      ]
    }
  ]
};
```

### Telemetry Summary

A data-dense report using multiple table sections:

```js
const data = {
  title: "Telemetry Summary — 2026-08-04",
  generatedAt: new Date().toISOString(),
  metrics: [
    { label: "Providers Checked", value: "7", status: "healthy" },
    { label: "Auth Failures", value: "3", status: "critical", detail: "Expected in cron" },
    { label: "Avg Latency", value: "120ms", status: "healthy" }
  ],
  sections: [
    {
      title: "Provider Connectivity",
      type: "table",
      headers: ["Provider", "Status", "Latency", "Quota Remaining"],
      rows: [
        ["ollama-cloud", { value: "Online", status: "healthy" }, "120ms", "85%"],
        ["openai-codex", { value: "Auth Error", status: "critical" }, "—", "0%"]
      ]
    }
  ]
};
```

## Design System

Warm parchment palette with botanical SVG status indicators:

| Token | Value | Use |
|-------|-------|-----|
| `--bg-page` | `#f5f0e8` | Page background |
| `--bg-card` | `#faf7f0` | Card surfaces (manifest, metric cards) |
| `--bg-surface` | `#ffffff` | Section surfaces |
| `--text-primary` | `#2c2416` | Primary text |
| `--text-secondary` | `#6b5d4a` | Secondary text |
| `--text-muted` | `#9a8b78` | Muted captions |
| `--border` | `#e0d6c4` | Section borders |
| `--border-light` | `#ede5d6` | Inner borders |
| `--accent` | `#7a6b4e` | Accent color |
| `--accent-light` | `#e8dfce` | Accent background (used in some hover states) |
| `--shadow` | `0 1px 3px rgba(44,36,22,0.08), 0 1px 2px rgba(44,36,22,0.06)` | Card shadow |
| `--shadow-lg` | `0 4px 12px rgba(44,36,22,0.1)` | Hover card shadow |
| `--radius` | `8px` | Section/card border radius |
| `--radius-sm` | `4px` | Small radius |
| `--font-sans` | `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | Body font stack |
| `--font-mono` | `'JetBrains Mono', 'SF Mono', 'Fira Code', monospace` | Code font stack |

Fonts: Inter (sans-serif, v4.1 variable) + JetBrains Mono (monospace).

**Responsive:** Design is mobile-first. Below 640px viewport, metric cards switch to 2-column grid, manifest ledger stacks vertically, and guardrail footer wraps.

## Deployment

### Static hosting

Report Kit output is a single self-contained HTML file with inline CSS and inline SVG icons. It has no external dependencies at runtime (the Google Fonts `@import` is a progressive enhancement — the design falls back to system fonts if it fails).

Upload the rendered HTML to any static host: S3, Cloudflare Pages, GitHub Pages, Paperclip attachments, etc.

### Paperclip integration

For fleet reports that should be inspectable by board users, upload the rendered HTML via the Paperclip artifact helper:

```sh
# 1. Create a small render script (see report-renderer.js for the data contract)
cat > scripts/render-report.js <<'EOF'
import { renderReport } from '../report-kit/report-renderer.js';
import { writeFileSync } from 'node:fs';

const data = {
  title: "Fleet Health Report",
  generatedAt: new Date().toISOString(),
  metrics: [
    { label: "Agents healthy", value: "21/22", status: "healthy" },
    { label: "Memory planes", value: "4/4 ok", status: "healthy" }
  ],
  sections: [
    {
      title: "Recent activity",
      type: "text",
      body: "All systems nominal."
    }
  ]
};

writeFileSync('dist/fleet-health.html', renderReport(data));
console.log('Wrote dist/fleet-health.html');
EOF

# 2. Render and upload
node scripts/render-report.js
skills/paperclip/scripts/paperclip-upload-artifact.sh dist/fleet-health.html \
  --title "Fleet health report" \
  --summary "Render for board review"
```

The uploaded attachment is served inline-safe (HTML is in the default upload allowlist). For archive distribution, zip all 6 content files:

```sh
cd report-kit && zip -r report-kit.zip report-renderer.js report-data.schema.json template.html sample-report.html sample-data-devin-deepwiki.json README.md
```

### Headless / CI-CD

Report Kit renders server-side with Node.js — no browser or DOM required. This makes it ideal for CI/CD pipelines:

```yaml
# .github/workflows/report.yml
name: Generate Report
on:
  schedule:
    - cron: "0 * * * *"  # Hourly
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: node scripts/generate-report.js
      - uses: actions/upload-artifact@v4
        with:
          name: fleet-report
          path: dist/report.html
```

The `renderReport` function is a pure function with no side effects — it can be called from any JavaScript runtime that supports ES modules (Node.js 18+, browsers, Bun, Deno).

### Cron Automation

For scheduled fleet reports, create a script that calls `renderReport` and uploads via the Paperclip artifact helper:

```sh
# crontab entry: hourly fleet health report
0 * * * * cd /Users/hermes/Projects/paperclip && \
  node scripts/render-report.js && \
  skills/paperclip/scripts/paperclip-upload-artifact.sh dist/fleet-health.html \
    --title "Fleet health report (hourly)" \
    --summary "Auto-generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

## Schema Validation

Validate your data against the schema before rendering. Report Kit's `renderReport` does not validate input — always validate first to catch contract errors early.

### CLI (ajv-cli)

```bash
# Requires ajv-cli (npm install -g ajv-cli)
npx ajv validate -s report-kit/report-data.schema.json -d your-data.json
```

### Node.js

```js
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync('./report-kit/report-data.schema.json', 'utf-8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(data)) {
  console.error('Schema validation failed:', validate.errors);
  process.exit(1);
}

const html = renderReport(data);
```

> **Note:** The `assert { type: 'json' }` import assertion syntax is deprecated in modern Node.js. Use `readFileSync` + `JSON.parse` instead (as shown above).

## Troubleshooting

### ES Module Import Errors

**Symptom:** `renderReport is not a function` or `SyntaxError: Cannot use import statement outside a module`

You are likely importing from the wrong path or using CommonJS `require()` on an ES module. Report Kit uses ES module syntax — use `import` or `import()` dynamic import:

```js
// ✅ ES module
import { renderReport } from './report-kit/report-renderer.js';

// ✅ Dynamic import in CommonJS
const { renderReport } = await import('./report-kit/report-renderer.js');

// ❌ Will not work
const { renderReport } = require('./report-kit/report-renderer.js');
```

**Node.js without `"type": "module"`:** If your project doesn't have `"type": "module"` in `package.json`, rename your script to `.mjs` or use dynamic `import()`.

### Unstyled Output

**Symptom:** Raw HTML tags or unstyled content visible in the rendered output.

Ensure you are using the return value of `renderReport()` as `innerHTML` or writing it directly to a file. The function returns a complete HTML document including `<!DOCTYPE html>`, `<style>`, and `<body>` — it is not a fragment.

```js
// ✅ In browser
document.body.innerHTML = renderReport(data);

// ✅ To file
import { writeFileSync } from 'node:fs';
writeFileSync('report.html', renderReport(data));
```

### SVG Icons Not Rendering

The botanical SVG symbols are inline in the output. They require `fill="none" stroke="currentColor"` attribute support, which all modern browsers provide. If rendering via a headless service, ensure it supports inline SVG.

### Font Loading Issues

The design uses `font-family` tokens with system-font fallbacks. If the Google Fonts CDN is unreachable, the report renders with `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` (macOS/Windows) and `monospace` fallbacks for code font. The visual design degrades gracefully.

### Schema Validation Errors

Common issues:

- **Missing `generatedAt`**: Must be ISO 8601 (e.g. `new Date().toISOString()`).
- **Missing `metrics`**: Must have at least one item (minItems: 1).
- **Missing `sections`**: Must have at least one item (minItems: 1).
- **Invalid `status` value**: Must be exactly `healthy`, `warning`, `critical`, or `unknown`.
- **Invalid `type` value**: Must be exactly `table`, `list`, `text`, or `metrics-grid`.
- **Missing section-type fields**: A `table` section needs `headers` and `rows`; a `list` or `metrics-grid` section needs `items`; a `text` section needs `body`.

Use `ajv` with `allErrors: true` to catch all issues at once (see [Schema Validation](#schema-validation)).

### Template Placeholders Not Replaced

**Symptom:** Report shows `{{TITLE}}`, `{{SECTION_1_TITLE}}`, etc. in the output.

The `template.html` file uses `{{PLACEHOLDER}}` tokens as documentation examples — they are not automatically replaced. You must replace them with your real data. Two approaches:

1. **Manual:** Edit `template.html` directly, replacing each `{{TOKEN}}` with your content, then open in a browser.
2. **Automated:** Use `sed` or a script to substitute tokens before rendering:

```bash
# Example: replace all placeholders in a copy of template.html
cp report-kit/template.html dist/my-report.html
sed -i '' \
  -e 's/{{TITLE}}/Fleet Health Report/g' \
  -e 's/{{SUBTITLE}}/Aegis Cluster · 2026-08-04/g' \
  -e 's/{{GENERATED_BY}}/Quill (hermes_local)/g' \
  dist/my-report.html
```

Or programmatically, generate the data object and call `renderReport()` directly (recommended — avoids placeholder tokens entirely).

### Empty Metrics or Sections

**Symptom:** Report renders but the metrics grid or sections area is blank.

The schema requires at least one item in both `metrics` and `sections` arrays (`minItems: 1`). If either is empty, the report will still render but the corresponding area will be blank. Always validate data before rendering.

### Invalid Row Structure in Tables

**Symptom:** Table cells render as `[object Object]` or display `[object Object]` instead of the value.

Table `rows` must be arrays of cells, where each cell is either a plain string or `{ value, status }`. If you pass a plain object without the `value` key (e.g., `{ status: "healthy" }`), the renderer will output `[object Object]`.

```js
// ✅ Correct
rows: [["Agent A", { value: "OK", status: "healthy" }]]

// ❌ Incorrect — missing `value` key
rows: [["Agent A", { status: "healthy" }]]
```

## Verification

### Verification Battery

Report Kit ships a standard verification battery that agents can source for
independent re-verification:

```sh
./scripts/verify-report-kit.sh
```

This script performs six deterministic checks:
1. Git diff is clean for `report-kit/`
2. `report-renderer.js` passes `node --check` (syntax validation)
3. QA test suite passes (`node --test report-kit/report-kit.test.mjs`)
4. `report-kit.zip` integrity via `unzip -t`
5. SHA-256 match between `report-kit.zip` on disk and `git show HEAD`
6. End-to-end render from `sample-data-devin-deepwiki.json` (smoke test)

### CI Checks

The following checks run in the PR workflow (`.github/workflows/pr.yml` →
policy job):

| Check | Script | Purpose |
|-------|--------|---------|
| Report-kit zip freshness (O3) | `scripts/check-report-kit-zip.mjs` | Fails if `report-kit.zip` contents differ from on-disk source files |
| Hermes adapter config lint (O6) | `scripts/check-hermes-adapter-config.mjs` | Rejects `hermes_local` agents with empty `adapterConfig` or `model="auto"` |

## Changelog

### v1.2.5 (2026-08-04)
|- **Test**: Added zip content-integrity test (`report-kit.zip contents match current source files`) to the QA suite — automatically catches stale zip archives by comparing file count, entries, and uncompressed sizes between `report-kit.zip` and on-disk source files. This prevents the recurring stale-zip defect (v1.2.2 → v1.2.3 → v1.2.4) where README updates were committed without rebuilding the archive. Test suite now has 12 tests (was 11).

### v1.2.4 (2026-08-04)
|- **Fix**: Corrected the `report-kit.zip` row in the Files table — README text stated the zip "excludes tests and this README" but the zip includes README.md (6 files: 5 source files + README; excludes only `report-kit.test.mjs`). Updated description to "Archive of all 6 content files (excludes the QA test suite report-kit.test.mjs) for distribution".
|- **Fix**: Rebuilt `report-kit.zip` to include the corrected README.md.

### v1.2.3 (2026-08-04)
|- **Fix**: Rebuilt `report-kit.zip` to include the updated README.md (v1.2.2 content). The previous zip contained the stale v1.2.1 README despite the v1.2.2 documentation changes being committed to the repo.

### v1.2.2 (2026-08-04)
- **Docs**: Added "Running Tests" section with `node --test` command and full test catalog (11 tests covering syntax, XSS, schema, render, zip, README).
- **Docs**: Corrected test runner identification — the suite uses Node.js native `node:test` (not Vitest), despite both being supported in the repo. Updated Files table and changelog entries accordingly.

### v1.2.1 (2026-08-04)
- **Fix**: Updated Files table and deployment instructions to reflect 6 content files (was 5) — `sample-data-devin-deepwiki.json` was added to the kit but not listed.
- **Fix**: ZIP rebuild command now includes `sample-data-devin-deepwiki.json`.
- **Docs**: Added `report-kit.test.mjs` to the Files table — the QA regression test suite was previously omitted from documentation despite being part of the kit.

### v1.2.0 (2026-08-04)

- **Docs**: Enhanced README with table of contents, section type decision guide, common report templates (fleet health, audit narrative, telemetry summary), headless/CI-CD deployment patterns, cron automation guide, expanded troubleshooting (ES Module import errors, empty metrics/sections, invalid row structure, deprecated `assert` syntax), and full design system token documentation (including `--accent-light`, `--font-sans`, and `--font-mono` tokens).
- **Docs**: Clarified `renderReport` error behavior — the function does not validate input; consumers should validate with the schema first.
- **Docs**: Removed deprecated `assert { type: 'json' }` import syntax from validation example; replaced with `readFileSync` + `JSON.parse` approach.

### v1.1.0 (2026-08-04)

- **Fix**: Replaced `escapeHtml` DOM-based implementation with pure-JS string replacements. The original used `document.createElement` which crashes in Node.js/SSR/test environments. The new implementation is a pure function that works everywhere.
- **Docs**: Expanded README with full API reference, section type guide, troubleshooting, and deployment patterns.

### v1.0.0 (2026-08-03)

- Initial release as reusable template for Fable-5-quality reports.
- Includes `report-renderer.js` (ES module `renderReport(data)` function), `report-data.schema.json` (JSON Schema draft-07), `template.html` (standalone with placeholders), `sample-report.html` (fleet health sample with real fleet data), and `report-kit.zip` archive.
- Warm parchment design system with botanical SVG status indicators, metric cards, tables, manifest ledger, and guardrail footer.
- Responsive down to 640px viewport width.

## License

Internal use. Part of the Paperclip fleet toolchain.
