#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REQUIRED_CHANNELS = ["internal", "beta", "stable"];
const UPDATE_STATES = new Set([
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "installing",
  "relaunch_required",
  "failed",
  "rolled_back",
]);
const ROLLOUT_STRATEGIES = new Set(["all", "percentage", "paused"]);
const CHANNEL_NAME_SET = new Set(REQUIRED_CHANNELS);
const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const PLATFORM_PATTERN = /^(darwin|windows|linux)-(x86_64|aarch64|i686|armv7)$/;
const URL_PATTERN = /^https:\/\/[^\s]+$/i;

const SECRET_VALUE_PATTERNS = [
  { code: "SECRET_PRIVATE_KEY_DETECTED", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "SECRET_AWS_KEY_DETECTED", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "SECRET_GITHUB_TOKEN_DETECTED", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/ },
  { code: "SECRET_TAURI_KEY_DETECTED", pattern: /\bTAURI_SIGNING_PRIVATE_KEY\s*=\s*(?!<secret-ref>)[^\s`]+/ },
  { code: "SECRET_PASSWORD_DETECTED", pattern: /\b(?:PASSWORD|TOKEN|PRIVATE_KEY)\s*=\s*(?!<secret-ref>)[^\s`]+/ },
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
  console.log(`Usage: node scripts/rt2-release-channel-gate.mjs --manifest <path> [options]

Options:
  --root <path>          Repository root for resolving relative artifact/evidence paths
  --output-dir <path>    Evidence parent directory (default: .planning/native-updater-runs)
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

function isPathLike(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/^[a-z]+:\/\//i.test(value)) return false;
  if (SAFE_SECRET_REFERENCE.test(value)) return false;
  return /[\\/]/.test(value) || /\.(json|txt|log|md|zip|sig|gz|dmg|pkg|msix|msi|exe|appx|appxbundle|msixbundle)$/i.test(value);
}

function resolveMaybePath(root, value) {
  if (!isPathLike(value)) return null;
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function addBlocker(blockers, { channel = null, platform = null, check, code, message, source = null, owner = "release-ops", nextCommand = null }) {
  blockers.push({
    category: "blocker",
    channel,
    platform,
    check,
    code,
    message,
    source,
    owner,
    nextCommand,
  });
}

function addPass(passed, { channel = null, platform = null, check, message, source = null }) {
  const parts = [channel, platform, check].filter(Boolean).join("_").toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
  passed.push({
    category: "passed",
    channel,
    platform,
    check,
    code: `${parts}_PASSED`,
    message,
    source,
  });
}

function requireText(blockers, { entry, field, check, code, label, channel = null, platform = null }) {
  const value = entry?.[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    addBlocker(blockers, {
      channel,
      platform,
      check,
      code,
      message: `${label} is required.`,
    });
    return null;
  }
  return value;
}

function validSemver(value) {
  return typeof value === "string" && SEMVER_PATTERN.test(value.trim());
}

function validateInstalled(manifest, blockers, passed) {
  const installed = manifest.installed;
  if (!isObject(installed)) {
    addBlocker(blockers, {
      check: "installed",
      code: "INSTALLED_STATE_MISSING",
      message: "Installed channel/build identity is required.",
    });
    return;
  }

  const channel = requireText(blockers, {
    entry: installed,
    field: "channel",
    check: "installed.channel",
    code: "INSTALLED_CHANNEL_MISSING",
    label: "Installed channel",
  });
  if (channel && !CHANNEL_NAME_SET.has(channel)) {
    addBlocker(blockers, {
      channel,
      check: "installed.channel",
      code: "INSTALLED_CHANNEL_INVALID",
      message: `Installed channel must be one of ${REQUIRED_CHANNELS.join(", ")}.`,
    });
  }

  const version = requireText(blockers, {
    entry: installed,
    field: "version",
    check: "installed.version",
    code: "INSTALLED_VERSION_MISSING",
    label: "Installed version",
  });
  if (version && !validSemver(version)) {
    addBlocker(blockers, {
      channel,
      check: "installed.version",
      code: "INSTALLED_VERSION_INVALID",
      message: `Installed version must be SemVer-compatible: ${version}`,
    });
  }

  requireText(blockers, {
    entry: installed,
    field: "buildId",
    check: "installed.buildId",
    code: "INSTALLED_BUILD_ID_MISSING",
    label: "Installed build ID",
  });

  addPass(passed, {
    check: "installed",
    message: "Installed channel/build identity is present.",
  });
}

function validateUpdateState(manifest, blockers, passed) {
  const updateState = manifest.updateState;
  if (!isObject(updateState)) {
    addBlocker(blockers, {
      check: "updateState",
      code: "UPDATE_STATE_MISSING",
      message: "Update lifecycle state is required.",
    });
    return;
  }

  const state = requireText(blockers, {
    entry: updateState,
    field: "state",
    check: "updateState.state",
    code: "UPDATE_STATE_MISSING",
    label: "Update state",
  });
  if (state && !UPDATE_STATES.has(state)) {
    addBlocker(blockers, {
      check: "updateState.state",
      code: "UPDATE_STATE_INVALID",
      message: `Update state must be one of ${[...UPDATE_STATES].join(", ")}.`,
    });
  }
  if (state === "failed" && (typeof updateState.failureReason !== "string" || !updateState.failureReason.trim())) {
    addBlocker(blockers, {
      check: "updateState.failureReason",
      code: "UPDATE_FAILURE_REASON_MISSING",
      message: "Failed update state must include failureReason.",
    });
  }

  addPass(passed, {
    check: "updateState",
    message: "Update lifecycle state is present.",
  });
}

function validateRollout(channel, entry, blockers, passed) {
  const rollout = entry.rollout;
  if (!isObject(rollout)) {
    addBlocker(blockers, {
      channel,
      check: "rollout",
      code: "ROLLOUT_POLICY_MISSING",
      message: "Rollout policy is required.",
    });
    return;
  }

  const strategy = rollout.strategy;
  if (typeof strategy !== "string" || !ROLLOUT_STRATEGIES.has(strategy)) {
    addBlocker(blockers, {
      channel,
      check: "rollout.strategy",
      code: "ROLLOUT_POLICY_INVALID",
      message: `Rollout strategy must be one of ${[...ROLLOUT_STRATEGIES].join(", ")}.`,
    });
    return;
  }

  if (strategy === "percentage") {
    const percentage = rollout.percentage;
    if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      addBlocker(blockers, {
        channel,
        check: "rollout.percentage",
        code: "ROLLOUT_POLICY_INVALID",
        message: "Percentage rollout must include percentage between 0 and 100.",
      });
      return;
    }
  }

  addPass(passed, {
    channel,
    check: "rollout",
    message: `${channel} rollout policy is valid.`,
  });
}

function validateRollback(channel, entry, blockers, passed) {
  const rollback = entry.rollback ?? entry.rollbackCandidate;
  if (!isObject(rollback)) {
    addBlocker(blockers, {
      channel,
      check: "rollback",
      code: "ROLLBACK_CANDIDATE_MISSING",
      message: "Rollback candidate metadata is required.",
    });
    return;
  }

  const version = requireText(blockers, {
    entry: rollback,
    field: "version",
    check: "rollback.version",
    code: "ROLLBACK_VERSION_MISSING",
    label: "Rollback version",
    channel,
  });
  if (version && !validSemver(version)) {
    addBlocker(blockers, {
      channel,
      check: "rollback.version",
      code: "ROLLBACK_VERSION_INVALID",
      message: `Rollback version must be SemVer-compatible: ${version}`,
    });
  }
  requireText(blockers, {
    entry: rollback,
    field: "buildId",
    check: "rollback.buildId",
    code: "ROLLBACK_BUILD_ID_MISSING",
    label: "Rollback build ID",
    channel,
  });

  addPass(passed, {
    channel,
    check: "rollback",
    message: `${channel} rollback candidate is present.`,
  });
}

function inferSigningPlatform(platformKey) {
  const match = platformKey.match(PLATFORM_PATTERN);
  if (!match) return null;
  if (match[1] === "darwin") return "macos";
  if (match[1] === "windows") return "windows";
  return "linux";
}

function readSigningSummary(root, summaryPath, blockers, { channel, platform }) {
  if (typeof summaryPath !== "string" || !summaryPath.trim()) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "signingSummary",
      code: "SIGNING_GATE_SUMMARY_MISSING",
      message: "Phase 60 signing summary path is required.",
    });
    return null;
  }

  const resolved = path.isAbsolute(summaryPath) ? summaryPath : path.join(root, summaryPath);
  if (!fs.existsSync(resolved)) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "signingSummary",
      code: "SIGNING_GATE_SUMMARY_MISSING",
      message: `Phase 60 signing summary does not exist: ${summaryPath}`,
      source: summaryPath,
      nextCommand: "Run pnpm run rt2:native-signing-gate before publishing updater metadata.",
    });
    return null;
  }

  try {
    return readJson(resolved);
  } catch (error) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "signingSummary",
      code: "SIGNING_GATE_SUMMARY_INVALID",
      message: `Phase 60 signing summary is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      source: summaryPath,
    });
    return null;
  }
}

