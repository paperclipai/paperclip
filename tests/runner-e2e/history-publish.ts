import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";
import { renderRunnerHistoryIndex } from "./history-index.js";
import {
  campaignHistoryRecord,
  emptyRunnerHistory,
  mergeRunnerHistory,
} from "./history.js";
import type { RunnerE2ECampaign, RunnerE2EHistoryIndex } from "./types.js";

const execFileAsync = promisify(execFile);
const MUTABLE_HISTORY_FILES = new Set([
  "history.json",
  "latest.json",
  "latest-green.json",
]);
const PUBLISH_ROOT_FILES = new Set([
  "dashboard.html",
  "index.html",
  "junit.xml",
  "normalized-results.json",
  "summary.md",
]);
const PUBLIC_EVIDENCE_EXTENSIONS = new Set([".json", ".log", ".md", ".txt"]);
const PRIVATE_EVIDENCE_DIRECTORIES = new Set([
  "blob-report",
  "html-report",
  "playwright-output",
]);

function publicEvidencePath(relative: string) {
  const match = relative.match(
    /^evidence\/[A-Za-z0-9._-]+\/attempt-[1-9][0-9]*\/(.+)$/,
  );
  if (!match) return false;
  const evidencePath = match[1]!;
  const segments = evidencePath.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        PRIVATE_EVIDENCE_DIRECTORIES.has(segment),
    )
  ) {
    return false;
  }
  return PUBLIC_EVIDENCE_EXTENSIONS.has(
    path.posix.extname(evidencePath).toLowerCase(),
  );
}

export function isHistoricalBundlePathAllowed(relative: string) {
  if (
    relative.includes("\\") ||
    relative.startsWith("/") ||
    relative.includes("..")
  ) {
    return false;
  }
  if (PUBLISH_ROOT_FILES.has(relative)) return true;
  if (
    relative === "assets/favicon.svg" ||
    relative === "assets/InterVariable.woff2"
  ) {
    return true;
  }
  return publicEvidencePath(relative);
}

async function pruneEvidenceDirectory(root: string, current: string) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await pruneEvidenceDirectory(root, absolute);
      if ((await readdir(absolute)).length === 0) {
        await rm(absolute, { recursive: true });
      }
      continue;
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (!entry.isFile() || !publicEvidencePath(relative)) {
      await rm(absolute, { force: true });
    }
  }
}

export async function prunePrivateHistoryEvidence(root: string) {
  const evidenceRoot = path.join(root, "evidence");
  const metadata = await lstat(evidenceRoot).catch(() => null);
  if (!metadata) return;
  if (!metadata.isDirectory()) {
    throw new Error("Historical evidence root must be a directory");
  }
  await pruneEvidenceDirectory(root, evidenceRoot);
}

interface BundleManifest {
  schema: "paperclip.runner-e2e.bundle/v1";
  campaignId: string;
  bundleDigest: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function validateHistoryDestination(input: {
  bucket: string;
  prefix: string;
  publicBaseUrl: string;
}) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) {
    throw new Error("RUNNER_E2E_HISTORY_S3_BUCKET is not a valid bucket name");
  }
  const prefix = input.prefix.replace(/^\/+|\/+$/g, "");
  if (
    !prefix ||
    prefix
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(
      "RUNNER_E2E_HISTORY_PREFIX must be a safe non-empty key prefix",
    );
  }
  const publicUrl = new URL(input.publicBaseUrl);
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error(
      "RUNNER_E2E_HISTORY_PUBLIC_BASE_URL must be a credential-free HTTPS URL",
    );
  }
  return { prefix, publicBaseUrl: publicUrl.href.replace(/\/$/, "") };
}

async function relativeFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to publish symbolic link ${entry.name}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await relativeFiles(root, absolute)));
    } else if (entry.isFile()) {
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (MUTABLE_HISTORY_FILES.has(relative)) continue;
      if (!isHistoricalBundlePathAllowed(relative)) {
        throw new Error(
          `Refusing non-allowlisted historical bundle path ${relative}`,
        );
      }
      files.push(relative);
    }
  }
  return files;
}

export async function createBundleManifest(
  root: string,
  campaignId: string,
): Promise<BundleManifest> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(campaignId)) {
    throw new Error("Campaign ID is unsafe for immutable object storage");
  }
  const files = await Promise.all(
    (await relativeFiles(root)).sort().map(async (relative) => {
      const absolute = path.join(root, ...relative.split("/"));
      const [content, metadata] = await Promise.all([
        readFile(absolute),
        stat(absolute),
      ]);
      return {
        path: relative,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: metadata.size,
      };
    }),
  );
  const bundleDigest = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  return {
    schema: "paperclip.runner-e2e.bundle/v1",
    campaignId,
    bundleDigest,
    files,
  };
}

