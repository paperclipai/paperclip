import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  cp,
  copyFile,
  mkdtemp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { writePublicCampaignSummaryImage } from "./public-summary-image.js";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";
import { renderRunnerHistoryIndex } from "./history-index.js";
import { validateHistoryDestination } from "./history-destination.js";
import { PUBLIC_RUNNER_SCREENSHOT_MARKER } from "./screenshot-policy.js";
import {
  campaignHistoryRecord,
  emptyRunnerHistory,
  mergeRunnerHistory,
} from "./history.js";
import type { RunnerE2ECampaign, RunnerE2EHistoryIndex } from "./types.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
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
const MAX_PUBLIC_RASTER_BYTES = 12 * 1024 * 1024;
const EMPTY_PUBLIC_SCREENSHOTS: ReadonlySet<string> = new Set();
const PRIVATE_EVIDENCE_DIRECTORIES = new Set([
  "blob-report",
  "html-report",
  "playwright-output",
]);

function publicEvidencePath(
  relative: string,
  publicScreenshots: ReadonlySet<string> = EMPTY_PUBLIC_SCREENSHOTS,
) {
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
  return (
    PUBLIC_EVIDENCE_EXTENSIONS.has(
      path.posix.extname(evidencePath).toLowerCase(),
    ) || publicScreenshots.has(relative)
  );
}

export function publicScreenshotPaths(campaign: RunnerE2ECampaign) {
  const screenshots = new Set<string>();
  for (const result of campaign.results) {
    const files =
      result.screenshots
        ?.filter(
          (screenshot) =>
            screenshot.publication === PUBLIC_RUNNER_SCREENSHOT_MARKER,
        )
        .map((screenshot) => screenshot.file) ?? [];
    if (files.length === 0) continue;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,299}$/.test(result.executionId) ||
      !Number.isSafeInteger(result.attempt) ||
      result.attempt < 1
    ) {
      throw new Error(
        `Cannot publish screenshots for unsafe execution identity ${result.executionId}`,
      );
    }
    for (const file of files) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.png$/i.test(file)) {
        throw new Error(
          `Cannot publish unsafe screenshot path for ${result.executionId}: ${file}`,
        );
      }
      screenshots.add(
        `evidence/${result.executionId}/attempt-${result.attempt}/${file}`,
      );
    }
  }
  return screenshots;
}

export function isHistoricalBundlePathAllowed(
  relative: string,
  allowPublicSummary = false,
  publicScreenshots: ReadonlySet<string> = EMPTY_PUBLIC_SCREENSHOTS,
) {
  if (
    relative.includes("\\") ||
    relative.startsWith("/") ||
    relative.includes("..")
  ) {
    return false;
  }
  if (PUBLISH_ROOT_FILES.has(relative)) return true;
  if (allowPublicSummary && relative === "public-images/campaign-summary.png") {
    return true;
  }
  if (
    relative === "assets/favicon-32x32.png" ||
    relative === "assets/InterVariable.woff2"
  ) {
    return true;
  }
  return publicEvidencePath(relative, publicScreenshots);
}

function hasPublicPngMagic(content: Buffer) {
  return (
    content.length >= 24 &&
    content
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    content.subarray(12, 16).equals(Buffer.from("IHDR", "ascii"))
  );
}

async function validatePublicRaster(absolute: string, relative: string) {
  const metadata = await stat(absolute);
  if (metadata.size === 0 || metadata.size > MAX_PUBLIC_RASTER_BYTES) {
    throw new Error(
      `Public screenshot ${relative} exceeds the per-file size boundary`,
    );
  }
  const content = await readFile(absolute);
  if (!hasPublicPngMagic(content)) {
    throw new Error(
      `Public screenshot ${relative} does not match its raster file type`,
    );
  }
}

async function pruneEvidenceDirectory(
  root: string,
  current: string,
  publicScreenshots: ReadonlySet<string>,
) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await pruneEvidenceDirectory(root, absolute, publicScreenshots);
      if ((await readdir(absolute)).length === 0) {
        await rm(absolute, { recursive: true });
      }
      continue;
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (!entry.isFile() || !publicEvidencePath(relative, publicScreenshots)) {
      await rm(absolute, { force: true });
    }
  }
}

