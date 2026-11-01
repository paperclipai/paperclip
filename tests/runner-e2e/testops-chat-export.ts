import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildRunnerCampaign } from "./history.js";
import { findSecretLeakInJsonValues, assertSecretFree } from "./redaction.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import { PUBLIC_RUNNER_SCREENSHOT_MARKER } from "./screenshot-policy.js";
import type { RunnerE2EResult } from "./types.js";

export const TESTOPS_CHAT_EXECUTION = "chat-features.runner-opencode-deepseek-1017.local.create-backlog";
const model = "openrouter/deepseek/deepseek-v4.1-flash-1017";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sha = /^[a-f0-9]{40}$/;
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export interface TestOpsChatBinding { runId: string; attempt: string; workflowSha: string; targetSha: string }

export function publicBilling(value: NonNullable<RunnerE2EResult["billing"]>) {
  const pick = (source: object, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, (source as Record<string, unknown>)[key]]));
  const numeric = (source: object, keys: string[]) => {
    const selected = pick(source, keys);
    if (Object.values(selected).some(v => v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0))) throw new Error("Invalid billing scalar");
    return selected;
  };
  return {
    llm: { ...numeric(value.llm, ["runCount", "runsWithTokenUsage", "runsWithReportedCost", "runsWithEstimatedCost", "runsWithPartialReportedCost", "inputTokens", "outputTokens", "cachedInputTokens", "totalTokens", "reportedCostUsd", "estimatedCostUsd"]), costStatus: value.llm.costStatus },
    runtime: { ...numeric(value.runtime, ["agentRunDurationMs", "leaseDurationMs", "leaseCount", "cpuCores", "memoryGiB", "diskGiB", "estimatedListCostUsd"]), provider: value.runtime.provider, costStatus: value.runtime.costStatus, costSource: value.runtime.costSource },
    ...numeric(value, ["reportedCostUsd", "estimatedRuntimeCostUsd", "observedAndEstimatedCostUsd"]), complete: value.complete,
  } as RunnerE2EResult["billing"];
}

