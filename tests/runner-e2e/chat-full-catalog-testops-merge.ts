import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { buildRunnerCampaign } from "./history.js";
import { readPilotExport, exportPilotAllure } from "./chat-completion-testops-results.mjs";
import { hash, validateSelection, catalogDefinition, model } from "./chat-completion-testops-contract.mjs";
import type { PilotContext, PilotSelection } from "./chat-completion-testops-contract.mjs";
import type { RunnerE2EResult } from "./types.js";
import { findSecretLeakInJsonValues } from "./redaction.js";
import { privateArtifactKey } from "./private-history.js";
import { manualCellKind } from "./manual-private-retention.js";

export async function mergeCatalogProjections(root: string, output: string, selection: PilotSelection, context: PilotContext) {
  if (context.catalog !== "full") throw new Error("Full catalog context required");
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== path.resolve(root)) throw new Error("Invalid projection root");
  const selected = validateSelection(selection, context, selection.allureJobRunId);
  const directories = await readdir(root);
  if (directories.length !== selected.length || directories.some(name => !/^[A-Za-z0-9._-]+$/.test(name))) throw new Error("Incomplete projection set");
  const results: RunnerE2EResult[] = [], privateEvidence: unknown[] = [], seen = new Set<string>();
  for (const name of directories) {
    const directory = path.join(root, name), stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid projection path");
    const bindingPath = path.join(directory, "binding.json"), bindingStat = await lstat(bindingPath);
    if (!bindingStat.isFile() || bindingStat.isSymbolicLink() || bindingStat.nlink !== 1 || bindingStat.size > 262_144) throw new Error("Invalid projection binding");
    const bytes = await readFile(bindingPath);
    if (bytes.length > 262_144) throw new Error("Invalid projection binding");
    const binding = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(binding.executionIds) || binding.executionIds.length !== 1 || seen.has(binding.executionIds[0])) throw new Error("Duplicate projection");
    const row = selected.find(value => value.executionId === binding.executionIds[0]);
    if (!row) throw new Error("Foreign projection");
    const validated = await readPilotExport(directory, context, { ...selection, cases: [row] });
    seen.add(row.executionId); results.push(...validated.campaign.results); privateEvidence.push(...validated.privateEvidence);
  }
  const ordered = selected.map(row => results.find(result => result.executionId === row.executionId)!);
  const campaign = buildRunnerCampaign({ campaignId: `gha-${context.runId}-1`, generatedAt: new Date().toISOString(),
    expected: selected.map(row => row.executionId), results: ordered });
  if (findSecretLeakInJsonValues(campaign, [], { includeShapes: true })) throw new Error("Unsafe merged projection");
  const files = new Map([
    ["normalized-results.json", Buffer.from(`${JSON.stringify(campaign, null, 2)}\n`)],
    ["junit.xml", Buffer.from(`<?xml version="1.0"?><testsuite name="Chat feature catalog" tests="${ordered.length}" failures="${ordered.filter(row => row.status !== "passed" || row.cleanup !== "passed").length}"/>\n`)],
  ]);
  if ([...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) > 32 * 1024 * 1024) throw new Error("Projection exceeds allowance");
  await mkdir(output, { mode: 0o700 });
  for (const [name, data] of files) await writeFile(path.join(output, name), data, { flag: "wx", mode: 0o600 });
  const binding = { schema: "paperclip.chat-completion-testops-export/v1", ...context, campaignId: campaign.campaignId,
    executionIds: selected.map(row => row.executionId), privateEvidence,
    files: [...files].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })) };
  await writeFile(path.join(output, "binding.json"), JSON.stringify(binding, null, 2), { flag: "wx", mode: 0o600 });
  await readPilotExport(output, context, selection);
  return binding;
}

export interface RetainedDisposition {
  schema: "paperclip.chat-catalog-retained-disposition/v1";
  origin: PilotContext & { projectId: number; planId: number; jobId: number; launchId: number; allureJobRunId: string };
  selectionSha256: string;
  upstream: { status: "completed"; jobsSha256: string };
  custodySha256: string;
  gaps: Array<{ executionId: string; archiveKey: string; archiveStatus: "not_found" }>;
}

/** Report retained measurements without turning missing evidence into a measurement.
 * This is an offline data transform, not dispatch authority. The operator must
 * authenticate the selection, terminal jobs and exact-key custody observations
 * before invoking it. Origin and recovery executor identities remain separate.
 */
