import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { packageEvidence, isStandardEvidencePath, isStandardEvidenceFile, type EvidencePackageResult } from "./evidence.js";
import { canonicalGeneratedReportAsset, isTrustedGeneratedReportAsset, assertCellReportProducer, privateCellEvidenceOwner, cellTraceAsset, readPrivateCellTraceAsset, assertPrivateCellDirectories, type CellReportProducerIdentity } from "./manual-private-report-assets.js";
import { assertSecretFree, normalizedSecrets } from "./redaction.js";
import { MANUAL_PRIVATE_PROTOCOL, manualCellKind, type ManualRetentionIdentity } from "./manual-private-retention.js";

export interface ManualPrivateHandoff extends ManualRetentionIdentity {
  protocol: typeof MANUAL_PRIVATE_PROTOCOL; private: true; root: string; cellReportProducer?: CellReportProducerIdentity;
}
export async function readManualPrivateHandoff(env: NodeJS.ProcessEnv, ids: string[]): Promise<ManualPrivateHandoff | undefined> {
  const file = env.PAPERCLIP_RUNNER_E2E_PRIVATE_PREFLIGHT;
  if (!file) return undefined;
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536 || metadata.mode & 0o077
    || typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("Invalid private evidence preflight custody");
  const receipt = JSON.parse(await readFile(file, "utf8")) as ManualPrivateHandoff & { status: string };
  if (receipt.protocol !== MANUAL_PRIVATE_PROTOCOL || receipt.status !== "verified" || receipt.private !== true
    || receipt.runId !== env.GITHUB_RUN_ID || receipt.attempt !== env.GITHUB_RUN_ATTEMPT || receipt.attempt !== "1"
    || receipt.workflowSha !== env.GITHUB_SHA || receipt.targetSha !== env.PAPERCLIP_RUNNER_E2E_SOURCE_SHA || receipt.executionIds.length !== ids.length
    || [...receipt.executionIds].sort().join() !== [...ids].sort().join()) throw new Error("Private evidence preflight does not match this exact attempt");
  const root = await realpath(receipt.root), temporary = await realpath(env.RUNNER_TEMP ?? "");
  const directory = await lstat(root);
  if (!root.startsWith(`${temporary}${path.sep}`) || root !== path.dirname(await realpath(file))
    || !directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077
    || typeof process.getuid === "function" && directory.uid !== process.getuid()) throw new Error("Invalid private evidence staging ownership");
  await assertCellReportProducer(receipt.cellReportProducer);
  return Object.freeze({ ...receipt, root });
}
export async function preserveOriginalFrameworkResult(directory: string) {
  const source = path.join(directory, "result.json");
  const info = await lstat(source).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid original framework result");
  const destination = path.join(directory, "snapshots", "manual-original-framework-result.json");
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}
export async function sealStandardOriginalEvidence(input: {
  context: ManualPrivateHandoff; executionId: string; source: string; evidence: EvidencePackageResult; secrets: readonly string[]; expectPassScreenshot: boolean;
}) {
  if (!input.context.executionIds.includes(input.executionId)) throw new Error("Private evidence execution is outside preflight");
  const cellOwner = input.context.cellReportProducer ? await privateCellEvidenceOwner(input.context, input.executionId) : undefined;
  if (cellOwner) await assertPrivateCellDirectories(cellOwner, input.source);
  const secrets = normalizedSecrets(input.secrets).flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")]);
  const out = path.join(input.context.root, "originals", manualCellKind(input.executionId));
  const root = await realpath(input.source), info = await lstat(input.source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid original standard evidence root");
  if (input.evidence.leaks.length) {
    await writeFile(path.join(input.context.root, "contamination.json"), JSON.stringify({ protocol: MANUAL_PRIVATE_PROTOCOL,
      status: "withheld_credential_contamination", complete: false }), { mode: 0o600, flag: "wx" });
    throw new Error("Credential-contaminated original evidence cannot be retained");
  }
  const parent = path.dirname(out);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (!(await realpath(parent)).startsWith(`${await realpath(input.context.root)}${path.sep}`)) throw new Error("Private original handoff escaped its preflight root");
  await mkdir(out, { mode: 0o700 });
  const records: Array<{ path: string; bytes: number; sha256: string }> = [];
  let visited = 0, bytes = 0;
  let missingRequiredEvidence: string[] = [];
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (++visited > 4096) throw new Error("Complete original evidence exceeds entry allowance");
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error("Original evidence contains an unsupported entry");
      if (entry.isDirectory()) {
        if (name.split("/").length > 24) throw new Error("Original evidence exceeds depth allowance");
        if (isStandardEvidencePath(`${name}/placeholder`)) await visit(name);
        continue;
      }
      if (!isStandardEvidencePath(name)) continue;
      const asset = cellOwner ? cellTraceAsset(name, cellOwner, "original") : undefined;
      if (asset?.reserved ? !asset.canonical : !isStandardEvidenceFile(name)) throw new Error("Unsupported original evidence carrier cannot be retained");
      assertSecretFree(name, secrets, "private evidence path");
      const source = path.join(root, name), target = path.join(out, name);
      if (!(await realpath(source)).startsWith(`${root}${path.sep}`)) throw new Error("Original evidence escaped its owned root");
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat(); bytes += before.size;
        if (!before.isFile() || !Number.isSafeInteger(bytes) || bytes > 256 * 1024 * 1024) throw new Error("Complete original evidence exceeds byte allowance");
        if (asset?.reserved) await readPrivateCellTraceAsset({ owner: cellOwner!, layout: "original", relative: name, file: source, remaining: before.size, secrets });
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const output = await open(target, "wx", 0o600), hash = createHash("sha256"), buffer = Buffer.alloc(65536);
        try {
          let copied = 0;
          while (copied < before.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - copied), copied);
            if (!bytesRead) throw new Error("Original evidence changed during handoff");
            hash.update(buffer.subarray(0, bytesRead)); let written = 0;
            while (written < bytesRead) { const part = await output.write(buffer, written, bytesRead - written, copied + written); if (!part.bytesWritten) throw new Error("Original evidence copy stopped"); written += part.bytesWritten; }
            copied += bytesRead;
          }
          const after = await handle.stat();
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Original evidence changed during handoff");
          await output.sync(); records.push({ path: name, bytes: copied, sha256: hash.digest("hex") });
        } finally { await output.close(); }
      } finally { await handle.close(); }
    }
  }
  try {
    await visit("");
    const validation = path.join(input.context.root, `validation-${manualCellKind(input.executionId)}`);
    await mkdir(validation, { mode: 0o700 });
    try {
      const scan = await packageEvidence({ privateDir: out, uploadDir: validation, secrets, expectPassScreenshot: input.expectPassScreenshot, ...(cellOwner ? { privateCell: { owner: cellOwner, layout: "original" as const } } : {}) });
      missingRequiredEvidence = scan.missing;
      if (scan.leaks.length) {
        await writeFile(path.join(input.context.root, "contamination.json"), JSON.stringify({ protocol: MANUAL_PRIVATE_PROTOCOL, status: "withheld_credential_contamination", complete: false }), { mode: 0o600, flag: "wx" });
        throw new Error("Original evidence failed unchanged privacy or required-file checks");
      }
    } finally { await rm(validation, { recursive: true, force: true }); }
    records.sort((a, b) => a.path.localeCompare(b.path));
    const receipt = { protocol: MANUAL_PRIVATE_PROTOCOL, executionId: input.executionId, targetSha: input.context.targetSha,
      complete: true, requiredEvidenceComplete: input.expectPassScreenshot ? missingRequiredEvidence.length === 0 : null,
      missingRequiredEvidence, sourceBytes: bytes, files: records, inventorySha256: createHash("sha256").update(JSON.stringify(records)).digest("hex") };
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    assertSecretFree(serialized, secrets, "private evidence inventory");
    await writeFile(path.join(out, "original-evidence-inventory.json"), serialized, { mode: 0o600, flag: "wx" });
    return receipt;
  } catch (error) { await rm(out, { recursive: true, force: true }); throw error; }
}