export function buildHistoryPointers(history: RunnerE2EHistoryIndex) {
  const byCampaign = new Map(
    history.campaigns.map((campaign) => [campaign.campaignId, campaign]),
  );
  const pointer = (campaignId: string | null | undefined) => {
    const campaign = campaignId ? byCampaign.get(campaignId) : undefined;
    return campaign
      ? {
          campaignId: campaign.campaignId,
          generatedAt: campaign.generatedAt,
          publicUrl: campaign.publicUrl,
          sha: campaign.source.sha,
        }
      : null;
  };
  return {
    latest: {
      schema: "paperclip.runner-e2e.pointer/v1",
      updatedAt: history.updatedAt,
      overall: pointer(history.latestCampaignId),
      suites: Object.fromEntries(
        Object.entries(history.latestBySuite).map(([suiteId, campaignId]) => [
          suiteId,
          pointer(campaignId),
        ]),
      ),
    },
    latestGreen: {
      schema: "paperclip.runner-e2e.pointer/v1",
      updatedAt: history.updatedAt,
      overall: pointer(history.latestGreenCampaignId),
      suites: Object.fromEntries(
        Object.entries(history.latestGreenBySuite).map(
          ([suiteId, campaignId]) => [suiteId, pointer(campaignId)],
        ),
      ),
    },
  };
}

function awsObject(bucket: string, key: string) {
  return `s3://${bucket}/${key}`;
}

async function objectExists(bucket: string, key: string) {
  try {
    await execFileAsync("aws", [
      "s3api",
      "head-object",
      "--bucket",
      bucket,
      "--key",
      key,
    ]);
    return true;
  } catch (error) {
    const detail = String(
      (error as { stderr?: string }).stderr ??
        (error instanceof Error ? error.message : error),
    );
    if (/\b(?:404|Not Found|NoSuchKey)\b/i.test(detail)) return false;
    throw new Error(
      `Unable to inspect historical object: ${detail.slice(0, 400)}`,
    );
  }
}

async function downloadJson<T>(
  bucket: string,
  key: string,
  destination: string,
) {
  if (!(await objectExists(bucket, key))) return null;
  await execFileAsync("aws", [
    "s3",
    "cp",
    awsObject(bucket, key),
    destination,
    "--only-show-errors",
  ]);
  return JSON.parse(await readFile(destination, "utf8")) as T;
}

async function uploadJson(
  bucket: string,
  key: string,
  file: string,
  cacheControl: string,
) {
  await uploadFile(bucket, key, file, "application/json", cacheControl);
}

async function uploadFile(
  bucket: string,
  key: string,
  file: string,
  contentType: string,
  cacheControl: string,
) {
  await execFileAsync("aws", [
    "s3",
    "cp",
    file,
    awsObject(bucket, key),
    "--only-show-errors",
    "--content-type",
    contentType,
    "--cache-control",
    cacheControl,
  ]);
}

