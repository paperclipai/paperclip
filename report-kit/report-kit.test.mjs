/**
 * Sentry QA regression tests for JAC-3679 report-kit template.
 *
 * These tests provide deterministic, reproducible verification of the
 * report-kit deliverables so regressions are caught in CI.
 *
 * Run: node --test report-kit/report-kit.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// __dirname equivalent for .mjs — this file lives inside report-kit/
const __dirname = fileURLToPath(new URL(".", import.meta.url));

async function loadRenderer() {
  return import(pathToFileURL(`${__dirname}/report-renderer.js`));
}

function readJson(filename) {
  return JSON.parse(readFileSync(`${__dirname}/${filename}`, "utf8"));
}

function readText(filename) {
  return readFileSync(`${__dirname}/${filename}`, "utf8");
}

test("report-renderer.js has valid JS syntax", async () => {
  const renderer = await loadRenderer();
  assert.equal(typeof renderer.renderReport, "function");
});

test("report-renderer.js escapeHtml is pure-JS (no DOM dependency)", () => {
  const src = readText("report-renderer.js");
  const implMatch = src.match(/function escapeHtml[\s\S]*?\n\}/);
  assert.ok(implMatch, "escapeHtml function should be found");
  const impl = implMatch[0];
  assert.equal(impl.includes("document."), false, "escapeHtml must not reference document");
  assert.equal(impl.includes("createElement"), false, "escapeHtml must not use createElement");
  assert.equal(impl.includes(".replace("), true, "escapeHtml should use .replace() chains");
});

test("report-renderer.js escapeHtml correctly escapes HTML entities", async () => {
  const renderer = await loadRenderer();
  // escapeHtml is not exported, but it should be present in the module source.
  // We verify it works by calling renderReport and checking that user-supplied
  // data is properly escaped (no XSS leakage)
  const html = renderer.renderReport({
    title: "<script>alert(1)</script>",
    generatedAt: "2026-08-04T00:00:00Z",
    metrics: [{ label: "Test", value: 1, status: "healthy" }],
    sections: [],
  });
  assert.equal(html.includes("<script>alert(1)</script>"), false, "raw script tag should not appear unescaped");
  assert.ok(html.includes("&lt;script&gt;"), "script tag should be HTML-escaped");
});

test("report-data.schema.json is valid JSON Schema draft-07", () => {
  const schema = readJson("report-data.schema.json");
  assert.equal(schema["$schema"], "http://json-schema.org/draft-07/schema#");
  assert.equal(schema["title"], "Report Data Contract");
  assert.deepEqual(schema["required"], ["title", "generatedAt", "metrics", "sections"]);
  assert.ok(schema.properties, "schema must define properties");
  assert.equal(schema.properties.sections.minItems, 1, "sections must contain at least one item");
  assert.deepEqual(schema.properties.metrics.items.properties.status.enum, ["healthy", "warning", "critical", "unknown"]);
  assert.ok(Array.isArray(schema.properties.sections.items.oneOf), "sections must be a oneOf of typed section schemas");
  assert.equal(schema.properties.sections.items.oneOf.length, 4, "sections must support four content types");
  const sectionTypes = schema.properties.sections.items.oneOf.map((s) => s.properties.type.const);
  assert.deepEqual(sectionTypes, ["table", "list", "metrics-grid", "text"], "section oneOf must define table, list, metrics-grid, and text");
});

test("sample-data-devin-deepwiki.json validates against schema", () => {
  const data = readJson("sample-data-devin-deepwiki.json");

  assert.ok(Array.isArray(data.metrics) && data.metrics.length > 0, "metrics must be a non-empty array");
  for (const m of data.metrics) {
    assert.ok(m.label, "each metric must have a label");
    assert.ok(m.value !== undefined, "each metric must have a value");
    assert.ok(["healthy", "warning", "critical", "unknown"].includes(m.status), `invalid status: ${m.status}`);
  }

  assert.ok(Array.isArray(data.sections) && data.sections.length > 0, "sections must be a non-empty array");
  for (const s of data.sections) {
    assert.ok(s.title, "each section must have a title");
    assert.ok(["table", "list", "text", "metrics-grid"].includes(s.type), `invalid section type: ${s.type}`);

    if (s.type === "table") {
      assert.ok(Array.isArray(s.headers) && s.headers.length > 0, "table section must have headers");
      assert.ok(Array.isArray(s.rows) && s.rows.length > 0, "table section must have rows");
      for (let i = 0; i < s.rows.length; i++) {
        assert.equal(s.rows[i].length, s.headers.length,
          `table row ${i} must have the same number of cells as headers`);
      }
    } else if (s.type === "list" || s.type === "metrics-grid") {
      assert.ok(Array.isArray(s.items) && s.items.length > 0, `${s.type} section must have items`);
    } else if (s.type === "text") {
      assert.ok(typeof s.body === "string" && s.body.length > 0, "text section must have a non-empty body");
    }
  }

  assert.ok(!isNaN(Date.parse(data.generatedAt)), "generatedAt must be a valid date-time");
});

test("template.html contains expected placeholder tokens", () => {
  const html = readText("template.html");
  assert.ok(html.includes("<!DOCTYPE html>"), "template should have DOCTYPE");
  assert.ok(html.includes("{{TITLE}}"), "template should have TITLE token");
  assert.ok(html.includes("{{SUBTITLE}}"), "template should have SUBTITLE token");
  assert.ok(html.includes("{{GENERATED_BY}}"), "template should have GENERATED_BY token");
  assert.ok(html.includes("{{SOURCE}}"), "template should have SOURCE token");
  assert.ok(html.includes("{{CHECKSUM}}"), "template should have CHECKSUM token");
  assert.ok(html.includes("{{GUARDRAIL_VERSION}}"), "template should have GUARDRAIL_VERSION token");
  assert.ok(html.includes("{{ENVIRONMENT}}"), "template should have ENVIRONMENT token");
  assert.ok(html.includes("{{NOTES}}"), "template should have NOTES token");

  const tokenCount = (html.match(/{{[A-Z_]+}}/g) || []).length;
  assert.equal(tokenCount, 9, `expected 9 token occurrences, got ${tokenCount}`);
});

test("renderReport produces a complete HTML document from sample data", async () => {
  const { renderReport } = await loadRenderer();
  const data = readJson("sample-data-devin-deepwiki.json");

  const html = renderReport(data);

  assert.ok(html.startsWith("<!DOCTYPE html>"), "output should start with DOCTYPE");
  assert.ok(html.includes("</html>"), "output should end with closing html tag");
  assert.ok(html.includes(data.title), "output should contain the report title");

  const metricCardCount = (html.match(/class="metric-card"/g) || []).length;
  assert.equal(metricCardCount, data.metrics.length, `expected ${data.metrics.length} metric cards, got ${metricCardCount}`);

  assert.equal(html.includes("{{"), false, "no unresolved template tokens should remain");
  assert.equal(html.includes("[object"), false, "no [object] string artifacts");

  const divOpens = (html.match(/<div\b/g) || []).length;
  const divCloses = (html.match(/<\/div>/g) || []).length;
  assert.equal(divOpens, divCloses, `div balance: ${divOpens} opens vs ${divCloses} closes`);

  const svgCount = (html.match(/<svg/g) || []).length;
  assert.ok(svgCount > 0, "should have SVG status indicators");
  assert.ok(html.length > 5000, `output too short: ${html.length} chars`);
});

test("renderReport handles the fleetHealth dataset from sample-report.html", async () => {
  const { renderReport } = await loadRenderer();
  const sampleHtml = readText("sample-report.html");

  const startIdx = sampleHtml.indexOf("const fleetHealthData = {");
  const endIdx = sampleHtml.indexOf("};", startIdx);
  const objBlock = sampleHtml.substring(startIdx, endIdx + 1);
  const fleetData = eval("(" + objBlock.replace("const fleetHealthData = ", "").replace(/;$/, "") + ")");

  const html = renderReport(fleetData);

  assert.ok(html.length > 10000, `output too short: ${html.length} chars`);
  assert.ok(html.includes(fleetData.title), "should contain the fleet health title");

  const metricCardCount = (html.match(/class="metric-card"/g) || []).length;
  // fleetHealthData has 6 top-level metrics + 4 metrics-grid items = 10 metric cards
  assert.equal(metricCardCount, 10, `expected 10 metric cards (6 top-level + 4 grid)`);

  const tables = (html.match(/class="report-table"/g) || []).length;
  const tableSections = fleetData.sections.filter(s => s.type === "table").length;
  assert.equal(tables, tableSections, `expected ${tableSections} tables`);

  const listItems = (html.match(/<li\b/g) || []).length;
  assert.ok(listItems > 0, "should have list items");

  assert.ok(html.includes("JAC-3679"), "should contain JAC-3679 reference");
  assert.equal(html.includes("{{"), false, "no unresolved template tokens");
  assert.equal(html.includes("[object"), false, "no [object] artifacts");

  const divOpens = (html.match(/<div\b/g) || []).length;
  const divCloses = (html.match(/<\/div>/g) || []).length;
  assert.equal(divOpens, divCloses, `div balance: ${divOpens} opens vs ${divCloses} closes`);
});

test("renderReport produces different output for different inputs", async () => {
  const { renderReport } = await loadRenderer();
  const dataA = readJson("sample-data-devin-deepwiki.json");
  const dataB = { ...dataA, title: "Different Title For Testing" };

  const htmlA = renderReport(dataA);
  const htmlB = renderReport(dataB);

  assert.notEqual(htmlA, htmlB, "different inputs should produce different output");
  assert.ok(htmlB.includes("Different Title For Testing"), "modified title should appear in output");
});

test("report-kit.zip is a valid archive with ZIP signature", () => {
  const zipBuffer = readFileSync(`${__dirname}/report-kit.zip`);
  assert.equal(zipBuffer[0], 0x50, "ZIP file should start with 'P'");
  assert.equal(zipBuffer[1], 0x4b, "ZIP file should start with 'K'");
  assert.equal(zipBuffer[2], 0x03, "ZIP file should have local file header signature");
  assert.equal(zipBuffer[3], 0x04, "ZIP file should have local file header signature");
});

test("report-kit.zip contents match current source files (prevents stale zip)", async () => {
  // O3 improvement: verify the zip archive's contents match the actual
  // source files on disk, so a stale zip is caught automatically rather
  // than by manual agent re-verification.
  // Uses the standard `zipinfo` tool (available on macOS/Linux) to list
  // the archive's entries without extraction.
  const { execSync } = await import("node:child_process");
  const zipPath = `${__dirname}/report-kit.zip`;

  // Source files that must be present in the zip (excluding the test suite
  // and the zip itself, per the README Files table).
  const expectedFiles = [
    "report-renderer.js",
    "report-data.schema.json",
    "template.html",
    "sample-report.html",
    "sample-data-devin-deepwiki.json",
    "README.md",
  ];

  // List zip entries
  const listing = execSync(`zipinfo -1 ${zipPath}`, { encoding: "utf8" });
  const entries = listing.split("\n").map((e) => e.trim()).filter(Boolean);

  assert.equal(entries.length, expectedFiles.length,
    `expected ${expectedFiles.length} entries in zip, got ${entries.length}: ${JSON.stringify(entries)}`);

  for (const expected of expectedFiles) {
    const found = entries.some((e) => e === expected);
    assert.ok(found, `zip should contain "${expected}" but entries are: ${JSON.stringify(entries)}`);

    // Verify zip entry matches the on-disk file by content (CRC/size check).
    // zipinfo gives us sizes; we compare against actual file sizes on disk.
    const fileInfo = entries.find((e) => e === expected);
    assert.ok(fileInfo, `zip entry "${expected}" not found in listing`);
  }

  // Verify each expected file's bytes match between zip and disk
  for (const expected of expectedFiles) {
    const diskContent = readFileSync(`${__dirname}/${expected}`);
    const zipContent = execSync(`unzip -p "${zipPath}" "${expected}"`);
    assert.ok(zipContent.equals(diskContent),
      `"${expected}": zip content differs from disk content — zip is stale`);
  }
});

test("README.md contains usage documentation", () => {
  const readme = readText("README.md");
  assert.ok(readme.length > 1000, "README should be substantial");
  assert.ok(readme.includes("renderReport"), "README should document renderReport");
  assert.ok(readme.includes("report-data.schema.json"), "README should reference the schema");
  assert.ok(readme.includes("report-renderer.js"), "README should reference the renderer");
});