function validateSigningPrerequisite(root, channel, platform, entry, blockers, passed) {
  const expected = entry.signingPlatform ?? inferSigningPlatform(platform);
  if (!["macos", "windows"].includes(expected)) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "signingPlatform",
      code: "SIGNING_PLATFORM_UNSUPPORTED",
      message: `Unsupported signing platform for updater channel gate: ${expected ?? "missing"}`,
    });
    return;
  }

  const inferred = inferSigningPlatform(platform);
  if (inferred && expected !== inferred) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "signingPlatform",
      code: "SIGNING_PLATFORM_MISMATCH",
      message: `Signing platform ${expected} does not match target ${platform}.`,
    });
    return;
  }

  const summary = readSigningSummary(root, entry.signingSummary, blockers, { channel, platform });
  if (!summary) return;

  if (summary.status !== "passed") {
    addBlocker(blockers, {
      channel,
      platform,
      check: "signingSummary",
      code: "SIGNING_GATE_BLOCKED",
      message: `Phase 60 signing summary must be passed; got ${summary.status ?? "missing"}.`,
      source: entry.signingSummary,
      nextCommand: "Resolve native signing gate blockers before publishing updater metadata.",
    });
    return;
  }

  if (!isObject(summary.platforms) || summary.platforms[expected] !== true) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "signingSummary.platforms",
      code: "SIGNING_GATE_PLATFORM_MISSING",
      message: `Phase 60 signing summary does not include passed ${expected} evidence.`,
      source: entry.signingSummary,
    });
    return;
  }

  addPass(passed, {
    channel,
    platform,
    check: "signingSummary",
    message: `${channel} ${platform} signing prerequisite passed.`,
    source: entry.signingSummary,
  });
}

