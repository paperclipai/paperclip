// hermes-stub-server.mjs — scripted local Hermes remote (the ONLY mock
// boundary for spec-309 Phase 1, per 01-CONTEXT.md). One `node:http` server
// per `startHermesStub(mode)` call; response bodies/status codes are chosen
// entirely by `mode`, never by URL-routing tricks (01-RESEARCH.md Pattern 1).
//
// ---------------------------------------------------------------------------
// Wire-shape provenance (Task 1 STEP A, 01-01-PLAN.md)
// ---------------------------------------------------------------------------
// DEVIATION (recorded here + in 01-01-SUMMARY.md): this execution run's hard
// offline-network constraint permits network access ONLY to `git clone`/
// `ls-remote` of the pinned `paperclipai/paperclip @ v2026.707.0` fork-build
// target. A fresh, direct (non-summarized) read of
// `NousResearch/hermes-agent @ v2026.6.5 gateway/platforms/api_server.py`
// — which 01-01-PLAN.md Task 1 STEP A calls for — was therefore NOT
// performed this session; that would be a second, disallowed remote. Wire
// shapes below instead carry forward 01-RESEARCH.md's existing Assumptions
// Log (A1/A2, tertiary confidence — a prior single-pass WebFetch summary,
// not byte-verified) using the plan's own explicitly-sanctioned fallbacks:
//
//   - Resolved skill-id field: the cited `/v1/skills` envelope
//     (`{object:"list", data:[{name, description, category}]}`) carries no
//     field distinct from `name` (Open Question 1) -> skillId <- name is an
//     explicit adapter-level decision, not a silent assumption. Re-verify
//     directly against the live matrix before Phase 4 (research.md note).
//   - remoteVersion: the cited `/v1/capabilities` shape
//     (`{object, platform, model, auth, runtime, features, endpoints}`) has
//     no field confirmed to carry a parseable Hermes release version for a
//     v0.16 remote -> the v0_16 happy path negotiates with
//     `remoteVersion: null` (data-model.md explicitly allows this; never
//     invented as a stub-only field). `auth_incompat` mode DOES carry a
//     parseable version (`runtime: "0.17.2"`) — that row is locked by the
//     contract's Fail-closed matrix, not by the tertiary source.
//
// UNSUPPORTED_LITERAL provenance: searched this repo + git history
// (`git log --all --diff-filter=A --name-only | grep -i 302`) for a
// spec-302-recorded unsupported skill-inventory JSON artifact. Spec-302 in
// THIS repo is `specs/302-hermes-adapter-reliability`, whose recorded
// fixtures (`fixtures/diagnosis/phase2-raw-sources/*/skill.json`) are a
// DIFFERENT artifact shape entirely (`phase2_skill_audit` agentRecords —
// population/audit records, not a capability-negotiation unsupported
// response). No byte-level artifact matching
// `{supported:false, mode:"unsupported", entries:[], warning}` was located
// anywhere in the repo or its history. Freezing the CONTEXT.md-specified
// literal below instead — INT-002 therefore degrades to `deepStrictEqual`
// against this literal (documented fallback), not a true byte-compat check
// against a historical artifact.
// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------
// Phase-2 provenance update (02-02-PLAN.md Task 3)
// ---------------------------------------------------------------------------
// Shapes are now byte-verified against the real `v2026.6.5` tree per
// 02-RESEARCH.md Sources: `api_server.py:855-879` (auth envelope),
// `:1161-1191` (skills route), `tools/skills_tool.py:568-641` (hashless
// inventory shape). The Layer-2 surface (POST/DELETE
// /v1/skills/activations, GET /v1/skills?scope=managed, plus the three
// failure-injection modes) mirrors contract §Layer 2 + 02-01-PLAN.md
// <artifacts> — the SAME locked wire spec 02-01's fork implements, per
// LD-S1 (wave-1 parallel isolation).
//
// LD-S2 (fix-forward, orchestrator-adjudicated 2026-07-17): the real
// v2026.6.5 `/v1/capabilities` serves `features` as an OBJECT MAP
// (api_server.py:1110-1135 @ 3c231eb3979ab9c57d5cd6d02f1d577a3b718b43) — the
// Phase-1 array shape was a fantasy-shape deviation, now CLOSED: the stub
// serves real object-map shapes in every mode (see capabilitiesPayloadFor
// below) and capabilities.ts parses the object map (array -> unsupported
// fail-closed, see capability-negotiation.test.mjs
// negotiate_array_features_unsupported). The Phase-1 DEVIATION record above
// stays intact as history.
//
// Deliberately NOT scripted here (no test depends on them): the 500-row
// managed-entry cap and 1 MiB-adjacent DoS edge cases beyond the single
// content-size check below — these are server-behavior proofs owned by
// 02-01's pytest suite against the real fork.
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

