#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  trustedViewerFiles,
  validatePublicViewerPage,
} from "./public-eval-viewer.mjs";

const execFileAsync = promisify(execFile);
const SAFE_CAMPAIGN =
  /^gha-[1-9][0-9]*-[1-9][0-9]*(?:-report-[a-z0-9][a-z0-9-]{0,39})?$/;
const SAFE_REPORT_PATHS = [
  /^(?:index|latest|inventory|real-server)\.html$/,
  /^tests\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.html$/,
  /^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.html$/,
  /^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/index\.html$/,
  /^viewer\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|woff2)$/,
  /^campaign\.json$/,
];
const CREDENTIAL_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/iu,
  /["'](?:providerSessionId|sessionId)["']\s*:/u,
];
const ACTIVE_HTML_PATTERNS = [
  /<script\b/iu,
  /<iframe\b/iu,
  /<object\b/iu,
  /<embed\b/iu,
  /<form\b/iu,
  /\son[a-z]+\s*=/iu,
  /javascript\s*:/iu,
  /(?:src|href)\s*=\s*["'](?:https?:)?\/\//iu,
];
const MAX_HISTORY_CAMPAIGNS = 200;

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function loadObject(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  return value;
}

export function validateProtocolEvalHistoryDestination({
  bucket,
  prefix,
  publicBaseUrl,
}) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(
      "RUNNER_PROTOCOL_EVAL_HISTORY_S3_BUCKET is not a valid bucket name",
    );
  }
  const normalizedPrefix = String(prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (
    !normalizedPrefix ||
    normalizedPrefix
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(
      "RUNNER_PROTOCOL_EVAL_HISTORY_PREFIX must be a safe non-empty key prefix",
    );
  }
  const url = new URL(publicBaseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "RUNNER_PROTOCOL_EVAL_HISTORY_PUBLIC_BASE_URL must be a credential-free HTTPS URL",
    );
  }
  return {
    bucket,
    prefix: normalizedPrefix,
    publicBaseUrl: url.href.replace(/\/$/, ""),
  };
}

export function isPublicProtocolEvalPath(relativePath) {
  if (
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return false;
  }
  return SAFE_REPORT_PATHS.some((pattern) => pattern.test(relativePath));
}