function validatePlatform(root, channel, platform, entry, blockers, passed) {
  if (!isObject(entry)) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "platform",
      code: "CHANNEL_PLATFORM_INVALID",
      message: "Platform metadata must be an object.",
    });
    return;
  }

  if (!PLATFORM_PATTERN.test(platform)) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "platform",
      code: "CHANNEL_PLATFORM_KEY_INVALID",
      message: `Platform key must use OS-ARCH format, got: ${platform}`,
    });
  }

  const url = requireText(blockers, {
    entry,
    field: "url",
    check: "platform.url",
    code: "CHANNEL_ARTIFACT_URL_MISSING",
    label: "Artifact URL",
    channel,
    platform,
  });
  if (url && !URL_PATTERN.test(url)) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "platform.url",
      code: "CHANNEL_ARTIFACT_URL_INVALID",
      message: "Artifact URL must be an HTTPS URL.",
      source: url,
    });
  }

  const checksum = requireText(blockers, {
    entry,
    field: "checksum",
    check: "platform.checksum",
    code: "CHANNEL_CHECKSUM_MISSING",
    label: "SHA-256 checksum",
    channel,
    platform,
  });
  if (checksum && !SHA256_PATTERN.test(checksum)) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "platform.checksum",
      code: "CHANNEL_CHECKSUM_INVALID",
      message: "Checksum must be a 64-character SHA-256 hex string.",
    });
  }

  const signature = requireText(blockers, {
    entry,
    field: "signature",
    check: "platform.signature",
    code: "UPDATER_SIGNATURE_MISSING",
    label: "Updater signature content",
    channel,
    platform,
  });
  if (signature && (/^[a-z]+:\/\//i.test(signature) || isPathLike(signature) || SAFE_SECRET_REFERENCE.test(signature))) {
    addBlocker(blockers, {
      channel,
      platform,
      check: "platform.signature",
      code: "UPDATER_SIGNATURE_INVALID",
      message: "Updater signature must be the generated .sig content, not a path, URL, or secret reference.",
      source: signature,
    });
  }

  if (typeof entry.artifact === "string" && entry.artifact.trim()) {
    const resolved = resolveMaybePath(root, entry.artifact) ?? path.join(root, entry.artifact);
    if (!fs.existsSync(resolved)) {
      addBlocker(blockers, {
        channel,
        platform,
        check: "platform.artifact",
        code: "CHANNEL_ARTIFACT_FILE_MISSING",
        message: `Local artifact file does not exist: ${entry.artifact}`,
        source: entry.artifact,
      });
    } else if (checksum && SHA256_PATTERN.test(checksum)) {
      const actual = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
      if (actual !== checksum.toLowerCase()) {
        addBlocker(blockers, {
          channel,
          platform,
          check: "platform.checksum",
          code: "CHANNEL_CHECKSUM_MISMATCH",
          message: `Local artifact checksum does not match manifest checksum for ${entry.artifact}.`,
          source: entry.artifact,
        });
      }
    }
  }

  validateSigningPrerequisite(root, channel, platform, entry, blockers, passed);

  addPass(passed, {
    channel,
    platform,
    check: "platform",
    message: `${channel} ${platform} updater metadata is present.`,
    source: url,
  });
}

