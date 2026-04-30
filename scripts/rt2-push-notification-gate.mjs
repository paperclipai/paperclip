#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const PROVIDERS = new Set(["web_push", "apns"]);
const PLATFORMS = new Set(["pwa", "web", "ios", "ipados", "macos", "android"]);
const REGISTRATION_STATES = new Set(["active", "revoked", "rotated", "invalid", "permission_denied", "expired", "failed"]);
const PERMISSION_STATES = new Set(["granted", "prompt", "denied", "unknown"]);
const SIGNAL_TYPES = new Set(["approval_waiting", "failed_sync", "review_requested"]);
const DELIVERY_STATUSES = new Set(["queued", "sending", "sent", "delivered", "failed", "retry_scheduled", "abandoned", "clicked"]);
const FAILURE_STATUSES = new Set(["failed", "abandoned"]);
const RETRY_REQUIRED_STATUSES = new Set(["failed", "retry_scheduled"]);
const TOKEN_INVALID_PATTERN = /\b(?:TOKEN_INVALID|INVALID_TOKEN|UNREGISTERED|NOT_REGISTERED|410|GONE)\b/i;
const ALLOWED_ROUTE_PATTERNS = [/\/rt2\/capture-drafts(?:\/|\?|$)/, /\/rt2\/work-board(?:\/|\?|$)/, /\/rt2\/review(?:\/|\?|$)/];

const SECRET_VALUE_PATTERNS = [
  { code: "SECRET_PRIVATE_KEY_DETECTED", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "SECRET_AWS_KEY_DETECTED", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "SECRET_GITHUB_TOKEN_DETECTED", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/ },
  { code: "SECRET_VAPID_KEY_DETECTED", pattern: /\bVAPID_PRIVATE_KEY\s*=\s*(?!<secret-ref>)[^\s`]+/i },
  { code: "SECRET_APNS_KEY_DETECTED", pattern: /\bAPNS(?:_AUTH)?_KEY\s*=\s*(?!<secret-ref>)[^\s`]+/i },
  { code: "SECRET_PASSWORD_DETECTED", pattern: /\b(?:PASSWORD|TOKEN|PRIVATE_KEY)\s*=\s*(?!<secret-ref>)[^\s`]+/ },
];

const SENSITIVE_KEY_PATTERN = /(?:password|privatekey|private_key|privatekeymaterial|clientsecret|client_secret|deviceToken|vapidPrivateKey|apnsAuthKey|authKey|rawToken|secret|token)$/i;
const SAFE_SECRET_REFERENCE = /^(secret-ref:|env:|github-secret:|azure-key-vault:|keychain:|ci-secret:|<secret-ref>)/i;
const SENSITIVE_PAYLOAD_KEY_PATTERN = /(?:rawText|rawContent|draftText|description|taskDescription|deliverableContent|customerData|privateNote|secret|token|password|privateKey|content)$/i;

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
  console.log(`Usage: node scripts/rt2-push-notification-gate.mjs --manifest <path> [options]

Options:
  --root <path>          Repository root for resolving relative evidence paths
  --output-dir <path>    Evidence parent directory (default: .planning/native-push-runs)
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
  provider = null,
  registrationId = null,
  signalId = null,
  deliveryId = null,
  clickId = null,
  check,
  code,
  message,
  source = null,
  owner = "native-push",
  nextCommand = null,
}) {
  blockers.push({
    category: "blocker",
    area,
    provider,
    registrationId,
    signalId,
    deliveryId,
    clickId,
    check,
    code,
    message,
    source,
    owner,
    nextCommand,
  });
}

function addPass(passed, {
  area = null,
  provider = null,
  registrationId = null,
  signalId = null,
  deliveryId = null,
  clickId = null,
  check,
  message,
  source = null,
}) {
  const parts = [area, provider, registrationId, signalId, deliveryId, clickId, check]
    .filter(Boolean)
    .join("_")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_");
  passed.push({
    category: "passed",
    area,
    provider,
    registrationId,
    signalId,
    deliveryId,
    clickId,
    check,
    code: `${parts}_PASSED`,
    message,
    source,
  });
}

function requireText(blockers, {
  entry,
  field,
  check,
  code,
  label,
  area = null,
  provider = null,
  registrationId = null,
  signalId = null,
  deliveryId = null,
  clickId = null,
}) {
  const value = entry?.[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    addBlocker(blockers, {
      area,
      provider,
      registrationId,
      signalId,
      deliveryId,
      clickId,
      check,
      code,
      message: `${label} is required.`,
    });
    return null;
  }
  return value;
}

function requireEvidence(blockers, {
  entry,
  field = "evidence",
  check,
  code,
  label,
  area = null,
  provider = null,
  registrationId = null,
  signalId = null,
  deliveryId = null,
  clickId = null,
}) {
  const value = entry?.[field];
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0) ||
    (isObject(value) && Object.keys(value).length === 0)
  ) {
    addBlocker(blockers, {
      area,
      provider,
      registrationId,
      signalId,
      deliveryId,
      clickId,
      check,
      code,
      message: `${label} evidence is required.`,
    });
    return false;
  }
  return true;
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

