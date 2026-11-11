import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diagnosticSecrets, stagePrivateDiagnostics } from "./private-diagnostics.js";
import { copyHealthHelloDetail, HEALTH_DETAIL_ID, HEALTH_DETAIL_PATH, retainHealthHelloDetail } from "./chat-readiness-detail.js";
import { isHistoricalBundlePathAllowed } from "./history-publish.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(secrets: string[] = []) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "health-detail-"))); roots.push(root);
  await mkdir(path.join(root, "artifacts-private"), { mode: 0o700 });
  await mkdir(path.join(root, "selected-private-inputs"), { mode: 0o700 });
  stagePrivateDiagnostics(root, [HEALTH_DETAIL_ID], secrets);
  return { root, uploadDir: path.join(root, "results") };
}
const result = (detail: string) => ({ checks: [{ code: "opencode_hello_probe_failed", level: "error", message: "OpenCode hello probe failed.", detail }] });
it("retains useful unknown returned detail only in nonpublic Actions diagnostics", async () => {
  const f = await fixture();
  expect(await retainHealthHelloDetail(f.root, [HEALTH_DETAIL_ID], 1, result("Provider rejected request: unsupported structured response mode"))).toBe("retained");
  await copyHealthHelloDetail(f.root, HEALTH_DETAIL_ID, f.uploadDir, []);
  const file = path.join(f.uploadDir, HEALTH_DETAIL_PATH);
  expect(await readFile(file, "utf8")).toContain("unsupported structured response mode");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(isHistoricalBundlePathAllowed(`campaign/chat-setup-health/runner-opencode/local/setup-only/attempt-1/${HEALTH_DETAIL_PATH}`, true)).toBe(false);
});
it("scrubs registered encodings plus credential headers, URLs and email before any write", async () => {
  const secret = 'private-key-"with-sensitive-chars';
  const f = await fixture([secret]);
  const variants = diagnosticSecrets([secret]).values;
  const detail = [...variants, "https://person:password@provider.invalid/path?token=another", "person@example.invalid", "Authorization: Basic unregistered-header-value"].join("\n");
  expect(await retainHealthHelloDetail(f.root, [HEALTH_DETAIL_ID], 1, result(detail))).toBe("retained");
  const original = await readFile(path.join(f.root, "artifacts-private/setup-health-hello.jsonl"), "utf8");
  for (const value of variants) expect(original).not.toContain(value);
  expect(original).not.toMatch(/person@example|provider\.invalid|unregistered-header-value/);
  await copyHealthHelloDetail(f.root, HEALTH_DETAIL_ID, f.uploadDir, [secret]);
  expect(await readFile(path.join(f.uploadDir, HEALTH_DETAIL_PATH), "utf8")).toBe(original);
});
it("withholds missing registry and oversized details, and never observes ordinary catalog cases", async () => {
  const f = await fixture();
  expect(await retainHealthHelloDetail(f.root, ["chat-features.runner-opencode.local.create-backlog"], 1, result("not retained"))).toBeUndefined();
  expect(await retainHealthHelloDetail(f.root, [HEALTH_DETAIL_ID], 1, result("x".repeat(2049)))).toBe("withheld");
  await rm(path.join(f.root, "selected-private-inputs/diagnostic-redaction.json"));
  expect(await retainHealthHelloDetail(f.root, [HEALTH_DETAIL_ID], 1, result("unregistered detail"))).toBe("withheld");
  await expect(readFile(path.join(f.root, "artifacts-private/setup-health-hello.jsonl"))).rejects.toThrow();
});
