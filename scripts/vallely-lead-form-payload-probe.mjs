#!/usr/bin/env node
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ARTIFACT_DIR = "artifacts/vallely-lead-form-payload-probe";
const DEFAULT_DP360_API_URL = "https://api.dp360crm.com/api/2.0/";
const DEFAULT_DP360_LEADS_PATH = "/leads/{dealer_id}.json";
const DEFAULT_VALLELY_LISTING_ID = "15329398";
const DEFAULT_TIMEOUT_SECONDS = 5 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;
const REQUIRED_FIELDS = ["name", "email", "phone", "source", "listing_id", "message"];
const DEALERSPIKE_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

class ProbeError extends Error {
  constructor(message, code = "probe_failed") {
    super(message);
    this.name = "ProbeError";
    this.code = code;
  }
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function normalizeBaseUrl(value = DEFAULT_DP360_API_URL) {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildUrl({ apiUrl, pathTemplate, dealerId }) {
  const trimmed = pathTemplate.replace("{dealer_id}", encodeURIComponent(dealerId)).replace(/^\/+/, "");
  return new URL(trimmed, normalizeBaseUrl(apiUrl)).toString();
}

function readBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new ProbeError(`${name} is required for Vallely lead-form payload probe`, "missing_credentials");
  return value;
}

function authHeaders(env) {
  const headers = { Accept: "application/json", "User-Agent": "paperclip-vallely-lead-form-payload-probe/1.0" };
  if (env.DP360_API_TOKEN) headers[env.DP360_AUTH_HEADER || "token"] = env.DP360_API_TOKEN;
  if (env.DP360_VENDOR_TOKEN) headers.Authorization = `Bearer ${env.DP360_VENDOR_TOKEN}`;
  return headers;
}

function stableId(prefix, runId) {
  return `${prefix}_${crypto.createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
}

function defaultRunId(now = new Date()) {
  return `vallely-lead-form-payload-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

function buildSyntheticLeadPayload({ runId, now = new Date(), listingId }) {
  const email = `synthetic+${runId}@example.invalid`;
  const message = `Synthetic Vallely lead-form payload probe; run_id=${runId}; synthetic=true; delete_after=true`;
  return {
    synthetic: true,
    run_id: runId,
    idempotency_key: stableId("idem", runId),
    submitted_at: nowIso(now),
    name: `Synthetic Payload ${runId.slice(-8)}`,
    first_name: "Synthetic",
    last_name: `Payload ${runId.slice(-8)}`,
    email,
    phone: "+15550101010",
    source: "paperclip_vallely_lead_form_payload_probe",
    listing_id: listingId,
    message,
    metadata: {
      synthetic: true,
      run_id: runId,
      delete_after: true,
      probe: "vallely_lead_form_payload_completeness",
    },
  };
}

function parseJsonEnv(env, name) {
  const raw = env[name]?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!asRecord(parsed)) throw new Error("expected object");
    return parsed;
  } catch (error) {
    throw new ProbeError(`${name} must be a JSON object`, "invalid_configuration");
  }
}

function buildDealerSpikeFormPayload(payload, env) {
  const overrides = parseJsonEnv(env, "VALLELY_LEAD_FORM_FIELD_OVERRIDES_JSON");
  return {
    fname: payload.first_name,
    lname: payload.last_name,
    email: payload.email,
    telephone: payload.phone,
    comments: payload.message,
    location: env.VALLELY_LEAD_FORM_LOCATION?.trim() || "Bismarck ND",
    NewsletterOptIn: env.VALLELY_LEAD_FORM_NEWSLETTER_OPT_IN?.trim() || "Y",
    formpage: "xinquiry",
    SourcePage: "xinquiry",
    oid: payload.listing_id,
    source: payload.source,
    submit: "submit",
    ...overrides,
  };
}

