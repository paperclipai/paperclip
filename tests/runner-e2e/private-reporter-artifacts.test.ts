import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizePrivateReporterArtifacts } from "./private-reporter-artifacts.js";
import { inspectEmbeddedReport, packageEvidence } from "./evidence.js";
const roots: string[] = []; afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("redacts actual reporter sinks, rejects compressed HTML/blob secrets, and leaves independently observed product bytes unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "report-privacy-control-")); roots.push(root);
  const canary = "synthetic-private-cookie-723958234";
  for (const directory of ["snapshots", "playwright-output", "html-report", "blob-report"]) await mkdir(path.join(root, directory));
  for (const relative of ["playwright.log", "junit.xml", "playwright-output/error-context.md"]) await writeFile(path.join(root, relative), `HTTP429: provider unavailable; failed fill ${canary}\n`, { mode: 0o600 });
  // This is independent oracle input, deliberately not a diagnostic sink.
  await writeFile(path.join(root, "snapshots", "api-state.json"), JSON.stringify({ actualProductResponse: canary }));
  const raw = path.join(root, "report.json"); await writeFile(raw, JSON.stringify({ error: `failed fill ${canary}` }), { mode: 0o600 });
  const zip = path.join(root, "blob-report", "report.zip"); execFileSync("zip", ["-q", zip, "report.json"], { cwd: root });
  const html = `<html><script>window.playwrightReportBase64 = "data:application/zip;base64,${(await readFile(zip)).toString("base64")}"</script></html>`;
  await writeFile(path.join(root, "html-report", "index.html"), html);
  expect(await inspectEmbeddedReport(html, [canary])).toContain("exact secret");
  const issues = await sanitizePrivateReporterArtifacts(root, [canary]);
  expect(issues.filter(issue => issue.disposition === "redacted")).toHaveLength(3);
  expect(issues.filter(issue => issue.disposition === "omitted")).toHaveLength(2);
  expect(JSON.stringify(issues)).not.toContain(canary);
  for (const relative of ["playwright.log", "junit.xml", "playwright-output/error-context.md"]) { const safe = await readFile(path.join(root, relative), "utf8"); expect(safe).not.toContain(canary); expect(safe).toContain("HTTP429: provider unavailable"); }
  expect(await readdir(path.join(root, "blob-report"))).toEqual([]); expect(await readdir(path.join(root, "html-report"))).toEqual([]);
  expect(await readFile(path.join(root, "snapshots/api-state.json"), "utf8")).toContain(canary);
  const packaged = await packageEvidence({ privateDir: root, uploadDir: path.join(root, "uploaded"), secrets: [canary], expectPassScreenshot: false });
  // Product leakage still fails independently, despite sanitized diagnostics.
  expect(packaged.leaks).toContainEqual({ file: "snapshots/api-state.json", reason: "exact secret value" });
});
it("keeps clean inspectable reports, but refuses unknown embedded report encoding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "report-clean-control-")); roots.push(root);
  await mkdir(path.join(root, "html-report")); await writeFile(path.join(root, "html-report/index.html"), "<html>ordinary clean report</html>");
  expect(await sanitizePrivateReporterArtifacts(root, ["private-canary-6234"])).toEqual([]);
  expect(await readFile(path.join(root, "html-report/index.html"), "utf8")).toContain("ordinary clean report");
  await writeFile(path.join(root, "clean.json"), JSON.stringify({ error: "HTTP503 provider unavailable" }));
  const zip = path.join(root, "clean.zip"); execFileSync("zip", ["-q", zip, "clean.json"], { cwd: root });
  const embedded = `window.playwrightReportBase64="data:application/zip;base64,${(await readFile(zip)).toString("base64")}";`;
  expect(await inspectEmbeddedReport(embedded, ["private-canary-6234"])).toBeNull();
  expect(await inspectEmbeddedReport('<script>window.playwrightReportBase64="opaque";</script>', [])).toContain("could not be inspected");
});