async function ownedRead(root: string, relative: string, limit: number) {
  const segments = relative.split("/");
  if (segments.some(s => !/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..")) throw new Error("Unsafe export source");
  let current = root;
  const rootStat = await lstat(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Invalid report root");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const st = await lstat(current);
    if (st.isSymbolicLink() || (index < segments.length - 1 ? !st.isDirectory() : !st.isFile() || st.nlink !== 1 || st.size > limit)) throw new Error("Invalid export source");
  }
  if (!(await realpath(current)).startsWith(`${await realpath(root)}${path.sep}`)) throw new Error("Export source escapes report");
  const before = await lstat(current), bytes = await readFile(current), after = await lstat(current);
  if (bytes.length > limit || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Export source changed");
  return bytes;
}

export async function exportTestOpsChat(reportRoot: string, output: string, binding: TestOpsChatBinding) {
  if (!/^[1-9][0-9]{0,19}$/.test(binding.runId) || binding.attempt !== "1" || !sha.test(binding.workflowSha) || !sha.test(binding.targetSha)) throw new Error("Invalid TestOps run binding");
  const raw = JSON.parse((await ownedRead(reportRoot, "normalized-results.json", 8 * 1024 * 1024)).toString("utf8"));
  const campaignId = `gha-${binding.runId}-${binding.attempt}`;
  if (raw.schema !== "paperclip.runner-e2e.campaign/v2" || raw.campaignId !== campaignId || !Array.isArray(raw.expected) || raw.expected.length !== 1 || raw.expected[0] !== TESTOPS_CHAT_EXECUTION || !Array.isArray(raw.results) || raw.results.length !== 1 || raw.retries !== 0) throw new Error("Foreign or repeated TestOps selection");
  const original = raw.results[0];
  validateRetainedRunnerResult(original);
  if (original.executionId !== TESTOPS_CHAT_EXECUTION || original.suiteId !== "chat-features" || original.profileId !== "runner-opencode-deepseek-1017" || original.environmentId !== "local" || original.caseId !== "create-backlog" || original.provider !== "opencode" || original.model !== model || original.runtimeMode !== "native" || original.attempt !== 1 || original.source?.sha !== binding.targetSha) throw new Error("Foreign TestOps result");
  if (!original.billing) throw new Error("Missing retained billing coverage");
  const checks = original.matcherResults ?? [];
  if (original.status === "passed" && (original.cleanup !== "passed" || raw.results[0].evidenceValid !== true || checks.length === 0 || checks.some(c => !c.passed) || original.runIds?.length !== 1)) throw new Error("Incomplete passing TestOps evidence");
  const screenshots = (original.screenshots ?? []).filter(s => s.publication === PUBLIC_RUNNER_SCREENSHOT_MARKER);
  if (screenshots.length > 8 || original.status === "passed" && !screenshots.some(s => s.id === "final-state" && s.file === "final-state.png")) throw new Error("Missing or excessive fixture screenshots");
  const files = new Map<string, Buffer>();
  for (const shot of screenshots) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.png$/.test(shot.file) || !/^[a-f0-9]{64}$/.test(shot.sha256 ?? "")) throw new Error("Unbound fixture screenshot");
    const relative = `evidence/${TESTOPS_CHAT_EXECUTION}/attempt-1/${shot.file}`;
    const bytes = await ownedRead(reportRoot, relative, 12 * 1024 * 1024);
    if (!bytes.subarray(0, 8).equals(pngMagic) || bytes.subarray(12, 16).toString("ascii") !== "IHDR" || hash(bytes) !== shot.sha256 || files.has(relative)) throw new Error("Invalid fixture PNG");
    assertSecretFree(bytes, [], "TestOps fixture PNG", { includeShapes: true });
    files.set(relative, bytes);
  }
  const result: RunnerE2EResult = {
    schema: original.schema, executionId: TESTOPS_CHAT_EXECUTION, suiteId: "chat-features", suiteDefinitionHash: original.suiteDefinitionHash,
    source: { sha: binding.targetSha, ref: null, workflowRunUrl: `https://github.com/paperclipai/paperclip/actions/runs/${binding.runId}` },
    attempt: 1, status: original.status, ...(original.failureClass ? { failureClass: original.failureClass } : {}),
    ...(original.status === "failed" ? { error: "Retained chat feature evaluation failed; private originals preserve diagnostics" } : {}),
    profileId: "runner-opencode-deepseek-1017", environmentId: "local", caseId: "create-backlog", provider: "opencode", model, runtimeMode: "native",
    runIds: original.runIds?.map(id => { if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw new Error("Invalid task run identity"); return id; }),
    startedAt: original.startedAt, finishedAt: original.finishedAt, durationMs: original.durationMs, cleanup: original.cleanup,
    billing: publicBilling(original.billing),
    matcherResults: checks.map(check => {
      if (check.matcher.kind !== "json_path" || !/^[A-Za-z0-9._-]{1,150}$/.test(check.matcher.path) || check.matcher.expected !== true) throw new Error("Unsupported chat oracle check");
      return { matcher: { kind: "json_path", path: check.matcher.path, expected: true }, passed: check.passed, detail: "Retained independent chat-feature oracle check" };
    }),
    screenshots: screenshots.map(s => ({ id: s.id, label: "Reviewed synthetic chat-feature fixture", file: s.file, publication: PUBLIC_RUNNER_SCREENSHOT_MARKER, sha256: s.sha256 })),
  };
  validateRetainedRunnerResult(result);
  const campaign = buildRunnerCampaign({ campaignId, generatedAt: raw.generatedAt, expected: [TESTOPS_CHAT_EXECUTION], results: [result] });
  if (findSecretLeakInJsonValues(campaign, [], { includeShapes: true })) throw new Error("Unsafe TestOps projection");
  files.set("normalized-results.json", Buffer.from(`${JSON.stringify(campaign, null, 2)}\n`));
  const failed = result.status !== "passed" || result.cleanup !== "passed";
  files.set("junit.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><testsuite name="Chat feature TestOps" tests="1" failures="${failed ? 1 : 0}"><testcase classname="paperclip.Product E2E.chat-features" name="create-backlog" time="${result.durationMs / 1000}">${failed ? '<failure message="Retained evaluation or cleanup failed"/>' : ""}</testcase></testsuite>\n`));
  const manifest = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => ({ path: file, sha256: hash(bytes), bytes: bytes.length }));
  const receipt = { schema: "paperclip.chat-feature-testops-export/v1", ...binding, executionId: TESTOPS_CHAT_EXECUTION, campaignId, resultStatus: result.status, cleanup: result.cleanup, files: manifest };
  await mkdir(output, { mode: 0o700 });
  for (const [relative, bytes] of files) { const target = path.join(output, relative); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
  await writeFile(path.join(output, "binding.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exportTestOpsChat(path.resolve(process.env.TESTOPS_CHAT_REPORT_ROOT ?? "runner-e2e-merged-report/normalized"), path.resolve(process.env.TESTOPS_CHAT_EXPORT_ROOT ?? "runner-e2e-testops"), {
    runId: process.env.GITHUB_RUN_ID ?? "", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "", workflowSha: process.env.GITHUB_SHA ?? "", targetSha: process.env.TESTOPS_CHAT_TARGET_SHA ?? "",
  }).catch(() => { process.stderr.write("Chat feature TestOps export rejected; private originals retained\n"); process.exitCode = 1; });
}