/** Synthetic Bearer token every advert-serving mode enforces on EVERY route
 * (research A3 — the real v0.16 server applies one shared Bearer check to
 * both `/v1/capabilities` and `/v1/skills`). Not a real secret. */
export const STUB_API_KEY = "spec309-synthetic-hermes-bearer-1a2b3c";

const MODES = new Set([
  "v0_16",
  "old",
  "old_no_advert",
  "auth_fail",
  "auth_fail_inventory",
  "malformed",
  "inventory_malformed",
  "transient",
  "capabilities_5xx",
  "timeout",
  "auth_incompat",
  "unknown_major",
  "v1_activation",
  "bad_item",
  "v1_wrong_scope",
  "v1_integrity_409",
  "v1_ack_not_observed",
]);

// The four Layer-2 modes: v1_activation plus the three failure injections.
// All four route through the same activation/deactivation/managed-scope
// handlers and advertise the same real object-map skills_activation/v1
// capability (LD-S2, byte-matching 02-01's fork advert).
const LAYER2_MODES = new Set(["v1_activation", "v1_wrong_scope", "v1_integrity_409", "v1_ack_not_observed"]);

// LD-1: the deployment's configured identity IS the authenticated scope —
// never derived from request bodies. Frozen literal mirroring 02-01's
// HERMES_SKILLS_SCOPE_* env defaults.
const DEPLOYMENT_SCOPE = Object.freeze({
  tenantId: "deployment-local",
  companyId: "deployment-local",
  agentId: "deployment-local",
});

const MANAGED_BY = "paperclip-skill-contract/v1";

// skillId <- name (no distinct stable id field cited — see provenance above).
// Plan-02 addition: canary fields (`internalToken`, `syncedStatus`) that MUST
// NEVER propagate into a mapped AdapterSkillEntry/serialized snapshot
// (FR-004) — the real field map only reads `name`/`description`/`category`,
// so these prove field-by-field construction, never a spread of the remote
// object (T-01-06).
const SKILL_ENTRIES = [
  {
    name: "brand-voice",
    description: "Brand voice + tone guardrails",
    category: "content",
    internalToken: "spec309-canary-internal-token-DO-NOT-LEAK",
    syncedStatus: "synced",
  },
  {
    name: "release-notes",
    description: "Release notes formatting",
    category: "ops",
    internalToken: "spec309-canary-internal-token-DO-NOT-LEAK",
    syncedStatus: "synced",
  },
];

// Plan-02 `bad_item` mode: a duplicate stable id — the whole response must
// be rejected fail-closed, never a partial mapping of the first (valid) one.
const BAD_ITEM_ENTRIES = [
  { name: "brand-voice", description: "Brand voice + tone guardrails", category: "content" },
  { name: "brand-voice", description: "Duplicate stable id", category: "ops" },
];

// The legacy unsupported response literal (INT-002 fixture). Deliberately
// frozen; never rebuilt by a general outcome-serializer (research Pitfall 2).
// capabilities.ts exports a byte-identical literal for the legacy surface —
// keep both in sync if this ever changes.
export const UNSUPPORTED_LITERAL = Object.freeze({
  supported: false,
  mode: "unsupported",
  entries: Object.freeze([]),
  warning: "Remote Hermes gateway does not advertise skills_api; skill inventory is unsupported.",
});

