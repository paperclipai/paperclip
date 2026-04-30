#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const REQUIRED_CHANNELS = ["internal", "beta", "stable"];
const CHANNEL_NAME_SET = new Set(REQUIRED_CHANNELS);
const REQUIRED_RESIDENT_PLATFORMS = ["macos", "windows"];
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
const TRAY_CAPTURE_STATES = new Set(["available", "disabled", "blocked"]);
const SHORTCUT_REGISTRATION_STATES = new Set([
  "registered",
  "unregistered",
  "conflict",
  "permission_required",
  "unsupported",
  "failed",
]);
const SHORTCUT_CONFLICT_STATES = new Set(["none", "detected", "unknown"]);
const SHORTCUT_PERMISSION_STATES = new Set(["granted", "required", "denied", "unknown"]);
const FOCUS_BEHAVIORS = new Set(["open_capture", "focus_existing_capture", "open_or_focus_capture"]);
const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const EXPECTED_CAPTURE_ROUTE = "/companies/:companyId/rt2/one-liner/inbound-draft";

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
  console.log(`Usage: node scripts/rt2-resident-surface-gate.mjs --manifest <path> [options]

Options:
  --root <path>          Repository root for resolving relative evidence paths
  --output-dir <path>    Evidence parent directory (default: .planning/native-resident-runs)
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

function addBlocker(blockers, { area = null, platform = null, check, code, message, source = null, owner = "native-ux", nextCommand = null }) {
  blockers.push({
    category: "blocker",
    area,
    platform,
    check,
    code,
    message,
    source,
    owner,
    nextCommand,
  });
}

function addPass(passed, { area = null, platform = null, check, message, source = null }) {
  const parts = [area, platform, check].filter(Boolean).join("_").toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
  passed.push({
    category: "passed",
    area,
    platform,
    check,
    code: `${parts}_PASSED`,
    message,
    source,
  });
}

function requireText(blockers, { entry, field, check, code, label, area = null, platform = null }) {
  const value = entry?.[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    addBlocker(blockers, {
      area,
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
      area: "installed",
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
    area: "installed",
  });
  if (channel && !CHANNEL_NAME_SET.has(channel)) {
    addBlocker(blockers, {
      area: "installed",
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
    area: "installed",
  });
  if (version && !validSemver(version)) {
    addBlocker(blockers, {
      area: "installed",
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
    area: "installed",
  });

  addPass(passed, {
    area: "installed",
    check: "installed",
    message: "Installed channel/build identity is present.",
  });
}

function validateUpdateState(manifest, blockers, passed) {
  const updateState = manifest.updateState;
  if (!isObject(updateState)) {
    addBlocker(blockers, {
      area: "update",
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
    area: "update",
  });
  if (state && !UPDATE_STATES.has(state)) {
    addBlocker(blockers, {
      area: "update",
      check: "updateState.state",
      code: "UPDATE_STATE_INVALID",
      message: `Update state must be one of ${[...UPDATE_STATES].join(", ")}.`,
    });
  }
  if (state === "failed" && (typeof updateState.failureReason !== "string" || !updateState.failureReason.trim())) {
    addBlocker(blockers, {
      area: "update",
      check: "updateState.failureReason",
      code: "UPDATE_FAILURE_REASON_MISSING",
      message: "Failed update state must include failureReason.",
    });
  }

  addPass(passed, {
    area: "update",
    check: "updateState",
    message: "Update lifecycle state is present.",
  });
}

function validateSupportedPlatform(area, platforms, platform, blockers, passed) {
  const entry = platforms?.[platform];
  if (!isObject(entry)) {
    addBlocker(blockers, {
      area,
      platform,
      check: `${area}.platforms.${platform}`,
      code: `${area.toUpperCase()}_PLATFORM_EVIDENCE_MISSING`,
      message: `${platform} evidence is required.`,
    });
    return;
  }

  if (entry.supported !== true) {
    addBlocker(blockers, {
      area,
      platform,
      check: `${area}.platforms.${platform}.supported`,
      code: `${area.toUpperCase()}_PLATFORM_UNSUPPORTED`,
      message: `${platform} must be marked supported for the resident surface gate.`,
    });
  }

  requireText(blockers, {
    entry,
    field: "evidence",
    check: `${area}.platforms.${platform}.evidence`,
    code: `${area.toUpperCase()}_PLATFORM_EVIDENCE_MISSING`,
    label: `${platform} ${area} evidence`,
    area,
    platform,
  });

  addPass(passed, {
    area,
    platform,
    check: "platform",
    message: `${platform} ${area} evidence is present.`,
  });
}

function validateTray(manifest, blockers, passed) {
  const tray = manifest.tray;
  if (!isObject(tray)) {
    addBlocker(blockers, {
      area: "tray",
      check: "tray",
      code: "TRAY_STATUS_MISSING",
      message: "Tray/menu bar status contract is required.",
    });
    return;
  }

  const quickCapture = tray.quickCapture;
  if (!isObject(quickCapture)) {
    addBlocker(blockers, {
      area: "tray",
      check: "tray.quickCapture",
      code: "TRAY_QUICK_CAPTURE_MISSING",
      message: "Tray quick capture status is required.",
    });
  } else {
    const state = requireText(blockers, {
      entry: quickCapture,
      field: "state",
      check: "tray.quickCapture.state",
      code: "TRAY_QUICK_CAPTURE_STATE_MISSING",
      label: "Tray quick capture state",
      area: "tray",
    });
    if (state && !TRAY_CAPTURE_STATES.has(state)) {
      addBlocker(blockers, {
        area: "tray",
        check: "tray.quickCapture.state",
        code: "TRAY_QUICK_CAPTURE_STATE_INVALID",
        message: `Tray quick capture state must be one of ${[...TRAY_CAPTURE_STATES].join(", ")}.`,
      });
    }
    if (state && state !== "available") {
      addBlocker(blockers, {
        area: "tray",
        check: "tray.quickCapture.state",
        code: "TRAY_QUICK_CAPTURE_BLOCKED",
        message: "Tray quick capture must be available before native resident release.",
      });
    }
    if (quickCapture.entrypoint !== "native:tray") {
      addBlocker(blockers, {
        area: "tray",
        check: "tray.quickCapture.entrypoint",
        code: "TRAY_QUICK_CAPTURE_ENTRYPOINT_INVALID",
        message: "Tray quick capture entrypoint must be native:tray.",
      });
    }
    addPass(passed, {
      area: "tray",
      check: "quickCapture",
      message: "Tray quick capture status is present.",
    });
  }

  const queue = tray.queue;
  if (!isObject(queue)) {
    addBlocker(blockers, {
      area: "tray",
      check: "tray.queue",
      code: "TRAY_QUEUE_STATE_MISSING",
      message: "Tray queue/sync state is required.",
    });
  } else {
    requireText(blockers, {
      entry: queue,
      field: "state",
      check: "tray.queue.state",
      code: "TRAY_QUEUE_STATE_MISSING",
      label: "Tray queue state",
      area: "tray",
    });
    for (const field of ["pending", "failed"]) {
      const value = queue[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        addBlocker(blockers, {
          area: "tray",
          check: `tray.queue.${field}`,
          code: "TRAY_QUEUE_COUNT_INVALID",
          message: `Tray queue ${field} count must be a non-negative number.`,
        });
      }
    }
    addPass(passed, {
      area: "tray",
      check: "queue",
      message: "Tray queue/sync state is present.",
    });
  }

  const auth = tray.auth;
  if (!isObject(auth) || typeof auth.state !== "string" || !auth.state.trim()) {
    addBlocker(blockers, {
      area: "tray",
      check: "tray.auth.state",
      code: "TRAY_AUTH_STATE_MISSING",
      message: "Tray auth state is required.",
    });
  } else {
    addPass(passed, {
      area: "tray",
      check: "auth",
      message: "Tray auth state is present.",
    });
  }

  const company = tray.company;
  if (!isObject(company) || typeof company.state !== "string" || !company.state.trim()) {
    addBlocker(blockers, {
      area: "tray",
      check: "tray.company.state",
      code: "TRAY_COMPANY_STATE_MISSING",
      message: "Tray company state is required.",
    });
  } else {
    addPass(passed, {
      area: "tray",
      check: "company",
      message: "Tray company state is present.",
    });
  }

  const installed = isObject(manifest.installed) ? manifest.installed : {};
  const releaseChannel = requireText(blockers, {
    entry: tray,
    field: "releaseChannel",
    check: "tray.releaseChannel",
    code: "TRAY_RELEASE_CHANNEL_MISSING",
    label: "Tray release channel",
    area: "tray",
  });
  if (releaseChannel && installed.channel && releaseChannel !== installed.channel) {
    addBlocker(blockers, {
      area: "tray",
      check: "tray.releaseChannel",
      code: "TRAY_RELEASE_CHANNEL_MISMATCH",
      message: "Tray release channel must match installed.channel.",
    });
  }

  const buildIdentity = requireText(blockers, {
    entry: tray,
    field: "buildIdentity",
    check: "tray.buildIdentity",
    code: "TRAY_BUILD_IDENTITY_MISSING",
    label: "Tray build identity",
    area: "tray",
  });
  if (buildIdentity && installed.buildId && buildIdentity !== installed.buildId) {
    addBlocker(blockers, {
      area: "tray",
      check: "tray.buildIdentity",
      code: "TRAY_BUILD_IDENTITY_MISMATCH",
      message: "Tray build identity must match installed.buildId.",
    });
  }

  const trayUpdateState = requireText(blockers, {
    entry: tray,
    field: "updateState",
    check: "tray.updateState",
    code: "TRAY_UPDATE_STATE_MISSING",
    label: "Tray update state",
    area: "tray",
  });
  const manifestUpdateState = manifest.updateState?.state;
  if (trayUpdateState && manifestUpdateState && trayUpdateState !== manifestUpdateState) {
    addBlocker(blockers, {
      area: "tray",
      check: "tray.updateState",
      code: "TRAY_UPDATE_STATE_MISMATCH",
      message: "Tray update state must match updateState.state.",
    });
  }
  if (trayUpdateState === "failed" && (typeof tray.failureReason !== "string" || !tray.failureReason.trim())) {
    addBlocker(blockers, {
      area: "tray",
      check: "tray.failureReason",
      code: "TRAY_UPDATE_FAILURE_REASON_MISSING",
      message: "Tray status must expose failureReason when update state is failed.",
    });
  }

  requireText(blockers, {
    entry: tray,
    field: "statusLabel",
    check: "tray.statusLabel",
    code: "TRAY_STATUS_LABEL_MISSING",
    label: "Tray status label",
    area: "tray",
  });

  for (const platform of REQUIRED_RESIDENT_PLATFORMS) {
    validateSupportedPlatform("tray", tray.platforms, platform, blockers, passed);
  }

  addPass(passed, {
    area: "tray",
    check: "status",
    message: "Tray status exposes quick capture, queue, auth, company, build, channel, and update state.",
  });
}

function requireLifecycleReason(blockers, entry, field, state, code, label) {
  if (state !== "registered" && state !== "none" && state !== "granted") {
    if (typeof entry?.[field] !== "string" || !entry[field].trim()) {
      addBlocker(blockers, {
        area: "shortcut",
        check: `shortcut.${label}.reason`,
        code,
        message: `${label} reason is required when state is ${state}.`,
      });
    }
  }
}

function validateShortcut(manifest, blockers, passed) {
  const shortcut = manifest.shortcut;
  if (!isObject(shortcut)) {
    addBlocker(blockers, {
      area: "shortcut",
      check: "shortcut",
      code: "SHORTCUT_STATE_MISSING",
      message: "Global shortcut state contract is required.",
    });
    return;
  }

  requireText(blockers, {
    entry: shortcut,
    field: "accelerator",
    check: "shortcut.accelerator",
    code: "SHORTCUT_ACCELERATOR_MISSING",
    label: "Shortcut accelerator",
    area: "shortcut",
  });

  const registration = shortcut.registration;
  if (!isObject(registration)) {
    addBlocker(blockers, {
      area: "shortcut",
      check: "shortcut.registration",
      code: "SHORTCUT_REGISTRATION_MISSING",
      message: "Shortcut registration state is required.",
    });
  } else {
    const state = requireText(blockers, {
      entry: registration,
      field: "state",
      check: "shortcut.registration.state",
      code: "SHORTCUT_REGISTRATION_STATE_MISSING",
      label: "Shortcut registration state",
      area: "shortcut",
    });
    if (state && !SHORTCUT_REGISTRATION_STATES.has(state)) {
      addBlocker(blockers, {
        area: "shortcut",
        check: "shortcut.registration.state",
        code: "SHORTCUT_REGISTRATION_STATE_INVALID",
        message: `Shortcut registration state must be one of ${[...SHORTCUT_REGISTRATION_STATES].join(", ")}.`,
      });
    }
    if (state && state !== "registered") {
      addBlocker(blockers, {
        area: "shortcut",
        check: "shortcut.registration.state",
        code: "SHORTCUT_REGISTRATION_BLOCKED",
        message: "Global shortcut must be registered before native resident release.",
      });
      requireLifecycleReason(blockers, registration, "reason", state, "SHORTCUT_REGISTRATION_REASON_MISSING", "registration");
    }
    addPass(passed, {
      area: "shortcut",
      check: "registration",
      message: "Shortcut registration state is present.",
    });
  }

  const conflict = shortcut.conflict;
  if (!isObject(conflict)) {
    addBlocker(blockers, {
      area: "shortcut",
      check: "shortcut.conflict",
      code: "SHORTCUT_CONFLICT_STATE_MISSING",
      message: "Shortcut conflict state is required.",
    });
  } else {
    const state = requireText(blockers, {
      entry: conflict,
      field: "state",
      check: "shortcut.conflict.state",
      code: "SHORTCUT_CONFLICT_STATE_MISSING",
      label: "Shortcut conflict state",
      area: "shortcut",
    });
    if (state && !SHORTCUT_CONFLICT_STATES.has(state)) {
      addBlocker(blockers, {
        area: "shortcut",
        check: "shortcut.conflict.state",
        code: "SHORTCUT_CONFLICT_STATE_INVALID",
        message: `Shortcut conflict state must be one of ${[...SHORTCUT_CONFLICT_STATES].join(", ")}.`,
      });
    }
    if (state && state !== "none") {
      addBlocker(blockers, {
        area: "shortcut",
        check: "shortcut.conflict.state",
        code: "SHORTCUT_CONFLICT_BLOCKED",
        message: "Shortcut conflict state must be none before native resident release.",
      });
      requireLifecycleReason(blockers, conflict, "reason", state, "SHORTCUT_CONFLICT_REASON_MISSING", "conflict");
    }
    addPass(passed, {
      area: "shortcut",
      check: "conflict",
      message: "Shortcut conflict state is present.",
    });
  }

  const permission = shortcut.permission;
  if (!isObject(permission)) {
    addBlocker(blockers, {
      area: "shortcut",
      check: "shortcut.permission",
      code: "SHORTCUT_PERMISSION_STATE_MISSING",
      message: "Shortcut permission state is required.",
    });
  } else {
    const state = requireText(blockers, {
      entry: permission,
      field: "state",
      check: "shortcut.permission.state",
      code: "SHORTCUT_PERMISSION_STATE_MISSING",
      label: "Shortcut permission state",
      area: "shortcut",
    });
    if (state && !SHORTCUT_PERMISSION_STATES.has(state)) {
      addBlocker(blockers, {
        area: "shortcut",
        check: "shortcut.permission.state",
        code: "SHORTCUT_PERMISSION_STATE_INVALID",
        message: `Shortcut permission state must be one of ${[...SHORTCUT_PERMISSION_STATES].join(", ")}.`,
      });
    }
    if (state && state !== "granted") {
      addBlocker(blockers, {
        area: "shortcut",
        check: "shortcut.permission.state",
        code: "SHORTCUT_PERMISSION_BLOCKED",
        message: "Shortcut permission state must be granted before native resident release.",
      });
      requireLifecycleReason(blockers, permission, "reason", state, "SHORTCUT_PERMISSION_REASON_MISSING", "permission");
    }
    addPass(passed, {
      area: "shortcut",
      check: "permission",
      message: "Shortcut permission state is present.",
    });
  }

  const focus = shortcut.focus;
  if (!isObject(focus)) {
    addBlocker(blockers, {
      area: "shortcut",
      check: "shortcut.focus",
      code: "SHORTCUT_FOCUS_BEHAVIOR_MISSING",
      message: "Shortcut focus behavior is required.",
    });
  } else {
    const behavior = requireText(blockers, {
      entry: focus,
      field: "behavior",
      check: "shortcut.focus.behavior",
      code: "SHORTCUT_FOCUS_BEHAVIOR_MISSING",
      label: "Shortcut focus behavior",
      area: "shortcut",
    });
    if (behavior && !FOCUS_BEHAVIORS.has(behavior)) {
      addBlocker(blockers, {
        area: "shortcut",
        check: "shortcut.focus.behavior",
        code: "SHORTCUT_FOCUS_BEHAVIOR_INVALID",
        message: `Shortcut focus behavior must be one of ${[...FOCUS_BEHAVIORS].join(", ")}.`,
      });
    }
    addPass(passed, {
      area: "shortcut",
      check: "focus",
      message: "Shortcut focus behavior is present.",
    });
  }

  validateShortcutPrivacy(shortcut.privacy, blockers, passed);
  validateShortcutAction(shortcut.unregister, blockers, passed, "unregister", "SHORTCUT_UNREGISTER_MISSING");
  validateShortcutAction(shortcut.change, blockers, passed, "change", "SHORTCUT_CHANGE_MISSING");

  for (const platform of REQUIRED_RESIDENT_PLATFORMS) {
    validateSupportedPlatform("shortcut", shortcut.platforms, platform, blockers, passed);
  }
}

function validateShortcutPrivacy(privacy, blockers, passed) {
  if (!isObject(privacy)) {
    addBlocker(blockers, {
      area: "shortcut",
      check: "shortcut.privacy",
      code: "SHORTCUT_PRIVACY_MISSING",
      message: "Shortcut privacy contract is required.",
    });
    return;
  }

  if (privacy.explicitInputOnly !== true) {
    addBlocker(blockers, {
      area: "shortcut",
      check: "shortcut.privacy.explicitInputOnly",
      code: "SHORTCUT_PRIVACY_EXPLICIT_INPUT_REQUIRED",
      message: "Shortcut capture must be explicit-input-only.",
    });
  }

  for (const field of ["readsClipboard", "readsSelectedText", "readsScreen", "readsWindowTitle", "readsForegroundApp"]) {
    if (privacy[field] === true) {
      addBlocker(blockers, {
        area: "shortcut",
        check: `shortcut.privacy.${field}`,
        code: "SHORTCUT_PRIVACY_UNSAFE",
        message: `Shortcut capture must not read ${field} implicitly.`,
      });
    }
  }

  addPass(passed, {
    area: "shortcut",
    check: "privacy",
    message: "Shortcut privacy contract avoids implicit clipboard, selection, screen, and foreground app reads.",
  });
}

function validateShortcutAction(action, blockers, passed, name, missingCode) {
  if (!isObject(action)) {
    addBlocker(blockers, {
      area: "shortcut",
      check: `shortcut.${name}`,
      code: missingCode,
      message: `Shortcut ${name} evidence is required.`,
    });
    return;
  }

  if (action.supported !== true) {
    addBlocker(blockers, {
      area: "shortcut",
      check: `shortcut.${name}.supported`,
      code: `SHORTCUT_${name.toUpperCase()}_UNSUPPORTED`,
      message: `Shortcut ${name} must be supported.`,
    });
  }

  requireText(blockers, {
    entry: action,
    field: "evidence",
    check: `shortcut.${name}.evidence`,
    code: `SHORTCUT_${name.toUpperCase()}_EVIDENCE_MISSING`,
    label: `Shortcut ${name} evidence`,
    area: "shortcut",
  });

  addPass(passed, {
    area: "shortcut",
    check: name,
    message: `Shortcut ${name} evidence is present.`,
  });
}

function validateCaptureHandoff(manifest, blockers, passed) {
  const handoff = manifest.captureHandoff;
  if (!isObject(handoff)) {
    addBlocker(blockers, {
      area: "captureHandoff",
      check: "captureHandoff",
      code: "CAPTURE_HANDOFF_MISSING",
      message: "Native capture handoff contract is required.",
    });
    return;
  }

  if (handoff.source !== "native") {
    addBlocker(blockers, {
      area: "captureHandoff",
      check: "captureHandoff.source",
      code: "CAPTURE_HANDOFF_SOURCE_INVALID",
      message: "Capture handoff source must be native.",
    });
  }

  const channels = Array.isArray(handoff.channels) ? handoff.channels : [];
  for (const channel of ["native:tray", "native:global-shortcut"]) {
    if (!channels.includes(channel)) {
      addBlocker(blockers, {
        area: "captureHandoff",
        check: "captureHandoff.channels",
        code: "CAPTURE_HANDOFF_CHANNEL_MISSING",
        message: `Capture handoff channel ${channel} is required.`,
      });
    }
  }

  if (handoff.route !== EXPECTED_CAPTURE_ROUTE) {
    addBlocker(blockers, {
      area: "captureHandoff",
      check: "captureHandoff.route",
      code: "CAPTURE_HANDOFF_ROUTE_INVALID",
      message: `Capture handoff route must be ${EXPECTED_CAPTURE_ROUTE}.`,
    });
  }

  if (handoff.createsPersistentDraft !== true) {
    addBlocker(blockers, {
      area: "captureHandoff",
      check: "captureHandoff.createsPersistentDraft",
      code: "CAPTURE_HANDOFF_DRAFT_REQUIRED",
      message: "Native capture handoff must create a persistent draft.",
    });
  }

  if (handoff.requiresReview !== true || handoff.autoApply !== false || handoff.autoPromote !== false) {
    addBlocker(blockers, {
      area: "captureHandoff",
      check: "captureHandoff.review",
      code: "CAPTURE_HANDOFF_REVIEW_BYPASS",
      message: "Native capture handoff must require review and must not auto-apply or auto-promote.",
    });
  }

  const fields = Array.isArray(handoff.eventFields) ? handoff.eventFields : [];
  for (const field of ["eventId", "eventTimestamp", "externalUserId"]) {
    if (!fields.includes(field)) {
      addBlocker(blockers, {
        area: "captureHandoff",
        check: "captureHandoff.eventFields",
        code: "CAPTURE_HANDOFF_EVENT_FIELD_MISSING",
        message: `Capture handoff event field ${field} is required.`,
      });
    }
  }

  addPass(passed, {
    area: "captureHandoff",
    check: "review",
    message: "Native capture handoff targets reviewed persistent drafts only.",
  });
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

function evaluateResidentSurfaceManifest({ root = process.cwd(), manifest }) {
  const blockers = [];
  const passed = [];
  scanSecrets(manifest, blockers);
  if (!isObject(manifest)) {
    addBlocker(blockers, {
      check: "manifest",
      code: "MANIFEST_INVALID",
      message: "Resident surface manifest must be a JSON object.",
    });
    return { blockers, passed };
  }
  validateInstalled(manifest, blockers, passed);
  validateUpdateState(manifest, blockers, passed);
  validateTray(manifest, blockers, passed);
  validateShortcut(manifest, blockers, passed);
  validateCaptureHandoff(manifest, blockers, passed);
  return { blockers, passed, root };
}

function buildReport(summary) {
  const lines = [
    "# RT2 Resident Surface Gate",
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
    "## Tray Status",
    "",
    `- Quick capture: ${summary.tray?.quickCapture?.state ?? "missing"}`,
    `- Queue/sync: ${summary.tray?.queue?.state ?? "missing"}`,
    `- Auth: ${summary.tray?.auth?.state ?? "missing"}`,
    `- Company: ${summary.tray?.company?.state ?? "missing"}`,
    `- Release channel: ${summary.tray?.releaseChannel ?? "missing"}`,
    `- Build identity: ${summary.tray?.buildIdentity ?? "missing"}`,
    `- Update state: ${summary.tray?.updateState ?? "missing"}`,
    `- Failure reason: ${summary.tray?.failureReason ?? ""}`,
    "",
    "## Shortcut State",
    "",
    `- Accelerator: ${summary.shortcut?.accelerator ?? "missing"}`,
    `- Registration: ${summary.shortcut?.registration?.state ?? "missing"}`,
    `- Conflict: ${summary.shortcut?.conflict?.state ?? "missing"}`,
    `- Permission: ${summary.shortcut?.permission?.state ?? "missing"}`,
    `- Focus behavior: ${summary.shortcut?.focus?.behavior ?? "missing"}`,
    "",
    "## Capture Handoff",
    "",
    `- Source: ${summary.captureHandoff?.source ?? "missing"}`,
    `- Channels: ${(summary.captureHandoff?.channels ?? []).join(", ") || "missing"}`,
    `- Route: ${summary.captureHandoff?.route ?? "missing"}`,
    `- Requires review: ${summary.captureHandoff?.requiresReview === true ? "true" : "false"}`,
    `- Auto apply: ${summary.captureHandoff?.autoApply === true ? "true" : "false"}`,
    `- Auto promote: ${summary.captureHandoff?.autoPromote === true ? "true" : "false"}`,
    "",
    "## Blockers",
    "",
  ];

  if (summary.blockers.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Code | Area | Platform | Check | Source | Message | Next |");
    lines.push("|------|------|----------|-------|--------|---------|------|");
    for (const blocker of summary.blockers) {
      lines.push(
        `| ${blocker.code} | ${blocker.area ?? ""} | ${blocker.platform ?? ""} | ${blocker.check} | ${blocker.source ?? ""} | ${blocker.message.replace(/\|/g, "\\|")} | ${(blocker.nextCommand ?? "").replace(/\|/g, "\\|")} |`,
      );
    }
  }

  lines.push("", "## Passed Checks", "");
  if (summary.passed.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Code | Area | Platform | Check | Source |");
    lines.push("|------|------|----------|-------|--------|");
    for (const item of summary.passed) {
      lines.push(`| ${item.code} | ${item.area ?? ""} | ${item.platform ?? ""} | ${item.check} | ${item.source ?? ""} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function writeSummary(summary) {
  ensureDir(summary.runDirAbs);
  fs.writeFileSync(path.join(summary.runDirAbs, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(summary.runDirAbs, "report.md"), buildReport(summary), "utf8");
}

function runResidentSurfaceGate(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  if (!options.manifestPath) throw new Error("--manifest is required");
  const manifestPathAbs = path.resolve(options.manifestPath);
  const manifest = readJson(manifestPathAbs);
  const outputParentAbs = path.resolve(
    path.isAbsolute(options.outputDir ?? "")
      ? options.outputDir
      : path.join(root, options.outputDir ?? ".planning/native-resident-runs"),
  );
  const runDirAbs = path.join(outputParentAbs, timestampForPath(options.now ?? new Date()));
  const result = evaluateResidentSurfaceManifest({ root, manifest });
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
    tray: isObject(manifest.tray) ? manifest.tray : null,
    shortcut: isObject(manifest.shortcut) ? manifest.shortcut : null,
    captureHandoff: isObject(manifest.captureHandoff) ? manifest.captureHandoff : null,
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
    const summary = runResidentSurfaceGate({
      root: args.root,
      manifestPath: args.manifestPath,
      outputDir: args.outputDir,
    });
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log("# RT2 Resident Surface Gate");
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

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("rt2-resident-surface-gate.mjs")) {
  main();
}

export {
  buildReport,
  evaluateResidentSurfaceManifest,
  parseArgs,
  runResidentSurfaceGate,
};