export async function prepareRetainedCatalogReport(root: string, output: string, selection: PilotSelection, context: PilotContext,
  disposition: RetainedDisposition, executor: { kind: "operator"; revisionSha: string }) {
  const selected = validateSelection(selection, context, selection.allureJobRunId);
  const keys = (value: object, expected: string[]) => Object.keys(value).sort().join() === [...expected].sort().join();
  const sha = (value: string) => /^[a-f0-9]{64}$/.test(value);
  const origin = { catalog: context.catalog, runId: context.runId, attempt: context.attempt, workflowSha: context.workflowSha,
    targetSha: context.targetSha, projectId: selection.projectId, planId: selection.planId, jobId: selection.jobId,
    launchId: selection.launchId, allureJobRunId: selection.allureJobRunId };
  if (context.catalog !== "full" || context.targetSha !== catalogDefinition(context).targetSha || context.attempt !== "1"
    || !/^[1-9][0-9]{0,15}$/.test(context.runId) || !/^[a-f0-9]{40}$/.test(context.workflowSha)
    || !keys(disposition, ["schema", "origin", "selectionSha256", "upstream", "custodySha256", "gaps"])
    || disposition.schema !== "paperclip.chat-catalog-retained-disposition/v1"
    || !keys(disposition.origin, Object.keys(origin)) || Object.entries(origin).some(([key, value]) => disposition.origin[key as keyof typeof origin] !== value)
    || disposition.selectionSha256 !== hash(JSON.stringify(selection, null, 2))
    || !keys(disposition.upstream, ["status", "jobsSha256"]) || disposition.upstream.status !== "completed" || !sha(disposition.upstream.jobsSha256)
    || !sha(disposition.custodySha256) || !Array.isArray(disposition.gaps) || disposition.gaps.length > selected.length
    || !keys(executor, ["kind", "revisionSha"]) || executor.kind !== "operator" || !/^[a-f0-9]{40}$/.test(executor.revisionSha)) throw new Error("Invalid retained reporting disposition");
  const gaps = new Set<string>();
  for (const gap of disposition.gaps) {
    if (!keys(gap, ["executionId", "archiveKey", "archiveStatus"]) || gaps.has(gap.executionId)
      || !selected.some(row => row.executionId === gap.executionId) || gap.archiveStatus !== "not_found"
      || gap.archiveKey !== privateArtifactKey(manualCellKind(gap.executionId), context.runId)) throw new Error("Invalid reporting gap");
    gaps.add(gap.executionId);
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== path.resolve(root)) throw new Error("Invalid projection root");
  const originals = new Set<string>();
  for (const name of await readdir(root)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Invalid projection path");
    const directory = path.join(root, name), info = await lstat(directory), bindingFile = path.join(directory, "binding.json");
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid projection path");
    const bindingStat = await lstat(bindingFile);
    if (!bindingStat.isFile() || bindingStat.isSymbolicLink() || bindingStat.nlink !== 1 || bindingStat.size > 262_144) throw new Error("Invalid projection binding");
    const binding = JSON.parse(await readFile(bindingFile, "utf8"));
    const id = binding.executionIds?.length === 1 ? binding.executionIds[0] : undefined;
    const row = selected.find(value => value.executionId === id);
    if (!row || originals.has(id) || gaps.has(id)) throw new Error("Duplicate or foreign retained partition");
    await readPilotExport(directory, context, { ...selection, cases: [row] }); originals.add(id);
  }
  if (originals.size + gaps.size !== selected.length) throw new Error("Incomplete retained reporting partition");
  await mkdir(output, { mode: 0o700 });
  const originalSelection = { ...selection, cases: selection.cases.filter(row => originals.has(row.executionId)) };
  const allure = path.join(output, "allure");
  let exported: Array<{ caseId: number; executionId: string; status: string; cleanup: string; attachments: unknown[] }> = [];
  if (originals.size) {
    const merged = path.join(output, "originals");
    await mergeCatalogProjections(root, merged, originalSelection, context);
    exported = await exportPilotAllure(merged, allure, context, originalSelection);
  } else await mkdir(allure, { mode: 0o700 });
  for (const row of selected.filter(value => gaps.has(value.executionId))) {
    const dto = { schema: "paperclip.chat-catalog-reporting-gap/v1", outcome: "reporting_gap", originalStatus: null,
      nativeRunCount: null, checks: null, cleanup: null, doesNotAttestFeatureOutcome: true,
      executionId: row.executionId, caseId: row.caseId, fullName: row.registeredFullName ?? row.fullName,
      origin, recoveryExecutor: executor, reason: "retained_archive_unavailable",
      selectionSha256: disposition.selectionSha256, terminalJobsSha256: disposition.upstream.jobsSha256, custodySha256: disposition.custodySha256 };
    const attachments = [];
    for (const [name, value] of [["Reporting gap (original grade UNKNOWN)", dto],
      ["Retained evidence custody", { schema: "paperclip.chat-catalog-reporting-gap-custody/v1", executionId: row.executionId,
        archiveStatus: "not_found_at_expected_retained_key", originalEvidenceAvailable: false, doesNotAttestFeatureOutcome: true,
        custodySha256: disposition.custodySha256 }]] as const) {
      const source = `${randomUUID()}-attachment.json`;
      await writeFile(path.join(allure, source), JSON.stringify(value), { flag: "wx", mode: 0o600 });
      attachments.push({ name, source, type: "application/json" });
    }
    const uuid = randomUUID();
    await writeFile(path.join(allure, `${uuid}-result.json`), JSON.stringify({ uuid, name: row.name,
      fullName: row.registeredFullName ?? row.fullName,
      testCaseId: hash(`${JSON.stringify(row.registeredFullName ?? row.fullName)}\n`),
      historyId: hash(JSON.stringify([row.registeredFullName ?? row.fullName, "runner-opencode", model, "local"])),
      status: "broken", stage: "finished", statusDetails: { message: "Reporting gap: retained original unavailable. Original evaluation grade is UNKNOWN. No evaluation was rerun." },
      labels: [{ name: "AS_ID", value: String(row.caseId) }, { name: "parentSuite", value: "Product E2E" },
        { name: "suite", value: "chat-features" }, { name: "framework", value: "Paperclip Evals" }, { name: "tag", value: "reporting-gap" }],
      parameters: [{ name: "canonicalScenario", value: row.key }, { name: "originalGrade", value: "UNKNOWN" }],
      links: [{ name: "Original GitHub Actions run", type: "custom", url: `https://github.com/paperclipai/paperclip/actions/runs/${context.runId}` }],
      steps: [], attachments }), { flag: "wx", mode: 0o600 });
  }
  const files = [];
  for (const name of (await readdir(allure)).sort()) {
    const bytes = await readFile(path.join(allure, name));
    if (findSecretLeakInJsonValues(JSON.parse(bytes.toString()), [], { includeShapes: true })) throw new Error("Unsafe reporting payload");
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  if (files.length !== selected.length * 3 || files.reduce((sum, row) => sum + row.bytes, 0) > 32 * 1024 * 1024) throw new Error("Invalid reporting payload inventory");
  const receipt = { schema: "paperclip.chat-catalog-retained-report/v1", origin, recoveryExecutor: executor,
    selectionSha256: disposition.selectionSha256, dispositionSha256: hash(JSON.stringify(disposition)),
    coverage: { selected: selected.length, gradedOriginals: originals.size,
      originalPassed: exported.filter(row => row.status === "passed").length, originalFailed: exported.filter(row => row.status !== "passed").length,
      reportingGaps: gaps.size },
    rows: selected.map(row => ({ executionId: row.executionId, caseId: row.caseId,
      originalStatus: exported.find(value => value.executionId === row.executionId)?.status ?? null,
      reportingStatus: exported.find(value => value.executionId === row.executionId)?.status ?? "broken" })), files };
  await writeFile(path.join(output, "reporting-manifest.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "retained-reporting") {
    const [root, output, selectionFile, dispositionFile, executorSha] = process.argv.slice(3);
    const selection = JSON.parse(await readFile(selectionFile!, "utf8"));
    const context = { catalog: "full" as const, runId: selection.runId, attempt: selection.attempt,
      workflowSha: selection.workflowSha, targetSha: selection.targetSha };
    await prepareRetainedCatalogReport(path.resolve(root!), path.resolve(output!), selection, context,
      JSON.parse(await readFile(dispositionFile!, "utf8")), { kind: "operator", revisionSha: executorSha! });
  } else {
  const bytes = await readFile(process.env.TESTOPS_CATALOG_SELECTION!);
  if (hash(bytes) !== process.env.EXPECTED_SELECTION_SHA256) throw new Error("Selection digest mismatch");
  const selection = JSON.parse(bytes.toString("utf8"));
  const context = { catalog: "full" as const, runId: process.env.GITHUB_RUN_ID!, attempt: process.env.GITHUB_RUN_ATTEMPT!,
    workflowSha: process.env.GITHUB_SHA!, targetSha: selection.targetSha };
  await mergeCatalogProjections(path.resolve("catalog-projections"), path.resolve("runner-e2e-testops"), selection, context);
  }
}
