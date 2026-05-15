#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MANIFEST_PATH = new URL("./release-package-manifest.json", import.meta.url);
const CANARY_VERSION_RE = /-canary\.\d+$/;
const REGISTRY_BASE = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org/";
const TIMEOUT_MS = parseInt(process.env.RELEASE_MONITOR_TIMEOUT ?? "30000", 10);
const EXIT_OK = 0;
const EXIT_WARN = 1;
const EXIT_ERROR = 2;

function isCanaryVersion(version) {
  return CANARY_VERSION_RE.test(version);
}

function usage() {
  process.stderr.write([
    "Usage:",
    "  node scripts/release-monitor.mjs [options]",
    "",
    "Options:",
    "  --format <text|json>     Output format (default: text)",
    "  --check-dist-tags        Verify dist-tag integrity for all packages",
    "  --recent <N>             Show N most recent releases per channel (default: 3)",
    "  --silent                 Only output on warnings/errors (for cron)",
    "  --help                   Show this help",
    "",
    "Environment:",
    "  NPM_REGISTRY                   npm registry URL (default: https://registry.npmjs.org/)",
    "  RELEASE_MONITOR_TIMEOUT        HTTP timeout in ms (default: 30000)",
    "",
    "Exit codes:",
    "  0  OK — all checks pass",
    "  1  WARN — non-blocking issues found (e.g. old canary drift, partial data)",
    "  2  ERROR — blocking issues found (e.g. package not found, canary on latest)",
    "",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    format: "text",
    checkDistTags: false,
    recent: 3,
    silent: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--format":
        options.format = argv[++i] ?? "text";
        if (options.format !== "text" && options.format !== "json") {
          throw new Error(`--format must be text or json, got ${options.format}`);
        }
        break;
      case "--check-dist-tags":
        options.checkDistTags = true;
        break;
      case "--recent":
        options.recent = parseInt(argv[++i] ?? "3", 10);
        if (isNaN(options.recent) || options.recent < 0) {
          throw new Error("--recent must be a non-negative integer");
        }
        break;
      case "--silent":
        options.silent = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        throw new Error(`unexpected argument: ${argv[i]}`);
    }
  }

  return options;
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`release package manifest not found at ${MANIFEST_PATH}`);
  }
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("release-package-manifest.json must be an array");
  }
  return entries.filter((e) => e?.publishFromCi && e.name);
}

function registryUrl(packageName) {
  const base = REGISTRY_BASE.endsWith("/") ? REGISTRY_BASE : `${REGISTRY_BASE}/`;
  return new URL(encodeURIComponent(packageName), base);
}

