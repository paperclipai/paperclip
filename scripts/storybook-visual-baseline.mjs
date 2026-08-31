#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultManifestPath = join(repoRoot, "tests", "storybook-visual", "baseline-manifest.json");
const manifestPath = resolvePath(
  process.env.STORYBOOK_VISUAL_BASELINE_MANIFEST ?? defaultManifestPath,
);
const defaultCacheDir = join(repoRoot, "tests", "storybook-visual", ".cache");
const cacheDir = resolvePath(process.env.STORYBOOK_VISUAL_BASELINE_CACHE_DIR ?? defaultCacheDir);
const defaultSnapshotDir = join(repoRoot, "tests", "storybook-visual", ".snapshots");
const snapshotDir = resolvePath(process.env.STORYBOOK_VISUAL_SNAPSHOT_DIR ?? defaultSnapshotDir);

const command = process.argv[2];
const flags = parseFlags(process.argv.slice(3));

try {
  if (command === "download") {
    await download();
  } else if (command === "verify") {
    await verify();
  } else if (command === "pack") {
    await pack();
  } else if (command === "upload") {
    await upload();
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function parseFlags(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      result.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      result.set(key, "true");
    } else {
      result.set(key, next);
      index += 1;
    }
  }
  return result;
}

function usage() {
  console.log(`Usage: node scripts/storybook-visual-baseline.mjs <command>

Commands:
  download  Fetch, checksum, and unpack the manifest archive into the snapshot dir.
  verify    Check the unpacked snapshot count and cached archive checksum.
  pack      Create a deterministic snapshots.tgz from the snapshot dir.
  upload    Upload a packed archive to S3 with immutable overwrite checks.

Environment:
  STORYBOOK_VISUAL_BASELINE_MANIFEST  Manifest path.
  STORYBOOK_VISUAL_BASELINE_CACHE_DIR Cache path.
  STORYBOOK_VISUAL_SNAPSHOT_DIR       Playwright snapshot dir.
  STORYBOOK_VISUAL_S3_URI             s3://bucket/key target for upload.
  STORYBOOK_VISUAL_PUBLIC_URL         Public HTTPS URL to write into manifest instructions.
`);
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing baseline manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1) {
    throw new Error(`Unsupported baseline manifest version: ${manifest.version}`);
  }
  if (!Number.isInteger(manifest.snapshotCount) || manifest.snapshotCount < 0) {
    throw new Error("Manifest snapshotCount must be a non-negative integer.");
  }
  return manifest;
}

function archivePathFor(manifest) {
  const hash = manifest.archive?.sha256;
  return join(cacheDir, "archives", `${hash || "unconfigured"}-snapshots.tgz`);
}

async function download() {
  const manifest = readManifest();
  assertConfiguredArchive(manifest);
  mkdirSync(dirname(archivePathFor(manifest)), { recursive: true });
  const archivePath = archivePathFor(manifest);

  if (!existsSync(archivePath) || sha256File(archivePath) !== manifest.archive.sha256) {
    await fetchArchive(manifest.archive.url, archivePath);
  }
  verifyArchiveFile(manifest, archivePath);
  rmSync(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", snapshotDir], "unpack baseline archive");
  verifySnapshotCount(manifest, snapshotDir);
  console.log(`Downloaded ${manifest.baselineId} to ${relative(repoRoot, snapshotDir)}`);
}

async function verify() {
  const manifest = readManifest();
  assertConfiguredArchive(manifest);
  const archivePath = archivePathFor(manifest);
  if (!existsSync(archivePath)) {
    throw new Error(
      `Missing cached archive ${archivePath}. Run \`pnpm storybook-visual:baseline download\` first.`,
    );
  }
  verifyArchiveFile(manifest, archivePath);
  verifySnapshotCount(manifest, snapshotDir);
  console.log(
    `Verified ${manifest.snapshotCount} snapshots for ${manifest.baselineId} in ${relative(
      repoRoot,
      snapshotDir,
    )}`,
  );
}

async function pack() {
  const sourceDir = resolvePath(flags.get("source") ?? snapshotDir);
  if (!existsSync(sourceDir)) {
    throw new Error(`Snapshot source does not exist: ${sourceDir}`);
  }
  const count = countPngFiles(sourceDir);
  if (count === 0) {
    throw new Error(`No PNG snapshots found in ${sourceDir}`);
  }
  const out = resolvePath(
    flags.get("out") ?? join(repoRoot, "tests", "storybook-visual", "baseline-review", "snapshots.tgz"),
  );
  mkdirSync(dirname(out), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "storybook-visual-pack-"));
  const tempArchive = join(tempDir, "snapshots.tgz");
  try {
    run(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--use-compress-program=gzip -n",
        "-cf",
        tempArchive,
        "-C",
        sourceDir,
        ".",
      ],
      "pack deterministic baseline archive",
    );
    rmSync(out, { force: true });
    run("cp", [tempArchive, out], "write packed archive");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  const sha256 = sha256File(out);
  const byteSize = statSync(out).size;
  const publicUrl = flags.get("public-url") ?? process.env.STORYBOOK_VISUAL_PUBLIC_URL ?? "";
  const objectKey = `baselines/storybook-visual/${sha256}/snapshots.tgz`;
  console.log(`Packed ${count} PNG snapshots into ${relative(repoRoot, out)}`);
  console.log("");
  console.log("Manifest archive update:");
  console.log(
    JSON.stringify(
      {
        snapshotCount: count,
        archive: {
          url: publicUrl || `https://<cloudfront-host>/${objectKey}`,
          sha256,
          byteSize,
          objectKey,
        },
      },
      null,
      2,
    ),
  );
}

