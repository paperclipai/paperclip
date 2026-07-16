#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function args() {
  const [command, ...rest] = process.argv.slice(2);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument: ${key ?? "missing"}`);
    values[key.slice(2)] = value;
  }
  return { command, values };
}

async function filesUnder(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in build artifacts: ${relative}`);
    if (entry.isDirectory()) result.push(...await filesUnder(root, absolute));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Unsupported artifact entry: ${relative}`);
  }
  return result.sort();
}

async function describe(root) {
  const entries = [];
  for (const relative of await filesUnder(root)) {
    const absolute = path.join(root, relative);
    const content = await readFile(absolute);
    const stat = await lstat(absolute);
    entries.push({
      path: relative,
      size: stat.size,
      mode: stat.mode & 0o777,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  const canonical = `${JSON.stringify(entries)}\n`;
  return { entries, digest: createHash("sha256").update(canonical).digest("hex") };
}

async function create(source, output) {
  const sourceRoot = path.resolve(source);
  const first = await describe(sourceRoot);
  if (first.entries.length === 0) throw new Error("Refusing to create an empty build artifact");
  const artifactRoot = path.resolve(output, `paperclip-build-${first.digest}`);
  await mkdir(artifactRoot, { recursive: false });
  for (const entry of first.entries) {
    const destination = path.join(artifactRoot, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(sourceRoot, entry.path), destination);
  }
  const copied = await describe(artifactRoot);
  if (copied.digest !== first.digest) throw new Error("Artifact copy digest mismatch");
  const manifest = {
    schemaVersion: 1,
    artifactDigest: copied.digest,
    fileCount: copied.entries.length,
    files: copied.entries,
  };
  const manifestPath = `${artifactRoot}.manifest.json`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  process.stdout.write(`${JSON.stringify({ status: "pass", artifactRoot, manifestPath, artifactDigest: copied.digest })}\n`);
}

async function verify(artifactRoot, manifestPath) {
  const manifest = JSON.parse(await readFile(path.resolve(manifestPath), "utf8"));
  const actual = await describe(path.resolve(artifactRoot));
  const pass = manifest.schemaVersion === 1
    && manifest.artifactDigest === actual.digest
    && manifest.fileCount === actual.entries.length
    && JSON.stringify(manifest.files) === JSON.stringify(actual.entries);
  process.stdout.write(`${JSON.stringify({ status: pass ? "pass" : "fail", artifactDigest: actual.digest, expectedDigest: manifest.artifactDigest })}\n`);
  if (!pass) process.exitCode = 1;
}

try {
  const { command, values } = args();
  if (command === "create" && values.source && values.output) await create(values.source, values.output);
  else if (command === "verify" && values.artifact && values.manifest) await verify(values.artifact, values.manifest);
  else fail("Usage: build-artifact.mjs create --source <dir> --output <empty-dir> | verify --artifact <dir> --manifest <file>");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
