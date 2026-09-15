#!/usr/bin/env node
// The build job has no publish credential. The publisher only validates and
// uploads fixed data files; it never installs or executes package code.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertMetadata, tarManifest, versionFor } from "./preview-artifacts.mjs";

export const artifactBase = "https://d1p6rlowie26tp.cloudfront.net/cloud-migrators/v1";
export const artifactBucket = "paperclipai-runner-e2e-history-078455283791-us-east-1";
const prefix = "cloud-migrators/v1/";
const names = ["db", "shared"];
const maximumBytes = 32 * 1024 * 1024;
const integrityFor = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export function descriptor(bytes, extension) {
  const hash = createHash("sha512").update(bytes).digest("hex");
  return { url: `${artifactBase}/blobs/${hash}.${extension}`, integrity: integrityFor(bytes), size: bytes.length };
}

function assertDescriptor(pin, extension) {
  if (!pin || typeof pin.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity) ||
      !Number.isSafeInteger(pin.size) || pin.size <= 0 || pin.size > maximumBytes) throw new Error("Invalid artifact integrity or size.");
  const digest = Buffer.from(pin.integrity.slice(7), "base64");
  if (digest.toString("base64") !== pin.integrity.slice(7) || pin.url !== `${artifactBase}/blobs/${digest.toString("hex")}.${extension}`) {
    throw new Error("Artifact URL does not match its content hash and trusted origin.");
  }
}

export function assertManifest(manifest, sha) {
  if (manifest?.version !== 1 || manifest.sourceSha !== sha || manifest.packageVersion !== versionFor(sha)) throw new Error("Artifact source identity mismatch.");
  for (const name of names) assertDescriptor(manifest.packages?.[name], "tgz");
  assertDescriptor(manifest.lockfile, "json");
}

export function assertLockfile(lock, manifest) {
  const version = manifest.packageVersion;
  if (lock?.lockfileVersion !== 3 || !lock.packages || Array.isArray(lock.packages) ||
      JSON.stringify(lock.packages[""]?.dependencies) !== JSON.stringify({ "@paperclipai/db": version })) throw new Error("Invalid migrator lockfile root.");
  for (const name of names) {
    const pin = lock.packages[`node_modules/@paperclipai/${name}`];
    const expected = manifest.packages[name];
    if (pin?.version !== version || pin.integrity !== expected.integrity || pin.resolved !== expected.url || pin.link || pin.inBundle) throw new Error("Migrator lockfile package pin mismatch.");
  }
  if (lock.packages["node_modules/@paperclipai/db"].dependencies?.["@paperclipai/shared"] !== version) throw new Error("Migrator shared dependency mismatch.");
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue;
    if (!entry || typeof entry !== "object" || entry.link) throw new Error("Invalid migrator lockfile entry.");
    if (/(?:^|\/)node_modules\/@paperclipai\/[^/]+$/.test(key) && !names.some((name) => key === `node_modules/@paperclipai/${name}`)) throw new Error("Unexpected internal migrator dependency.");
    if (entry.inBundle === true) {
      if (!key.startsWith("node_modules/@paperclipai/db/node_modules/")) throw new Error("Unexpected bundled dependency.");
      continue;
    }
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? "")) throw new Error("Migrator dependency has no strong integrity pin.");
    if (names.some((name) => key === `node_modules/@paperclipai/${name}`)) continue;
    const url = new URL(entry.resolved);
    if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash) throw new Error("Migrator dependency must resolve to npm.");
  }
}

export function buildBundle(directory, sha, { exec = execFileSync } = {}) {
  versionFor(sha);
  directory = path.resolve(directory);
  const packages = {};
  for (const name of names) {
    const bytes = readFileSync(path.join(directory, `${name}.tgz`));
    assertMetadata(tarManifest(bytes), `@paperclipai/${name}`, sha);
    packages[name] = descriptor(bytes, "tgz");
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), "cloud-migrator-lock-"));
  try {
    for (const name of names) copyFileSync(path.join(directory, `${name}.tgz`), path.join(scratch, `${name}.tgz`));
    const root = { name: "paperclip-migrator-install-root", version: "0.0.0", private: true,
      dependencies: { "@paperclipai/db": "file:db.tgz", "@paperclipai/shared": "file:shared.tgz" } };
    writeFileSync(path.join(scratch, "package.json"), JSON.stringify(root));
    exec("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"], { cwd: scratch, stdio: "inherit", timeout: 180_000 });
    const lock = JSON.parse(readFileSync(path.join(scratch, "package-lock.json"), "utf8"));
    // Both new packages are local during resolution. npm ci subsequently uses
    // these immutable URLs, without looking up the new npm versions.
    lock.packages[""].dependencies = { "@paperclipai/db": versionFor(sha) };
    for (const name of names) lock.packages[`node_modules/@paperclipai/${name}`].resolved = packages[name].url;
    const lockBytes = Buffer.from(JSON.stringify(lock) + "\n");
    const manifest = { version: 1, sourceSha: sha, packageVersion: versionFor(sha), packages, lockfile: descriptor(lockBytes, "json") };
    assertManifest(manifest, sha);
    assertLockfile(lock, manifest);
    writeFileSync(path.join(directory, "package-lock.json"), lockBytes);
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest) + "\n");
    return manifest;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function verifyBytes(bytes, pin) {
  if (bytes.length !== pin.size || integrityFor(bytes) !== pin.integrity) throw new Error("Artifact bytes do not match their immutable pin.");
}