function validateChannel(root, channel, entry, blockers, passed) {
  if (!isObject(entry)) {
    addBlocker(blockers, {
      channel,
      check: "channel",
      code: `CHANNEL_${channel.toUpperCase()}_MISSING`,
      message: `${channel} channel metadata is required.`,
    });
    return;
  }

  const version = requireText(blockers, {
    entry,
    field: "version",
    check: "channel.version",
    code: "CHANNEL_VERSION_MISSING",
    label: "Channel version",
    channel,
  });
  if (version && !validSemver(version)) {
    addBlocker(blockers, {
      channel,
      check: "channel.version",
      code: "CHANNEL_VERSION_INVALID",
      message: `Channel version must be SemVer-compatible: ${version}`,
    });
  }

  requireText(blockers, {
    entry,
    field: "buildId",
    check: "channel.buildId",
    code: "CHANNEL_BUILD_ID_MISSING",
    label: "Channel build ID",
    channel,
  });

  const hasNotes = typeof entry.notes === "string" && entry.notes.trim().length > 0;
  const hasNotesUrl = typeof entry.notesUrl === "string" && URL_PATTERN.test(entry.notesUrl);
  if (!hasNotes && !hasNotesUrl) {
    addBlocker(blockers, {
      channel,
      check: "channel.notes",
      code: "CHANNEL_NOTES_MISSING",
      message: "Channel notes or notesUrl is required.",
    });
  }

  validateRollout(channel, entry, blockers, passed);
  validateRollback(channel, entry, blockers, passed);

  if (!isObject(entry.platforms) || Object.keys(entry.platforms).length === 0) {
    addBlocker(blockers, {
      channel,
      check: "channel.platforms",
      code: "CHANNEL_PLATFORMS_MISSING",
      message: "At least one platform entry is required.",
    });
    return;
  }

  for (const [platform, platformEntry] of Object.entries(entry.platforms)) {
    validatePlatform(root, channel, platform, platformEntry, blockers, passed);
  }

  addPass(passed, {
    channel,
    check: "channel",
    message: `${channel} channel metadata is present.`,
  });
}

function validateChannels(root, manifest, blockers, passed) {
  if (!isObject(manifest.channels)) {
    addBlocker(blockers, {
      check: "channels",
      code: "CHANNELS_MISSING",
      message: "channels object is required.",
    });
    return;
  }

  for (const channel of REQUIRED_CHANNELS) {
    validateChannel(root, channel, manifest.channels[channel], blockers, passed);
  }
}