function routeAllowed(route) {
  return typeof route === "string" && ALLOWED_ROUTE_PATTERNS.some((pattern) => pattern.test(route));
}

function routeMatchesExpected(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  if (actual === expected) return true;
  const actualWithoutQuery = actual.split("?")[0];
  const expectedWithoutQuery = expected.split("?")[0];
  return actualWithoutQuery === expectedWithoutQuery;
}

function validateRegistrations(manifest, blockers, passed) {
  const registrations = Array.isArray(manifest.registrations) ? manifest.registrations : null;
  if (!registrations || registrations.length === 0) {
    addBlocker(blockers, {
      area: "registrations",
      check: "registrations",
      code: "PUSH_REGISTRATIONS_MISSING",
      message: "At least one push registration is required.",
    });
    return new Map();
  }

  const byId = new Map();
  for (const registration of registrations) {
    const id = requireText(blockers, {
      entry: registration,
      field: "id",
      check: "registration.id",
      code: "PUSH_REGISTRATION_ID_MISSING",
      label: "Registration ID",
      area: "registrations",
    });
    const registrationId = id ?? null;
    if (id) byId.set(id, registration);

    requireText(blockers, {
      entry: registration,
      field: "companyId",
      check: "registration.companyId",
      code: "PUSH_REGISTRATION_COMPANY_MISSING",
      label: "Registration company ID",
      area: "registrations",
      registrationId,
    });
    if (
      (typeof registration?.userId !== "string" || !registration.userId.trim()) &&
      (typeof registration?.externalUserId !== "string" || !registration.externalUserId.trim())
    ) {
      addBlocker(blockers, {
        area: "registrations",
        registrationId,
        check: "registration.user",
        code: "PUSH_REGISTRATION_USER_MISSING",
        message: "Registration userId or externalUserId is required.",
      });
    }
    requireText(blockers, {
      entry: registration,
      field: "deviceId",
      check: "registration.deviceId",
      code: "PUSH_REGISTRATION_DEVICE_MISSING",
      label: "Registration device ID",
      area: "registrations",
      registrationId,
    });

    const provider = requireText(blockers, {
      entry: registration,
      field: "provider",
      check: "registration.provider",
      code: "PUSH_REGISTRATION_PROVIDER_MISSING",
      label: "Registration provider",
      area: "registrations",
      registrationId,
    });
    if (provider && !PROVIDERS.has(provider)) {
      addBlocker(blockers, {
        area: "registrations",
        provider,
        registrationId,
        check: "registration.provider",
        code: "PUSH_REGISTRATION_PROVIDER_INVALID",
        message: `Registration provider must be one of ${[...PROVIDERS].join(", ")}.`,
      });
    }

    const platform = requireText(blockers, {
      entry: registration,
      field: "platform",
      check: "registration.platform",
      code: "PUSH_REGISTRATION_PLATFORM_MISSING",
      label: "Registration platform",
      area: "registrations",
      provider,
      registrationId,
    });
    if (platform && !PLATFORMS.has(platform)) {
      addBlocker(blockers, {
        area: "registrations",
        provider,
        registrationId,
        check: "registration.platform",
        code: "PUSH_REGISTRATION_PLATFORM_INVALID",
        message: `Registration platform must be one of ${[...PLATFORMS].join(", ")}.`,
      });
    }

    const state = requireText(blockers, {
      entry: registration,
      field: "registrationState",
      check: "registration.registrationState",
      code: "PUSH_REGISTRATION_STATE_MISSING",
      label: "Registration state",
      area: "registrations",
      provider,
      registrationId,
    });
    if (state && !REGISTRATION_STATES.has(state)) {
      addBlocker(blockers, {
        area: "registrations",
        provider,
        registrationId,
        check: "registration.registrationState",
        code: "PUSH_REGISTRATION_STATE_INVALID",
        message: `Registration state must be one of ${[...REGISTRATION_STATES].join(", ")}.`,
      });
    }
    if (state && state !== "active") {
      addBlocker(blockers, {
        area: "registrations",
        provider,
        registrationId,
        check: "registration.registrationState",
        code: "PUSH_REGISTRATION_NOT_ACTIVE",
        message: "Registration must be active to receive push notifications.",
      });
      if (typeof registration.reason !== "string" || !registration.reason.trim()) {
        addBlocker(blockers, {
          area: "registrations",
          provider,
          registrationId,
          check: "registration.reason",
          code: "PUSH_REGISTRATION_REASON_MISSING",
          message: "Inactive, revoked, invalid, or permission-denied registrations require a reason.",
        });
      }
    }

    if (state === "active" && provider === "web_push") {
      requireText(blockers, {
        entry: registration,
        field: "endpointHash",
        check: "registration.endpointHash",
        code: "PUSH_WEB_ENDPOINT_HASH_MISSING",
        label: "Web Push endpoint hash",
        area: "registrations",
        provider,
        registrationId,
      });
      requireText(blockers, {
        entry: registration,
        field: "endpointHost",
        check: "registration.endpointHost",
        code: "PUSH_WEB_ENDPOINT_HOST_MISSING",
        label: "Web Push endpoint host",
        area: "registrations",
        provider,
        registrationId,
      });
    }
    if (state === "active" && provider === "apns") {
      requireText(blockers, {
        entry: registration,
        field: "tokenHash",
        check: "registration.tokenHash",
        code: "PUSH_APNS_TOKEN_HASH_MISSING",
        label: "APNs token hash",
        area: "registrations",
        provider,
        registrationId,
      });
      requireText(blockers, {
        entry: registration,
        field: "topic",
        check: "registration.topic",
        code: "PUSH_APNS_TOPIC_MISSING",
        label: "APNs topic",
        area: "registrations",
        provider,
        registrationId,
      });
    }

    const permission = registration?.permission;
    if (!isObject(permission)) {
      addBlocker(blockers, {
        area: "registrations",
        provider,
        registrationId,
        check: "registration.permission",
        code: "PUSH_PERMISSION_STATE_MISSING",
        message: "Permission state evidence is required.",
      });
    } else {
      const permissionState = requireText(blockers, {
        entry: permission,
        field: "state",
        check: "registration.permission.state",
        code: "PUSH_PERMISSION_STATE_MISSING",
        label: "Permission state",
        area: "registrations",
        provider,
        registrationId,
      });
      if (permissionState && !PERMISSION_STATES.has(permissionState)) {
        addBlocker(blockers, {
          area: "registrations",
          provider,
          registrationId,
          check: "registration.permission.state",
          code: "PUSH_PERMISSION_STATE_INVALID",
          message: `Permission state must be one of ${[...PERMISSION_STATES].join(", ")}.`,
        });
      }
      if (permissionState === "denied") {
        requireEvidence(blockers, {
          entry: permission,
          check: "registration.permission.evidence",
          code: "PUSH_PERMISSION_DENIED_EVIDENCE_MISSING",
          label: "Permission denied",
          area: "registrations",
          provider,
          registrationId,
        });
      }
    }

    addPass(passed, {
      area: "registrations",
      provider,
      registrationId,
      check: "registration",
      message: "Push registration identity and lifecycle fields are present.",
    });
  }

  return byId;
}