export async function sealManualResultEvidence(context: ManualPrivateHandoff, secrets: readonly string[], source = path.join(context.root, "results"), treeKind: "standard" | "generated-report" = "standard") {
  const cellOwner = treeKind === "standard" && context.cellReportProducer
    ? await privateCellEvidenceOwner(context, context.executionIds.length === 1 ? context.executionIds[0]! : "") : undefined;
  const root = await realpath(source), owned = await realpath(context.root);
  if (!root.startsWith(`${owned}${path.sep}`)) throw new Error("Packaged evidence escaped its owned root");
  const wrapper = path.join(context.root, "result-validation");
  const { cp, rename } = await import("node:fs/promises");
  await mkdir(wrapper, { mode: 0o700 });
  const records: Array<{ path: string; bytes: number; sha256: string }> = [];
  let bytes = 0;
  const scanSecrets = normalizedSecrets(secrets).flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")]);
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      assertSecretFree(name, scanSecrets, "private packaged evidence path");
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory() || name.split("/").length > 24) throw new Error("Invalid packaged evidence entry");
      if (entry.isDirectory()) { await visit(name); continue; }
      const cellAsset = cellOwner ? cellTraceAsset(name, cellOwner, "final") : undefined;
      if (cellAsset?.reserved && !cellAsset.canonical) throw new Error("Unsupported private cell trace owner");
      const standard = isStandardEvidenceFile(`html-report/${name}`);
      const canonical = treeKind === "generated-report" ? canonicalGeneratedReportAsset(name) : undefined;
      const staticReportOwner = treeKind === "generated-report" && (name.startsWith("html/trace/") || canonical !== undefined);
      if (cellAsset?.reserved ? !cellAsset.canonical : staticReportOwner ? !canonical : !standard) throw new Error("Unsupported packaged evidence carrier");
      const file = path.join(root, name), metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Invalid packaged evidence entry");
      if (metadata.size > 256 * 1024 * 1024 - bytes || records.length >= 4096) throw new Error("Complete packaged evidence exceeds allowance");
      const data = cellAsset?.reserved
        ? (await readPrivateCellTraceAsset({ owner: cellOwner!, layout: "final", relative: name, file, remaining: 256 * 1024 * 1024 - bytes, secrets: scanSecrets }))!
        : await readFile(file);
      if (staticReportOwner) {
        if (!await isTrustedGeneratedReportAsset(name, data)) throw new Error("Unsupported packaged evidence carrier");
        assertSecretFree(data, scanSecrets, "authenticated static report asset");
      }
      bytes += data.length;
      if (bytes > 256 * 1024 * 1024) throw new Error("Complete packaged evidence exceeds allowance");
      records.push({ path: name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    }
  }
  try {
    await visit("");
    if (!records.length) throw new Error("No genuine packaged evidence was produced");
    await cp(root, path.join(wrapper, "html-report"), { recursive: true, errorOnExist: true, force: false });
    const validation = path.join(context.root, "packaged-scan");
    try {
      const scan = await packageEvidence({ privateDir: wrapper, uploadDir: validation, secrets: scanSecrets, expectPassScreenshot: false, ...(cellOwner ? { privateCell: { owner: cellOwner, layout: "final-wrapper" as const } } : {}) });
      if (scan.leaks.length) throw new Error("Packaged evidence contains credential contamination");
      for (const record of records) {
        if (createHash("sha256").update(await readFile(path.join(wrapper, "html-report", record.path))).digest("hex") !== record.sha256)
          throw new Error("Packaged evidence changed during handoff");
      }
    } finally { await rm(validation, { recursive: true, force: true }); }
    records.sort((a, b) => a.path.localeCompare(b.path));
    const receipt = { protocol: MANUAL_PRIVATE_PROTOCOL, treeKind, complete: true, sourceBytes: bytes, files: records,
      inventorySha256: createHash("sha256").update(JSON.stringify(records)).digest("hex") };
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    assertSecretFree(serialized, scanSecrets, "private packaged inventory");
    await writeFile(path.join(wrapper, "result-evidence-inventory.json"), serialized, { mode: 0o600, flag: "wx" });
    await rename(wrapper, path.join(context.root, "sealed-results"));
    return receipt;
  } catch (error) { await rm(wrapper, { recursive: true, force: true }); throw error; }
}