async function upload() {
  const archive = resolvePath(flags.get("archive") ?? join(repoRoot, "tests", "storybook-visual", "baseline-review", "snapshots.tgz"));
  const s3Uri = flags.get("s3-uri") ?? process.env.STORYBOOK_VISUAL_S3_URI;
  if (!s3Uri) {
    throw new Error("Missing --s3-uri or STORYBOOK_VISUAL_S3_URI for upload.");
  }
  if (!s3Uri.startsWith("s3://")) {
    throw new Error(`Upload target must be an s3:// URI: ${s3Uri}`);
  }
  if (!existsSync(archive)) {
    throw new Error(`Archive does not exist: ${archive}`);
  }
  const sha256 = sha256File(archive);
  const { bucket, key } = parseS3Uri(s3Uri);
  const head = spawnSync(
    "aws",
    ["s3api", "head-object", "--bucket", bucket, "--key", key, "--output", "json"],
    { encoding: "utf8" },
  );
  if (head.status === 0) {
    const metadata = JSON.parse(head.stdout || "{}").Metadata ?? {};
    if (metadata.sha256 === sha256) {
      console.log(`Archive already exists at ${s3Uri} with matching sha256 ${sha256}.`);
      return;
    }
    throw new Error(`Refusing to overwrite existing S3 object with different sha256: ${s3Uri}`);
  }
  run(
    "aws",
    [
      "s3",
      "cp",
      archive,
      s3Uri,
      "--metadata",
      `sha256=${sha256}`,
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--content-type",
      "application/gzip",
    ],
    "upload baseline archive",
  );
  console.log(`Uploaded ${basename(archive)} to ${s3Uri}`);
}

function assertConfiguredArchive(manifest) {
  const archive = manifest.archive ?? {};
  if (!archive.url || !archive.sha256 || !archive.byteSize) {
    throw new Error(
      `Baseline manifest ${relative(
        repoRoot,
        manifestPath,
      )} does not point at a published archive yet. Run \`pnpm storybook-visual:baseline pack\`, upload the immutable archive, then update the manifest archive url/sha256/byteSize/snapshotCount.`,
    );
  }
}

async function fetchArchive(url, destination) {
  if (url.startsWith("file://")) {
    await pipeline(createReadStream(fileURLToPath(url)), createWriteStream(destination));
    return;
  }
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error(`Unsupported archive URL: ${url}`);
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download baseline archive: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

function verifyArchiveFile(manifest, archivePath) {
  const actualSha = sha256File(archivePath);
  if (actualSha !== manifest.archive.sha256) {
    throw new Error(
      `Baseline checksum mismatch: expected ${manifest.archive.sha256}, got ${actualSha}`,
    );
  }
  const actualSize = statSync(archivePath).size;
  if (actualSize !== manifest.archive.byteSize) {
    throw new Error(
      `Baseline byte size mismatch: expected ${manifest.archive.byteSize}, got ${actualSize}`,
    );
  }
}

function verifySnapshotCount(manifest, dir) {
  const count = countPngFiles(dir);
  if (count !== manifest.snapshotCount) {
    throw new Error(
      `Baseline snapshot count mismatch: expected ${manifest.snapshotCount}, got ${count} in ${dir}`,
    );
  }
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function countPngFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countPngFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".png")) {
      count += 1;
    }
  }
  return count;
}

function parseS3Uri(uri) {
  const withoutScheme = uri.slice("s3://".length);
  const slash = withoutScheme.indexOf("/");
  if (slash === -1) throw new Error(`S3 URI must include a key: ${uri}`);
  return { bucket: withoutScheme.slice(0, slash), key: withoutScheme.slice(slash + 1) };
}

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`Failed to ${label}.`);
  }
}