function validatePayload(signal, blockers, signalId) {
  const payload = signal?.payload;
  if (!isObject(payload)) {
    addBlocker(blockers, {
      area: "signals",
      signalId,
      check: "signal.payload",
      code: "PUSH_PAYLOAD_MISSING",
      message: "Minimal push payload is required.",
    });
    return;
  }

  const requiredFields = ["signalType", "companyId", "targetType", "targetId", "route", "eventId", "eventTimestamp"];
  for (const field of requiredFields) {
    if (typeof payload[field] !== "string" || !payload[field].trim()) {
      addBlocker(blockers, {
        area: "signals",
        signalId,
        check: `signal.payload.${field}`,
        code: "PUSH_PAYLOAD_FIELD_MISSING",
        message: `Payload field ${field} is required.`,
      });
    }
  }

  function scanPayload(value, keyPath = []) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => scanPayload(item, [...keyPath, String(index)]));
      return;
    }
    if (!isObject(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      const joined = [...keyPath, key].join(".");
      if (SENSITIVE_PAYLOAD_KEY_PATTERN.test(key)) {
        addBlocker(blockers, {
          area: "signals",
          signalId,
          check: "signal.payload.privacy",
          code: "PUSH_PAYLOAD_SENSITIVE_FIELD",
          message: `Push payload must stay minimal and cannot include sensitive field ${joined}.`,
          source: joined,
          owner: "privacy",
        });
      }
      scanPayload(nested, [...keyPath, key]);
    }
  }
  scanPayload(payload);
}

