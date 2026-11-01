import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildRunnerCampaign } from "./history.js";
import { assertSecretFree, findSecretLeakInJsonValues } from "./redaction.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import { publicBilling } from "./testops-chat-export.js";
import { cases, targetSha, model, hash, validRunCount } from "./chat-completion-testops-contract.mjs";
import type { RunnerE2EResult } from "./types.js";

const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
interface Binding { runId: string; attempt: string; workflowSha: string; targetSha: string }

async function ownedRead(root: string, relative: string, limit: number) {
  if (!path.isAbsolute(root) || await realpath(root) !== root || relative.split("/").some(part => !/^[A-Za-z0-9._-]+$/.test(part) || [".", ".."].includes(part))) throw new Error("Invalid pilot evidence path");
  let current = root;
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Invalid pilot evidence root");
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part); const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > limit)) throw new Error("Invalid pilot evidence file");
  }
  const before = await lstat(current), bytes = await readFile(current), after = await lstat(current);
  if (bytes.length > limit || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Pilot evidence changed");
  return bytes;
}

/** Public-safe metadata projection for the protected TestOps reporter.
 * Original screenshots stay in private AWS storage. The exact final PNG is
 * verified here, but only its checksum and availability receipt cross jobs.
 */
export async function exportCompletionPilot(root: string, output: string, binding: Binding, expectedIds: string[]) {
  if (!/^[1-9][0-9]{0,15}$/.test(binding.runId) || binding.attempt !== "1" || !/^[a-f0-9]{40}$/.test(binding.workflowSha)
    || binding.targetSha !== targetSha || !Array.isArray(expectedIds) || !expectedIds.length || expectedIds.length > 3
    || new Set(expectedIds).size !== expectedIds.length || expectedIds.some(id => !cases.some(row => row.executionId === id))) throw new Error("Invalid pilot binding");
  const campaignId = `gha-${binding.runId}-1`, runUrl = `https://github.com/paperclipai/paperclip/actions/runs/${binding.runId}`;
  const raw = JSON.parse((await ownedRead(root, "normalized-results.json", 8 * 1024 * 1024)).toString("utf8"));
  if (raw.schema !== "paperclip.runner-e2e.campaign/v2" || raw.campaignId !== campaignId || raw.retries !== 0
    || !Array.isArray(raw.expected) || JSON.stringify([...raw.expected].sort()) !== JSON.stringify([...expectedIds].sort())
    || !Array.isArray(raw.results) || raw.results.length !== expectedIds.length || new Set(raw.results.map((row: RunnerE2EResult) => row.executionId)).size !== expectedIds.length) throw new Error("Foreign pilot campaign");
  const files = new Map<string, Buffer>(), results: RunnerE2EResult[] = [];
  const privateEvidence: { executionId: string; requiredEvidenceComplete: boolean | null; finalScreenshot: { sha256: string; bytes: number } | null }[] = [];
  for (const id of expectedIds) {
    const descriptor = cases.find(row => row.executionId === id)!;
    const original = raw.results.find((row: RunnerE2EResult) => row.executionId === id) as RunnerE2EResult & { evidenceValid?: boolean };
    if (!original) throw new Error("Missing selected pilot result");
    validateRetainedRunnerResult(original);
    if (original.suiteId !== "chat-features" || original.profileId !== "runner-opencode" || original.environmentId !== "local"
      || original.caseId !== descriptor.scenario || original.provider !== "opencode" || original.model !== model || original.runtimeMode !== "native"
      || original.source?.sha !== targetSha || original.source?.workflowRunUrl !== runUrl || original.attempt !== 1
      || !["passed", "failed"].includes(original.status)) throw new Error("Foreign pilot result");
    const checks = original.matcherResults ?? [];
    if (checks.length > 200 || checks.some(check => check.matcher.kind !== "json_path" || !/^[A-Za-z0-9._-]{1,150}$/.test(check.matcher.path)
      || check.matcher.expected !== true || typeof check.passed !== "boolean")) throw new Error("Invalid pilot checks");
    if (original.status === "passed" && (original.cleanup !== "passed" || original.evidenceValid !== true
      || checks.length !== descriptor.checks || checks.some(check => !check.passed) || !validRunCount(original.runIds, descriptor))) throw new Error("Incomplete pilot pass");
    let image: Buffer | undefined;
    const relative = `evidence/${id}/attempt-1/final-state.png`;
    try { image = await ownedRead(root, relative, 12 * 1024 * 1024); }
    catch (error) { if (original.status === "passed" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (image) {
      if (!image.subarray(0, 8).equals(pngMagic) || image.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error("Invalid pilot fixture PNG");
      assertSecretFree(image, [], "Private synthetic pilot PNG", { includeShapes: true });
    }
    privateEvidence.push({ executionId: id, requiredEvidenceComplete: typeof original.evidenceValid === "boolean" ? original.evidenceValid : null,
      finalScreenshot: image ? { sha256: hash(image), bytes: image.length } : null });
    const result: RunnerE2EResult = {
      schema: original.schema, executionId: id, suiteId: "chat-features", suiteDefinitionHash: original.suiteDefinitionHash,
      source: { sha: targetSha, ref: null, workflowRunUrl: runUrl }, attempt: 1, status: original.status,
      ...(original.failureClass ? { failureClass: original.failureClass } : {}),
      ...(original.status === "failed" ? { error: "Original pilot evaluation failed; diagnostics remain in protected evidence" } : {}),
      profileId: "runner-opencode", environmentId: "local", caseId: descriptor.scenario, provider: "opencode", model, runtimeMode: "native",
      runIds: original.runIds?.map(value => { if (!/^[A-Za-z0-9._-]{1,100}$/.test(value)) throw new Error("Invalid pilot run identity"); return value; }),
      startedAt: original.startedAt, finishedAt: original.finishedAt, durationMs: original.durationMs, cleanup: original.cleanup,
      ...(original.billing ? { billing: publicBilling(original.billing) } : {}),
      matcherResults: checks.map(check => ({ matcher: { kind: "json_path", path: (check.matcher as { path: string }).path, expected: true },
        passed: check.passed, detail: "Retained independent Product E2E oracle check" })),
      screenshots: [],
    };
    validateRetainedRunnerResult(result); results.push(result);
  }
  const campaign = buildRunnerCampaign({ campaignId, generatedAt: raw.generatedAt, expected: expectedIds, results });
  if (findSecretLeakInJsonValues(campaign, [], { includeShapes: true })) throw new Error("Unsafe pilot projection");
  files.set("normalized-results.json", Buffer.from(`${JSON.stringify(campaign, null, 2)}\n`));
  const failed = results.filter(row => row.status !== "passed" || row.cleanup !== "passed").length;
  files.set("junit.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><testsuite name="Chat completion pilot" tests="${results.length}" failures="${failed}">${results.map(row => `<testcase classname="paperclip.Product E2E.chat-features" name="${row.caseId}" time="${row.durationMs / 1000}">${row.status !== "passed" || row.cleanup !== "passed" ? '<failure message="Original evaluation or cleanup failed"/>' : ""}</testcase>`).join("")}</testsuite>\n`));
  const manifest = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({ path: name, sha256: hash(bytes), bytes: bytes.length }));
  if (manifest.reduce((total, row) => total + row.bytes, 0) > 32 * 1024 * 1024) throw new Error("Pilot projection exceeds allowance");
  const receipt = { schema: "paperclip.chat-completion-testops-export/v1", ...binding, campaignId, executionIds: expectedIds, privateEvidence, files: manifest };
  await mkdir(output, { mode: 0o700 });
  for (const [relative, bytes] of files) {
    const destination = path.join(output, relative); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  await writeFile(path.join(output, "binding.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exportCompletionPilot(path.resolve(process.env.TESTOPS_PILOT_REPORT_ROOT ?? "runner-e2e-merged-report/normalized"),
    path.resolve(process.env.TESTOPS_PILOT_EXPORT_ROOT ?? "runner-e2e-testops"), {
      runId: process.env.GITHUB_RUN_ID ?? "", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "", workflowSha: process.env.GITHUB_SHA ?? "", targetSha,
    }, JSON.parse(process.env.MANUAL_PRIVATE_IDS ?? "null"))
    .catch(() => { process.stderr.write("TestOps pilot projection rejected; originals remain protected\n"); process.exitCode = 1; });
}