export async function prunePrivateHistoryEvidence(
  root: string,
  publicScreenshots: ReadonlySet<string> = EMPTY_PUBLIC_SCREENSHOTS,
) {
  const evidenceRoot = path.join(root, "evidence");
  const metadata = await lstat(evidenceRoot).catch(() => null);
  if (!metadata) return;
  if (!metadata.isDirectory()) {
    throw new Error("Historical evidence root must be a directory");
  }
  await pruneEvidenceDirectory(root, evidenceRoot, publicScreenshots);
}

export async function stageTrustedHistoryAssets(
  root: string,
  trustedRoot = repositoryRoot,
) {
  const resolveTrustedAsset = async (segments: string[]) => {
    const trustedRootReal = await realpath(trustedRoot);
    let source = trustedRoot;
    for (const [index, segment] of segments.entries()) {
      source = path.join(source, segment);
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Refusing symbolic link in trusted publisher asset path ${segments.join("/")}`,
        );
      }
      const final = index === segments.length - 1;
      if (
        (final && !metadata.isFile()) ||
        (!final && !metadata.isDirectory())
      ) {
        throw new Error(
          `Trusted publisher asset path has an invalid file type: ${segments.join("/")}`,
        );
      }
    }
    const sourceReal = await realpath(source);
    const relative = path.relative(trustedRootReal, sourceReal);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error(
        `Trusted publisher asset escapes its checkout: ${segments.join("/")}`,
      );
    }
    return sourceReal;
  };
  const [faviconSource, fontSource] = await Promise.all([
    resolveTrustedAsset(["ui", "public", "favicon-32x32.png"]),
    resolveTrustedAsset(["ui", "public", "fonts", "InterVariable.woff2"]),
  ]);
  const assets = path.join(root, "assets");
  await rm(assets, { recursive: true, force: true });
  await mkdir(assets, { recursive: true });
  await Promise.all([
    copyFile(faviconSource, path.join(assets, "favicon-32x32.png")),
    copyFile(fontSource, path.join(assets, "InterVariable.woff2")),
  ]);
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

export { validateHistoryDestination };

async function relativeFiles(
  root: string,
  current = root,
  allowPublicSummary = false,
  publicScreenshots: ReadonlySet<string> = EMPTY_PUBLIC_SCREENSHOTS,
): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to publish symbolic link ${entry.name}`);
    }
    if (entry.isDirectory()) {
      files.push(
        ...(await relativeFiles(
          root,
          absolute,
          allowPublicSummary,
          publicScreenshots,
        )),
      );
    } else if (entry.isFile()) {
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (MUTABLE_HISTORY_FILES.has(relative)) continue;
      if (
        !isHistoricalBundlePathAllowed(
          relative,
          allowPublicSummary,
          publicScreenshots,
        )
      ) {
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
  allowPublicSummary = false,
  publicScreenshots: ReadonlySet<string> = EMPTY_PUBLIC_SCREENSHOTS,
): Promise<BundleManifest> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(campaignId)) {
    throw new Error("Campaign ID is unsafe for immutable object storage");
  }
  const files = await Promise.all(
    (await relativeFiles(root, root, allowPublicSummary, publicScreenshots))
      .sort()
      .map(async (relative) => {
        const absolute = path.join(root, ...relative.split("/"));
        if (
          relative === "public-images/campaign-summary.png" ||
          publicScreenshots.has(relative)
        ) {
          await validatePublicRaster(absolute, relative);
        }
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

async function uploadImmutableBundle(
  bucket: string,
  key: string,
  directory: string,
) {
  const common = [
    "--recursive",
    "--only-show-errors",
    "--cache-control",
    "public,max-age=31536000,immutable",
  ];
  await execFileAsync("aws", [
    "s3",
    "cp",
    directory,
    awsObject(bucket, key),
    ...common,
    "--exclude",
    "history.json",
    "--exclude",
    "latest.json",
    "--exclude",
    "latest-green.json",
    "--exclude",
    "*.png",
  ]);
  await execFileAsync("aws", [
    "s3",
    "cp",
    directory,
    awsObject(bucket, key),
    ...common,
    "--exclude",
    "*",
    "--include",
    "*.png",
    "--content-type",
    "image/png",
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
  const publicScreenshots = publicScreenshotPaths(campaign);

  // Campaign bundles are immutable and must not capture a mutable history
  // file left in a reused local directory. The root landing page below is the
  // only dashboard that embeds navigation across campaigns. S3 gets its own
  // staged copy. Only screenshots declared by normalized results (plus the
  // fixed failure screenshot for failed executions) cross the public boundary;
  // all other target-produced files remain subject to the structured allowlist.
  const s3ReportRoot = path.join(temporary, "s3-campaign");
  await cp(reportRoot, s3ReportRoot, { recursive: true, errorOnExist: true });
  await prunePrivateHistoryEvidence(s3ReportRoot, publicScreenshots);
  await stageTrustedHistoryAssets(s3ReportRoot);
  await rm(path.join(s3ReportRoot, "public-images"), {
    recursive: true,
    force: true,
  });
  const summaryImage = path.join(
    s3ReportRoot,
    "public-images",
    "campaign-summary.png",
  );
  await writePublicCampaignSummaryImage(campaign, summaryImage);
  await regenerateRunnerDashboard({
    bundle: s3ReportRoot,
    historyFile: null,
    publicSummaryImageHref: "public-images/campaign-summary.png",
  });
  const manifest = await createBundleManifest(
    s3ReportRoot,
    campaign.campaignId,
    true,
    publicScreenshots,
  );
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
    await uploadImmutableBundle(bucket, campaignPrefix, s3ReportRoot);
    const manifestFile = path.join(temporary, "bundle-manifest.json");
    await writeFile(manifestFile, json(manifest), "utf8");
    await uploadJson(
      bucket,
      manifestKey,
      manifestFile,
      "public,max-age=31536000,immutable",
    );
  }

  // Pages uses the same declared-screenshot boundary in a sibling stage. The
  // downloaded access-controlled report stays intact for this whole job.
  const pagesRoot = path.join(path.dirname(reportRoot), "pages");
  await rm(pagesRoot, { recursive: true, force: true });
  await cp(reportRoot, pagesRoot, { recursive: true, errorOnExist: true });
  await prunePrivateHistoryEvidence(pagesRoot, publicScreenshots);
  await stageTrustedHistoryAssets(pagesRoot);
  await rm(path.join(pagesRoot, "public-images"), {
    recursive: true,
    force: true,
  });
  const pointers = buildHistoryPointers(history);
  const historyFile = path.join(pagesRoot, "history.json");
  const latestFile = path.join(pagesRoot, "latest.json");
  const latestGreenFile = path.join(pagesRoot, "latest-green.json");
  await Promise.all([
    writeFile(historyFile, json(history), "utf8"),
    writeFile(latestFile, json(pointers.latest), "utf8"),
    writeFile(latestGreenFile, json(pointers.latestGreen), "utf8"),
  ]);
  await regenerateRunnerDashboard({ bundle: pagesRoot, historyFile });
  await createBundleManifest(
    pagesRoot,
    campaign.campaignId,
    false,
    publicScreenshots,
  );
  const landingDirectory = path.join(temporary, "landing");
  await regenerateRunnerDashboard({
    bundle: s3ReportRoot,
    historyFile,
    outputDirectory: landingDirectory,
    evidenceHrefPrefix: `campaigns/${campaign.campaignId}`,
    publicSummaryImageHref: `campaigns/${campaign.campaignId}/public-images/campaign-summary.png`,
  });
  await writeFile(
    path.join(landingDirectory, "index.html"),
    renderRunnerHistoryIndex(history, {
      latestSummaryImageHref:
        history.latestCampaignId === campaign.campaignId
          ? `campaigns/${campaign.campaignId}/public-images/campaign-summary.png`
          : undefined,
    }),
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
      `${destination.prefix}/assets/favicon-32x32.png`,
      path.join(s3ReportRoot, "assets", "favicon-32x32.png"),
      "image/png",
      "public,max-age=86400",
    ),
    uploadFile(
      bucket,
      `${destination.prefix}/assets/InterVariable.woff2`,
      path.join(s3ReportRoot, "assets", "InterVariable.woff2"),
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
