#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FINAL_STATUSES = new Set(["done", "cancelled"]);
const EXTERNAL_URL_RE = /^https?:\/\/(?!localhost(?::|\/|$)|127\.0\.0\.1(?::|\/|$)|0\.0\.0\.0(?::|\/|$))/i;
const VENDOR_ACTION_TYPES = new Set(["vendor_call", "llm_call", "model_completion", "external_tool_call"]);
const NETWORK_ACTION_TYPES = new Set(["http_request", "fetch", "curl", "api_request"]);
const SECRET_PATTERNS = [
  { name: "openai-style api key", re: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/ },
  { name: "anthropic api key", re: /\bsk-ant-[A-Za-z0-9_-]{12,}\b/ },
  { name: "github token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i },
  { name: "postgres url with credentials", re: /\bpostgres(?:ql)?:\/\/[^\s/@:]+:[^\s/@]+@/i },
];

function coercePath(input) {
  if (input instanceof URL) return fileURLToPath(input);
  if (typeof input !== "string") throw new TypeError(`Expected path or URL, got ${typeof input}`);
  if (input.startsWith("file://")) return fileURLToPath(input);
  return path.resolve(input);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function walkStrings(value, visitor, trail = []) {
  if (typeof value === "string") {
    visitor(value, trail);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, visitor, [...trail, String(index)]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      walkStrings(nested, visitor, [...trail, key]);
    }
  }
}

function collectActions(fixture) {
  const actions = [];
  if (Array.isArray(fixture?.actions)) actions.push(...fixture.actions);
  if (Array.isArray(fixture?.trace?.actions)) actions.push(...fixture.trace.actions);
  if (Array.isArray(fixture?.events)) actions.push(...fixture.events.filter((event) => event && typeof event === "object"));
  return actions;
}

export function countNetworkAndVendorCalls(fixture) {
  const actions = collectActions(fixture);
  let networkCalls = 0;
  let vendorCalls = 0;

  for (const action of actions) {
    const type = String(action?.type ?? "");
    const url = String(action?.url ?? action?.endpoint ?? "");
    if (NETWORK_ACTION_TYPES.has(type) || (url && EXTERNAL_URL_RE.test(url))) {
      networkCalls += 1;
    }
    if (VENDOR_ACTION_TYPES.has(type) || action?.vendor === true || action?.externalVendor === true) {
      vendorCalls += 1;
    }
  }

  return { networkCalls, vendorCalls };
}

function hasUsefulOutput(fixture) {
  const useful = fixture?.adapterRun?.usefulOutput ?? fixture?.usefulOutput ?? {};
  const comments = useful.comments ?? fixture?.comments ?? [];
  const artifacts = useful.artifacts ?? fixture?.artifacts ?? [];
  const validationEvidence = useful.validationEvidence ?? fixture?.issue?.validationEvidence ?? [];
  return [comments, artifacts, validationEvidence].some((items) => Array.isArray(items) && items.length > 0);
}

function hasValidationEvidence(fixture) {
  const issueEvidence = fixture?.issue?.validationEvidence;
  const usefulEvidence = fixture?.adapterRun?.usefulOutput?.validationEvidence;
  return [issueEvidence, usefulEvidence].some((items) => Array.isArray(items) && items.length > 0);
}

function recoveryChildren(fixture) {
  return Array.isArray(fixture?.recoveryChildren) ? fixture.recoveryChildren : [];
}

function blockers(fixture) {
  if (Array.isArray(fixture?.blockers)) return fixture.blockers;
  if (Array.isArray(fixture?.issue?.blockedBy)) return fixture.issue.blockedBy;
  return [];
}

function isFinalStatus(status) {
  return FINAL_STATUSES.has(String(status ?? ""));
}

function hasDuplicateRecovery(fixture) {
  const bySource = new Map();
  for (const child of recoveryChildren(fixture)) {
    const source = child.sourceIssueId ?? fixture?.issue?.id ?? "unknown-source";
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
  }
  return [...bySource.values()].some((count) => count > 1);
}

function activeRecoveryCount(fixture) {
  return recoveryChildren(fixture).filter((child) => !isFinalStatus(child.status)).length;
}

function hasStaleBlocker(fixture) {
  return blockers(fixture).some((blocker) => isFinalStatus(blocker.status) || blocker.stale === true);
}

function hasActiveCanonicalBlocker(fixture) {
  return blockers(fixture).some((blocker) => blocker.canonical === true && !isFinalStatus(blocker.status));
}

function hasReviewStageHang(fixture) {
  const issue = fixture?.issue ?? {};
  const review = fixture?.reviewStage ?? issue.reviewStage ?? {};
  const reviewerRun = fixture?.reviewerRun ?? review.reviewerRun ?? {};
  const minutes = Number(review.lastReviewerActivityMinutesAgo ?? reviewerRun.lastActivityMinutesAgo ?? 0);
  return (
    issue.status === "in_review" &&
    (review.status === "waiting" || review.status === "stalled") &&
    (reviewerRun.status === "failed" || reviewerRun.status === "lost" || reviewerRun.errorCode === "process_lost") &&
    minutes >= 30
  );
}

export function classifyFixture(fixture) {
  const { networkCalls, vendorCalls } = countNetworkAndVendorCalls(fixture);
  if (networkCalls > 0 || vendorCalls > 0) return "offline_only_violation";
  if (hasReviewStageHang(fixture)) return "review_stage_hang";
  if (fixture?.issue?.claimsCompletion === true && !hasValidationEvidence(fixture)) return "missing_validation_evidence";
  if (hasStaleBlocker(fixture)) return "stale_blocker_graph";
  if (hasDuplicateRecovery(fixture)) return "duplicate_recovery_child";
  if (fixture?.adapterRun?.status === "failed" && hasUsefulOutput(fixture)) return "useful_output_adapter_failed";
  return "unknown";
}

function pass(message = "passed") {
  return { passed: true, message };
}

function fail(message) {
  return { passed: false, message };
}

export const BUILT_IN_CHECKS = Object.freeze({
  redacted(fixture) {
    if (fixture?.redaction?.sanitized !== true) {
      return fail("fixture redaction.sanitized must be true");
    }
    const matches = [];
    walkStrings(fixture, (text, trail) => {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.re.test(text)) {
          matches.push(`${trail.join(".") || "<root>"}: ${pattern.name}`);
        }
      }
    });
    if (matches.length > 0) {
      return fail(`fixture contains secret-shaped content: ${matches.join(", ")}`);
    }
    return pass("fixture is marked sanitized and contains no obvious secret-shaped strings");
  },

  "offline-only"(fixture) {
    const { networkCalls, vendorCalls } = countNetworkAndVendorCalls(fixture);
    if (networkCalls > 0 || vendorCalls > 0) {
      return fail(`fixture attempted external network/vendor calls (network=${networkCalls}, vendor=${vendorCalls})`);
    }
    return pass("fixture uses local sanitized replay data only");
  },

  classification(fixture, context = {}) {
    const actual = classifyFixture(fixture);
    const expected = context.expectedClassification;
    if (!expected) return fail("classification check requires expected.classification");
    if (actual !== expected) return fail(`expected classification ${expected}, got ${actual}`);
    return pass(`classification matched ${expected}`);
  },

  "useful-output-preserved"(fixture) {
    if (fixture?.adapterRun?.status !== "failed") return fail("adapter run was not marked failed");
    if (!hasUsefulOutput(fixture)) return fail("failed adapter did not preserve useful comments/artifacts/validation evidence");
    return pass("failed adapter run includes durable useful output");
  },

  "duplicate-recovery-detected"(fixture) {
    if (!hasDuplicateRecovery(fixture)) return fail("duplicate recovery child pattern was not present");
    return pass("duplicate recovery child pattern detected");
  },

  "single-active-recovery"(fixture) {
    const active = activeRecoveryCount(fixture);
    if (active > 1) return fail(`expected at most one active recovery child, got ${active}`);
    return pass(`active recovery child count is ${active}`);
  },

  "stale-blocker-detected"(fixture) {
    if (!hasStaleBlocker(fixture)) return fail("stale/final blocker relation was not present");
    if (!hasActiveCanonicalBlocker(fixture)) return fail("stale blocker case lacks an active canonical replacement blocker");
    return pass("stale blocker and active canonical replacement detected");
  },

  "missing-validation-evidence-detected"(fixture) {
    if (fixture?.issue?.claimsCompletion !== true) return fail("issue does not claim completion");
    if (hasValidationEvidence(fixture)) return fail("fixture unexpectedly has validation evidence");
    return pass("completion claim with missing validation evidence detected");
  },

  "validation-evidence-required"(fixture) {
    if (!hasValidationEvidence(fixture)) return fail("issue is missing validation evidence");
    return pass("validation evidence present");
  },

  "review-stage-hang-detected"(fixture) {
    if (!hasReviewStageHang(fixture)) return fail("review-stage hang pattern was not present");
    return pass("review-stage hang pattern detected");
  },
});