function buildLeadFormRequest(payload, env) {
  const format = env.VALLELY_LEAD_FORM_PAYLOAD_FORMAT?.trim() || "dealerspike-form";
  if (format === "json") {
    return {
      format,
      contentType: "application/json",
      submittedPayload: payload,
      body: JSON.stringify(payload),
    };
  }
  if (format !== "dealerspike-form") {
    throw new ProbeError("VALLELY_LEAD_FORM_PAYLOAD_FORMAT must be dealerspike-form or json", "invalid_configuration");
  }
  const submittedPayload = buildDealerSpikeFormPayload(payload, env);
  return {
    format,
    contentType: DEALERSPIKE_FORM_CONTENT_TYPE,
    submittedPayload,
    body: new URLSearchParams(submittedPayload).toString(),
  };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function flattenArrays(value, keys) {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key];
  }
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested) {
      const result = flattenArrays(nested, keys);
      if (result.length) return result;
    }
  }
  return [];
}

function pickString(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function normalizePhone(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeLead(record) {
  const lead = asRecord(record?.lead) ? { ...record, ...record.lead } : record;
  const customer = asRecord(lead?.customer) ?? asRecord(lead?.contact) ?? {};
  const vehicle = asRecord(lead?.vehicle) ?? asRecord(lead?.inventory) ?? asRecord(lead?.listing) ?? {};
  const firstName = pickString(lead, ["first_name", "firstName"]) ?? pickString(customer, ["first_name", "firstName"]);
  const lastName = pickString(lead, ["last_name", "lastName"]) ?? pickString(customer, ["last_name", "lastName"]);
  const composedName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const name =
    pickString(lead, ["name", "customer_name", "customerName", "full_name", "fullName"]) ??
    pickString(customer, ["name", "customer_name", "customerName", "full_name", "fullName"]) ??
    (composedName || null);
  return {
    raw: record,
    id: pickString(lead, ["lead_id", "leadId", "id", "uuid", "key", "lead_key", "leadKey"]),
    run_id: pickString(lead, ["run_id", "runId"]) ?? pickString(asRecord(lead?.metadata), ["run_id", "runId"]),
    idempotency_key: pickString(lead, ["idempotency_key", "idempotencyKey"]),
    name,
    email: pickString(lead, ["email", "email_address", "emailAddress"]) ?? pickString(customer, ["email", "email_address", "emailAddress"]),
    phone: pickString(lead, ["phone", "phone_number", "phoneNumber", "mobile"]) ?? pickString(customer, ["phone", "phone_number", "phoneNumber", "mobile"]),
    source: pickString(lead, ["source", "lead_source", "leadSource", "origin", "channel"]),
    listing_id:
      pickString(lead, ["listing_id", "listingId", "inventory_id", "inventoryId", "stock_number", "stockNumber", "unit_id", "unitId"]) ??
      pickString(vehicle, ["listing_id", "listingId", "inventory_id", "inventoryId", "stock_number", "stockNumber", "unit_id", "unitId"]),
    message: pickString(lead, ["message", "comments", "comment", "notes", "note", "body"]),
    created_at: pickString(lead, ["created_at", "createdAt", "submitted_at", "submittedAt", "received_at", "receivedAt"]),
  };
}

function leadMatchesProbe(lead, expected) {
  return (
    lead.run_id === expected.run_id ||
    lead.idempotency_key === expected.idempotency_key ||
    lead.email?.toLowerCase() === expected.email.toLowerCase() ||
    lead.message?.includes(expected.run_id)
  );
}

function fieldValue(lead, field) {
  return field === "phone" ? normalizePhone(lead.phone) : lead[field];
}

function validatePayload(lead, expected, now = new Date(), timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
  const missing = REQUIRED_FIELDS.filter((field) => !fieldValue(lead, field));
  const mismatched = [];
  if (lead.email?.toLowerCase() !== expected.email.toLowerCase()) mismatched.push("email");
  if (normalizePhone(lead.phone) !== normalizePhone(expected.phone)) mismatched.push("phone");
  if (lead.source !== expected.source) mismatched.push("source");
  if (lead.listing_id !== expected.listing_id) mismatched.push("listing_id");
  if (!lead.message?.includes(expected.run_id)) mismatched.push("message");

  const createdAt = lead.created_at ? new Date(lead.created_at) : null;
  const arrivalLagSeconds =
    createdAt && !Number.isNaN(createdAt.getTime()) ? Math.max(0, (createdAt.getTime() - new Date(expected.submitted_at).getTime()) / 1000) : null;
  const observedLagSeconds = Math.max(0, (now.getTime() - new Date(expected.submitted_at).getTime()) / 1000);
  if ((arrivalLagSeconds ?? observedLagSeconds) > timeoutSeconds) mismatched.push("arrival_lag");

  return {
    status: missing.length === 0 && mismatched.length === 0 ? "ok" : "failed",
    missing,
    mismatched,
    arrival_lag_seconds: arrivalLagSeconds,
    observed_lag_seconds: Math.round(observedLagSeconds),
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function postLeadForm(url, payload, { env, fetcher }) {
  const request = buildLeadFormRequest(payload, env);
  const headers = {
    "Content-Type": request.contentType,
    Accept: "application/json",
    "User-Agent": "paperclip-vallely-lead-form-payload-probe/1.0",
  };
  if (env.VALLELY_LEAD_FORM_AUTH_HEADER) headers.Authorization = env.VALLELY_LEAD_FORM_AUTH_HEADER;
  const response = await fetcher(url, { method: "POST", headers, body: request.body });
  if (!response.ok) throw new ProbeError(`Lead-form submission failed with HTTP ${response.status}`, "lead_form_unavailable");
  const responseBody = await response.json().catch(() => ({}));
  return {
    status: "submitted",
    endpoint: url,
    payload_format: request.format,
    content_type: request.contentType,
    submitted_payload: request.submittedPayload,
    response: responseBody,
  };
}

async function fetchDp360Leads({ env, fetcher }) {
  if (env.DP360_LEADS_INPUT_FILE) return readJson(env.DP360_LEADS_INPUT_FILE);
  const dealerId = requiredEnv(env, "DP360_DEALER_ID");
  if (!env.DP360_API_TOKEN?.trim() && !env.DP360_VENDOR_TOKEN?.trim()) {
    throw new ProbeError("DP360_API_TOKEN or DP360_VENDOR_TOKEN is required when DP360_LEADS_INPUT_FILE is not set", "missing_credentials");
  }
  const response = await fetcher(
    buildUrl({
      apiUrl: env.DP360_API_URL || DEFAULT_DP360_API_URL,
      pathTemplate: env.DP360_LEADS_PATH || DEFAULT_DP360_LEADS_PATH,
      dealerId,
    }),
    { headers: authHeaders(env) },
  );
  if (!response.ok) throw new ProbeError(`DP360 lead fetch failed with HTTP ${response.status}`, "crm_unavailable");
  return response.json();
}

async function findCrmLead(expected, { env, fetcher, now, timeoutSeconds, pollIntervalSeconds, sleep }) {
  const deadline = now.getTime() + timeoutSeconds * 1000;
  let attempts = 0;
  let lastCheckedAt = now;
  do {
    attempts += 1;
    lastCheckedAt = new Date(Math.min(deadline, now.getTime() + (attempts - 1) * pollIntervalSeconds * 1000));
    const raw = await fetchDp360Leads({ env, fetcher });
    const leads = flattenArrays(raw, ["leads", "items", "results", "contacts", "customers"]).map(normalizeLead);
    const matched = leads.find((lead) => leadMatchesProbe(lead, expected));
    if (matched) return { matched, attempts, checked_at: nowIso(lastCheckedAt) };
    if (env.DP360_LEADS_INPUT_FILE || lastCheckedAt.getTime() >= deadline) break;
    await sleep(pollIntervalSeconds * 1000);
  } while (Date.now() < deadline);
  return { matched: null, attempts, checked_at: nowIso(lastCheckedAt) };
}

async function emitAlert(record, { env, fetcher }) {
  const url = env.VALLELY_LEAD_FORM_PROBE_ALERT_URL?.trim();
  if (!url || record.status === "ok") return { status: "skipped" };
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      type: "vallely.lead_form_payload_probe.failed",
      run_id: record.run_id,
      status: record.status,
      missing: record.crm_validation?.missing ?? [],
      mismatched: record.crm_validation?.mismatched ?? [],
      error: record.error ?? null,
    }),
  });
  return { status: response.ok ? "sent" : "failed", http_status: response.status };
}

