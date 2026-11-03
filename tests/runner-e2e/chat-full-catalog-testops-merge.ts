import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildRunnerCampaign } from "./history.js";
import { readPilotExport } from "./chat-completion-testops-results.mjs";
import { hash, validateSelection } from "./chat-completion-testops-contract.mjs";
import type { PilotContext, PilotSelection } from "./chat-completion-testops-contract.mjs";
import type { RunnerE2EResult } from "./types.js";
import { findSecretLeakInJsonValues } from "./redaction.js";

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bytes = await readFile(process.env.TESTOPS_CATALOG_SELECTION!);
  if (hash(bytes) !== process.env.EXPECTED_SELECTION_SHA256) throw new Error("Selection digest mismatch");
  const selection = JSON.parse(bytes.toString("utf8"));
  const context = { catalog: "full" as const, runId: process.env.GITHUB_RUN_ID!, attempt: process.env.GITHUB_RUN_ATTEMPT!,
    workflowSha: process.env.GITHUB_SHA!, targetSha: selection.targetSha };
  await mergeCatalogProjections(path.resolve("catalog-projections"), path.resolve("runner-e2e-testops"), selection, context);
}
