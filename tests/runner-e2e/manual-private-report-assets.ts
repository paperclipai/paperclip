import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { assertSecretFree, normalizedSecrets } from "./redaction.js";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export function canonicalGeneratedReportAsset(relative: string): string | undefined {
  if (relative === "normalized/assets/InterVariable.woff2") return path.join(repositoryRoot, "ui/public/fonts/InterVariable.woff2");
  if (!relative.startsWith("html/trace/")) return;
  const parts = relative.slice("html/trace/".length).split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part))) return;
  if (parts.length === 1) {
    if (parts[0]!.endsWith(".map") || parts[0]!.includes("watch") || parts[0]!.includes("assets")) return;
  } else if (parts.length !== 2 || parts[0] !== "assets" || parts[1]!.endsWith(".map") || parts[1]!.includes("xtermModule")) return;
  const test = require.resolve("@playwright/test/package.json");
  const playwright = require.resolve("playwright/package.json", { paths: [path.dirname(test)] });
  const core = require.resolve("playwright-core/package.json", { paths: [path.dirname(playwright)] });
  return path.join(path.dirname(core), "lib/vite/traceViewer", ...parts);
}
export async function isTrustedGeneratedReportAsset(relative: string, bytes: Buffer): Promise<boolean> {
  const source = canonicalGeneratedReportAsset(relative);
  if (!source) return false;
  const metadata = await lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  return !!metadata && metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === bytes.length && bytes.equals(await readFile(source));
}

// Portable dependency identity: paths are package-relative, never host paths.
export interface CellReportProducerIdentity {
  packages: Array<{ name: string; version: string; sha256: string }>;
  producers: Array<{ path: string; sha256: string }>;
  staticManifestSha256: string; staticFileCount: number; staticBytes: number;
}
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const packageNames = ["@playwright/test", "playwright", "playwright-core"];
const producerNames = ["lib/index.js", "lib/worker/workerProcessEntry.js", "lib/runner/index.js"];
const sourceAllowance = 256 * 1024 * 1024;
async function boundedSource(file: string, remaining: number) {
  if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("Invalid canonical report allowance");
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > remaining) throw new Error("Invalid canonical report source");
  const bytes = await readFile(file), after = await lstat(file);
  if (bytes.length !== metadata.size || after.ino !== metadata.ino || after.dev !== metadata.dev
    || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs)
    throw new Error("Canonical report source changed");
  return bytes;
}
export async function inspectCellReportProducer(): Promise<CellReportProducerIdentity> {
  const test = require.resolve("@playwright/test/package.json");
  const playwright = require.resolve("playwright/package.json", { paths: [path.dirname(test)] });
  const core = require.resolve("playwright-core/package.json", { paths: [path.dirname(playwright)] });
  let sourceBytes = 0;
  const sourceRead = async (file: string, limit = sourceAllowance) => {
    const data = await boundedSource(file, Math.min(limit, sourceAllowance - sourceBytes)); sourceBytes += data.length; return data;
  };
  const packages: CellReportProducerIdentity["packages"] = [];
  for (const [index, file] of [test, playwright, core].entries()) {
    const bytes = await sourceRead(file, 65536), parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed.name !== packageNames[index] || typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(parsed.version) || parsed.version.length > 100)
      throw new Error("Invalid report package identity");
    packages.push({ name: parsed.name, version: parsed.version, sha256: hash(bytes) });
  }
  const producers: CellReportProducerIdentity["producers"] = [];
  for (const relative of producerNames) producers.push({ path: relative, sha256: hash(await sourceRead(path.join(path.dirname(playwright), relative))) });
  const viewer = path.join(path.dirname(core), "lib/vite/traceViewer"), assets = path.join(viewer, "assets");
  for (const directory of [viewer, assets]) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Invalid canonical report directory");
  }
  const manifest: Array<{ path: string; bytes: number; sha256: string }> = [];
  let bytes = 0, visited = 0;
  for (const prefix of ["", "assets/"]) {
    for (const entry of await readdir(path.join(viewer, prefix), { withFileTypes: true })) {
      if (++visited > 4096) throw new Error("Canonical report closure exceeds entry allowance");
      const relative = prefix + entry.name, canonical = canonicalGeneratedReportAsset(`html/trace/${relative}`);
      if (!canonical) continue;
      if (manifest.length >= 4096 || !entry.isFile() || entry.isSymbolicLink()) throw new Error("Invalid canonical report closure");
      const data = await sourceRead(canonical); bytes += data.length;
      manifest.push({ path: relative, bytes: data.length, sha256: hash(data) });
    }
  }
  if (!manifest.length) throw new Error("Empty canonical report closure");
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  return { packages, producers, staticManifestSha256: hash(JSON.stringify(manifest)), staticFileCount: manifest.length, staticBytes: bytes };
}
export async function assertCellReportProducer(expected: unknown) {
  const actual = await inspectCellReportProducer();
  // JSON equality also closes unknown keys, ordering and arbitrary machine paths.
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Private cell report producer differs from trusted preflight");
  return actual;
}