export function evaluateCase(caseDef) {
  const fixture = caseDef.fixture;
  if (!fixture || typeof fixture !== "object") {
    throw new Error(`Case ${caseDef.id} is missing a loaded fixture object`);
  }
  const expected = caseDef.expected ?? {};
  const checkIds = expected.checks ?? [];
  const checkResults = [];

  for (const checkId of checkIds) {
    const check = BUILT_IN_CHECKS[checkId];
    if (!check) {
      checkResults.push({ id: checkId, passed: false, message: `unknown check: ${checkId}` });
      continue;
    }
    const outcome = check(fixture, { expectedClassification: expected.classification, caseDef });
    checkResults.push({ id: checkId, ...outcome });
  }

  const failures = checkResults.filter((item) => !item.passed).map((item) => `${item.id}: ${item.message}`);
  const { networkCalls, vendorCalls } = countNetworkAndVendorCalls(fixture);
  return {
    id: caseDef.id,
    title: caseDef.title,
    passed: failures.length === 0,
    classification: classifyFixture(fixture),
    expectedClassification: expected.classification ?? null,
    checks: checkResults,
    failures,
    networkCalls,
    vendorCalls,
  };
}

function validatePackMetadata(pack, packFile) {
  if (pack?.offlineOnly !== true) {
    throw new Error(`Eval pack ${packFile} offlineOnly must be true`);
  }
  if (pack?.sanitized !== true) {
    throw new Error(`Eval pack ${packFile} sanitized must be true`);
  }
}