function validateSignals(manifest, blockers, passed) {
  const signals = Array.isArray(manifest.signals) ? manifest.signals : null;
  if (!signals || signals.length === 0) {
    addBlocker(blockers, {
      area: "signals",
      check: "signals",
      code: "PUSH_SIGNALS_MISSING",
      message: "At least one push signal is required.",
    });
    return new Map();
  }

  const byId = new Map();
  for (const signal of signals) {
    const id = requireText(blockers, {
      entry: signal,
      field: "id",
      check: "signal.id",
      code: "PUSH_SIGNAL_ID_MISSING",
      label: "Signal ID",
      area: "signals",
    });
    const signalId = id ?? null;
    if (id) byId.set(id, signal);

    const type = requireText(blockers, {
      entry: signal,
      field: "type",
      check: "signal.type",
      code: "PUSH_SIGNAL_TYPE_MISSING",
      label: "Signal type",
      area: "signals",
      signalId,
    });
    if (type && !SIGNAL_TYPES.has(type)) {
      addBlocker(blockers, {
        area: "signals",
        signalId,
        check: "signal.type",
        code: "PUSH_SIGNAL_TYPE_INVALID",
        message: `Signal type must be one of ${[...SIGNAL_TYPES].join(", ")}.`,
      });
    }
    requireText(blockers, {
      entry: signal,
      field: "companyId",
      check: "signal.companyId",
      code: "PUSH_SIGNAL_COMPANY_MISSING",
      label: "Signal company ID",
      area: "signals",
      signalId,
    });
    requireText(blockers, {
      entry: signal,
      field: "eventId",
      check: "signal.eventId",
      code: "PUSH_SIGNAL_EVENT_ID_MISSING",
      label: "Signal event ID",
      area: "signals",
      signalId,
    });
    requireText(blockers, {
      entry: signal,
      field: "eventTimestamp",
      check: "signal.eventTimestamp",
      code: "PUSH_SIGNAL_EVENT_TIMESTAMP_MISSING",
      label: "Signal event timestamp",
      area: "signals",
      signalId,
    });

    const target = signal?.target;
    if (!isObject(target)) {
      addBlocker(blockers, {
        area: "signals",
        signalId,
        check: "signal.target",
        code: "PUSH_TARGET_MISSING",
        message: "Signal target is required.",
      });
    } else {
      requireText(blockers, {
        entry: target,
        field: "type",
        check: "signal.target.type",
        code: "PUSH_TARGET_TYPE_MISSING",
        label: "Signal target type",
        area: "signals",
        signalId,
      });
      requireText(blockers, {
        entry: target,
        field: "id",
        check: "signal.target.id",
        code: "PUSH_TARGET_ID_MISSING",
        label: "Signal target ID",
        area: "signals",
        signalId,
      });
      const route = requireText(blockers, {
        entry: target,
        field: "route",
        check: "signal.target.route",
        code: "PUSH_TARGET_ROUTE_MISSING",
        label: "Signal target route",
        area: "signals",
        signalId,
      });
      if (route && !routeAllowed(route)) {
        addBlocker(blockers, {
          area: "signals",
          signalId,
          check: "signal.target.route",
          code: "PUSH_TARGET_ROUTE_INVALID",
          message: "Signal target route must deep-link to capture draft, work board, or review target.",
          source: route,
        });
      }
    }

    validatePayload(signal, blockers, signalId);
    if (isObject(signal?.payload) && isObject(target) && typeof signal.payload.route === "string" && typeof target.route === "string" && !routeMatchesExpected(signal.payload.route, target.route)) {
      addBlocker(blockers, {
        area: "signals",
        signalId,
        check: "signal.payload.route",
        code: "PUSH_PAYLOAD_ROUTE_MISMATCH",
        message: "Payload route must match the target route.",
      });
    }
    if (isObject(signal?.payload) && type && signal.payload.signalType !== type) {
      addBlocker(blockers, {
        area: "signals",
        signalId,
        check: "signal.payload.signalType",
        code: "PUSH_PAYLOAD_SIGNAL_TYPE_MISMATCH",
        message: "Payload signalType must match signal.type.",
      });
    }

    addPass(passed, {
      area: "signals",
      signalId,
      check: "signal",
      message: "Push signal has minimal payload and a review route target.",
    });
  }

  return byId;
}