async function fetchRegistryDoc(packageName, { fullMetadata = false } = {}) {
  const url = registryUrl(packageName);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const accept = fullMetadata
    ? "application/json"
    : "application/vnd.npm.install-v1+json, application/json;q=0.9";
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return res.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`registry request timed out for ${packageName} after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkPackageHealth(packageName) {
  const doc = await fetchRegistryDoc(packageName);
  if (!doc) {
    return { packageName, status: "missing", distTags: {}, error: "package not found on npm" };
  }

  const distTags = doc["dist-tags"] ?? {};
  const modified = doc.time ? Object.keys(doc.time).sort().pop() : null;

  const warn = [];
  const err = [];

  if (!distTags.latest) {
    warn.push("no latest dist-tag set");
  }
  if (!distTags.canary) {
    warn.push("no canary dist-tag set");
  }
  if (distTags.latest && isCanaryVersion(distTags.latest)) {
    err.push(`latest dist-tag (${distTags.latest}) points to a canary version`);
  }

  const status = err.length > 0 ? "error" : warn.length > 0 ? "warn" : "ok";
  return {
    packageName,
    status,
    distTags,
    latestVersion: distTags.latest ?? null,
    canaryVersion: distTags.canary ?? null,
    lastModified: modified,
    warnings: warn,
    errors: err,
  };
}

async function checkDistTagIntegrity(packages) {
  const docs = await Promise.all(packages.map((p) => fetchRegistryDoc(p.name)));
  const results = [];

  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    const doc = docs[i];
    if (!doc) {
      results.push({ packageName: pkg.name, status: "missing", detail: "not on npm" });
      continue;
    }
    const tags = doc["dist-tags"] ?? {};
    const latest = tags.latest;
    const canary = tags.canary;

    if (!latest) {
      results.push({ packageName: pkg.name, status: "warn", detail: "no latest tag" });
      continue;
    }

    if (isCanaryVersion(latest)) {
      results.push({
        packageName: pkg.name,
        status: "error",
        detail: `latest tag points to canary version ${latest}`,
        latestVersion: latest,
        canaryVersion: canary,
      });
      continue;
    }

    if (!canary) {
      results.push({ packageName: pkg.name, status: "warn", detail: "no canary tag" });
      continue;
    }

    results.push({ packageName: pkg.name, status: "ok" });
  }

  return results;
}

async function getRecentVersions(packageName, count) {
  const doc = await fetchRegistryDoc(packageName, { fullMetadata: true });
  if (!doc) return { packageName, versions: [] };

  const time = doc.time ?? {};
  const entries = Object.entries(time)
    .filter(([v]) => v !== "created" && v !== "modified" && v !== "unpublished")
    .sort((a, b) => new Date(b[1]) - new Date(a[1]))
    .slice(0, count);

  return {
    packageName,
    versions: entries.map(([version, date]) => ({
      version,
      date,
      isCanary: isCanaryVersion(version),
    })),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packages = loadManifest();
  const packageNames = packages.map((p) => p.name);
  const report = {
    timestamp: new Date().toISOString(),
    summary: { total: packageNames.length, ok: 0, warn: 0, error: 0, missing: 0 },
    packages: [],
    distTags: null,
    recentReleases: null,
  };

  const healthResults = await Promise.all(packageNames.map(checkPackageHealth));

  for (const result of healthResults) {
    report.packages.push(result);
    report.summary[result.status === "ok" ? "ok" : result.status === "warn" ? "warn" : result.status === "error" ? "error" : "missing"]++;
  }

  if (options.checkDistTags) {
    report.distTags = await checkDistTagIntegrity(packages);
  }

  if (options.recent > 0 && packageNames.length > 0) {
    const cliPkg = packages.find((p) => p.name === "paperclipai");
    const targetPkg = cliPkg ?? packages[0];
    report.recentReleases = await getRecentVersions(targetPkg.name, options.recent);
  }

  const canaryVersions = new Map();
  for (const pkg of healthResults) {
    if (pkg.canaryVersion) {
      const existing = canaryVersions.get(pkg.canaryVersion) ?? [];
      existing.push(pkg.packageName);
      canaryVersions.set(pkg.canaryVersion, existing);
    }
  }
  if (canaryVersions.size > 1) {
    const sorted = [...canaryVersions.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    report.canaryInconsistency = {
      detected: true,
      message: `multiple canary versions in flight: ${sorted.map(([v, pkgs]) => `${v} (${pkgs.length} packages)`).join(", ")}`,
      versions: Object.fromEntries(canaryVersions),
    };
    report.summary.warn++;
  }

  const hasErrors = report.summary.error > 0 || report.summary.missing > 0;
  const hasWarnings = report.summary.warn > 0;

  if (options.format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    if (!options.silent || hasErrors || hasWarnings) {
      printTextReport(report);
    }
  }

  if (report.distTags) {
    const tagErrors = report.distTags.filter((r) => r.status === "error");
    if (tagErrors.length > 0) {
      if (options.format === "json") process.exit(0);
      process.exit(EXIT_ERROR);
    }
  }

  if (hasErrors) process.exit(EXIT_ERROR);
  if (hasWarnings) process.exit(EXIT_WARN);
  process.exit(EXIT_OK);
}

function printTextReport(report) {
  const { summary, packages, distTags, recentReleases, timestamp } = report;

  process.stdout.write(`\n`);
  process.stdout.write(`Paperclip Release Monitor — ${timestamp}\n`);
  process.stdout.write(`${"=".repeat(50)}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Packages: ${summary.total} total, ${summary.ok} ok, ${summary.warn} warn, ${summary.error} error, ${summary.missing} missing\n`);
  process.stdout.write(`\n`);

  for (const pkg of packages) {
    const icon = pkg.status === "ok" ? "✓" : pkg.status === "warn" ? "⚠" : "✗";
    process.stdout.write(`  ${icon} ${pkg.packageName} [${pkg.status}]\n`);

    if (pkg.latestVersion) {
      process.stdout.write(`    latest: ${pkg.latestVersion}\n`);
    }
    if (pkg.canaryVersion) {
      process.stdout.write(`    canary: ${pkg.canaryVersion}\n`);
    }

    for (const w of pkg.warnings) {
      process.stdout.write(`    warning: ${w}\n`);
    }
    for (const e of pkg.errors) {
      process.stdout.write(`    ERROR: ${e}\n`);
    }
  }

  if (distTags && distTags.length > 0) {
    const tagErrors = distTags.filter((r) => r.status === "error");
    const tagWarns = distTags.filter((r) => r.status === "warn");

    if (tagErrors.length > 0 || tagWarns.length > 0) {
      process.stdout.write(`\n`);
      process.stdout.write(`Dist-tag Integrity:\n`);
      process.stdout.write(`${"-".repeat(20)}\n`);

      for (const r of tagErrors) {
        process.stdout.write(`  ✗ ${r.packageName}: ${r.detail}\n`);
      }
      for (const r of tagWarns) {
        process.stdout.write(`  ⚠ ${r.packageName}: ${r.detail}\n`);
      }
    }
  }

  if (report.canaryInconsistency) {
    process.stdout.write(`\n`);
    process.stdout.write(`⚠ Canary Version Inconsistency:\n`);
    process.stdout.write(`${"-".repeat(30)}\n`);
    process.stdout.write(`  ${report.canaryInconsistency.message}\n`);
    process.stdout.write(`\n`);
  }

  if (recentReleases) {
    process.stdout.write(`\n`);
    process.stdout.write(`Recent releases (${recentReleases.packageName}):\n`);
    process.stdout.write(`${"-".repeat(20)}\n`);

    for (const v of recentReleases.versions) {
      const tag = v.isCanary ? "canary" : "stable";
      process.stdout.write(`  ${v.version.padEnd(30)} ${tag.padEnd(8)} ${v.date}\n`);
    }
  }

  process.stdout.write(`\n`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(EXIT_ERROR);
  });
}