export function validateBundle(directory, sha) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assertManifest(manifest, sha);
  for (const name of names) {
    const bytes = readFileSync(path.join(directory, `${name}.tgz`));
    verifyBytes(bytes, manifest.packages[name]);
    assertMetadata(tarManifest(bytes), `@paperclipai/${name}`, sha);
  }
  const bytes = readFileSync(path.join(directory, "package-lock.json"));
  verifyBytes(bytes, manifest.lockfile);
  assertLockfile(JSON.parse(bytes), manifest);
  return manifest;
}

/** Exercise the real dependency graph before publishing, with no new npm versions. */
export function verifyInstall(directory, sha, { exec = execFileSync } = {}) {
  const manifest = validateBundle(directory, sha);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "cloud-migrator-install-"));
  try {
    const lock = JSON.parse(readFileSync(path.join(directory, "package-lock.json"), "utf8"));
    for (const name of names) {
      copyFileSync(path.join(directory, `${name}.tgz`), path.join(scratch, `${name}.tgz`));
      // The public objects do not exist yet. Only transport changes for this
      // smoke install; exact versions, integrity, root and transitive pins stay.
      lock.packages[`node_modules/@paperclipai/${name}`].resolved = `file:${name}.tgz`;
    }
    writeFileSync(path.join(scratch, "package.json"), JSON.stringify({ name: "paperclip-migrator-install-root", version: "0.0.0", private: true,
      dependencies: { "@paperclipai/db": manifest.packageVersion } }));
    writeFileSync(path.join(scratch, "package-lock.json"), JSON.stringify(lock));
    exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--update-notifier=false", "--cache", path.join(scratch, "empty-cache"),
      "--registry=https://registry.npmjs.org"], { cwd: scratch, stdio: "inherit", timeout: 180_000 });
    for (const name of names) assertMetadata(JSON.parse(readFileSync(path.join(scratch, "node_modules", "@paperclipai", name, "package.json"), "utf8")), `@paperclipai/${name}`, sha);
    exec(process.execPath, ["--input-type=module", "--eval", "await import('@paperclipai/db'); await import('@paperclipai/shared');"], { cwd: scratch, stdio: "inherit", timeout: 30_000 });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

async function download(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Artifact download failed: HTTP ${response.status}`, { cause: { status: response.status } });
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximumBytes) throw new Error("Artifact exceeds size limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export async function verifyPublished(sha, fetchImpl = fetch, { verifyProvenance } = {}) {
  versionFor(sha);
  const bytes = await download(`${artifactBase}/${sha}/manifest.json`, fetchImpl);
  const manifest = JSON.parse(bytes);
  assertManifest(manifest, sha);
  if (verifyProvenance) await verifyProvenance(bytes, sha);
  await Promise.all(names.map(async (name) => {
    const bytes = await download(manifest.packages[name].url, fetchImpl);
    verifyBytes(bytes, manifest.packages[name]);
    assertMetadata(tarManifest(bytes), `@paperclipai/${name}`, sha);
  }));
  const lock = await download(manifest.lockfile.url, fetchImpl);
  verifyBytes(lock, manifest.lockfile);
  assertLockfile(JSON.parse(lock), manifest);
  return manifest;
}

export async function publishBundle(directory, sha, { exec = execFileSync, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const manifest = validateBundle(directory, sha);
  const key = `${prefix}${sha}/manifest.json`;
  const verifyVisible = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await verifyPublished(sha, fetchImpl); }
      catch (error) {
        // A consumer may have cached a missing-object response just before
        // publication. Wait through the CDN error TTL, never through bad bytes.
        if (attempt >= 6 || ![403, 404].includes(error.cause?.status)) throw error;
        await sleep(2_000);
      }
    }
  };
  const aws = (args) => exec("aws", ["s3api", ...args, "--bucket", artifactBucket, "--region", "us-east-1"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  // Exact prefix listing distinguishes missing objects from permission errors.
  const exists = (objectKey) => JSON.parse(aws(["list-objects-v2", "--prefix", objectKey, "--max-keys", "1"])).Contents?.some((object) => object.Key === objectKey);
  if (exists(key)) return verifyVisible();
  const upload = (file, objectKey, contentType) => {
    if (exists(objectKey)) return;
    aws(["put-object", "--key", objectKey, "--body", path.resolve(directory, file), "--content-type", contentType,
      "--cache-control", "public,max-age=31536000,immutable", "--if-none-match", "*"]);
  };
  for (const name of names) upload(`${name}.tgz`, prefix + manifest.packages[name].url.slice(`${artifactBase}/`.length), "application/gzip");
  upload("package-lock.json", prefix + manifest.lockfile.url.slice(`${artifactBase}/`.length), "application/json");
  // Publish the commit marker last; readers can never observe a partial bundle.
  upload("manifest.json", key, "application/json");
  return verifyVisible();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, directory, sha] = process.argv.slice(2);
  try {
    if (command === "build") buildBundle(directory, sha);
    else if (command === "validate") validateBundle(directory, sha);
    else if (command === "verify-install") verifyInstall(directory, sha);
    else if (command === "publish") await publishBundle(directory, sha);
    else if (command === "verify") await verifyPublished(directory);
    else throw new Error("Expected build, validate, verify-install, publish, or verify.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