function validateDeliveries(manifest, registrationsById, signalsById, blockers, passed) {
  const deliveries = Array.isArray(manifest.deliveries) ? manifest.deliveries : null;
  if (!deliveries || deliveries.length === 0) {
    addBlocker(blockers, {
      area: "delivery",
      check: "deliveries",
      code: "PUSH_DELIVERIES_MISSING",
      message: "Delivery evidence is required.",
    });
    return new Map();
  }

  const byId = new Map();
  for (const delivery of deliveries) {
    const id = requireText(blockers, {
      entry: delivery,
      field: "id",
      check: "delivery.id",
      code: "PUSH_DELIVERY_ID_MISSING",
      label: "Delivery ID",
      area: "delivery",
    });
    const deliveryId = id ?? null;
    if (id) byId.set(id, delivery);

    const signalId = requireText(blockers, {
      entry: delivery,
      field: "signalId",
      check: "delivery.signalId",
      code: "PUSH_DELIVERY_SIGNAL_MISSING",
      label: "Delivery signal ID",
      area: "delivery",
      deliveryId,
    });
    if (signalId && !signalsById.has(signalId)) {
      addBlocker(blockers, {
        area: "delivery",
        signalId,
        deliveryId,
        check: "delivery.signalId",
        code: "PUSH_DELIVERY_SIGNAL_UNKNOWN",
        message: "Delivery signalId must reference an existing signal.",
      });
    }

    const registrationId = requireText(blockers, {
      entry: delivery,
      field: "registrationId",
      check: "delivery.registrationId",
      code: "PUSH_DELIVERY_REGISTRATION_MISSING",
      label: "Delivery registration ID",
      area: "delivery",
      signalId,
      deliveryId,
    });
    const registration = registrationId ? registrationsById.get(registrationId) : null;
    if (registrationId && !registration) {
      addBlocker(blockers, {
        area: "delivery",
        registrationId,
        signalId,
        deliveryId,
        check: "delivery.registrationId",
        code: "PUSH_DELIVERY_REGISTRATION_UNKNOWN",
        message: "Delivery registrationId must reference an existing registration.",
      });
    }

    const provider = requireText(blockers, {
      entry: delivery,
      field: "provider",
      check: "delivery.provider",
      code: "PUSH_DELIVERY_PROVIDER_MISSING",
      label: "Delivery provider",
      area: "delivery",
      registrationId,
      signalId,
      deliveryId,
    });
    if (provider && !PROVIDERS.has(provider)) {
      addBlocker(blockers, {
        area: "delivery",
        provider,
        registrationId,
        signalId,
        deliveryId,
        check: "delivery.provider",
        code: "PUSH_DELIVERY_PROVIDER_INVALID",
        message: `Delivery provider must be one of ${[...PROVIDERS].join(", ")}.`,
      });
    }
    if (provider && registration?.provider && provider !== registration.provider) {
      addBlocker(blockers, {
        area: "delivery",
        provider,
        registrationId,
        signalId,
        deliveryId,
        check: "delivery.provider",
        code: "PUSH_DELIVERY_PROVIDER_MISMATCH",
        message: "Delivery provider must match the referenced registration provider.",
      });
    }

    const status = requireText(blockers, {
      entry: delivery,
      field: "status",
      check: "delivery.status",
      code: "PUSH_DELIVERY_STATUS_MISSING",
      label: "Delivery status",
      area: "delivery",
      provider,
      registrationId,
      signalId,
      deliveryId,
    });
    if (status && !DELIVERY_STATUSES.has(status)) {
      addBlocker(blockers, {
        area: "delivery",
        provider,
        registrationId,
        signalId,
        deliveryId,
        check: "delivery.status",
        code: "PUSH_DELIVERY_STATUS_INVALID",
        message: `Delivery status must be one of ${[...DELIVERY_STATUSES].join(", ")}.`,
      });
    }

    if (!Number.isInteger(delivery?.attemptCount) || delivery.attemptCount < 1) {
      addBlocker(blockers, {
        area: "delivery",
        provider,
        registrationId,
        signalId,
        deliveryId,
        check: "delivery.attemptCount",
        code: "PUSH_DELIVERY_ATTEMPT_COUNT_MISSING",
        message: "Delivery attemptCount must be a positive integer.",
      });
    }
    requireText(blockers, {
      entry: delivery,
      field: "lastAttemptAt",
      check: "delivery.lastAttemptAt",
      code: "PUSH_DELIVERY_LAST_ATTEMPT_MISSING",
      label: "Delivery last attempt timestamp",
      area: "delivery",
      provider,
      registrationId,
      signalId,
      deliveryId,
    });
    requireEvidence(blockers, {
      entry: delivery,
      check: "delivery.evidence",
      code: "PUSH_DELIVERY_EVIDENCE_MISSING",
      label: "Delivery",
      area: "delivery",
      provider,
      registrationId,
      signalId,
      deliveryId,
    });

    if (status && FAILURE_STATUSES.has(status) && (typeof delivery.errorCode !== "string" || !delivery.errorCode.trim())) {
      addBlocker(blockers, {
        area: "delivery",
        provider,
        registrationId,
        signalId,
        deliveryId,
        check: "delivery.errorCode",
        code: "PUSH_DELIVERY_FAILURE_CODE_MISSING",
        message: "Failed or abandoned delivery must include a provider errorCode.",
      });
    }
    if (status && RETRY_REQUIRED_STATUSES.has(status)) {
      if (!isObject(delivery.retry) || typeof delivery.retry.decision !== "string" || !delivery.retry.decision.trim()) {
        addBlocker(blockers, {
          area: "delivery",
          provider,
          registrationId,
          signalId,
          deliveryId,
          check: "delivery.retry.decision",
          code: "PUSH_DELIVERY_RETRY_DECISION_MISSING",
          message: "Failed or retry-scheduled delivery must include a retry decision.",
        });
      }
    }
    if (
      typeof delivery.errorCode === "string" &&
      TOKEN_INVALID_PATTERN.test(delivery.errorCode) &&
      registration?.registrationState !== "invalid" &&
      registration?.registrationState !== "revoked" &&
      delivery?.invalidToken?.handled !== true &&
      delivery?.registrationRevoked !== true
    ) {
      addBlocker(blockers, {
        area: "delivery",
        provider,
        registrationId,
        signalId,
        deliveryId,
        check: "delivery.invalidToken",
        code: "PUSH_INVALID_TOKEN_NOT_REVOKED",
        message: "Invalid token evidence must revoke or invalidate the registration.",
      });
    }

    addPass(passed, {
      area: "delivery",
      provider,
      registrationId,
      signalId,
      deliveryId,
      check: "delivery",
      message: "Delivery evidence includes status, attempt, retry, and provider linkage.",
    });
  }

  return byId;
}