async function main() {
  const reportRoot = path.resolve(
    process.env.PAPERCLIP_RUNNER_E2E_REPORT_DIR ??
      "runner-e2e-merged-report/normalized",
  );
  const bucket = process.env.RUNNER_E2E_HISTORY_S3_BUCKET ?? "";
  const destination = validateHistoryDestination({
    bucket,
    prefix: process.env.RUNNER_E2E_HISTORY_PREFIX ?? "runner-e2e",
    publicBaseUrl: process.env.RUNNER_E2E_HISTORY_PUBLIC_BASE_URL ?? "",
  });
  const campaign = JSON.parse(
    await readFile(path.join(reportRoot, "normalized-results.json"), "utf8"),
  ) as RunnerE2ECampaign;
  if (campaign.schema !== "paperclip.runner-e2e.campaign/v2") {
    throw new Error("Historical publishing requires a v2 normalized campaign");
  }

  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "runner-e2e-history-"),
  );
  const historyKey = `${destination.prefix}/history.json`;
  const current =
    (await downloadJson<RunnerE2EHistoryIndex>(
      bucket,
      historyKey,
      path.join(temporary, "current-history.json"),
    )) ?? emptyRunnerHistory();
  const history = mergeRunnerHistory(
    current,
    campaignHistoryRecord(
      campaign,
      `${destination.publicBaseUrl}/${destination.prefix}`,
    ),
  );

  // Campaign bundles are immutable and must not capture a mutable history
  // file left in a reused local directory. The root landing page below is the
  // only dashboard that embeds navigation across campaigns.
  // Raster/video pixels are not OCR-scanned for secrets, and generated HTML,
  // archives, and SVG may contain or execute active/private content. Preserve
  // those in the access-controlled workflow artifact but remove them from the
  // directory shared by public S3 and Pages publication.
  await prunePrivateHistoryEvidence(reportRoot);
  await regenerateRunnerDashboard({ bundle: reportRoot, historyFile: null });
  const manifest = await createBundleManifest(reportRoot, campaign.campaignId);
  const campaignPrefix = `${destination.prefix}/campaigns/${campaign.campaignId}`;
  const manifestKey = `${campaignPrefix}/bundle-manifest.json`;
  const existingManifest = await downloadJson<BundleManifest>(
    bucket,
    manifestKey,
    path.join(temporary, "existing-manifest.json"),
  );
  if (
    existingManifest &&
    existingManifest.bundleDigest !== manifest.bundleDigest
  ) {
    throw new Error(
      `Immutable campaign ${campaign.campaignId} already exists with a different digest`,
    );
  }
  if (!existingManifest) {
    await execFileAsync("aws", [
      "s3",
      "cp",
      reportRoot,
      awsObject(bucket, campaignPrefix),
      "--recursive",
      "--only-show-errors",
      "--exclude",
      "history.json",
      "--exclude",
      "latest.json",
      "--exclude",
      "latest-green.json",
      "--cache-control",
      "public,max-age=31536000,immutable",
    ]);
    const manifestFile = path.join(temporary, "bundle-manifest.json");
    await writeFile(manifestFile, json(manifest), "utf8");
    await uploadJson(
      bucket,
      manifestKey,
      manifestFile,
      "public,max-age=31536000,immutable",
    );
  }

  const pointers = buildHistoryPointers(history);
  const historyFile = path.join(reportRoot, "history.json");
  const latestFile = path.join(reportRoot, "latest.json");
  const latestGreenFile = path.join(reportRoot, "latest-green.json");
  await Promise.all([
    writeFile(historyFile, json(history), "utf8"),
    writeFile(latestFile, json(pointers.latest), "utf8"),
    writeFile(latestGreenFile, json(pointers.latestGreen), "utf8"),
  ]);
  await regenerateRunnerDashboard({ bundle: reportRoot, historyFile });
  const landingDirectory = path.join(temporary, "landing");
  await regenerateRunnerDashboard({
    bundle: reportRoot,
    historyFile,
    outputDirectory: landingDirectory,
    evidenceHrefPrefix: `campaigns/${campaign.campaignId}`,
  });
  await writeFile(
    path.join(landingDirectory, "index.html"),
    renderRunnerHistoryIndex(history),
    "utf8",
  );
  await Promise.all([
    uploadJson(bucket, historyKey, historyFile, "no-cache"),
    uploadJson(
      bucket,
      `${destination.prefix}/latest.json`,
      latestFile,
      "no-cache",
    ),
    uploadJson(
      bucket,
      `${destination.prefix}/latest-green.json`,
      latestGreenFile,
      "no-cache",
    ),
    uploadFile(
      bucket,
      `${destination.prefix}/index.html`,
      path.join(landingDirectory, "index.html"),
      "text/html; charset=utf-8",
      "no-cache",
    ),
    uploadFile(
      bucket,
      `${destination.prefix}/dashboard.html`,
      path.join(landingDirectory, "dashboard.html"),
      "text/html; charset=utf-8",
      "no-cache",
    ),
    uploadFile(
      bucket,
      `${destination.prefix}/normalized-results.json`,
      path.join(landingDirectory, "normalized-results.json"),
      "application/json",
      "no-cache",
    ),
    uploadFile(
      bucket,
      `${destination.prefix}/assets/favicon.svg`,
      path.join(reportRoot, "assets", "favicon.svg"),
      "image/svg+xml",
      "public,max-age=86400",
    ),
    uploadFile(
      bucket,
      `${destination.prefix}/assets/InterVariable.woff2`,
      path.join(reportRoot, "assets", "InterVariable.woff2"),
      "font/woff2",
      "public,max-age=86400",
    ),
  ]);
  console.log(
    `Published immutable campaign ${campaign.campaignId} (${manifest.bundleDigest}) and ${history.campaigns.length} history record(s)`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