export async function runVallelyLeadFormPayloadProbe({
  env = process.env,
  fetcher = globalThis.fetch,
  now = new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof fetcher !== "function") throw new ProbeError("global fetch is unavailable", "fetch_unavailable");
  const production = env.VALLELY_LEAD_FORM_PROBE_MODE === "production";
  if (production && !readBoolean(env.ALLOW_PRODUCTION_SYNTHETIC_LEADS)) {
    throw new ProbeError("ALLOW_PRODUCTION_SYNTHETIC_LEADS=true is required before sending synthetic Vallely lead-form submissions", "production_not_allowed");
  }

  const runId = env.VALLELY_LEAD_FORM_PROBE_RUN_ID?.trim() || defaultRunId(now);
  const timeoutSeconds = Number(env.VALLELY_LEAD_FORM_PROBE_TIMEOUT_SECONDS || DEFAULT_TIMEOUT_SECONDS);
  const pollIntervalSeconds = Number(env.VALLELY_LEAD_FORM_PROBE_POLL_INTERVAL_SECONDS || DEFAULT_POLL_INTERVAL_SECONDS);
  const payload = buildSyntheticLeadPayload({
    runId,
    now,
    listingId: env.VALLELY_LEAD_FORM_PROBE_LISTING_ID?.trim() || DEFAULT_VALLELY_LISTING_ID,
  });
  const artifact = {
    synthetic: true,
    run_id: runId,
    mode: production ? "production" : "dry-run",
    generated_at: nowIso(now),
    expected_fields: REQUIRED_FIELDS,
    timeout_seconds: timeoutSeconds,
    payload,
    status: "unknown",
  };

  try {
    if (production) {
      artifact.submission = await postLeadForm(requiredEnv(env, "VALLELY_LEAD_FORM_ENDPOINT_URL"), payload, { env, fetcher });
    } else {
      artifact.submission = { status: "skipped", reason: "VALLELY_LEAD_FORM_PROBE_MODE is not production" };
    }
    const { matched, attempts, checked_at: checkedAt } = await findCrmLead(payload, { env, fetcher, now, timeoutSeconds, pollIntervalSeconds, sleep });
    artifact.crm_lookup = { target: "DP360 leads", attempts, checked_at: checkedAt, found: Boolean(matched), lead_id: matched?.id ?? null };
    if (!matched) throw new ProbeError(`Synthetic lead did not arrive in DP360 within ${timeoutSeconds} seconds`, "crm_arrival_timeout");
    artifact.crm_validation = validatePayload(matched, payload, new Date(checkedAt), timeoutSeconds);
    artifact.crm_lead = matched;
    artifact.status = artifact.crm_validation.status;
  } catch (error) {
    artifact.status = "failed";
    artifact.error = {
      code: error instanceof ProbeError ? error.code : "unexpected_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  artifact.alert = await emitAlert(artifact, { env, fetcher });
  const artifactFile =
    env.VALLELY_LEAD_FORM_PROBE_ARTIFACT_FILE?.trim() ||
    path.join(env.VALLELY_LEAD_FORM_PROBE_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR, `${runId}.json`);
  await writeJson(artifactFile, artifact);
  return { artifactFile, artifact };
}

async function main() {
  const { artifactFile, artifact } = await runVallelyLeadFormPayloadProbe();
  console.log(`[vallely-lead-form-payload-probe] ${artifact.status} mode=${artifact.mode} run_id=${artifact.run_id} artifact=${artifactFile}`);
  if (artifact.status !== "ok") process.exitCode = 1;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[vallely-lead-form-payload-probe] ${error.message}`);
    process.exit(1);
  });
}
