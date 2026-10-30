import { createHash } from "node:crypto";
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalGeneratedReportAsset, isTrustedGeneratedReportAsset, inspectCellReportProducer, privateCellEvidenceOwner, cellTraceAsset, readPrivateCellTraceAsset } from "./manual-private-report-assets.js";
import { sealManualResultEvidence, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { normalizedSecrets } from "./redaction.js";
import { CREDENTIAL_NAMES } from "./types.js";
import { isStandardEvidenceFile } from "./evidence.js";
import { BoundedHistoryPublisher } from "./history-budget.js";
import { privateArtifactKey, retainPrivateTransfer, transferPrivateArtifact, verifyPrivateHistory, type PrivateEvidenceCompleteness } from "./private-history.js";
import { authorizeManualPrivateEvidence, MANUAL_PRIVATE_PROTOCOL, manualCellKind, manualPrivateSessionPolicy } from "./manual-private-retention.js";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function request(env: NodeJS.ProcessEnv) {
  const ids = JSON.parse(env.MANUAL_PRIVATE_IDS ?? "null") as string[];
  const approval = authorizeManualPrivateEvidence({ workflowSha: env.GITHUB_SHA ?? "", targetSha: env.TARGET_SHA ?? "",
    runId: env.GITHUB_RUN_ID ?? "", attempt: env.GITHUB_RUN_ATTEMPT ?? "", executionIds: ids }, env.MANUAL_PRIVATE_APPROVALS_JSON ?? "");
  return { ids, approval, bucket: env.RUNNER_E2E_PRIVATE_HISTORY_S3_BUCKET ?? "" };
}
async function output(name: string, value: string) {
  if (/[\r\n]/.test(value)) throw new Error("Invalid private evidence step output");
  await appendFile(process.env.GITHUB_OUTPUT!, `${name}=${value}\n`);
}
async function prepare(env: NodeJS.ProcessEnv) {
  const { ids, approval, bucket } = request(env), id = env.SELECTED_EXECUTION_ID;
  if (!id || !ids.includes(id)) throw new Error("Private evidence cell is not approved");
  const target = await realpath(env.TARGET_ROOT ?? ""), trusted = path.resolve(import.meta.dirname, "../..");
  if (target === trusted) throw new Error("Trusted transfer code must be separate from target checkout");
  const launch = await readFile(path.join(target, "tests/runner-e2e/launch.ts"));
  if (hash(launch) !== approval.launchSha256) throw new Error("Target evidence launcher differs from protected approval");
  for (const file of ["manual-private-handoff.ts", "manual-private-retention.ts", "manual-private-report-assets.ts"]) {
    if (!(await readFile(path.join(target, "tests/runner-e2e", file))).equals(await readFile(path.join(trusted, "tests/runner-e2e", file))))
      throw new Error("Target private evidence protocol differs from trusted implementation");
  }
  const temporary = await realpath(env.RUNNER_TEMP ?? ""), root = await mkdtemp(path.join(temporary, "manual-private-evidence-"));
  await writeFile(path.join(root, "identity.json"), JSON.stringify({ ...approval, executionIds: [id], root, status: "pending" }), { mode: 0o600, flag: "wx" });
  await output("root", root); await output("session_policy", JSON.stringify(manualPrivateSessionPolicy({ bucket, runId: approval.runId, executionIds: [id], mode: "cell-write" })));
}
function requireSession(env: NodeJS.ProcessEnv) {
  if (![env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN].every(value => typeof value === "string" && value.length > 0))
    throw new Error("Explicit private archive session is required; no credential fallback");
}
async function verify(env: NodeJS.ProcessEnv) {
  requireSession(env); const { approval, bucket } = request(env), root = await realpath(env.PRIVATE_EVIDENCE_ROOT ?? "");
  const identity = JSON.parse(await readFile(path.join(root, "identity.json"), "utf8"));
  if (identity.approvalSha256 !== approval.approvalSha256 || identity.targetSha !== approval.targetSha || identity.workflowSha !== approval.workflowSha
    || identity.runId !== approval.runId || identity.attempt !== "1" || identity.root !== root) throw new Error("Private preflight identity changed");
  const publisher = new BoundedHistoryPublisher(path.join(root, "preflight-requests.json"));
  await verifyPrivateHistory(publisher, bucket);
  const preflight = JSON.stringify({ ...identity, status: "verified", cellReportProducer: await inspectCellReportProducer() });
  if (Buffer.byteLength(preflight) > 65536) throw new Error("Private preflight exceeds its byte allowance");
  await writeFile(path.join(root, "preflight.json"), preflight, { mode: 0o600, flag: "wx" });
}
export async function validateSealedInventory(directory: string, inventory: string, id?: string, treeKind: "standard" | "generated-report" = "standard", context?: ManualPrivateHandoff) {
  const cellOwner = treeKind === "standard" && context?.cellReportProducer
    ? await privateCellEvidenceOwner(context, id ?? (context.executionIds.length === 1 ? context.executionIds[0]! : "")) : undefined;
  const receipt = JSON.parse(await readFile(path.join(directory, inventory), "utf8"));
  if (receipt.protocol !== MANUAL_PRIVATE_PROTOCOL || id !== undefined && receipt.executionId !== id || receipt.complete !== true
    || !Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 4096
    || hash(JSON.stringify(receipt.files)) !== receipt.inventorySha256) throw new Error("Original evidence inventory is incomplete");
  if (id === undefined && receipt.treeKind !== treeKind) throw new Error("Private evidence tree kind differs from its inventory");
  const expected = new Set<string>(inventory.startsWith("../") ? [] : [inventory]); let bytes = 0;
  for (const row of receipt.files) {
    if (!row || Object.keys(row).sort().join() !== "bytes,path,sha256" || typeof row.path !== "string"
      || row.path.split("/").some((part: string) => !part || part === "." || part === "..") || row.path.includes("\\")
      || expected.has(row.path) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[0-9a-f]{64}$/.test(row.sha256)) throw new Error("Invalid original evidence inventory row");
    const cellAsset = cellOwner ? cellTraceAsset(row.path, cellOwner, id === undefined ? "final" : "original") : undefined;
    if (cellAsset?.reserved && !cellAsset.canonical) throw new Error("Invalid private cell trace owner");
    const standard = isStandardEvidenceFile(id === undefined ? `html-report/${row.path}` : row.path);
    const canonical = id === undefined && treeKind === "generated-report" ? canonicalGeneratedReportAsset(row.path) : undefined;
    const staticReportOwner = id === undefined && treeKind === "generated-report" && (row.path.startsWith("html/trace/") || canonical !== undefined);
    if (cellAsset?.reserved ? !cellAsset.canonical : staticReportOwner ? !canonical : !standard) throw new Error("Invalid original evidence inventory row");
    if (row.bytes > 256 * 1024 * 1024 - bytes) throw new Error("Original evidence byte accounting changed");
    expected.add(row.path); bytes += row.bytes;
    const file = path.join(directory, row.path), metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== row.bytes) throw new Error("Original evidence changed after its scan");
    const data = cellAsset?.reserved
      ? (await readPrivateCellTraceAsset({ owner: cellOwner!, layout: id === undefined ? "final" : "original", relative: row.path, file, remaining: row.bytes, secrets: [] }))!
      : await readFile(file);
    if (hash(data) !== row.sha256) throw new Error("Original evidence changed after its scan");
    if (staticReportOwner && !await isTrustedGeneratedReportAsset(row.path, data)) throw new Error("Invalid original evidence inventory row");
  }
  if (bytes !== receipt.sourceBytes || bytes > 256 * 1024 * 1024) throw new Error("Original evidence byte accounting changed");
  const actual = new Set<string>();
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory() || name.split("/").length > 24) throw new Error("Invalid sealed evidence entry");
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!expected.has(name)) throw new Error("Unscanned file added to sealed evidence");
      actual.add(name);
    }
  }
  await visit("");
  if (actual.size !== expected.size) throw new Error("Sealed evidence is incomplete");
  return receipt;
}
export async function validateSealedOriginals(root: string, id: string, context?: ManualPrivateHandoff) {
  const receipt = await validateSealedInventory(path.join(root, "originals", manualCellKind(id)), "original-evidence-inventory.json", id, "standard", context);
  const missing = receipt.missingRequiredEvidence;
  const allowed = new Set(["final-state.png", "result.json", "junit.xml", "html-report/index.html", "snapshots/fixtures.json", "snapshots/api-state.json", "blob-report/*.zip"]);
  if (![true, false, null].includes(receipt.requiredEvidenceComplete) || !Array.isArray(missing) || new Set(missing).size !== missing.length
    || missing.some((name: unknown) => typeof name !== "string" || !allowed.has(name))
    || (receipt.requiredEvidenceComplete === false) !== (missing.length > 0)) throw new Error("Required evidence completeness is unknown");
  return receipt;
}
function cellCompleteness(id: string, receipt: { requiredEvidenceComplete: boolean | null; missingRequiredEvidence: string[] }): PrivateEvidenceCompleteness {
  return { meaning: "available-files-and-transfer-only", doesNotAttestFeatureOutcome: true,
    cells: [{ executionId: id, availableFileInventoryComplete: true, requiredPassEvidenceComplete: receipt.requiredEvidenceComplete, missingRequiredEvidence: receipt.missingRequiredEvidence }] };
}
async function uploadCell(env: NodeJS.ProcessEnv) {
  requireSession(env); const { approval, bucket } = request(env), id = env.SELECTED_EXECUTION_ID!;
  if (!approval.executionIds.includes(id)) throw new Error("Private evidence cell is not approved");
  const root = await realpath(env.PRIVATE_EVIDENCE_ROOT ?? ""), context = JSON.parse(await readFile(path.join(root, "preflight.json"), "utf8"));
  if (context.status !== "verified" || context.approvalSha256 !== approval.approvalSha256 || context.targetSha !== approval.targetSha
    || context.runId !== approval.runId || context.executionIds.join() !== id || context.root !== root) throw new Error("Private evidence preflight identity changed");
  if (await lstat(path.join(root, "contamination.json")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }))
    throw new Error("Contaminated private evidence cannot be uploaded");
  const originals = await validateSealedOriginals(root, id, context);
  const evidenceCompleteness = cellCompleteness(id, originals);
  const bundle = path.join(root, "sealed-bundle"); await mkdir(bundle, { mode: 0o700 });
  const results = path.join(root, "sealed-results");
  await validateSealedInventory(path.join(results, "html-report"), "../result-evidence-inventory.json", undefined, "standard", context);
  await mkdir(path.join(bundle, "originals"), { mode: 0o700 });
  await cp(path.join(root, "originals", manualCellKind(id)), path.join(bundle, "originals", manualCellKind(id)), { recursive: true, errorOnExist: true, force: false });
  await cp(results, path.join(bundle, "sealed-results"), { recursive: true, errorOnExist: true, force: false });
  await writeFile(path.join(bundle, "identity.json"), JSON.stringify({ ...context, evidenceCompleteness }), { mode: 0o600, flag: "wx" });
  const receipt = path.join(root, "cell-transfer.json"), publisher = new BoundedHistoryPublisher(receipt);
  await retainPrivateTransfer({ operation: "upload", kind: manualCellKind(id), runId: approval.runId, directory: bundle, bucket, publisher, evidenceCompleteness }, receipt,
    () => new BoundedHistoryPublisher(`${receipt}.retention.json`));
}
async function reportSession(env: NodeJS.ProcessEnv) {
  const { approval, bucket } = request(env);
  await output("session_policy", JSON.stringify(manualPrivateSessionPolicy({ bucket, runId: approval.runId, executionIds: [...approval.executionIds], mode: "report-write" })));
  await output("cell_count", String(approval.executionIds.length));
  for (const [index, id] of approval.executionIds.entries()) {
    await output(`read_policy_${index}`, JSON.stringify(manualPrivateSessionPolicy({ bucket, runId: approval.runId, executionIds: [id], mode: "cell-read" })));
  }
}
async function downloadCell(env: NodeJS.ProcessEnv) {
  requireSession(env); const { approval, bucket } = request(env), root = await realpath(env.PRIVATE_REPORT_ROOT ?? "");
  const index = Number(env.SELECTED_CELL_INDEX);
  if (!/^[0-7]$/.test(env.SELECTED_CELL_INDEX ?? "") || !approval.executionIds[index]) throw new Error("Invalid exact private cell index");
  const selected = path.join(root, "selected-runner-e2e"); await mkdir(selected, { recursive: true, mode: 0o700 });
  const id = approval.executionIds[index]!;
  {
    const directory = path.join(root, manualCellKind(id)), publisher = new BoundedHistoryPublisher(path.join(root, `${manualCellKind(id)}-download.json`));
    const receipt = await publisher.downloadJson<{ evidenceCompleteness?: PrivateEvidenceCompleteness; transfer?: { status?: string; sha256?: string } }>(bucket,
      `${privateArtifactKey(manualCellKind(id), approval.runId)}.upload-receipt.json`, path.join(root, `${manualCellKind(id)}-receipt.json`));
    if (receipt?.transfer?.status !== "complete" || !/^[0-9a-f]{64}$/.test(receipt.transfer.sha256 ?? "")) throw new Error("Private cell transfer receipt is unavailable");
    const downloaded = await transferPrivateArtifact({ operation: "download", kind: manualCellKind(id), runId: approval.runId, directory, bucket, publisher });
    if (downloaded.sha256 !== receipt.transfer.sha256) throw new Error("Private cell archive differs from retained transfer receipt");
    const identity = JSON.parse(await readFile(path.join(directory, "identity.json"), "utf8"));
    if (identity.targetSha !== approval.targetSha || identity.workflowSha !== approval.workflowSha || identity.runId !== approval.runId
      || identity.executionIds.join() !== id || identity.protocol !== MANUAL_PRIVATE_PROTOCOL) throw new Error("Private cell archive has a foreign identity");
    const originals = await validateSealedOriginals(directory, id, { ...identity, root: directory }), summary = cellCompleteness(id, originals);
    if (hash(JSON.stringify(identity.evidenceCompleteness)) !== hash(JSON.stringify(summary))
      || hash(JSON.stringify(receipt.evidenceCompleteness)) !== hash(JSON.stringify(summary))) throw new Error("Private evidence completeness receipt differs from archive");
    await validateSealedInventory(path.join(directory, "sealed-results", "html-report"), "../result-evidence-inventory.json", undefined, "standard", { ...identity, root: directory });
    await cp(path.join(directory, "sealed-results", "html-report"), path.join(selected, manualCellKind(id)), { recursive: true, errorOnExist: true, force: false });
    await writeFile(path.join(root, `manual-cell-completeness-${index}.json`), JSON.stringify(summary), { mode: 0o600, flag: "wx" });
  }
}
async function verifyDownloads(env: NodeJS.ProcessEnv) {
  const { approval } = request(env), root = await realpath(env.PRIVATE_REPORT_ROOT ?? "");
  const cells: PrivateEvidenceCompleteness["cells"] = [];
  for (const [index, id] of approval.executionIds.entries()) {
    const summary = JSON.parse(await readFile(path.join(root, `manual-cell-completeness-${index}.json`), "utf8")) as PrivateEvidenceCompleteness;
    if (summary.meaning !== "available-files-and-transfer-only" || summary.doesNotAttestFeatureOutcome !== true
      || summary.cells.length !== 1 || summary.cells[0]!.executionId !== id) throw new Error("Private report lacks an exact cell transfer");
    cells.push(...summary.cells);
  }
  await writeFile(path.join(root, "manual-report-input-completeness.json"), JSON.stringify({ meaning: "available-files-and-transfer-only", doesNotAttestFeatureOutcome: true, cells }), { mode: 0o600, flag: "wx" });
}
export async function uploadReport(env: NodeJS.ProcessEnv) {
  requireSession(env); const { approval, bucket } = request(env), source = await realpath(env.PRIVATE_REPORT_SOURCE ?? ""), root = await realpath(env.PRIVATE_REPORT_ROOT ?? "");
  if (!source.startsWith(`${root}${path.sep}`)) throw new Error("Private report escaped owned staging");
  const evidenceCompleteness = JSON.parse(await readFile(path.join(root, "manual-report-input-completeness.json"), "utf8")) as PrivateEvidenceCompleteness;
  if (evidenceCompleteness.meaning !== "available-files-and-transfer-only" || evidenceCompleteness.doesNotAttestFeatureOutcome !== true
    || evidenceCompleteness.cells.map(cell => cell.executionId).sort().join() !== [...approval.executionIds].sort().join()) throw new Error("Private report lacks exact cell completeness receipts");
  const secrets = normalizedSecrets([...CREDENTIAL_NAMES.map(name => env[name]), env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN]);
  await sealManualResultEvidence({ root, protocol: MANUAL_PRIVATE_PROTOCOL, private: true, workflowSha: approval.workflowSha,
    targetSha: approval.targetSha, runId: approval.runId, attempt: approval.attempt, executionIds: [...approval.executionIds] }, secrets, source, "generated-report");
  const sealed = path.join(root, "sealed-results");
  await validateSealedInventory(path.join(sealed, "html-report"), "../result-evidence-inventory.json", undefined, "generated-report");
  const receipt = path.join(root, "report-transfer.json"), publisher = new BoundedHistoryPublisher(receipt);
  await retainPrivateTransfer({ operation: "upload", kind: "manual-report", runId: approval.runId, directory: sealed, bucket, publisher, evidenceCompleteness }, receipt,
    () => new BoundedHistoryPublisher(`${receipt}.retention.json`));
}
async function main() {
  const action = process.argv[2];
  if (process.argv.length !== 3) throw new Error("Invalid private evidence command");
  if (action === "prepare") await prepare(process.env);
  else if (action === "verify") await verify(process.env);
  else if (action === "upload-cell") await uploadCell(process.env);
  else if (action === "report-session") await reportSession(process.env);
  else if (action === "download-cell") await downloadCell(process.env);
  else if (action === "verify-downloads") await verifyDownloads(process.env);
  else if (action === "upload-report") await uploadReport(process.env);
  else throw new Error("Invalid private evidence command");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write("Restricted manual evidence operation failed; no public fallback\n"); process.exitCode = 1; });
}
