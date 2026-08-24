import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import test from "node:test";
import { runCheck } from "./check-report-kit-zip.mjs";

function makeZip(dir, files) {
  // Write files first
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  // Build zip using zip CLI
  const names = Object.keys(files).join(" ");
  execSync(`cd ${dir} && zip -r report-kit.zip ${names}`, { stdio: "ignore" });
}

test("check-report-kit-zip passes when zip matches disk", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "zip-pass-"));
  try {
    const dir = path.join(tmpRoot, "report-kit");
    mkdirSync(dir, { recursive: true });

    const files = {
      "report-renderer.js": "export const x = 1;\n",
      "report-data.schema.json": '{"$schema":"http://json-schema.org/draft-07/schema#"}',
      "template.html": "<html>{{TITLE}}</html>",
      "sample-report.html": "<html>sample</html>",
      "sample-data-devin-deepwiki.json": '{"title":"test"}',
      "README.md": "# Report Kit\n",
    };
    makeZip(dir, files);

    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      zipDir: dir,
      zipPath: path.join(dir, "report-kit.zip"),
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("fresh")));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("check-report-kit-zip fails when zip content differs from disk", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "zip-fail-"));
  try {
    const dir = path.join(tmpRoot, "report-kit");
    mkdirSync(dir, { recursive: true });

    // Write disk files with NEW README content
    writeFileSync(path.join(dir, "report-renderer.js"), "export const x = 1;\n");
    writeFileSync(path.join(dir, "report-data.schema.json"), '{"v":1}');
    writeFileSync(path.join(dir, "template.html"), "<html>{{TITLE}}</html>");
    writeFileSync(path.join(dir, "sample-report.html"), "<html>sample</html>");
    writeFileSync(path.join(dir, "sample-data-devin-deepwiki.json"), '{"title":"test"}');
    const tmpReadme = path.join(dir, "README.md");
    const newContent = "# Report Kit v2\nNewer content\n";
    writeFileSync(tmpReadme, newContent);

    // Build zip with OLD README content (stale)
    writeFileSync(tmpReadme, "# Report Kit\n"); // old content for zip
    const zipPath = path.join(dir, "report-kit.zip");
    execSync(`cd ${dir} && zip -r report-kit.zip report-renderer.js report-data.schema.json template.html sample-report.html sample-data-devin-deepwiki.json README.md`, { stdio: "ignore" });
    // Restore NEW content on disk
    writeFileSync(tmpReadme, newContent);

    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      zipDir: dir,
      zipPath,
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((l) => l.includes("README.md") && l.includes("stale")), "should report README.md as stale");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("check-report-kit-zip fails when zip is missing", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "zip-missing-"));
  try {
    const dir = path.join(tmpRoot, "report-kit");
    mkdirSync(dir, { recursive: true });

    const logs = [];
    const errors = [];
    // No zip created
    const code = runCheck({
      repoRoot: tmpRoot,
      zipDir: dir,
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((l) => l.includes("not found")));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("check-report-kit-zip fails on missing entry", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "zip-missing-entry-"));
  try {
    const dir = path.join(tmpRoot, "report-kit");
    mkdirSync(dir, { recursive: true });

    writeFileSync(path.join(dir, "report-renderer.js"), "export const x = 1;\n");
    writeFileSync(path.join(dir, "report-data.schema.json"), '{"v":1}');
    writeFileSync(path.join(dir, "template.html"), "<html></html>");
    // Missing sample-report.html, sample-data, README.md on disk and in zip
    const zipPath = path.join(dir, "report-kit.zip");
    execSync(`cd ${dir} && zip -r report-kit.zip report-renderer.js report-data.schema.json template.html`, { stdio: "ignore" });

    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      zipDir: dir,
      zipPath,
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((l) => l.includes("MISSING") || l.includes("mismatch")));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