function scanSecrets(value, blockers, keyPath = []) {
  if (typeof value === "string") {
    for (const { code, pattern } of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        addBlocker(blockers, {
          check: "secret-hygiene",
          code,
          message: `Potential raw secret found at ${keyPath.join(".") || "manifest"}. Use a secret reference instead.`,
          source: keyPath.join(".") || null,
        });
      }
    }
    const joined = keyPath.join(".");
    if (SENSITIVE_KEY_PATTERN.test(joined) && value.trim() && !SAFE_SECRET_REFERENCE.test(value.trim())) {
      addBlocker(blockers, {
        check: "secret-hygiene",
        code: "SECRET_REFERENCE_REQUIRED",
        message: `Sensitive field ${joined} must contain a secret reference, not a raw value.`,
        source: joined,
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

function evaluateReleaseChannelManifest({ root = process.cwd(), manifest }) {
  const blockers = [];
  const passed = [];
  scanSecrets(manifest, blockers);
  if (!isObject(manifest)) {
    addBlocker(blockers, {
      check: "manifest",
      code: "MANIFEST_INVALID",
      message: "Release channel manifest must be a JSON object.",
    });
    return { blockers, passed };
  }
  validateInstalled(manifest, blockers, passed);
  validateUpdateState(manifest, blockers, passed);
  validateChannels(root, manifest, blockers, passed);
  return { blockers, passed };
}

function buildReport(summary) {
  const lines = [
    "# RT2 Release Channel Gate",
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
    "## Installed State",
    "",
    `- Channel: ${summary.installed?.channel ?? "missing"}`,
    `- Version: ${summary.installed?.version ?? "missing"}`,
    `- Build ID: ${summary.installed?.buildId ?? "missing"}`,
    "",
    "## Update State",
    "",
    `- State: ${summary.updateState?.state ?? "missing"}`,
    `- Latest channel: ${summary.updateState?.latestChannel ?? "missing"}`,
    `- Latest version: ${summary.updateState?.latestVersion ?? "missing"}`,
    `- Failure reason: ${summary.updateState?.failureReason ?? ""}`,
    "",
    "## Blockers",
    "",
  ];

  if (summary.blockers.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Code | Channel | Platform | Check | Source | Message | Next |");
    lines.push("|------|---------|----------|-------|--------|---------|------|");
    for (const blocker of summary.blockers) {
      lines.push(
        `| ${blocker.code} | ${blocker.channel ?? ""} | ${blocker.platform ?? ""} | ${blocker.check} | ${blocker.source ?? ""} | ${blocker.message.replace(/\|/g, "\\|")} | ${(blocker.nextCommand ?? "").replace(/\|/g, "\\|")} |`,
      );
    }
  }

  lines.push("", "## Passed Checks", "");
  if (summary.passed.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Code | Channel | Platform | Check | Source |");
    lines.push("|------|---------|----------|-------|--------|");
    for (const item of summary.passed) {
      lines.push(`| ${item.code} | ${item.channel ?? ""} | ${item.platform ?? ""} | ${item.check} | ${item.source ?? ""} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function writeSummary(summary) {
  ensureDir(summary.runDirAbs);
  fs.writeFileSync(path.join(summary.runDirAbs, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(summary.runDirAbs, "report.md"), buildReport(summary), "utf8");
}

function runReleaseChannelGate(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  if (!options.manifestPath) throw new Error("--manifest is required");
  const manifestPathAbs = path.resolve(options.manifestPath);
  const manifest = readJson(manifestPathAbs);
  const outputParentAbs = path.resolve(
    path.isAbsolute(options.outputDir ?? "")
      ? options.outputDir
      : path.join(root, options.outputDir ?? ".planning/native-updater-runs"),
  );
  const runDirAbs = path.join(outputParentAbs, timestampForPath(options.now ?? new Date()));
  const result = evaluateReleaseChannelManifest({ root, manifest });
  const summary = {
    version: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    status: result.blockers.length > 0 ? "blocker" : "passed",
    root,
    manifestPath: repoPath(root, manifestPathAbs),
    runDir: repoPath(root, runDirAbs),
    runDirAbs,
    counts: {
      blockers: result.blockers.length,
      passed: result.passed.length,
    },
    installed: isObject(manifest.installed) ? manifest.installed : null,
    updateState: isObject(manifest.updateState) ? manifest.updateState : null,
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
    const summary = runReleaseChannelGate({
      root: args.root,
      manifestPath: args.manifestPath,
      outputDir: args.outputDir,
    });
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log("# RT2 Release Channel Gate");
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

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("rt2-release-channel-gate.mjs")) {
  main();
}

export {
  buildReport,
  evaluateReleaseChannelManifest,
  parseArgs,
  runReleaseChannelGate,
};