function validateClicks(manifest, deliveriesById, registrationsById, signalsById, blockers, passed) {
  const clicks = Array.isArray(manifest.clicks) ? manifest.clicks : null;
  if (!clicks || clicks.length === 0) {
    addBlocker(blockers, {
      area: "clicks",
      check: "clicks",
      code: "PUSH_CLICK_EVIDENCE_MISSING",
      message: "Click-through evidence is required.",
    });
    return;
  }

  for (const click of clicks) {
    const id = requireText(blockers, {
      entry: click,
      field: "id",
      check: "click.id",
      code: "PUSH_CLICK_ID_MISSING",
      label: "Click ID",
      area: "clicks",
    });
    const clickId = id ?? null;
    const deliveryId = requireText(blockers, {
      entry: click,
      field: "deliveryId",
      check: "click.deliveryId",
      code: "PUSH_CLICK_DELIVERY_MISSING",
      label: "Click delivery ID",
      area: "clicks",
      clickId,
    });
    const signalId = requireText(blockers, {
      entry: click,
      field: "signalId",
      check: "click.signalId",
      code: "PUSH_CLICK_SIGNAL_MISSING",
      label: "Click signal ID",
      area: "clicks",
      deliveryId,
      clickId,
    });
    const registrationId = requireText(blockers, {
      entry: click,
      field: "registrationId",
      check: "click.registrationId",
      code: "PUSH_CLICK_REGISTRATION_MISSING",
      label: "Click registration ID",
      area: "clicks",
      signalId,
      deliveryId,
      clickId,
    });
    requireText(blockers, {
      entry: click,
      field: "clickedAt",
      check: "click.clickedAt",
      code: "PUSH_CLICK_TIMESTAMP_MISSING",
      label: "Click timestamp",
      area: "clicks",
      registrationId,
      signalId,
      deliveryId,
      clickId,
    });
    const route = requireText(blockers, {
      entry: click,
      field: "route",
      check: "click.route",
      code: "PUSH_CLICK_ROUTE_MISSING",
      label: "Click route",
      area: "clicks",
      registrationId,
      signalId,
      deliveryId,
      clickId,
    });
    requireEvidence(blockers, {
      entry: click,
      check: "click.evidence",
      code: "PUSH_CLICK_EVIDENCE_MISSING",
      label: "Click-through",
      area: "clicks",
      registrationId,
      signalId,
      deliveryId,
      clickId,
    });

    if (deliveryId && !deliveriesById.has(deliveryId)) {
      addBlocker(blockers, {
        area: "clicks",
        registrationId,
        signalId,
        deliveryId,
        clickId,
        check: "click.deliveryId",
        code: "PUSH_CLICK_DELIVERY_UNKNOWN",
        message: "Click deliveryId must reference an existing delivery.",
      });
    }
    if (signalId && !signalsById.has(signalId)) {
      addBlocker(blockers, {
        area: "clicks",
        registrationId,
        signalId,
        deliveryId,
        clickId,
        check: "click.signalId",
        code: "PUSH_CLICK_SIGNAL_UNKNOWN",
        message: "Click signalId must reference an existing signal.",
      });
    }
    if (registrationId && !registrationsById.has(registrationId)) {
      addBlocker(blockers, {
        area: "clicks",
        registrationId,
        signalId,
        deliveryId,
        clickId,
        check: "click.registrationId",
        code: "PUSH_CLICK_REGISTRATION_UNKNOWN",
        message: "Click registrationId must reference an existing registration.",
      });
    }
    const signal = signalId ? signalsById.get(signalId) : null;
    if (route && signal?.target?.route && !routeMatchesExpected(route, signal.target.route)) {
      addBlocker(blockers, {
        area: "clicks",
        registrationId,
        signalId,
        deliveryId,
        clickId,
        check: "click.route",
        code: "PUSH_CLICK_ROUTE_MISMATCH",
        message: "Click route must match the target route from the original signal.",
        source: route,
      });
    }
    if (click?.reachedTarget !== true) {
      addBlocker(blockers, {
        area: "clicks",
        registrationId,
        signalId,
        deliveryId,
        clickId,
        check: "click.reachedTarget",
        code: "PUSH_CLICK_TARGET_NOT_REACHED",
        message: "Click-through evidence must confirm the target screen was reached.",
      });
    }

    addPass(passed, {
      area: "clicks",
      registrationId,
      signalId,
      deliveryId,
      clickId,
      check: "click",
      message: "Click-through evidence reaches the intended review target.",
    });
  }
}

