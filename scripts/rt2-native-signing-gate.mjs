#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const MACOS_CHECKS = [
  ["hardenedRuntime", "MACOS_HARDENED_RUNTIME"],
  ["codesign", "MACOS_CODESIGN"],
  ["notarization", "MACOS_NOTARIZATION"],
  ["stapling", "MACOS_STAPLING"],
  ["gatekeeper", "MACOS_GATEKEEPER"],
];

const WINDOWS_CHECKS = [
  ["signing", "WINDOWS_SIGNING"],
  ["timestamping", "WINDOWS_TIMESTAMP"],
  ["signatureVerification", "WINDOWS_SIGNATURE_VERIFICATION"],
  ["installTrust", "WINDOWS_INSTALL_TRUST"],
];

const WINDOWS_TRUST_PATHS = new Set([
  "store_resigning",
  "store",
  "msix_store",
  "azure_artifact_signing",
  "azure_trusted_signing",
  "azure_code_signing",
  "azure_key_vault",
  "ev_certificate",
  "ov_certificate",
  "custom_sign_command",
]);

const WINDOWS_INSTALLER_FORMATS = new Set(["msix", "msi", "nsis", "exe", "appx", "appxbundle", "msixbundle"]);

const SECRET_VALUE_PATTERNS = [
  { code: "SECRET_PRIVATE_KEY_DETECTED", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "SECRET_AWS_KEY_DETECTED", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "SECRET_GITHUB_TOKEN_DETECTED", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/ },
  { code: "SECRET_APPLE_PASSWORD_DETECTED", pattern: /\bAPPLE_(?:PASSWORD|CERTIFICATE_PASSWORD)\s*=\s*(?!<secret-ref>)[^\s`]+/ },
  { code: "SECRET_WINDOWS_CERT_DETECTED", pattern: /\bWINDOWS_SIGNING_CERTIFICATE\s*=\s*(?!<secret-ref>)[^\s`]+/ },
  { code: "SECRET_TAURI_KEY_DETECTED", pattern: /\bTAURI_SIGNING_PRIVATE_KEY\s*=\s*(?!<secret-ref>)[^\s`]+/ },
];

const SENSITIVE_KEY_PATTERN = /(password|privatekey|private_key|privatekeymaterial|clientsecret|client_secret|token|secret)$/i;
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
  console.log(`Usage: node scripts/rt2-native-signing-gate.mjs --manifest <path> [options]

Options:
  --root <path>          Repository root for resolving relative evidence paths
  --output-dir <path>    Evidence parent directory (default: .planning/native-signing-runs)
  --json                 Print JSON summary
  --help                 Show this help
`);
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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function repoPath(root, target) {
  const resolved = path.resolve(target);
  return path.relative(root, resolved).split(path.sep).join("/") || ".";
}

function addBlocker(blockers, { platform, check, code, message, source = null, owner = "release-ops", nextCommand = null }) {
  blockers.push({
    category: "blocker",
    platform,
    check,
    code,
    message,
    source,
    owner,
    nextCommand,
  });
}

function addPass(passed, { platform, check, message, source = null }) {
  passed.push({
    category: "passed",
    platform,
    check,
    code: `${platform.toUpperCase()}_${check.toUpperCase()}_PASSED`,
    message,
    source,
  });
}

function normalizePlatforms(manifest) {
  const source = isObject(manifest.platforms) ? manifest.platforms : manifest;
  return {
    macos: source.macos ?? source.darwin ?? null,
    windows: source.windows ?? source.win32 ?? null,
  };
}

function isPathLike(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/^[a-z]+:\/\//i.test(value)) return false;
  if (SAFE_SECRET_REFERENCE.test(value)) return false;
  return /[\\/]/.test(value) || /\.(json|txt|log|md|dmg|pkg|zip|msix|msi|exe|appx|appxbundle|msixbundle|p7b|cer)$/i.test(value);
}

function resolveMaybePath(root, value) {
  if (!isPathLike(value)) return null;
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function checkPathExists(root, blockers, { platform, check, code, value, label, owner }) {
  const resolved = resolveMaybePath(root, value);
  if (!resolved) return null;
  if (!fs.existsSync(resolved)) {
    addBlocker(blockers, {
      platform,
      check,
      code,
      message: `${label} does not exist: ${value}`,
      source: value,
      owner,
      nextCommand: `Create or attach ${label} evidence before running the native signing gate.`,
    });
  }
  return resolved;
}

function evidenceValue(check) {
  if (!isObject(check)) return null;
  if (check.evidence !== undefined) return check.evidence;
  if (check.evidencePath !== undefined) return check.evidencePath;
  if (check.output !== undefined) return check.output;
  return null;
}

function evidenceSource(root, value) {
  if (typeof value === "string") {
    const resolved = resolveMaybePath(root, value);
    return resolved ? repoPath(root, resolved) : null;
  }
  if (isObject(value) && typeof value.path === "string") {
    return value.path;
  }
  if (isObject(value) && typeof value.url === "string") return value.url;
  if (isObject(value) && typeof value.ref === "string") return value.ref;
  return null;
}

function validateEvidenceReference(root, blockers, { platform, checkName, codePrefix, check, owner }) {
  const value = evidenceValue(check);
  if (value === null || value === undefined || value === "") {
    addBlocker(blockers, {
      platform,
      check: checkName,
      code: `${codePrefix}_EVIDENCE_MISSING`,
      message: `${platform} ${checkName} evidence is required.`,
      owner,
      nextCommand: "Attach command output, evidence file, URL, or CI artifact reference.",
    });
    return null;
  }

  if (typeof value === "string") {
    checkPathExists(root, blockers, {
      platform,
      check: checkName,
      code: `${codePrefix}_EVIDENCE_FILE_MISSING`,
      value,
      label: `${platform} ${checkName} evidence`,
      owner,
    });
    return evidenceSource(root, value);
  }

  if (isObject(value)) {
    if (typeof value.path === "string") {
      checkPathExists(root, blockers, {
        platform,
        check: checkName,
        code: `${codePrefix}_EVIDENCE_FILE_MISSING`,
        value: value.path,
        label: `${platform} ${checkName} evidence`,
        owner,
      });
      return value.path;
    }
    if (typeof value.text === "string" && value.text.trim()) return null;
    if (typeof value.url === "string" && value.url.trim()) return value.url;
    if (typeof value.ref === "string" && value.ref.trim()) return value.ref;
  }

  addBlocker(blockers, {
    platform,
    check: checkName,
    code: `${codePrefix}_EVIDENCE_INVALID`,
    message: `${platform} ${checkName} evidence must be a string, or an object with path, text, url, or ref.`,
    owner,
  });
  return null;
}

function validateStatusCheck(root, blockers, passed, { platform, entry, checkName, codePrefix }) {
  const owner = entry.owner ?? "release-ops";
  const check = entry[checkName];
  if (!isObject(check)) {
    addBlocker(blockers, {
      platform,
      check: checkName,
      code: `${codePrefix}_MISSING`,
      message: `${platform} ${checkName} check is required.`,
      owner,
    });
    return;
  }

  if (check.status !== "passed") {
    addBlocker(blockers, {
      platform,
      check: checkName,
      code: `${codePrefix}_NOT_PASSED`,
      message: `${platform} ${checkName} status must be "passed"; got "${check.status ?? "missing"}".`,
      source: evidenceSource(root, evidenceValue(check)),
      owner,
      nextCommand: `Fix ${platform} ${checkName} and rerun the native signing gate.`,
    });
    return;
  }

  const source = validateEvidenceReference(root, blockers, { platform, checkName, codePrefix, check, owner });
  addPass(passed, {
    platform,
    check: checkName,
    message: `${platform} ${checkName} evidence passed.`,
    source,
  });
}

function requireText(blockers, { platform, check, code, entry, field, label }) {
  const value = entry[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    addBlocker(blockers, {
      platform,
      check,
      code,
      message: `${label} is required.`,
      owner: entry.owner ?? "release-ops",
    });
    return null;
  }
  return value;
}

function validateMacos(root, entry, blockers, passed) {
  if (!isObject(entry)) {
    addBlocker(blockers, {
      platform: "macos",
      check: "platform",
      code: "MACOS_EVIDENCE_MISSING",
      message: "macOS signing evidence is required.",
    });
    return;
  }

  const owner = entry.owner ?? "release-ops";
  const artifact = requireText(blockers, {
    platform: "macos",
    check: "artifact",
    code: "MACOS_ARTIFACT_MISSING",
    entry,
    field: "artifact",
    label: "macOS artifact path",
  });
  if (artifact) {
    checkPathExists(root, blockers, {
      platform: "macos",
      check: "artifact",
      code: "MACOS_ARTIFACT_FILE_MISSING",
      value: artifact,
      label: "macOS artifact",
      owner,
    });
  }

  requireText(blockers, {
    platform: "macos",
    check: "developerIdApplication",
    code: "MACOS_DEVELOPER_ID_MISSING",
    entry,
    field: "developerIdApplication",
    label: "Developer ID Application identity",
  });
  requireText(blockers, {
    platform: "macos",
    check: "appleTeamId",
    code: "MACOS_TEAM_ID_MISSING",
    entry,
    field: "appleTeamId",
    label: "Apple Team ID",
  });

  for (const [checkName, codePrefix] of MACOS_CHECKS) {
    validateStatusCheck(root, blockers, passed, { platform: "macos", entry, checkName, codePrefix });
  }

  if (isObject(entry.notarization) && entry.notarization.status === "passed") {
    requireText(blockers, {
      platform: "macos",
      check: "notarization",
      code: "MACOS_NOTARIZATION_SUBMISSION_MISSING",
      entry: entry.notarization,
      field: "submissionId",
      label: "Notarization submission ID",
    });
  }
}

function validateWindows(root, entry, blockers, passed) {
  if (!isObject(entry)) {
    addBlocker(blockers, {
      platform: "windows",
      check: "platform",
      code: "WINDOWS_EVIDENCE_MISSING",
      message: "Windows signing evidence is required.",
    });
    return;
  }

  const owner = entry.owner ?? "release-ops";
  const artifact = requireText(blockers, {
    platform: "windows",
    check: "artifact",
    code: "WINDOWS_ARTIFACT_MISSING",
    entry,
    field: "artifact",
    label: "Windows artifact path",
  });
  if (artifact) {
    checkPathExists(root, blockers, {
      platform: "windows",
      check: "artifact",
      code: "WINDOWS_ARTIFACT_FILE_MISSING",
      value: artifact,
      label: "Windows artifact",
      owner,
    });
  }

  const installerFormat = requireText(blockers, {
    platform: "windows",
    check: "installerFormat",
    code: "WINDOWS_INSTALLER_FORMAT_MISSING",
    entry,
    field: "installerFormat",
    label: "Windows installer format",
  });
  if (installerFormat && !WINDOWS_INSTALLER_FORMATS.has(installerFormat)) {
    addBlocker(blockers, {
      platform: "windows",
      check: "installerFormat",
      code: "WINDOWS_INSTALLER_FORMAT_UNSUPPORTED",
      message: `Unsupported Windows installer format: ${installerFormat}`,
      owner,
    });
  }

  const trustPath = requireText(blockers, {
    platform: "windows",
    check: "trustPath",
    code: "WINDOWS_TRUST_PATH_MISSING",
    entry,
    field: "trustPath",
    label: "Windows trust path",
  });
  if (trustPath && !WINDOWS_TRUST_PATHS.has(trustPath)) {
    addBlocker(blockers, {
      platform: "windows",
      check: "trustPath",
      code: "WINDOWS_TRUST_PATH_UNSUPPORTED",
      message: `Unsupported Windows trust path: ${trustPath}`,
      owner,
    });
  }

  requireText(blockers, {
    platform: "windows",
    check: "certificateSource",
    code: "WINDOWS_CERTIFICATE_SOURCE_MISSING",
    entry,
    field: "certificateSource",
    label: "Windows certificate source",
  });

  for (const [checkName, codePrefix] of WINDOWS_CHECKS) {
    validateStatusCheck(root, blockers, passed, { platform: "windows", entry, checkName, codePrefix });
  }

  if (isObject(entry.timestamping) && entry.timestamping.status === "passed") {
    if (typeof entry.timestamping.tsa !== "string" && typeof entry.timestamping.timestampUrl !== "string") {
      addBlocker(blockers, {
        platform: "windows",
        check: "timestamping",
        code: "WINDOWS_TIMESTAMP_TSA_MISSING",
        message: "Windows timestamping evidence must include tsa or timestampUrl.",
        owner,
      });
    }
  }
}

function scanSecrets(value, blockers, keyPath = []) {
  if (typeof value === "string") {
    for (const { code, pattern } of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        addBlocker(blockers, {
          platform: "all",
          check: "secret-hygiene",
          code,
          message: `Potential raw secret found at ${keyPath.join(".") || "manifest"}. Use a secret reference instead.`,
          source: keyPath.join(".") || null,
          owner: "release-ops",
        });
      }
    }
    const joined = keyPath.join(".");
    if (SENSITIVE_KEY_PATTERN.test(joined) && value.trim() && !SAFE_SECRET_REFERENCE.test(value.trim())) {
      addBlocker(blockers, {
        platform: "all",
        check: "secret-hygiene",
        code: "SECRET_REFERENCE_REQUIRED",
        message: `Sensitive field ${joined} must contain a secret reference, not a raw value.`,
        source: joined,
        owner: "release-ops",
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

function buildReport(summary) {
  const lines = [
    "# RT2 Native Signing Gate",
    "",
    `Status: ${summary.status}`,
    `Generated: ${summary.generatedAt}`,
    `Manifest: \`${summary.manifestPath}\``,
    `Run directory: \`${summary.runDir}\``,
    "",
    "| Blockers | Passed Checks |",
    "|----------|---------------|",
    `| ${summary.counts.blockers} | ${summary.counts.passed} |`,
    "",
    "## Blockers",
    "",
  ];

  if (summary.blockers.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Code | Platform | Check | Source | Message | Next |");
    lines.push("|------|----------|-------|--------|---------|------|");
    for (const blocker of summary.blockers) {
      lines.push(
        `| ${blocker.code} | ${blocker.platform} | ${blocker.check} | ${blocker.source ?? ""} | ${blocker.message.replace(/\|/g, "\\|")} | ${(blocker.nextCommand ?? "").replace(/\|/g, "\\|")} |`,
      );
    }
  }

  lines.push("", "## Passed Checks", "");
  if (summary.passed.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Code | Platform | Check | Source |");
    lines.push("|------|----------|-------|--------|");
    for (const item of summary.passed) {
      lines.push(`| ${item.code} | ${item.platform} | ${item.check} | ${item.source ?? ""} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function writeSummary(summary) {
  ensureDir(summary.runDirAbs);
  fs.writeFileSync(path.join(summary.runDirAbs, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(summary.runDirAbs, "report.md"), buildReport(summary), "utf8");
}

function evaluateNativeSigningManifest({ root = process.cwd(), manifest }) {
  const blockers = [];
  const passed = [];
  scanSecrets(manifest, blockers);
  const platforms = normalizePlatforms(manifest);
  validateMacos(root, platforms.macos, blockers, passed);
  validateWindows(root, platforms.windows, blockers, passed);
  return { blockers, passed, platforms: { macos: Boolean(platforms.macos), windows: Boolean(platforms.windows) } };
}

function runNativeSigningGate(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  if (!options.manifestPath) throw new Error("--manifest is required");
  const manifestPathAbs = path.resolve(options.manifestPath);
  const manifest = readJson(manifestPathAbs);
  const outputParentAbs = path.resolve(
    path.isAbsolute(options.outputDir ?? "")
      ? options.outputDir
      : path.join(root, options.outputDir ?? ".planning/native-signing-runs"),
  );
  const runDirAbs = path.join(outputParentAbs, timestampForPath(options.now ?? new Date()));
  const runDir = repoPath(root, runDirAbs);
  const result = evaluateNativeSigningManifest({ root, manifest });
  const summary = {
    version: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    status: result.blockers.length > 0 ? "blocker" : "passed",
    root,
    manifestPath: repoPath(root, manifestPathAbs),
    runDir,
    runDirAbs,
    counts: {
      blockers: result.blockers.length,
      passed: result.passed.length,
    },
    platforms: result.platforms,
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
    const summary = runNativeSigningGate({
      root: args.root,
      manifestPath: args.manifestPath,
      outputDir: args.outputDir,
    });
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log("# RT2 Native Signing Gate");
      console.log("");
      console.log(`Status: ${summary.status}`);
      console.log(`Summary: ${path.join(summary.runDir, "summary.json").split(path.sep).join("/")}`);
      console.log(`Report: ${path.join(summary.runDir, "report.md").split(path.sep).join("/")}`);
      console.log(`Blockers: ${summary.counts.blockers}`);
    }
    process.exit(summary.status === "passed" ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("rt2-native-signing-gate.mjs")) {
  main();
}

export {
  buildReport,
  evaluateNativeSigningManifest,
  normalizePlatforms,
  parseArgs,
  runNativeSigningGate,
};
