#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const SUMMARY_INPUTS = [
  ["signing", "SIGNING"],
  ["updater", "UPDATER"],
  ["resident", "RESIDENT"],
  ["push", "PUSH"],
];

const CHANNELS = new Set(["internal", "beta", "stable"]);

const REQUIRED_REGRESSION_IDS = [
  "shared-rt2-task",
  "server-rt2-task-routes",
  "ui-quick-capture-queue",
  "ui-quick-capture-page",
  "ui-daily-board",
  "test-identity-gate",
  "rt2-identity-gate",
  "typecheck",
];

const DEFAULT_MAX_AGE_HOURS = 24;

const SECRET_VALUE_PATTERNS = [
  { code: "SECRET_PRIVATE_KEY_DETECTED", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "SECRET_AWS_KEY_DETECTED", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "SECRET_GITHUB_TOKEN_DETECTED", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/ },
  { code: "SECRET_TAURI_KEY_DETECTED", pattern: /\bTAURI_SIGNING_PRIVATE_KEY\s*=\s*(?!<secret-ref>)[^\s`]+/i },
  { code: "SECRET_VAPID_KEY_DETECTED", pattern: /\bVAPID_PRIVATE_KEY\s*=\s*(?!<secret-ref>)[^\s`]+/i },
  { code: "SECRET_APNS_KEY_DETECTED", pattern: /\bAPNS(?:_AUTH)?_KEY\s*=\s*(?!<secret-ref>)[^\s`]+/i },
  { code: "SECRET_PASSWORD_DETECTED", pattern: /\b(?:PASSWORD|TOKEN|PRIVATE_KEY)\s*=\s*(?!<secret-ref>)[^\s`]+/ },
];

const SENSITIVE_KEY_PATTERN =
  /(?:password|privatekey|private_key|privatekeymaterial|clientsecret|client_secret|deviceToken|vapidPrivateKey|apnsAuthKey|authKey|rawToken|secret|token|privateKey)$/i;