function validateCaptureReliability(manifest, blockers, passed) {
  const reliability = manifest.captureReliability;
  if (!isObject(reliability)) {
    addBlocker(blockers, {
      area: "captureReliability",
      check: "captureReliability",
      code: "PUSH_CAPTURE_RELIABILITY_MISSING",
      message: "Capture reliability push metrics are required.",
    });
    return;
  }

  requireEvidence(blockers, {
    entry: reliability,
    field: "reportPath",
    check: "captureReliability.reportPath",
    code: "PUSH_CAPTURE_RELIABILITY_REPORT_MISSING",
    label: "Capture reliability report path",
    area: "captureReliability",
  });
  requireEvidence(blockers, {
    entry: reliability,
    check: "captureReliability.evidence",
    code: "PUSH_CAPTURE_RELIABILITY_EVIDENCE_MISSING",
    label: "Capture reliability",
    area: "captureReliability",
  });

  const metrics = reliability.metrics;
  if (!isObject(metrics)) {
    addBlocker(blockers, {
      area: "captureReliability",
      check: "captureReliability.metrics",
      code: "PUSH_CAPTURE_RELIABILITY_METRICS_MISSING",
      message: "Capture reliability metrics are required.",
    });
  } else {
    for (const metric of ["permissionDenied", "tokenInvalid", "deliveryFailures", "retryCount", "clickThroughCount"]) {
      if (typeof metrics[metric] !== "number" || metrics[metric] < 0) {
        addBlocker(blockers, {
          area: "captureReliability",
          check: `captureReliability.metrics.${metric}`,
          code: "PUSH_CAPTURE_RELIABILITY_METRIC_INVALID",
          message: `Capture reliability metric ${metric} must be a non-negative number.`,
        });
      }
    }
  }

  addPass(passed, {
    area: "captureReliability",
    check: "metrics",
    message: "Push delivery, retry, invalid token, permission, and click metrics are represented in capture reliability evidence.",
  });
}

function evaluatePushNotificationManifest({ root = process.cwd(), manifest }) {
  const blockers = [];
  const passed = [];
  scanSecrets(manifest, blockers);
  if (!isObject(manifest)) {
    addBlocker(blockers, {
      check: "manifest",
      code: "MANIFEST_INVALID",
      message: "Push notification manifest must be a JSON object.",
    });
    return { blockers, passed, root };
  }

  const registrationsById = validateRegistrations(manifest, blockers, passed);
  const signalsById = validateSignals(manifest, blockers, passed);
  const deliveriesById = validateDeliveries(manifest, registrationsById, signalsById, blockers, passed);
  validateClicks(manifest, deliveriesById, registrationsById, signalsById, blockers, passed);
  validateCaptureReliability(manifest, blockers, passed);
  return { blockers, passed, root };
}