async function relativeFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Refusing public report symlink ${absolute}`);
    if (entry.isDirectory())
      files.push(...(await relativeFiles(root, absolute)));
    else if (entry.isFile())
      files.push(relative(root, absolute).split(sep).join("/"));
    else throw new Error(`Refusing unusual public report path ${absolute}`);
  }
  return files.sort();
}

function internalHtmlHrefs(content) {
  return [...content.matchAll(/href\s*=\s*["']([^"']+)["']/giu)]
    .map((match) => match[1])
    .filter((href) => href && !href.startsWith("#"));
}

export async function validatePublicProtocolEvalReport(
  reportRoot,
  { viewerRoot } = {},
) {
  const root = resolve(reportRoot);
  const files = await relativeFiles(root);
  const hasChat = files.some((file) =>
    /^attempts\/[^/]+\/index\.html$/.test(file),
  );
  const viewer = hasChat ? await trustedViewerFiles(viewerRoot) : null;
  if (!files.includes("index.html") || !files.includes("campaign.json")) {
    throw new Error(
      "Public protocol eval report requires index.html and campaign.json",
    );
  }
  for (const file of files) {
    if (!isPublicProtocolEvalPath(file)) {
      throw new Error(
        `Refusing non-allowlisted public protocol eval path ${file}`,
      );
    }
    const absolute = resolve(root, ...file.split("/"));
    const metadata = await stat(absolute);
    if (metadata.size === 0 || metadata.size > 12 * 1024 * 1024) {
      throw new Error(
        `Public protocol eval file exceeds its size boundary: ${file}`,
      );
    }
    if (file.startsWith("viewer/")) {
      const expected = viewer?.files.get(file);
      if (!expected || !expected.equals(await readFile(absolute)))
        throw new Error(
          `Public viewer asset differs from trusted build: ${file}`,
        );
      continue;
    }
    const content = await readFile(absolute, "utf8");
    const richAttempt = /^attempts\/[^/]+\/index\.html$/.test(file);
    const payload = richAttempt
      ? validatePublicViewerPage(content, viewer.index)
      : null;
    if (!richAttempt) {
      for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.test(content))
          throw new Error(
            `Public report contains credential/session material: ${file}`,
          );
      }
      if (extname(file) !== ".html") continue;
      for (const pattern of ACTIVE_HTML_PATTERNS) {
        if (pattern.test(content))
          throw new Error(
            `Public report contains active or remote HTML: ${file}`,
          );
      }
    }
    const navigation = payload
      ? [
          payload.navigation?.suiteHref,
          payload.navigation?.previous?.href,
          payload.navigation?.next?.href,
        ].filter(Boolean)
      : [];
    for (const href of [...internalHtmlHrefs(content), ...navigation]) {
      if (typeof href !== "string" || /[?:\\]|^\/|^[a-z]+:/i.test(href))
        throw new Error(`Unsafe report navigation in ${file}`);
      const clean = href.split("#", 1)[0].split("?", 1)[0];
      const target = resolve(
        root,
        ...file.split("/").slice(0, -1),
        ...clean.split("/"),
      );
      const rel = relative(root, target).split(sep).join("/");
      if (
        !isPublicProtocolEvalPath(rel) ||
        !(await lstat(target).catch(() => null))?.isFile()
      ) {
        throw new Error(
          `Public report contains a broken or unsafe link in ${file}: ${href}`,
        );
      }
    }
  }
  if (viewer) {
    for (const file of viewer.files.keys())
      if (!files.includes(file))
        throw new Error(`Missing public viewer asset: ${file}`);
    if (files.some((file) => /^attempts\/[^/]+\.html$/.test(file)))
      throw new Error(
        "Chat Evalbook must not mix in legacy plain attempt pages",
      );
  }
  const campaign = await loadObject(join(root, "campaign.json"));
  if (
    campaign.schema !== "paperclip.runner-protocol-eval.campaign/v1" ||
    !SAFE_CAMPAIGN.test(String(campaign.campaignId ?? ""))
  ) {
    throw new Error("Public report campaign metadata is invalid");
  }
  return { files, campaign };
}

export async function createProtocolEvalBundleManifest(
  reportRoot,
  campaignId,
  { viewerRoot } = {},
) {
  if (!SAFE_CAMPAIGN.test(campaignId))
    throw new Error("Unsafe protocol eval campaign ID");
  const { files, campaign } = await validatePublicProtocolEvalReport(
    reportRoot,
    { viewerRoot },
  );
  if (campaign.campaignId !== campaignId)
    throw new Error("Report campaign ID does not match publication target");
  const entries = await Promise.all(
    files.map(async (file) => {
      const absolute = resolve(reportRoot, ...file.split("/"));
      const [content, metadata] = await Promise.all([
        readFile(absolute),
        stat(absolute),
      ]);
      return {
        path: file,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: metadata.size,
      };
    }),
  );
  return {
    schema: "paperclip.runner-protocol-eval.bundle/v1",
    campaignId,
    bundleDigest: createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex"),
    files: entries,
  };
}

export function emptyProtocolEvalHistory() {
  return {
    schema: "paperclip.runner-protocol-eval.history/v1",
    updatedAt: new Date(0).toISOString(),
    latestCampaignId: null,
    latestGreenCampaignId: null,
    campaigns: [],
  };
}

export function protocolEvalHistoryRecord(campaign, publicRoot) {
  return {
    campaignId: campaign.campaignId,
    generatedAt: campaign.generatedAt,
    publicUrl: `${publicRoot}/campaigns/${encodeURIComponent(campaign.campaignId)}/`,
    complete: campaign.complete === true,
    allPassed: campaign.allPassed === true,
    totals: campaign.totals,
    rosters: campaign.rosters,
    source: campaign.source,
    ...(campaign.reportRevision
      ? { reportRevision: campaign.reportRevision }
      : {}),
  };
}

export function mergeProtocolEvalHistory(history, record) {
  if (history.schema !== "paperclip.runner-protocol-eval.history/v1") {
    throw new Error("Unsupported protocol eval history schema");
  }
  const existing = history.campaigns.find(
    (item) => item.campaignId === record.campaignId,
  );
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
    throw new Error(
      `Immutable campaign history changed for ${record.campaignId}`,
    );
  }
  const campaigns = existing
    ? [...history.campaigns]
    : [...history.campaigns, record];
  const activityAt = (campaign) =>
    campaign.reportRevision?.renderedAt ?? campaign.generatedAt;
  const activityOrder = (left, right) =>
    activityAt(right).localeCompare(activityAt(left));
  campaigns.sort(activityOrder);
  // Report revisions are discoverable history entries, never qualification runs.
  const qualifications = campaigns
    .filter((campaign) => !campaign.reportRevision)
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  const latest = qualifications[0] ?? null;
  const latestGreen =
    qualifications.find(
      (campaign) => campaign.complete && campaign.allPassed,
    ) ?? null;
  const pointers = [...new Set([latest, latestGreen].filter(Boolean))];
  const retained = campaigns
    .filter((campaign) => !pointers.includes(campaign))
    .slice(0, MAX_HISTORY_CAMPAIGNS - pointers.length)
    .concat(pointers)
    .sort(activityOrder);
  return {
    schema: history.schema,
    updatedAt: new Date().toISOString(),
    latestCampaignId: latest?.campaignId ?? null,
    latestGreenCampaignId: latestGreen?.campaignId ?? null,
    campaigns: retained,
  };
}

export function buildProtocolEvalPointers(history) {
  const byId = new Map(
    history.campaigns.map((campaign) => [campaign.campaignId, campaign]),
  );
  const project = (id) => {
    const campaign = id ? byId.get(id) : null;
    return campaign
      ? {
          campaignId: campaign.campaignId,
          generatedAt: campaign.generatedAt,
          publicUrl: campaign.publicUrl,
          paperclipSha: campaign.source?.paperclip?.sha ?? null,
          evalsSha: campaign.source?.evals?.sha ?? null,
        }
      : null;
  };
  return {
    latest: {
      schema: "paperclip.runner-protocol-eval.pointer/v1",
      updatedAt: history.updatedAt,
      campaign: project(history.latestCampaignId),
    },
    latestGreen: {
      schema: "paperclip.runner-protocol-eval.pointer/v1",
      updatedAt: history.updatedAt,
      campaign: project(history.latestGreenCampaignId),
    },
  };
}

function date(value) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function renderProtocolEvalHistoryIndex(history, stylesheetHref) {
  if (!/^campaigns\/gha-[a-z0-9-]+\/viewer\/assets\/[A-Za-z0-9._-]+\.css$/.test(stylesheetHref ?? ""))
    throw new Error("History requires an immutable campaign's Runner Lab stylesheet");
  const rows = history.campaigns.length
    ? history.campaigns
        .map((campaign) => {
          const status =
            campaign.complete && campaign.allPassed ? "passed" : "failed";
          const rosters = campaign.rosters
            .map(
              (roster) =>
                `${html(roster.model)} · ${roster.passed}/${roster.selected}`,
            )
            .join("<br>");
          return `<tr><td><a href="${html(campaign.publicUrl)}"><code>${html(campaign.campaignId)}</code></a><small>${html(date(campaign.generatedAt))} UTC</small>${campaign.reportRevision ? `<small>Report refresh · no new model calls · source ${html(campaign.reportRevision.sourceCampaignId)}</small>` : ""}</td><td><span class="status ${status}">${status}</span></td><td><strong>${html(campaign.totals.passed)}/${html(campaign.totals.selected)}</strong><small>${html(campaign.totals.behaviorFailures)} behavior · ${html(campaign.totals.infrastructureFailures)} infrastructure</small></td><td>${rosters}</td><td><code>${html(campaign.source?.paperclip?.sha?.slice(0, 8) ?? "unknown")}</code><small>evals ${html(campaign.source?.evals?.sha?.slice(0, 8) ?? "unknown")}</small></td><td><a href="${html(campaign.publicUrl)}">Open Evalbook →</a></td></tr>`;
        })
        .join("")
    : '<tr><td colspan="6" class="empty">No campaigns have been published yet.</td></tr>';
  const latest = history.campaigns.find(
    (campaign) => campaign.campaignId === history.latestCampaignId,
  );
  const latestGreen = history.campaigns.find(
    (campaign) => campaign.campaignId === history.latestGreenCampaignId,
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Runner protocol eval campaigns · Paperclip</title>
<link rel="stylesheet" href="${html(stylesheetHref)}"></head>
<body class="evalbook-site"><main><header class="top"><a href="index.html">paperclip-runner evals</a><span class="badge">Run history</span></header><h1>Runner protocol eval campaigns</h1><p class="muted">Versioned live-runner reports. Full provider evidence remains in access-controlled workflow artifacts.</p>
<nav class="pointers">${latest ? `<a href="${html(latest.publicUrl)}">Latest · ${html(latest.campaignId)}</a>` : ""}${latestGreen ? `<a href="${html(latestGreen.publicUrl)}">Latest green · ${html(latestGreen.campaignId)}</a>` : ""}</nav>
<div class="table"><table><thead><tr><th>Campaign</th><th>Status</th><th>Cells</th><th>Models / rosters</th><th>Source</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><footer>Updated ${html(date(history.updatedAt))} UTC · Immutable campaign bundles · Canonical Evalbook layout with public-safe evidence projections</footer></main></body></html>`;
}