const SAFE_SECRET_REFERENCE = /^(secret-ref:|env:|github-secret:|azure-key-vault:|keychain:|ci-secret:|<secret-ref>)/i;

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    manifestPath: null,
    outputDir: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = path.resolve(argv[++i]);
    } else if (arg === "--manifest") {
      args.manifestPath = path.resolve(argv[++i]);
    } else if (arg === "--output-dir") {
      args.outputDir = argv[++i];
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/rt2-distribution-gate.mjs --manifest <path> [options]

Options:
  --root <path>          Repository root for resolving relative summary/evidence paths
  --output-dir <path>    Evidence parent directory (default: .planning/native-distribution-gate-runs)
  --json                 Print JSON summary
  --help                 Show this help
`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function repoPath(root, target) {
  const resolved = path.resolve(target);
  return path.relative(root, resolved).split(path.sep).join("/") || ".";
}

function addBlocker(blockers, {
  area = null,
  check,
  code,
  message,
  source = null,
  owner = "release-ops",
  nextCommand = null,
}) {
  blockers.push({
    category: "blocker",
    area,
    check,
    code,
    message,
    source,
    owner,
    nextCommand,
  });
}

function addPass(passed, { area = null, check, code = null, message, source = null }) {
  const derivedCode = code ?? [area, check].filter(Boolean).join("_").toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
  passed.push({
    category: "passed",
    area,
    check,
    code: `${derivedCode}_PASSED`,
    message,
    source,
  });
}

function parseDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requireText(blockers, { entry, field, area, check, code, label }) {
  const value = entry?.[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    addBlocker(blockers, {
      area,
      check,
      code,
      message: `${label} is required.`,
    });
    return null;
  }
  return value;
}

function scanSecrets(value, blockers, keyPath = []) {
  if (typeof value === "string") {
    for (const { code, pattern } of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        addBlocker(blockers, {
          area: "secret-hygiene",
          check: "secret-hygiene",
          code,
          message: `Potential raw secret found at ${keyPath.join(".") || "manifest"}. Use a secret reference instead.`,
          source: keyPath.join(".") || null,
          owner: "security",
        });
      }
    }
    const joined = keyPath.join(".");
    if (SENSITIVE_KEY_PATTERN.test(joined) && value.trim() && !SAFE_SECRET_REFERENCE.test(value.trim())) {
      addBlocker(blockers, {
        area: "secret-hygiene",
        check: "secret-hygiene",
        code: "SECRET_REFERENCE_REQUIRED",
        message: `Sensitive field ${joined} must contain a secret reference, not a raw value.`,
        source: joined,
        owner: "security",
      });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => scanSecrets(item, blockers, [...keyPath, String(index)]));
  } else if (isObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      scanSecrets(nested, blockers, [...keyPath, key]);
    }
  }
}

function validateReleaseIdentity(manifest, blockers, passed) {
  const release = manifest.release;
  if (!isObject(release)) {
    addBlocker(blockers, {
      area: "release",
      check: "release",
      code: "RELEASE_IDENTITY_MISSING",
      message: "Release identity is required.",
    });
    return { release: null, releaseDate: null, maxAgeHours: DEFAULT_MAX_AGE_HOURS };
  }

  const channel = requireText(blockers, {
    entry: release,
    field: "channel",
    area: "release",
    check: "release.channel",
    code: "RELEASE_CHANNEL_MISSING",
    label: "Release channel",
  });
  if (channel && !CHANNELS.has(channel)) {
    addBlocker(blockers, {
      area: "release",
      check: "release.channel",
      code: "RELEASE_CHANNEL_INVALID",
      message: `Release channel must be one of ${[...CHANNELS].join(", ")}.`,
    });
  }

  requireText(blockers, {
    entry: release,
    field: "version",
    area: "release",
    check: "release.version",
    code: "RELEASE_VERSION_MISSING",
    label: "Release version",
  });
  requireText(blockers, {
    entry: release,
    field: "buildId",
    area: "release",
    check: "release.buildId",
    code: "RELEASE_BUILD_ID_MISSING",
    label: "Release build ID",
  });

  const generatedAt = requireText(blockers, {
    entry: release,
    field: "generatedAt",
    area: "release",
    check: "release.generatedAt",
    code: "RELEASE_GENERATED_AT_MISSING",
    label: "Release generatedAt",
  });
  const releaseDate = parseDate(generatedAt);
  if (generatedAt && !releaseDate) {
    addBlocker(blockers, {
      area: "release",
      check: "release.generatedAt",
      code: "RELEASE_GENERATED_AT_INVALID",
      message: `Release generatedAt must be an ISO timestamp: ${generatedAt}`,
    });
  }

  const maxAgeHours = Number.isFinite(release.maxAgeHours) && release.maxAgeHours > 0
    ? release.maxAgeHours
    : DEFAULT_MAX_AGE_HOURS;

  addPass(passed, {
    area: "release",
    check: "identity",
    message: "Release identity is present.",
  });
  return { release, releaseDate, maxAgeHours };
}

function resolveSummaryPath(root, summaryPath) {
  if (typeof summaryPath !== "string" || !summaryPath.trim()) return null;
  return path.isAbsolute(summaryPath) ? summaryPath : path.join(root, summaryPath);
}

function readSummary(root, manifest, blockers, passed, key, label) {
  const summaryPath = manifest.summaries?.[key];
  if (typeof summaryPath !== "string" || !summaryPath.trim()) {
    addBlocker(blockers, {
      area: key,
      check: `${key}.summary`,
      code: `${label}_SUMMARY_MISSING`,
      message: `${key} summary path is required.`,
      source: "summaries",
      nextCommand: `Run or attach the ${key} evidence gate summary before final distribution gating.`,
    });
    return { path: summaryPath ?? null, summary: null };
  }

  const resolved = resolveSummaryPath(root, summaryPath);
  if (!resolved || !fs.existsSync(resolved)) {
    addBlocker(blockers, {
      area: key,
      check: `${key}.summary`,
      code: `${label}_SUMMARY_MISSING`,
      message: `${key} summary does not exist: ${summaryPath}`,
      source: summaryPath,
      nextCommand: `Run or attach the ${key} evidence gate summary before final distribution gating.`,
    });
    return { path: summaryPath, summary: null };
  }

  let summary;
  try {
    summary = readJson(resolved);
  } catch (error) {
    addBlocker(blockers, {
      area: key,
      check: `${key}.summary`,
      code: `${label}_SUMMARY_INVALID_JSON`,
      message: `${key} summary is not valid JSON: ${error.message}`,
      source: summaryPath,
    });
    return { path: summaryPath, summary: null };
  }

  const blockerCount = Number(summary.counts?.blockers ?? 0);
  const upstreamBlockers = Array.isArray(summary.blockers) ? summary.blockers : [];
  if (summary.status !== "passed" || blockerCount > 0 || upstreamBlockers.length > 0) {
    addBlocker(blockers, {
      area: key,
      check: `${key}.summary`,
      code: `${label}_SUMMARY_BLOCKED`,
      message: `${key} summary is not passed.`,
      source: summaryPath,
      nextCommand: `Resolve blockers in ${summaryPath} before running the final distribution gate.`,
    });
    for (const blocker of upstreamBlockers) {
      if (blocker?.code) {
        addBlocker(blockers, {
          area: key,
          check: `${key}.upstream`,
          code: `UPSTREAM_${blocker.code}`,
          message: blocker.message ?? `Upstream blocker ${blocker.code}`,
          source: summaryPath,
          owner: blocker.owner ?? "release-ops",
        });
      }
    }
  } else {
    addPass(passed, {
      area: key,
      check: "summary",
      code: `${label}_SUMMARY`,
      message: `${key} summary passed.`,
      source: summaryPath,
    });
  }

  return { path: summaryPath, summary };
}

function staleComparedToRelease(dateValue, releaseDate, maxAgeHours) {
  const date = parseDate(dateValue);
  if (!date || !releaseDate) return true;
  const ageMs = releaseDate.getTime() - date.getTime();
  return ageMs > maxAgeHours * 60 * 60 * 1000;
}

function validateSummaryFreshness({ summary, key, label, path: summaryPath, releaseDate, maxAgeHours, blockers, passed }) {
  if (!summary) return;
  if (staleComparedToRelease(summary.generatedAt, releaseDate, maxAgeHours)) {
    addBlocker(blockers, {
      area: key,
      check: `${key}.generatedAt`,
      code: `${label}_SUMMARY_STALE`,
      message: `${key} summary is older than the release freshness window or lacks generatedAt.`,
      source: summaryPath,
    });
    return;
  }
  addPass(passed, {
    area: key,
    check: "freshness",
    code: `${label}_SUMMARY_FRESHNESS`,
    message: `${key} summary is within freshness window.`,
    source: summaryPath,
  });
}

function validateUpdaterFreshness({ summary, path: summaryPath, releaseDate, maxAgeHours, blockers, passed }) {
  if (!summary) return;
  const checkedAt = summary.updateState?.checkedAt;
  if (staleComparedToRelease(summary.generatedAt, releaseDate, maxAgeHours) || staleComparedToRelease(checkedAt, releaseDate, maxAgeHours)) {
    addBlocker(blockers, {
      area: "updater",
      check: "updater.freshness",
      code: "UPDATER_SUMMARY_STALE",
      message: "Updater summary generatedAt and updateState.checkedAt must be inside the release freshness window.",
      source: summaryPath,
      nextCommand: "Run the release channel gate against current release artifacts.",
    });
    return;
  }
  addPass(passed, {
    area: "updater",
    check: "freshness",
    code: "UPDATER_SUMMARY_FRESHNESS",
    message: "Updater summary generatedAt and checkedAt are within freshness window.",
    source: summaryPath,
  });
}

function compareField({ actual, expected, code, area, check, label, blockers, source }) {
  if (actual === undefined || actual === null || actual === "") return;
  if (expected === undefined || expected === null || expected === "") return;
  if (actual !== expected) {
    addBlocker(blockers, {
      area,
      check,
      code,
      message: `${label} must match release identity. Expected ${expected}, got ${actual}.`,
      source,
    });
  }
}

function validateIdentityAlignment(release, summaryRecords, blockers, passed) {
  if (!release) return;
  const updater = summaryRecords.updater?.summary;
  const updaterPath = summaryRecords.updater?.path;
  if (updater) {
    compareField({
      actual: updater.installed?.channel,
      expected: release.channel,
      code: "UPDATER_CHANNEL_MISMATCH",
      area: "updater",
      check: "updater.installed.channel",
      label: "Updater installed channel",
      blockers,
      source: updaterPath,
    });
    compareField({
      actual: updater.updateState?.latestChannel,
      expected: release.channel,
      code: "UPDATER_CHANNEL_MISMATCH",
      area: "updater",
      check: "updater.updateState.latestChannel",
      label: "Updater latest channel",
      blockers,
      source: updaterPath,
    });
    compareField({
      actual: updater.installed?.version,
      expected: release.version,
      code: "UPDATER_VERSION_MISMATCH",
      area: "updater",
      check: "updater.installed.version",
      label: "Updater installed version",
      blockers,
      source: updaterPath,
    });
    compareField({
      actual: updater.updateState?.latestVersion,
      expected: release.version,
      code: "UPDATER_VERSION_MISMATCH",
      area: "updater",
      check: "updater.updateState.latestVersion",
      label: "Updater latest version",
      blockers,
      source: updaterPath,
    });
    compareField({
      actual: updater.installed?.buildId,
      expected: release.buildId,
      code: "UPDATER_BUILD_MISMATCH",
      area: "updater",
      check: "updater.installed.buildId",
      label: "Updater installed build ID",
      blockers,
      source: updaterPath,
    });
    addPass(passed, {
      area: "updater",
      check: "identity",
      code: "UPDATER_IDENTITY",
      message: "Updater identity was checked against release identity.",
      source: updaterPath,
    });
  }

  const resident = summaryRecords.resident?.summary;
  const residentPath = summaryRecords.resident?.path;
  if (resident) {
    compareField({
      actual: resident.installed?.channel,
      expected: release.channel,
      code: "RESIDENT_CHANNEL_MISMATCH",
      area: "resident",
      check: "resident.installed.channel",
      label: "Resident installed channel",
      blockers,
      source: residentPath,
    });
    compareField({
      actual: resident.tray?.releaseChannel,
      expected: release.channel,
      code: "RESIDENT_CHANNEL_MISMATCH",
      area: "resident",
      check: "resident.tray.releaseChannel",
      label: "Resident tray channel",
      blockers,
      source: residentPath,
    });
    compareField({
      actual: resident.installed?.version,
      expected: release.version,
      code: "RESIDENT_VERSION_MISMATCH",
      area: "resident",
      check: "resident.installed.version",
      label: "Resident installed version",
      blockers,
      source: residentPath,
    });
    compareField({
      actual: resident.installed?.buildId,
      expected: release.buildId,
      code: "RESIDENT_BUILD_MISMATCH",
      area: "resident",
      check: "resident.installed.buildId",
      label: "Resident installed build ID",
      blockers,
      source: residentPath,
    });
    compareField({
      actual: resident.tray?.buildIdentity,
      expected: release.buildId,
      code: "RESIDENT_BUILD_MISMATCH",
      area: "resident",
      check: "resident.tray.buildIdentity",
      label: "Resident tray build identity",
      blockers,
      source: residentPath,
    });
    addPass(passed, {
      area: "resident",
      check: "identity",
      code: "RESIDENT_IDENTITY",
      message: "Resident identity was checked against release identity.",
      source: residentPath,
    });
  }
}

function validateRegressionEvidence(manifest, releaseDate, maxAgeHours, blockers, passed) {
  const evidence = manifest.regressionEvidence;
  if (!isObject(evidence) || !Array.isArray(evidence.commands)) {
    addBlocker(blockers, {
      area: "regression",
      check: "regressionEvidence.commands",
      code: "CAPTURE_REGRESSION_MISSING",
      message: "Regression evidence commands are required.",
    });
    return { commands: [] };
  }

  const byId = new Map();
  for (const command of evidence.commands) {
    if (typeof command?.id === "string") byId.set(command.id, command);
  }

  for (const id of REQUIRED_REGRESSION_IDS) {
    const command = byId.get(id);
    if (!command) {
      addBlocker(blockers, {
        area: "regression",
        check: id,
        code: "CAPTURE_REGRESSION_MISSING",
        message: `Required regression evidence is missing: ${id}`,
      });
      continue;
    }
    if (command.status !== "passed") {
      addBlocker(blockers, {
        area: "regression",
        check: id,
        code: "CAPTURE_REGRESSION_FAILED",
        message: `Required regression evidence did not pass: ${id}`,
        source: command.evidence ?? null,
        nextCommand: command.command ?? null,
      });
    }
    if (!command.evidence) {
      addBlocker(blockers, {
        area: "regression",
        check: id,
        code: "CAPTURE_REGRESSION_EVIDENCE_MISSING",
        message: `Required regression evidence lacks an evidence reference: ${id}`,
        nextCommand: command.command ?? null,
      });
    }
    if (command.endedAt && staleComparedToRelease(command.endedAt, releaseDate, maxAgeHours)) {
      addBlocker(blockers, {
        area: "regression",
        check: id,
        code: "CAPTURE_REGRESSION_STALE",
        message: `Regression evidence is older than the release freshness window: ${id}`,
        source: command.evidence ?? null,
        nextCommand: command.command ?? null,
      });
    }
    if (command.status === "passed" && command.evidence) {
      addPass(passed, {
        area: "regression",
        check: id,
        code: `REGRESSION_${id}`,
        message: `${id} passed.`,
        source: command.evidence,
      });
    }
  }

  return { commands: evidence.commands };
}

function evaluateDistributionGateManifest({ root = process.cwd(), manifest }) {
  const blockers = [];
  const passed = [];
  scanSecrets(manifest, blockers);

  if (!isObject(manifest)) {
    addBlocker(blockers, {
      area: "manifest",
      check: "manifest",
      code: "MANIFEST_INVALID",
      message: "Distribution gate manifest must be an object.",
    });
    return { blockers, passed, release: null, summaries: {}, regressionEvidence: { commands: [] } };
  }

  const { release, releaseDate, maxAgeHours } = validateReleaseIdentity(manifest, blockers, passed);

  if (!isObject(manifest.summaries)) {
    addBlocker(blockers, {
      area: "summaries",
      check: "summaries",
      code: "SUMMARIES_MISSING",
      message: "Summary references are required.",
    });
  }

  const summaryRecords = {};
  for (const [key, label] of SUMMARY_INPUTS) {
    summaryRecords[key] = readSummary(root, manifest, blockers, passed, key, label);
  }

  for (const [key, label] of SUMMARY_INPUTS) {
    if (key === "updater") continue;
    validateSummaryFreshness({
      summary: summaryRecords[key]?.summary,
      key,
      label,
      path: summaryRecords[key]?.path,
      releaseDate,
      maxAgeHours,
      blockers,
      passed,
    });
  }
  validateUpdaterFreshness({
    summary: summaryRecords.updater?.summary,
    path: summaryRecords.updater?.path,
    releaseDate,
    maxAgeHours,
    blockers,
    passed,
  });

  validateIdentityAlignment(release, summaryRecords, blockers, passed);
  const regressionEvidence = validateRegressionEvidence(manifest, releaseDate, maxAgeHours, blockers, passed);

  return {
    blockers,
    passed,
    release,
    summaries: Object.fromEntries(
      Object.entries(summaryRecords).map(([key, record]) => [
        key,
        {
          path: record.path,
          status: record.summary?.status ?? null,
          generatedAt: record.summary?.generatedAt ?? null,
          blockers: Array.isArray(record.summary?.blockers) ? record.summary.blockers.length : null,
        },
      ]),
    ),
    regressionEvidence,
  };
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value).replace(/\r?\n/g, " ");
}

function buildReport(summary) {
  const lines = [
    "# RT2 Distribution Gate Report",
    "",
    `Generated: ${summary.generatedAt}`,
    `Status: ${summary.status}`,
    "",
    "## Release Identity",
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| Channel | ${formatValue(summary.release?.channel)} |`,
    `| Version | ${formatValue(summary.release?.version)} |`,
    `| Build ID | ${formatValue(summary.release?.buildId)} |`,
    `| Generated At | ${formatValue(summary.release?.generatedAt)} |`,
    `| Max Age Hours | ${formatValue(summary.release?.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS)} |`,
    "",
    "## Summary Inputs",
    "",
    "| Input | Status | Generated At | Source |",
    "|-------|--------|--------------|--------|",
  ];

  for (const [key, record] of Object.entries(summary.summaries)) {
    lines.push(`| ${key} | ${formatValue(record.status)} | ${formatValue(record.generatedAt)} | ${formatValue(record.path)} |`);
  }

  lines.push("", "## Regression Evidence", "", "| ID | Status | Evidence |", "|----|--------|----------|");
  for (const command of summary.regressionEvidence.commands ?? []) {
    lines.push(`| ${formatValue(command.id)} | ${formatValue(command.status)} | ${formatValue(command.evidence)} |`);
  }

  lines.push("", "## Blockers", "");
  if (summary.blockers.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Area | Code | Message | Source | Next Command |");
    lines.push("|------|------|---------|--------|--------------|");
    for (const blocker of summary.blockers) {
      lines.push(
        `| ${formatValue(blocker.area)} | ${formatValue(blocker.code)} | ${formatValue(blocker.message)} | ${formatValue(blocker.source)} | ${formatValue(blocker.nextCommand)} |`,
      );
    }
  }

  lines.push("", "## Passed Checks", "");
  if (summary.passed.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Area | Code | Message | Source |");
    lines.push("|------|------|---------|--------|");
    for (const pass of summary.passed) {
      lines.push(`| ${formatValue(pass.area)} | ${formatValue(pass.code)} | ${formatValue(pass.message)} | ${formatValue(pass.source)} |`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeSummary(summary) {
  ensureDir(summary.runDirAbs);
  fs.writeFileSync(path.join(summary.runDirAbs, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(summary.runDirAbs, "report.md"), buildReport(summary), "utf8");
}

function runDistributionGate(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  if (!options.manifestPath) throw new Error("--manifest is required");
  const manifestPathAbs = path.resolve(options.manifestPath);
  const manifest = readJson(manifestPathAbs);
  const outputParentAbs = path.resolve(
    path.isAbsolute(options.outputDir ?? "")
      ? options.outputDir
      : path.join(root, options.outputDir ?? ".planning/native-distribution-gate-runs"),
  );
  const now = options.now ?? new Date();
  const runDirAbs = path.join(outputParentAbs, timestampForPath(now));
  const result = evaluateDistributionGateManifest({ root, manifest });
  const summary = {
    version: 1,
    generatedAt: now.toISOString(),
    status: result.blockers.length > 0 ? "blocker" : "passed",
    root,
    manifestPath: repoPath(root, manifestPathAbs),
    runDir: repoPath(root, runDirAbs),
    runDirAbs,
    release: result.release,
    counts: {
      blockers: result.blockers.length,
      passed: result.passed.length,
    },
    summaries: result.summaries,
    regressionEvidence: result.regressionEvidence,
    blockers: result.blockers,
    passed: result.passed,
  };
  writeSummary(summary);
  return summary;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }
    const summary = runDistributionGate({
      root: args.root,
      manifestPath: args.manifestPath,
      outputDir: args.outputDir,
    });
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`RT2 distribution gate ${summary.status}: ${summary.runDir}`);
      if (summary.blockers.length > 0) {
        console.log(`Blockers: ${summary.blockers.map((blocker) => blocker.code).join(", ")}`);
      }
    }
    process.exitCode = summary.blockers.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("rt2-distribution-gate.mjs")) {
  main();
}

export {
  buildReport,
  evaluateDistributionGateManifest,
  runDistributionGate,
};
