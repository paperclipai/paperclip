import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { COPILOT_VERSION, materializePinnedCopilotBinary, resolveCopilotDistribution } from "./materialize-copilot-binary.mjs";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 384 * 1024 * 1024;
const PROFILE_DIGEST = "sha256:ece77e40876631a69a828b91813722001d71b6fc81be47ecd4b3dced84ff9473";

/** Build-time only; outputRoot is the exact runner-owned platform asset directory. */
export async function buildPinnedCopilotDistribution({ outputRoot, platform = process.platform, architecture = process.arch }, { fetchImpl = fetch } = {}) {
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot) || resolve(outputRoot) !== outputRoot || outputRoot.includes("\0")) {
    throw new Error("Copilot outputRoot must be a normalized absolute build directory");
  }
  const distribution = resolveCopilotDistribution(platform, architecture);
  const packageBasename = distribution.packageName.slice("@github/".length);
  const archiveUrl = `https://registry.npmjs.org/${distribution.packageName}/-/${packageBasename}-${COPILOT_VERSION}.tgz`;
  const response = await fetchImpl(archiveUrl, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Pinned Copilot archive download failed (${response.status})`);
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength !== null && (!/^\d+$/.test(advertisedLength) || Number(advertisedLength) > MAX_ARCHIVE_BYTES)) {
    await response.body.cancel(); throw new Error("Pinned Copilot archive exceeds its download bound");
  }
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_ARCHIVE_BYTES) throw new Error("Pinned Copilot archive exceeds its download bound");
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks, total);
  verifyCopilotArchiveIntegrity(archive, distribution.archiveIntegrity);
  const entries = readCopilotArchiveEntries(gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES }));
  const metadata = JSON.parse(entries.get("package/package.json").toString("utf8"));
  if (metadata.name !== distribution.packageName || metadata.version !== COPILOT_VERSION) throw new Error("Copilot archive package identity differs from its immutable profile");
  const binary = entries.get("package/copilot");
  if (binary.length !== distribution.size || createHash("sha256").update(binary).digest("hex") !== distribution.executableDigest) {
    throw new Error("Copilot archive executable differs from its pinned distribution");
  }
  // Never extract archive paths. Only the two admitted files enter this private
  // temporary package, and no package scripts or executables are invoked.
  const temporary = await mkdtemp(join(tmpdir(), "paperclip-copilot-build-"));
  try {
    await writeFile(join(temporary, "package.json"), entries.get("package/package.json"), { flag: "wx", mode: 0o600 });
    await writeFile(join(temporary, "copilot"), binary, { flag: "wx", mode: 0o700 });
    await mkdir(outputRoot, { recursive: true, mode: 0o755 });
    if (!(await lstat(outputRoot)).isDirectory() || await realpath(outputRoot) !== outputRoot) throw new Error("Copilot build directory must not redirect through links");
    const materialized = materializePinnedCopilotBinary({ packageRoot: temporary, targetDirectory: outputRoot, platform, architecture });
    return { version: COPILOT_VERSION, profileDigest: PROFILE_DIGEST, closureDigest: `sha256:${materialized.closureSha256}` };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function verifyCopilotArchiveIntegrity(bytes, integrity) {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error("Copilot archive integrity pin is malformed");
  const expected = Buffer.from(integrity.slice(7), "base64");
  if (!timingSafeEqual(createHash("sha512").update(bytes).digest(), expected)) throw new Error("Copilot archive SHA-512 integrity mismatch");
}

/** Strict npm tar subset: no links, traversal, PAX overrides, duplicates or hidden trailers. */
export function readCopilotArchiveEntries(tar) {
  if (!Buffer.isBuffer(tar) || tar.length < 1024 || tar.length > MAX_EXPANDED_BYTES || tar.length % 512 !== 0) throw new Error("Copilot tar archive has invalid framing");
  const permitted = new Set(["package/copilot", "package/package.json", "package/LICENSE.md", "package/README.md"]);
  const entries = new Map(); let offset = 0; let ended = false;
  const field = (header, start, end) => {
    const bytes = header.subarray(start, end); const nul = bytes.indexOf(0);
    if (nul >= 0 && bytes.subarray(nul).some(byte => byte !== 0)) throw new Error("Copilot tar field contains hidden bytes");
    return bytes.subarray(0, nul < 0 ? undefined : nul).toString("ascii");
  };
  const octal = (header, start, end) => {
    const value = header.subarray(start, end).toString("ascii").replace(/\0/g, "").trim();
    if (!/^[0-7]+$/.test(value)) throw new Error("Copilot tar numeric field is malformed");
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed)) throw new Error("Copilot tar numeric field exceeds its bound");
    return parsed;
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (offset + 512 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) throw new Error("Copilot tar archive has a hidden or truncated trailer");
      ended = true; break;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(header, 148, 156)) throw new Error("Copilot tar header checksum mismatch");
    const name = field(header, 0, 100);
    const size = octal(header, 124, 136);
    if (!permitted.has(name) || entries.has(name) || field(header, 345, 500) !== "" || field(header, 157, 257) !== ""
      || header[156] !== 48 || field(header, 257, 263) !== "ustar" || header.subarray(263, 265).toString("ascii") !== "00") {
      throw new Error("Copilot tar archive contains an unrecognized or unsafe entry");
    }
    if (size < 1 || size > (name === "package/copilot" ? MAX_EXPANDED_BYTES : 256 * 1024) || offset + size > tar.length) throw new Error("Copilot tar entry exceeds its bounded payload");
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tar.length || tar.subarray(offset + size, offset + paddedSize).some(byte => byte !== 0)) throw new Error("Copilot tar entry has invalid padding");
    entries.set(name, tar.subarray(offset, offset + size));
    offset += paddedSize;
  }
  if (!ended || entries.size !== permitted.size) throw new Error("Copilot tar archive is incomplete");
  return entries;
}
