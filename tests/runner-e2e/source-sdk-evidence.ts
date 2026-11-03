import { createSdkArtifactScanner } from "./source-sdk-public-type.js";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { diagnosticSecrets, readPrivateDiagnosticSecrets } from "./private-diagnostics.js";
import { findSecretLeak } from "./redaction.js";

const selectedIds = new Set(["plugins.configure-plugin", "plugins.disable-plugin", "plugins.install-plugin", "plugins.use-plugin-tool", "routines.plugin-managed-routine", "secrets.least-scope-delivery"].map(id => `chat-features.runner-opencode.local.${id}`));
export const SOURCE_SDK_DIAGNOSTICS = "diagnostics/source-plugin-sdk";
const targets = ["packages/shared/dist", "packages/plugins/sdk/dist"] as const;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const staging = (root: string) => path.join(root, "artifacts-private", "source-sdk-build");
interface BuiltFile { file: string; size: number; sha256: string }
const retainedPath = (file: string) => file.replace(/\/\.paperclip-build-complete$/, "/build-completion-receipt.json");
interface RetainedBuild {
  schema: "paperclip.source-plugin-sdk/v1" | "paperclip.source-plugin-sdk/v2"; sourceRootSha256?: string; scanAudit?: Awaited<ReturnType<ReturnType<typeof createSdkArtifactScanner>["audit"]>>; executionId: string; sourceRevision: string; retainedAt: string;
  buildHelperSha256: string; lockSha256: string; files: Array<BuiltFile & { retainedPath: string; retainedSha256: string }>;
  certifiedTargets: Array<{ directory: string; sources: string; outputs: string }>;
}
function selected(ids: readonly string[]) { return ids.length === 1 && selectedIds.has(ids[0]!); }
function checkSecret(bytes: Buffer, secrets: readonly string[]) {
  if (findSecretLeak(bytes.toString("utf8"), secrets)) throw new Error("Source SDK evidence privacy check failed; bytes withheld");
}
async function retainScanAudit(root: string, executionId: string, audit: unknown, complete: boolean, secrets: readonly string[]) {
  const bytes = Buffer.from(JSON.stringify({ schema: "paperclip.source-sdk-privacy-observation/v1", complete, audit }, null, 2) + "\n");
  checkSecret(bytes, secrets);
  const directory = path.join(root, "artifacts-private", "cases", executionId.slice("chat-features.runner-opencode.local.".length), "snapshots");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "source-sdk-privacy-observations.json"), bytes, { flag: "wx", mode: 0o600 });
}
async function boundedTree(root: string) {
  const files: Array<BuiltFile & { bytes: Buffer }> = []; let total = 0;
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else {
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error("Source SDK output custody invalid");
        const bytes = await readFile(filename); total += bytes.length;
        if (files.length >= 4096 || total > 64 * 1024 * 1024) throw new Error("Source SDK output exceeds evidence bound");
        files.push({ file: path.relative(root, filename).split(path.sep).join("/"), size: bytes.length, sha256: hash(bytes), bytes });
      }
    }
  }
  const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Source SDK output root invalid");
  await visit(root); return files;
}
function outputHash(files: Array<{ file: string; bytes: Buffer }>) {
  const digest = createHash("sha256");
  for (const file of files.filter(row => row.file !== ".paperclip-build-complete")) {
    digest.update(JSON.stringify([file.file, file.bytes.length])); digest.update(file.bytes);
  }
  return digest.digest("hex");
}
export async function retainPreparedSourceSdk(input: { repositoryRoot: string; temporaryRoot: string; executionIds: readonly string[]; sourceRevision: string | null; installed: boolean }) {
  if (input.installed || !selected(input.executionIds)) return;
  if (!/^[a-f0-9]{40}$/.test(input.sourceRevision ?? "")) throw new Error("Source SDK retention requires exact source revision");
  const root = await realpath(input.temporaryRoot), repository = await realpath(input.repositoryRoot);
  // External private capture need not create the local SDK staging parent.
  // Own its initialization before retention instead of relying on later server-log setup.
  const privateRoot = path.join(root, "artifacts-private");
  try { await mkdir(privateRoot, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (await realpath(privateRoot) !== privateRoot) throw new Error("Source SDK staging custody invalid");
  const secrets = diagnosticSecrets(readPrivateDiagnosticSecrets(path.join(root, "selected-private-inputs", "diagnostic-redaction.json"), root)).values;
  const scanner = createSdkArtifactScanner(repository, secrets);
  const buffers: Array<BuiltFile & { bytes: Buffer }> = [], certifiedTargets: RetainedBuild["certifiedTargets"] = [];
  for (const directory of targets) {
    const files = await boundedTree(path.join(repository, directory));
    const marker = files.find(row => row.file === ".paperclip-build-complete"), entry = files.find(row => row.file === "index.js");
    if (!marker || !entry) throw new Error("Source SDK build completion evidence missing");
    const certificate = JSON.parse(marker.bytes.toString("utf8"));
    if (!hex(certificate.sources) || !hex(certificate.outputs) || outputHash(files) !== certificate.outputs) throw new Error("Source SDK build output no longer matches its completed compiler receipt");
    certifiedTargets.push({ directory, sources: certificate.sources, outputs: certificate.outputs });
    for (const file of files) {
      if (!await scanner.scan(`${directory}/${file.file}`, file.bytes)) {
        await retainScanAudit(root, input.executionIds[0]!, await scanner.audit(), false, secrets);
        throw new Error("Source SDK evidence privacy check failed; bytes withheld");
      }
      buffers.push({ ...file, file: `${directory}/${file.file}` });
    }
  }
  if (buffers.length >= 4096 || buffers.reduce((total, file) => total + file.size, 0) > 63 * 1024 * 1024) throw new Error("Source SDK output exceeds combined evidence bound");
  const scanAudit = await scanner.audit();
  await retainScanAudit(root, input.executionIds[0]!, scanAudit, true, secrets);
  const syntax = scanAudit.observations.some(row => row.classification === "public_schema_type");
  const receipt: RetainedBuild = { schema: syntax ? "paperclip.source-plugin-sdk/v2" : "paperclip.source-plugin-sdk/v1", ...(syntax ? { sourceRootSha256: hash(repository), scanAudit } : {}), executionId: input.executionIds[0]!, sourceRevision: input.sourceRevision!, retainedAt: new Date().toISOString(),
    buildHelperSha256: hash(await readFile(path.join(repository, "scripts/ensure-plugin-build-deps.mjs"))), lockSha256: hash(await readFile(path.join(repository, "pnpm-lock.yaml"))),
    certifiedTargets, files: buffers.map(({ bytes: _, ...row }) => ({ ...row, retainedPath: retainedPath(row.file), retainedSha256: row.sha256 })) };
  if (new Set(receipt.files.map(file => file.retainedPath)).size !== receipt.files.length) throw new Error("Source SDK retained filename collision");
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n"); checkSecret(receiptBytes, secrets);
  const destination = staging(root); await mkdir(destination, { mode: 0o700 });
  try {
    for (const file of buffers) {
      const filename = path.join(destination, file.file); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, file.bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(path.join(destination, "receipt.json"), receiptBytes, { flag: "wx", mode: 0o600 });
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
export async function verifyRetainedSourceSdk(root: string, executionId: string, sourceRevision: string | null, knownSecrets: readonly string[], repositoryRoot = path.resolve(import.meta.dirname, "../..")) {
  if (!selected([executionId])) throw new Error("Source SDK retained selection mismatch");
  if (await realpath(staging(root)) !== staging(root)) throw new Error("Source SDK retained custody invalid");
  const secrets = diagnosticSecrets(knownSecrets).values, files = await boundedTree(staging(root));
  const receiptFile = files.find(row => row.file === "receipt.json"); if (!receiptFile) throw new Error("Source SDK retained receipt missing");
  const receipt = JSON.parse(receiptFile.bytes.toString("utf8")) as RetainedBuild;
  if (!["paperclip.source-plugin-sdk/v1", "paperclip.source-plugin-sdk/v2"].includes(receipt.schema) || receipt.executionId !== executionId || receipt.sourceRevision !== sourceRevision
    || !hex(receipt.buildHelperSha256) || !hex(receipt.lockSha256) || !Array.isArray(receipt.files)) throw new Error("Source SDK retained identity mismatch");
  const actual = files.filter(row => row.file !== "receipt.json");
  if (actual.length !== receipt.files.length || actual.some(row => !targets.some(target => row.file.startsWith(`${target}/`))
    || !receipt.files.some(expected => expected.file === row.file && expected.retainedPath === retainedPath(row.file) && expected.size === row.size && expected.sha256 === row.sha256 && expected.retainedSha256 === row.sha256))) throw new Error("Source SDK retained bytes changed");
  if (receipt.schema === "paperclip.source-plugin-sdk/v2") {
    if (!receipt.scanAudit || receipt.sourceRootSha256 !== hash(await realpath(repositoryRoot))) throw new Error("Source SDK public source custody changed");
    const scanner = createSdkArtifactScanner(await realpath(repositoryRoot), secrets);
    for (const file of actual) if (!await scanner.scan(file.file, file.bytes)) throw new Error("Source SDK evidence privacy check failed; bytes withheld");
    if (JSON.stringify(await scanner.audit()) !== JSON.stringify(receipt.scanAudit)) throw new Error("Source SDK public observations changed");
    checkSecret(receiptFile.bytes, secrets);
  } else for (const file of files) checkSecret(file.bytes, secrets);
  return { receipt, files };
}
export async function copyRetainedSourceSdk(root: string, executionId: string, sourceRevision: string | null, uploadDir: string, knownSecrets: readonly string[], repositoryRoot = path.resolve(import.meta.dirname, "../..")) {
  if (!selected([executionId])) return;
  const { files } = await verifyRetainedSourceSdk(root, executionId, sourceRevision, knownSecrets, repositoryRoot);
  const destination = path.join(uploadDir, SOURCE_SDK_DIAGNOSTICS); await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const filename = path.join(destination, retainedPath(file.file)); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, file.bytes, { flag: "wx", mode: 0o600 }); await chmod(filename, 0o600);
    if (hash(await readFile(filename)) !== file.sha256) throw new Error("Source SDK published bytes changed");
  }
}