function awsObject(bucket, key) {
  return `s3://${bucket}/${key}`;
}

async function objectExists(bucket, key) {
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
    const detail = String(error?.stderr ?? error?.message ?? error);
    if (/\b(?:404|Not Found|NoSuchKey)\b/iu.test(detail)) return false;
    throw new Error(
      `Unable to inspect protocol eval history object: ${detail.slice(0, 400)}`,
    );
  }
}

async function downloadJson(bucket, key, destination) {
  if (!(await objectExists(bucket, key))) return null;
  await execFileAsync("aws", [
    "s3",
    "cp",
    awsObject(bucket, key),
    destination,
    "--only-show-errors",
  ]);
  return loadObject(destination);
}

async function uploadFile(bucket, key, file, cacheControl) {
  const contentType =
    extname(file) === ".html" ? "text/html; charset=utf-8" : "application/json";
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

async function uploadImmutableReport(bucket, prefix, reportRoot) {
  const cacheControl = "public,max-age=31536000,immutable";
  await execFileAsync("aws", [
    "s3",
    "cp",
    reportRoot,
    awsObject(bucket, prefix),
    "--recursive",
    "--only-show-errors",
    "--cache-control",
    cacheControl,
    "--exclude",
    "*.json",
  ]);
  await uploadFile(
    bucket,
    `${prefix}/campaign.json`,
    resolve(reportRoot, "campaign.json"),
    cacheControl,
  );
}

export async function publishProtocolEvalHistory({
  reportRoot,
  destination,
  viewerRoot,
}) {
  const validatedDestination =
    validateProtocolEvalHistoryDestination(destination);
  const { campaign } = await validatePublicProtocolEvalReport(reportRoot, {
    viewerRoot,
  });
  const viewer = await trustedViewerFiles(viewerRoot);
  const stylesheet = viewer.index.match(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[A-Za-z0-9._-]+\.css)">/)?.[1];
  if (!stylesheet || !viewer.files.get(`viewer/${stylesheet}`)?.includes(".evalbook-site"))
    throw new Error("Published history requires the same-run Runner Lab site theme");
  const stylesheetHref = `campaigns/${campaign.campaignId}/viewer/${stylesheet}`;
  const manifest = await createProtocolEvalBundleManifest(
    reportRoot,
    campaign.campaignId,
    { viewerRoot },
  );
  const temporary = await mkdtemp(
    join(tmpdir(), "runner-protocol-eval-history-"),
  );
  const historyKey = `${validatedDestination.prefix}/history.json`;
  const history = mergeProtocolEvalHistory(
    (await downloadJson(
      validatedDestination.bucket,
      historyKey,
      join(temporary, "history.json"),
    )) ?? emptyProtocolEvalHistory(),
    protocolEvalHistoryRecord(
      campaign,
      `${validatedDestination.publicBaseUrl}/${validatedDestination.prefix}`,
    ),
  );
  const campaignPrefix = `${validatedDestination.prefix}/campaigns/${campaign.campaignId}`;
  const manifestKey = `${campaignPrefix}/bundle-manifest.json`;
  const existing = await downloadJson(
    validatedDestination.bucket,
    manifestKey,
    join(temporary, "existing-manifest.json"),
  );
  if (existing && existing.bundleDigest !== manifest.bundleDigest) {
    throw new Error(
      `Immutable campaign ${campaign.campaignId} already exists with a different digest`,
    );
  }
  if (!existing) {
    await uploadImmutableReport(
      validatedDestination.bucket,
      campaignPrefix,
      reportRoot,
    );
    const manifestFile = join(temporary, "bundle-manifest.json");
    await writeFile(manifestFile, json(manifest));
    await uploadFile(
      validatedDestination.bucket,
      manifestKey,
      manifestFile,
      "public,max-age=31536000,immutable",
    );
  }
  const pointers = buildProtocolEvalPointers(history);
  const mutable = {
    "history.json": history,
    "latest.json": pointers.latest,
    "latest-green.json": pointers.latestGreen,
  };
  for (const [name, value] of Object.entries(mutable)) {
    const file = join(temporary, name);
    await writeFile(file, json(value));
    await uploadFile(
      validatedDestination.bucket,
      `${validatedDestination.prefix}/${name}`,
      file,
      "no-cache",
    );
  }
  const index = join(temporary, "index.html");
  await writeFile(index, renderProtocolEvalHistoryIndex(history, stylesheetHref));
  await uploadFile(
    validatedDestination.bucket,
    `${validatedDestination.prefix}/index.html`,
    index,
    "no-cache",
  );
  return {
    campaignId: campaign.campaignId,
    bundleDigest: manifest.bundleDigest,
    historySize: history.campaigns.length,
    reportUrl: `${validatedDestination.publicBaseUrl}/${campaignPrefix}/index.html`,
    historyUrl: `${validatedDestination.publicBaseUrl}/${validatedDestination.prefix}/index.html`,
  };
}

export async function writeProtocolEvalPublicationLinks(result, environment = process.env) {
  const { campaignId, reportUrl, historyUrl } = result;
  if (!SAFE_CAMPAIGN.test(campaignId)) throw new Error("Invalid published campaign ID");
  const safeUrl = (value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || /[\r\n<>]/.test(value))
      throw new Error("Invalid published report URL");
    return url.href;
  };
  const report = safeUrl(reportUrl);
  const history = safeUrl(historyUrl);
  if (environment.GITHUB_OUTPUT)
    await appendFile(environment.GITHUB_OUTPUT, `report_url=${report}\nhistory_url=${history}\n`);
  if (environment.GITHUB_STEP_SUMMARY)
    await appendFile(environment.GITHUB_STEP_SUMMARY, `## Published Runner Evalbook\n\n[Open this run's Evalbook](<${report}>) · [All eval runs](<${history}>)\n\nCampaign: \`${campaignId}\`\n\nPublic replay uses the Runner Lab theme; full evidence is in the workflow artifact.\n`);
}

async function main() {
  const result = await publishProtocolEvalHistory({
    viewerRoot: process.env.PAPERCLIP_RUNNER_PROTOCOL_EVAL_VIEWER_DIR,
    reportRoot: resolve(
      process.env.PAPERCLIP_RUNNER_PROTOCOL_EVAL_PUBLIC_REPORT_DIR ??
        "runner-protocol-eval-public-report",
    ),
    destination: {
      bucket: process.env.RUNNER_PROTOCOL_EVAL_HISTORY_S3_BUCKET ?? "",
      prefix:
        process.env.RUNNER_PROTOCOL_EVAL_HISTORY_PREFIX ??
        "runner-protocol-evals",
      publicBaseUrl:
        process.env.RUNNER_PROTOCOL_EVAL_HISTORY_PUBLIC_BASE_URL ?? "",
    },
  });
  await writeProtocolEvalPublicationLinks(result);
  console.log(
    `Published immutable protocol eval campaign ${result.campaignId} (${result.bundleDigest}) and ${result.historySize} history record(s)`,
  );
  console.log(`Evalbook: ${result.reportUrl}\nRun history: ${result.historyUrl}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