function buildReport(summary) {
  const lines = [
    "# RT2 Push Notification Gate",
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
    "## Registrations",
    "",
    `- Count: ${summary.registrations.length}`,
    `- Providers: ${[...new Set(summary.registrations.map((item) => item.provider).filter(Boolean))].join(", ") || "missing"}`,
    `- Active: ${summary.registrations.filter((item) => item.registrationState === "active").length}`,
    "",
    "## Signals",
    "",
    `- Count: ${summary.signals.length}`,
    `- Types: ${[...new Set(summary.signals.map((item) => item.type).filter(Boolean))].join(", ") || "missing"}`,
    "",
    "## Delivery Evidence",
    "",
    `- Count: ${summary.deliveries.length}`,
    `- Statuses: ${[...new Set(summary.deliveries.map((item) => item.status).filter(Boolean))].join(", ") || "missing"}`,
    "",
    "## Click Evidence",
    "",
    `- Count: ${summary.clicks.length}`,
    `- Reached target: ${summary.clicks.filter((item) => item.reachedTarget === true).length}`,
    "",
    "## Capture Reliability",
    "",
    `- Report: ${summary.captureReliability?.reportPath ?? "missing"}`,
    `- Permission denied: ${summary.captureReliability?.metrics?.permissionDenied ?? "missing"}`,
    `- Invalid token: ${summary.captureReliability?.metrics?.tokenInvalid ?? "missing"}`,
    `- Delivery failures: ${summary.captureReliability?.metrics?.deliveryFailures ?? "missing"}`,
    `- Retries: ${summary.captureReliability?.metrics?.retryCount ?? "missing"}`,
    `- Click-through: ${summary.captureReliability?.metrics?.clickThroughCount ?? "missing"}`,
    "",
    "## Blockers",
    "",
  ];

  if (summary.blockers.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Code | Area | Provider | Registration | Signal | Delivery | Click | Check | Source | Message | Next |");
    lines.push("|------|------|----------|--------------|--------|----------|-------|-------|--------|---------|------|");
    for (const blocker of summary.blockers) {
      lines.push(
        `| ${blocker.code} | ${blocker.area ?? ""} | ${blocker.provider ?? ""} | ${blocker.registrationId ?? ""} | ${blocker.signalId ?? ""} | ${blocker.deliveryId ?? ""} | ${blocker.clickId ?? ""} | ${blocker.check} | ${blocker.source ?? ""} | ${blocker.message.replace(/\|/g, "\\|")} | ${(blocker.nextCommand ?? "").replace(/\|/g, "\\|")} |`,
      );
    }
  }

  lines.push("", "## Passed Checks", "");
  if (summary.passed.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Code | Area | Provider | Registration | Signal | Delivery | Click | Check | Source |");
    lines.push("|------|------|----------|--------------|--------|----------|-------|-------|--------|");
    for (const item of summary.passed) {
      lines.push(`| ${item.code} | ${item.area ?? ""} | ${item.provider ?? ""} | ${item.registrationId ?? ""} | ${item.signalId ?? ""} | ${item.deliveryId ?? ""} | ${item.clickId ?? ""} | ${item.check} | ${item.source ?? ""} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function writeSummary(summary) {
  ensureDir(summary.runDirAbs);
  fs.writeFileSync(path.join(summary.runDirAbs, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(summary.runDirAbs, "report.md"), buildReport(summary), "utf8");
}

function runPushNotificationGate(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  if (!options.manifestPath) throw new Error("--manifest is required");
  const manifestPathAbs = path.resolve(options.manifestPath);
  const manifest = readJson(manifestPathAbs);
  const outputParentAbs = path.resolve(
    path.isAbsolute(options.outputDir ?? "")
      ? options.outputDir
      : path.join(root, options.outputDir ?? ".planning/native-push-runs"),
  );
  const now = options.now ?? new Date();
  const runDirAbs = path.join(outputParentAbs, timestampForPath(now));
  const result = evaluatePushNotificationManifest({ root, manifest });
  const summary = {
    version: 1,
    generatedAt: now.toISOString(),
    status: result.blockers.length > 0 ? "blocker" : "passed",
    root,
    manifestPath: repoPath(root, manifestPathAbs),
    runDir: repoPath(root, runDirAbs),
    runDirAbs,
    counts: {
      blockers: result.blockers.length,
      passed: result.passed.length,
    },
    registrations: Array.isArray(manifest.registrations) ? manifest.registrations : [],
    signals: Array.isArray(manifest.signals) ? manifest.signals : [],
    deliveries: Array.isArray(manifest.deliveries) ? manifest.deliveries : [],
    clicks: Array.isArray(manifest.clicks) ? manifest.clicks : [],
    captureReliability: isObject(manifest.captureReliability) ? manifest.captureReliability : null,
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
    const summary = runPushNotificationGate({
      root: args.root,
      manifestPath: args.manifestPath,
      outputDir: args.outputDir,
    });
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log("# RT2 Push Notification Gate");
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

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("rt2-push-notification-gate.mjs")) {
  main();
}

export {
  buildReport,
  evaluatePushNotificationManifest,
  parseArgs,
  runPushNotificationGate,
};