export function loadEvalPack(packInput) {
  const packFile = coercePath(packInput);
  const packDir = path.dirname(packFile);
  const pack = readJson(packFile);
  validatePackMetadata(pack, packFile);
  const cases = (pack.cases ?? []).map((caseDef) => {
    if (!caseDef.fixture || typeof caseDef.fixture !== "string") {
      throw new Error(`Case ${caseDef.id ?? "<unknown>"} must declare a fixture path`);
    }
    const fixtureFile = path.resolve(packDir, caseDef.fixture);
    return {
      ...caseDef,
      fixturePath: fixtureFile,
      fixture: readJson(fixtureFile),
    };
  });
  return { ...pack, path: packFile, cases };
}

export function replayEvalPack(packInput, options = {}) {
  const pack = loadEvalPack(packInput);
  const selected = options.caseId ? pack.cases.filter((item) => item.id === options.caseId) : pack.cases;
  if (options.caseId && selected.length === 0) {
    throw new Error(`No case found with id ${options.caseId}`);
  }
  const caseResults = selected.map(evaluateCase);
  const summary = caseResults.reduce(
    (acc, item) => {
      acc.total += 1;
      if (item.passed) acc.passed += 1;
      else acc.failed += 1;
      acc.networkCalls += item.networkCalls;
      acc.vendorCalls += item.vendorCalls;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, networkCalls: 0, vendorCalls: 0 },
  );
  return {
    pack: {
      id: pack.id,
      version: pack.version,
      offlineOnly: pack.offlineOnly === true,
      sanitized: pack.sanitized === true,
      path: pack.path,
    },
    summary,
    cases: caseResults,
  };
}

function parseArgs(argv) {
  const args = { pack: "evals/workflow-packs/v0/pack.json", json: false, caseId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--pack") args.pack = argv[++index];
    else if (arg === "--case") args.caseId = argv[++index];
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/workflow-eval-replay.mjs [--pack evals/workflow-packs/v0/pack.json] [--case case-id] [--json]\n\nRuns deterministic, offline Paperclip workflow regression fixtures. The runner reads local JSON only and fails if a fixture contains external network/vendor actions.`);
}

function printHuman(result) {
  console.log(`Workflow eval pack: ${result.pack.id} (${result.pack.version})`);
  console.log(`Summary: ${result.summary.passed}/${result.summary.total} passed; network=${result.summary.networkCalls}; vendor=${result.summary.vendorCalls}`);
  for (const item of result.cases) {
    const mark = item.passed ? "PASS" : "FAIL";
    console.log(`${mark} ${item.id} classification=${item.classification}`);
    for (const check of item.checks) {
      console.log(`  ${check.passed ? "✓" : "✗"} ${check.id} - ${check.message}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const result = replayEvalPack(args.pack, { caseId: args.caseId });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (result.summary.failed > 0) process.exitCode = 1;
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (executedPath && import.meta.url === executedPath) {
  main();
}