const verifiedOwners = new WeakSet<object>();
export interface PrivateCellEvidenceOwner {
  readonly root: string; readonly executionId: string; readonly runId: string; readonly attempt: "1";
  readonly producer: CellReportProducerIdentity;
}
export type PrivateCellLayout = "original" | "final" | "final-wrapper";
/** Only the already verified preflight may enable private cell asset handling. */
export async function privateCellEvidenceOwner(context: {
  private: true; root: string; runId: string; attempt: string; executionIds: string[]; cellReportProducer?: CellReportProducerIdentity;
}, executionId: string): Promise<PrivateCellEvidenceOwner> {
  if (context.private !== true || !context.executionIds.includes(executionId) || !/^chat-features\.runner-opencode\.local\.[a-z0-9][a-z0-9.-]{0,159}$/.test(executionId)
    || executionId.includes("..") || !/^[1-9][0-9]{0,19}$/.test(context.runId) || context.attempt !== "1" || !context.cellReportProducer)
    throw new Error("Invalid private cell report owner");
  const root = await realpath(context.root), metadata = await lstat(context.root);
  if (root !== path.resolve(context.root) || !metadata.isDirectory() || metadata.isSymbolicLink() || metadata.mode & 0o077
    || typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("Invalid private cell report custody");
  const producer = await assertCellReportProducer(context.cellReportProducer);
  const owner = Object.freeze({ root, executionId, runId: context.runId, attempt: "1" as const, producer });
  verifiedOwners.add(owner); return owner;
}
export function cellTraceAsset(relative: string, owner: PrivateCellEvidenceOwner, layout: PrivateCellLayout) {
  if (!verifiedOwners.has(owner) || !["original", "final", "final-wrapper"].includes(layout)) throw new Error("Unverified private cell report owner");
  const segments = relative.split("/");
  const reserved = segments.some((part, index) => part === "html-report" && segments[index + 1] === "trace");
  if (!reserved) return { reserved: false };
  const scenario = owner.executionId.slice("chat-features.runner-opencode.local.".length);
  const final = `gha-${owner.runId}-${owner.attempt}-${owner.executionId}/chat-features/runner-opencode/local/${scenario}/attempt-${owner.attempt}/html-report/trace/`;
  const prefix = layout === "original" ? "html-report/trace/" : layout === "final" ? final : `html-report/${final}`;
  const canonical = relative.startsWith(prefix) ? canonicalGeneratedReportAsset(`html/trace/${relative.slice(prefix.length)}`) : undefined;
  return { reserved: true, canonical };
}
export async function assertPrivateCellDirectories(owner: PrivateCellEvidenceOwner, source: string, destination?: string) {
  if (!verifiedOwners.has(owner)) throw new Error("Unverified private cell report owner");
  const root = await realpath(owner.root), metadata = await lstat(root);
  if (root !== owner.root || !metadata.isDirectory() || metadata.mode & 0o077
    || typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("Private cell report custody changed");
  for (const [index, directory] of [source, ...(destination ? [destination] : [])].entries()) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Cell report escaped private staging");
    let current = root;
    for (const part of path.relative(root, resolved).split(path.sep)) {
      current = path.join(current, part);
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" && index > 0) return undefined; throw error; });
      if (!info) break;
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid private cell report directory");
    }
  }
  if (destination && (path.resolve(destination) === path.resolve(source) || path.resolve(source).startsWith(`${path.resolve(destination)}${path.sep}`)
    || path.resolve(destination).startsWith(`${path.resolve(source)}${path.sep}`))) throw new Error("Overlapping private cell report directories");
}

export async function readPrivateCellTraceAsset(input: {
  owner: PrivateCellEvidenceOwner; layout: PrivateCellLayout; relative: string; file: string; remaining: number; secrets: readonly string[];
}): Promise<Buffer | undefined> {
  const asset = cellTraceAsset(input.relative, input.owner, input.layout);
  const secrets = normalizedSecrets(input.secrets).flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")]);
  assertSecretFree(input.relative, secrets, "private cell trace path");
  if (!asset.reserved) return;
  if (!asset.canonical) throw new Error("Unsupported private cell trace owner");
  await assertPrivateCellDirectories(input.owner, path.dirname(input.file));
  const metadata = await lstat(input.file), canonical = await lstat(asset.canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > input.remaining
    || !canonical.isFile() || canonical.isSymbolicLink() || canonical.size !== metadata.size)
    throw new Error("Invalid private cell trace asset");
  const bytes = await boundedSource(input.file, input.remaining);
  if (!bytes.equals(await boundedSource(asset.canonical, bytes.length))) throw new Error("Private cell trace content differs from canonical producer");
  assertSecretFree(bytes, secrets, "private cell trace bytes");
  return bytes;
}