// ---------------------------------------------------------------------------
// Layer-2 validation constants (mirroring 02-01-PLAN.md <artifacts> verbatim)
// ---------------------------------------------------------------------------
const SKILL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PATH_KEY_DENYLIST = new Set([
  "path",
  "filePath",
  "file_path",
  "sourcePath",
  "source_path",
  "localPath",
  "local_path",
  "dir",
  "directory",
]);
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_RAW_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BODY_NESTING = 8;
const DELETE_MODES = new Set(["clean", "rollback"]);

function jsonBody(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function errorEnvelope(code, message) {
  return { error: { message, type: "invalid_request_error", code } };
}

function authInvalid(res) {
  jsonBody(res, 401, errorEnvelope("invalid_api_key", "Invalid API key"));
}

function insufficientScope(res) {
  jsonBody(res, 403, errorEnvelope("insufficient_scope", "Insufficient scope for skill inventory"));
}

// Plan-02 Task 1 (LD-S2, fix-forward): the real v2026.6.5 `/v1/capabilities`
// serves `features` as an OBJECT MAP (api_server.py:1110-1135 @
// 3c231eb3979ab9c57d5cd6d02f1d577a3b718b43, verified firsthand), not the
// Phase-1 string-array fantasy shape. Every mode below now serves the real
// object-map equivalent of its former array (see 02-02-PLAN.md LD-S2(a)).
function capabilitiesPayloadFor(mode) {
  switch (mode) {
    case "old_no_advert":
      return { object: "capabilities", platform: "hermes", features: {} };
    case "auth_incompat":
      // Adapter-defined heuristic (research Pitfall 3 / EDGE-007, #8924
      // lineage) — a PARSEABLE v0.17.x version plus an auth-scheme-mismatch
      // signal distinct from a plain 401. NOT a published Hermes v0.17 wire
      // guarantee; revalidate against the live matrix in Phase 4.
      return { object: "capabilities", platform: "hermes", runtime: "0.17.2", authScheme: "hmac-v2", features: { skills_api: true } };
    case "unknown_major":
      return { object: "capabilities", platform: "hermes", features: { skills_api: true, "skills_activation/v9": true } };
    case "v1_activation":
    case "v1_wrong_scope":
    case "v1_integrity_409":
    case "v1_ack_not_observed":
      // All four Layer-2 modes advertise the same real object-map advert
      // (byte-matching 02-01's fork advert key).
      return { object: "capabilities", platform: "hermes", features: { skills_api: true, "skills_activation/v1": true } };
    default:
      // v0_16, auth_fail_inventory, inventory_malformed, transient, bad_item
      // all advertise a plain v0.16-shaped skills_api-only capability.
      return { object: "capabilities", platform: "hermes", features: { skills_api: true } };
  }
}

function isNativeSkillName(name) {
  return SKILL_ENTRIES.some((entry) => entry.name === name);
}

function deriveDescription(content) {
  const line = content.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, 80);
}

function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function constantTimeHexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

function fingerprintOf(parsedBody) {
  return createHash("sha256").update(JSON.stringify(canonicalize(parsedBody)), "utf8").digest("hex");
}

