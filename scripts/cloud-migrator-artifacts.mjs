#!/usr/bin/env node
// The build job has no publish credential. The publisher only validates and
// uploads fixed data files; it never installs or executes package code.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
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

const compatibilityValues = ["online_compatible", "requires_staging", "unknown"];
const migrationsPrefix = "package/dist/migrations/";

/** Regular files under `prefix` in a package archive, by archive path. */
function tarFiles(bytes, prefix) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((v) => v === 0)) break;
    const field = (start, size) => h.subarray(start, start + size).toString("utf8").split("\0")[0].trim();
    const sizeText = field(124, 12);
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid package archive.");
    const size = Number.parseInt(sizeText, 8);
    if (offset + 512 + size > tar.length) throw new Error("Truncated package archive.");
    const name = `${field(345, 155) ? field(345, 155) + "/" : ""}${field(0, 100)}`;
    if ([0, 48].includes(h[156]) && name.startsWith(prefix)) {
      if (files.has(name)) throw new Error("Duplicate package archive entry.");
      files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The journal of the packed migrator, in apply order, with each file's bytes. */
function packedMigrations(dbBytes) {
  const files = tarFiles(dbBytes, migrationsPrefix);
  const journal = files.get(`${migrationsPrefix}meta/_journal.json`);
  if (!journal) throw new Error("Migrator package has no migration journal.");
  const entries = JSON.parse(journal.toString("utf8")).entries;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Migrator package has an empty migration journal.");
  // The migrator's apply order: journal idx, then file name. The shipped
  // journal repeats an idx, so idx alone does not identify a migration.
  return [...entries].sort((left, right) => left.idx - right.idx || (String(left.tag) < String(right.tag) ? -1 : 1)).map(({ idx, tag }) => {
    const sql = files.get(`${migrationsPrefix}${tag}.sql`);
    if (!sql) throw new Error(`Migrator package is missing migration ${tag}.`);
    // The same digest the migrator records in the database's migration history.
    return { idx, tag, sql, sqlSha256: createHash("sha256").update(sql).digest("hex") };
  });
}

/**
 * Whether each packed migration can be applied while the previous release is
 * still running. `classify` is classifyMigrationSequence from @paperclipai/db:
 * it takes the SQL of every migration in apply order. The overrides it honours
 * come only from the packed SQL itself.
 */
export function migrationCompatibility(dbBytes, classify) {
  const packed = packedMigrations(dbBytes);
  const results = classify(packed.map(({ sql }) => sql.toString("utf8")));
  if (!Array.isArray(results) || results.length !== packed.length) throw new Error("The classifier did not return one result per migration.");
  return {
    version: 1,
    migrations: packed.map(({ idx, tag, sqlSha256 }, position) => {
      const result = results[position];
      return {
        idx, tag, sqlSha256,
        compatibility: result.compatibility,
        classified: result.classified,
        override: Boolean(result.override),
        ...(result.override ? { overrideJustification: result.override.justification } : {}),
        reasons: result.reasons.map(({ code, compatibility, message, statements }) => ({ code, compatibility, message, statements: [...statements] })),
      };
    }),
  };
}

function assertMigrationCompatibility(value) {
  const fail = () => { throw new Error("Invalid migration compatibility data."); };
  if (value?.version !== 1 || !Array.isArray(value.migrations) || value.migrations.length === 0) fail();
  const text = (candidate) => typeof candidate === "string" && candidate.length > 0 && candidate.length <= 2000;
  value.migrations.forEach((migration, position) => {
    const previous = value.migrations[position - 1];
    if (!Number.isSafeInteger(migration?.idx) || migration.idx < 0 ||
        (previous && (migration.idx < previous.idx || (migration.idx === previous.idx && !(migration.tag > previous.tag)))) ||
        typeof migration.tag !== "string" || !/^\d{4}_[A-Za-z0-9_]+$/.test(migration.tag) ||
        typeof migration.sqlSha256 !== "string" || !/^[0-9a-f]{64}$/.test(migration.sqlSha256) ||
        !compatibilityValues.includes(migration.compatibility) || !compatibilityValues.includes(migration.classified) ||
        typeof migration.override !== "boolean" || !Array.isArray(migration.reasons)) fail();
    // An override always carries its justification and never yields `unknown`.
    if (migration.override ? !text(migration.overrideJustification) || migration.compatibility === "unknown" : migration.overrideJustification !== undefined) fail();
    for (const reason of migration.reasons) {
      if (typeof reason?.code !== "string" || !/^[a-z_]+$/.test(reason.code) || !compatibilityValues.includes(reason.compatibility) || !text(reason.message) ||
          !Array.isArray(reason.statements) || !reason.statements.every((statement) => Number.isSafeInteger(statement) && statement > 0)) fail();
    }
  });
}

export function assertManifest(manifest, sha) {
  if (manifest?.version !== 1 || manifest.sourceSha !== sha || manifest.packageVersion !== versionFor(sha)) throw new Error("Artifact source identity mismatch.");
  for (const name of names) assertDescriptor(manifest.packages?.[name], "tgz");
  assertDescriptor(manifest.lockfile, "json");
  // Additive since the classifier shipped; manifests published earlier lack it.
  if (manifest.migrationCompatibility !== undefined) assertMigrationCompatibility(manifest.migrationCompatibility);
}

/** The published classification must describe exactly the migrations in db.tgz. */
function assertCompatibilityMatchesPackage(manifest, dbBytes) {
  const published = manifest.migrationCompatibility?.migrations;
  const packed = packedMigrations(dbBytes);
  if (!published || published.length !== packed.length || packed.some(({ idx, tag, sqlSha256 }, position) =>
    published[position].idx !== idx || published[position].tag !== tag || published[position].sqlSha256 !== sqlSha256)) {
    throw new Error("Migration compatibility data does not match the packed migrations.");
  }
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

export function buildBundle(directory, sha, { exec = execFileSync, classify } = {}) {
  versionFor(sha);
  if (typeof classify !== "function") throw new Error("buildBundle needs the migration compatibility classifier.");
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
    const dbBytes = readFileSync(path.join(directory, "db.tgz"));
    const manifest = { version: 1, sourceSha: sha, packageVersion: versionFor(sha), packages, lockfile: descriptor(lockBytes, "json"),
      migrationCompatibility: migrationCompatibility(dbBytes, classify) };
    assertManifest(manifest, sha);
    assertCompatibilityMatchesPackage(manifest, dbBytes);
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
    if (name === "db") assertCompatibilityMatchesPackage(manifest, bytes);
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
    if (name === "db" && manifest.migrationCompatibility !== undefined) assertCompatibilityMatchesPackage(manifest, bytes);
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
    if (command === "build") {
      // Type-stripped by Node; the module has no imports, so the build job
      // needs nothing beyond the checkout.
      const { classifyMigrationSequence } = await import(new URL("../packages/db/src/migration-compatibility.ts", import.meta.url).href);
      buildBundle(directory, sha, { classify: classifyMigrationSequence });
    }
    else if (command === "validate") validateBundle(directory, sha);
    else if (command === "verify-install") verifyInstall(directory, sha);
    else if (command === "publish") await publishBundle(directory, sha);
    else if (command === "verify") await verifyPublished(directory);
    else throw new Error("Expected build, validate, verify-install, publish, or verify.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