// Recursively walks the parsed body: any denylisted key at any nesting depth,
// or any string VALUE other than `skill.content` containing a path separator
// or a dot-dot segment, fails the request closed. Depth beyond
// MAX_BODY_NESTING is itself treated as invalid (bounds the walk).
function scanForPathLeakage(value, path, depth) {
  if (depth > MAX_BODY_NESTING) return true;
  if (Array.isArray(value)) {
    return value.some((item) => scanForPathLeakage(item, path, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (PATH_KEY_DENYLIST.has(key)) return true;
      const childPath = path ? `${path}.${key}` : key;
      if (scanForPathLeakage(child, childPath, depth + 1)) return true;
    }
    return false;
  }
  if (typeof value === "string") {
    if (path === "skill.content") return false;
    return value.includes("/") || value.includes("..") || value.includes("\\");
  }
  return false;
}

function validateActivationBody(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  if (scanForPathLeakage(body, "", 0)) return false;
  const skill = body.skill;
  if (typeof skill !== "object" || skill === null || Array.isArray(skill)) return false;
  if (typeof skill.skillId !== "string" || !SKILL_ID_RE.test(skill.skillId)) return false;
  if (skill.version !== undefined && (typeof skill.version !== "string" || !VERSION_RE.test(skill.version))) return false;
  if (typeof skill.contentHash !== "string" || !CONTENT_HASH_RE.test(skill.contentHash)) return false;
  if (typeof skill.content !== "string" || skill.content.length === 0) return false;
  if (Buffer.byteLength(skill.content, "utf8") > MAX_CONTENT_BYTES) return false;
  if (typeof body.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_RE.test(body.idempotencyKey)) return false;
  return true;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("body-too-large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// POST /v1/skills/activations — Layer-2 modes only. `managed`/`replays` are
// per-instance Maps (created fresh inside startHermesStub) so two stub
// instances never share state (stub_two_instances_share_no_state).
async function handleActivationPost(req, res, { mode, managed, replays, record }) {
  let rawBody;
  try {
    rawBody = await readBody(req, MAX_RAW_BODY_BYTES);
  } catch {
    // Socket already destroyed by readBody on over-cap — nothing more to do.
    return;
  }

  if (mode === "v1_wrong_scope") {
    // LD-1: the honest adapter never sends identity in the body — this
    // mode-driven injection proves the ADAPTER's wrong-tenant handling
    // (contract INT-005), not a body-assert mismatch.
    jsonBody(res, 403, errorEnvelope("wrong_scope", "Wrong tenant/company/agent scope for this deployment"));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    record.body = null;
    jsonBody(res, 422, errorEnvelope("invalid_request", "Request body is not valid JSON"));
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    record.body = null;
    jsonBody(res, 422, errorEnvelope("invalid_request", "Request body must be a JSON object"));
    return;
  }
  record.body = parsed;

  if (parsed.contractVersion !== "1") {
    jsonBody(res, 422, errorEnvelope("unsupported_contract_version", "Unsupported contractVersion"));
    return;
  }

  if (!validateActivationBody(parsed)) {
    jsonBody(res, 422, errorEnvelope("invalid_request", "Activation payload failed validation"));
    return;
  }

  const { skill, idempotencyKey } = parsed;
  const { skillId, contentHash, content, version } = skill;

  if (isNativeSkillName(skillId) && !managed.has(skillId)) {
    jsonBody(res, 409, errorEnvelope("native_conflict", "skillId belongs to a remote-native skill"));
    return;
  }

  if (mode === "v1_integrity_409") {
    // Forced injection (EDGE-004): proves the injection itself, not just a
    // genuine hash mismatch — 02-03's reconcile_integrity_409 rides this.
    jsonBody(res, 409, errorEnvelope("integrity_mismatch", "Forced integrity-mismatch injection"));
    return;
  }

  const recomputedHex = sha256Hex(content);
  const suppliedHex = contentHash.slice("sha256:".length);
  if (!constantTimeHexEqual(recomputedHex, suppliedHex)) {
    jsonBody(res, 409, errorEnvelope("integrity_mismatch", "Recomputed content hash does not match the supplied hash"));
    return;
  }

  const fingerprint = fingerprintOf(parsed);
  const existingReplay = replays.get(idempotencyKey);
  if (existingReplay) {
    if (existingReplay.fingerprint === fingerprint) {
      jsonBody(res, 200, existingReplay.bodyJson);
      return;
    }
    jsonBody(res, 409, errorEnvelope("idempotency_conflict", "idempotencyKey reused with a different request body"));
    return;
  }

  const activatedAt = new Date().toISOString();
  const existingEntry = managed.get(skillId) ?? null;
  const previousState = existingEntry
    ? { contentHash: existingEntry.contentHash, version: existingEntry.version, content: existingEntry.content }
    : null;

  const responseBody = {
    ack: { skillId, contentHash, activatedAt, reloaded: true },
    ledgerEntry: {
      skillId,
      contentHash,
      version: version ?? null,
      scope: DEPLOYMENT_SCOPE,
      managedBy: MANAGED_BY,
      activatedAt,
      previousState,
      idempotencyKey,
    },
  };

  // EDGE-003 injection: the ack is not truth. In v1_ack_not_observed mode the
  // 201 ack is returned but NOTHING is stored — the skill is never observed.
  if (mode !== "v1_ack_not_observed") {
    managed.set(skillId, {
      skillId,
      contentHash,
      version: version ?? null,
      previousState,
      idempotencyKey,
      content,
      description: deriveDescription(content),
      category: "managed",
    });
    replays.set(idempotencyKey, { fingerprint, bodyJson: responseBody, skillId });
  }

  jsonBody(res, 201, responseBody);
}

// DELETE /v1/skills/activations/{skillId}?mode=clean|rollback — Layer-2
// modes only.
function handleActivationDelete(req, res, url, skillId, { managed, replays }) {
  const modeValues = url.searchParams.getAll("mode");
  if (modeValues.length > 1) {
    jsonBody(res, 422, errorEnvelope("unsupported_mode", "Duplicated mode parameter"));
    return;
  }
  const mode = modeValues[0] ?? "clean";
  if (!DELETE_MODES.has(mode)) {
    jsonBody(res, 422, errorEnvelope("unsupported_mode", `Unknown mode "${mode}"`));
    return;
  }

  if (!managed.has(skillId)) {
    if (isNativeSkillName(skillId)) {
      jsonBody(res, 403, errorEnvelope("not_managed", "Target belongs to a remote-native skill, not managed"));
      return;
    }
    jsonBody(res, 404, errorEnvelope("not_found", "No managed or native skill by that name"));
    return;
  }

  const entry = managed.get(skillId);
  const at = new Date().toISOString();

  if (mode === "clean") {
    managed.delete(skillId);
    for (const [key, replay] of replays) if (replay.skillId === skillId) replays.delete(key);
    jsonBody(res, 200, { ack: { skillId, removed: true, at } });
    return;
  }

  // mode === "rollback"
  if (entry.previousState === null) {
    managed.delete(skillId);
  } else {
    managed.set(skillId, {
      ...entry,
      contentHash: entry.previousState.contentHash,
      version: entry.previousState.version,
      content: entry.previousState.content,
      description: deriveDescription(entry.previousState.content),
      previousState: null,
    });
  }
  for (const [key, replay] of replays) if (replay.skillId === skillId) replays.delete(key);
  jsonBody(res, 200, { ack: { skillId, restored: true, at } });
}

function managedProjection(entry) {
  return {
    name: entry.skillId,
    description: entry.description,
    category: entry.category,
    contentHash: entry.contentHash,
    managedBy: MANAGED_BY,
    scope: DEPLOYMENT_SCOPE,
  };
}

/**
 * Boot an ephemeral-port `node:http` server scripted to one of the
 * §Fail-closed-matrix-aligned modes (14 from Phase 1 + Plan 02's three
 * Layer-2 injection modes). Resolves `{ server, baseUrl, requests }`
 * where `requests` is a read-only-by-convention transcript array of
 * `{ method, path, hasValidAuth }` for every request received (Layer-2
 * activation POST records additionally carry `body`, the parsed JSON or
 * null when unparseable) — consumed by Plan 02/03's wire-sequence +
 * zero-activation-calls assertions.
 */
export function startHermesStub(mode) {
  if (!MODES.has(mode)) {
    throw new Error(`unknown stub mode: ${mode}`);
  }

  const requests = [];
  const sockets = new Set();
  // Per-instance state (never module-global): two stub instances must be
  // fully isolated (stub_two_instances_share_no_state).
  const managed = new Map();
  const replays = new Map();

  const server = createServer((req, res) => {
    if (mode === "timeout") {
      // Hung response: accept the connection, never write, never end. The
      // caller's bounded request deadline (capabilities.ts) must abort; this
      // server's close() destroys the open socket so the test never hangs.
      requests.push({ method: req.method, path: req.url, hasValidAuth: null });
      return;
    }

    const authHeader = req.headers["authorization"] ?? null;
    const hasValidAuth = authHeader === `Bearer ${STUB_API_KEY}`;
    const record = { method: req.method, path: req.url, hasValidAuth };
    requests.push(record);

    const url = new URL(req.url, "http://stub.internal");
    const pathname = url.pathname;
    const activationMatch = /^\/v1\/skills\/activations(?:\/([^/]+))?$/.exec(pathname);

    if (pathname === "/v1/capabilities") {
      if (mode === "old") {
        // Missing route entirely (real old-remote fail-closed row) — this is
        // `unsupported`, NEVER `malformed` (research Anti-Pattern).
        jsonBody(res, 404, { error: { code: "not_found" } });
        return;
      }
      if (mode === "capabilities_5xx") {
        jsonBody(res, 503, { error: { code: "upstream_unavailable" } });
        return;
      }
      if (mode === "auth_fail") {
        // Real shared-Bearer behavior: an invalid/revoked key fails BOTH
        // routes before any advert is served, regardless of the token sent.
        authInvalid(res);
        return;
      }
      if (!hasValidAuth) {
        authInvalid(res);
        return;
      }
      if (mode === "malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{not-valid-json::");
        return;
      }
      jsonBody(res, 200, capabilitiesPayloadFor(mode));
      return;
    }

    if (activationMatch && LAYER2_MODES.has(mode)) {
      if (mode === "auth_fail") {
        authInvalid(res);
        return;
      }
      if (!hasValidAuth) {
        authInvalid(res);
        return;
      }
      const skillIdFromPath = activationMatch[1] ? decodeURIComponent(activationMatch[1]) : null;
      if (req.method === "POST" && !skillIdFromPath) {
        handleActivationPost(req, res, { mode, managed, replays, record });
        return;
      }
      if (req.method === "DELETE" && skillIdFromPath) {
        handleActivationDelete(req, res, url, skillIdFromPath, { managed, replays });
        return;
      }
      jsonBody(res, 404, { error: { code: "not_found" } });
      return;
    }

    if (pathname === "/v1/skills") {
      if (mode === "auth_fail") {
        authInvalid(res);
        return;
      }
      if (!hasValidAuth) {
        authInvalid(res);
        return;
      }
      if (mode === "auth_fail_inventory") {
        insufficientScope(res);
        return;
      }
      if (mode === "transient") {
        jsonBody(res, 503, { error: { code: "upstream_unavailable" } });
        return;
      }
      if (mode === "inventory_malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{not-valid-json::");
        return;
      }
      if (mode === "bad_item") {
        jsonBody(res, 200, { object: "list", data: BAD_ITEM_ENTRIES });
        return;
      }

      if (url.searchParams.get("scope") === "managed" && LAYER2_MODES.has(mode)) {
        // The ONLY source of `observed: true` (LD-2) — native entries NEVER
        // appear here, and it carries contentHash/managedBy/scope (unlike
        // the base list below, which stays hashless for ALL modes).
        jsonBody(res, 200, { object: "list", data: [...managed.values()].map(managedProjection) });
        return;
      }

      // Base list: native SKILL_ENTRIES plus managed entries projected to
      // {name, description, category} ONLY (hashless — LD-2). A real
      // pre-patch v0.16 server ignores unknown query params, so any
      // non-Layer-2 mode or unrecognized scope value falls through here too.
      const activatedProjections = [...managed.values()].map((entry) => ({
        name: entry.skillId,
        description: entry.description,
        category: entry.category,
      }));
      jsonBody(res, 200, { object: "list", data: [...SKILL_ENTRIES, ...activatedProjections] });
      return;
    }

    jsonBody(res, 404, { error: { code: "not_found" } });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  // Socket-cleanup override (timeout mode requirement): close() must destroy
  // any open sockets so the suite never hangs after a hung-response test.
  const nativeClose = server.close.bind(server);
  server.close = (callback) => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    return nativeClose(callback);
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requests });
    });
  });
}
