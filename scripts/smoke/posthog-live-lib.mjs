const REQUIRED_ENVIRONMENT = [
  "INTEGRATIONS_POSTHOG_PAPERCLIP_E2E_EMAIL",
  "INTEGRATIONS_POSTHOG_PAPERCLIP_DEV_LOGIN_PASSWORD",
  "INTEGRATIONS_POSTHOG_POSTHOG_PROJECT_ID",
];
const REQUIRED_PROJECT_ID = "483530";

export class PosthogLivePreflightError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "PosthogLivePreflightError";
    this.code = code;
    this.details = details;
  }
}

function requiredValue(environment, key) {
  const value = environment[key];
  return typeof value === "string" ? value.trim() : "";
}

export function parsePosthogLiveArguments(args = []) {
  if (args.length === 0) return {};
  if (args.length === 1 && !args[0].startsWith("-")) return { baseUrl: args[0] };
  if (args.length === 2 && args[0] === "--base-url" && args[1].trim()) {
    return { baseUrl: args[1] };
  }
  throw new PosthogLivePreflightError("invalid_arguments");
}

export function preflightPosthogLive(environment = process.env, options = {}) {
  const missing = REQUIRED_ENVIRONMENT.filter((key) => requiredValue(environment, key) === "");
  if (missing.length > 0) {
    throw new PosthogLivePreflightError("missing_environment", { missing });
  }

  const baseUrlValue = typeof options.baseUrl === "string" && options.baseUrl.trim()
    ? options.baseUrl.trim()
    : requiredValue(environment, "PAPERCLIP_API_URL");
  if (!baseUrlValue) {
    throw new PosthogLivePreflightError("missing_base_url");
  }

  let baseUrl;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new PosthogLivePreflightError("invalid_base_url");
  }
  const loopback = baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "localhost" || baseUrl.hostname === "[::1]";
  if ((baseUrl.protocol !== "https:" && !(loopback && baseUrl.protocol === "http:"))
    || baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash) {
    throw new PosthogLivePreflightError("unsafe_base_url");
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "") || "/";

  const projectId = requiredValue(environment, "INTEGRATIONS_POSTHOG_POSTHOG_PROJECT_ID");
  if (!/^\d+$/.test(projectId)) {
    throw new PosthogLivePreflightError("invalid_project_id");
  }
  if (projectId !== REQUIRED_PROJECT_ID) {
    throw new PosthogLivePreflightError("unexpected_project_id");
  }
  const email = requiredValue(environment, "INTEGRATIONS_POSTHOG_PAPERCLIP_E2E_EMAIL");
  if (!email.includes("@")) {
    throw new PosthogLivePreflightError("invalid_email");
  }

  return {
    baseUrl: baseUrl.origin,
    email,
    password: environment.INTEGRATIONS_POSTHOG_PAPERCLIP_DEV_LOGIN_PASSWORD,
    projectId,
  };
}

export async function preparePosthogLiveSmoke({
  environment = process.env,
  baseUrl,
  fetchImpl = globalThis.fetch,
  loadBrowser,
}) {
  const config = preflightPosthogLive(environment, { baseUrl });
  let response;
  try {
    response = await fetchImpl(new URL("/api/health", config.baseUrl), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PosthogLivePreflightError("health_unreachable");
  }
  if (!response.ok) {
    throw new PosthogLivePreflightError("health_http_error", { status: response.status });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new PosthogLivePreflightError("health_invalid_json");
  }
  if (body?.status !== "ok") {
    throw new PosthogLivePreflightError("health_not_ok");
  }
  return { config, browserModule: await loadBrowser() };
}

function projectIdFrom(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  for (const key of ["projectId", "project_id", "projectID", "id"]) {
    const value = candidate[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return null;
}

function projectNameFrom(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  for (const key of ["projectName", "project_name", "name"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parsedJsonString(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200_000) return null;
  const candidates = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidates.unshift(fenced[1]);
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Some MCP servers wrap structured JSON in prose; the regex fallback below
      // handles the small project summary without retaining that prose.
    }
  }
  return null;
}

export function extractProjectSummary(value, expectedProjectId) {
  const seen = new Set();
  const visit = (candidate, depth) => {
    if (depth > 12 || candidate === null || candidate === undefined) return null;
    if (typeof candidate === "string") {
      const parsed = parsedJsonString(candidate);
      if (parsed !== null) {
        const nested = visit(parsed, depth + 1);
        if (nested) return nested;
      }
      if (candidate.length <= 200_000) {
        const idMatch = candidate.match(/(?:project[_\s-]*id|\bid\b)["'\s:=]+([0-9]+)/i);
        if (idMatch?.[1] === expectedProjectId) {
          const nameMatch = candidate.match(/(?:project[_\s-]*name|\bname\b)["'\s:=]+["']?([^"'\n,}\]]+)/i);
          return { id: expectedProjectId, name: nameMatch?.[1]?.trim() || null };
        }
      }
      return null;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return null;
    seen.add(candidate);

    if (!Array.isArray(candidate)) {
      const id = projectIdFrom(candidate);
      if (id === expectedProjectId) {
        return { id, name: projectNameFrom(candidate) };
      }
    }
    const children = Array.isArray(candidate) ? candidate : Object.values(candidate);
    for (const child of children) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(value, 0);
}

export function parseSanitizedAgentProof(commentBody, expectedProjectId) {
  if (typeof commentBody !== "string") return null;
  const trimmed = commentBody.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).sort().join(",") !== "invocationId,projectId,projectName") return null;
  if (String(parsed.projectId ?? "") !== expectedProjectId) return null;
  if (typeof parsed.projectName !== "string" || !parsed.projectName.trim()) return null;
  if (typeof parsed.invocationId !== "string" || !parsed.invocationId.trim()) return null;
  return {
    projectId: expectedProjectId,
    projectName: parsed.projectName.trim(),
    invocationId: parsed.invocationId.trim(),
  };
}

const FORBIDDEN_EVIDENCE_KEYS = /(?:password|access[_-]?token|refresh[_-]?token|authorization|cookie|oauth[_-]?code|client[_-]?secret)/i;
const FORBIDDEN_EVIDENCE_TEXT = /(?:authorization:\s*bearer|cookie:|[?&](?:code|state|token|access_token|refresh_token)=)/i;

export function assertSanitizedEvidence(value) {
  const seen = new Set();
  const visit = (candidate, path) => {
    if (candidate === null || candidate === undefined) return;
    if (typeof candidate === "string") {
      if (FORBIDDEN_EVIDENCE_TEXT.test(candidate)) {
        throw new Error(`unsafe_evidence_text:${path}`);
      }
      return;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (FORBIDDEN_EVIDENCE_KEYS.test(key)) {
        throw new Error(`unsafe_evidence_key:${path}.${key}`);
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "$");
}

export function preflightFailureMessage(error) {
  if (!(error instanceof PosthogLivePreflightError)) return "PostHog live smoke preflight failed.";
  if (error.code === "missing_environment") {
    return `PostHog live smoke preflight failed: missing ${error.details.missing.join(", ")}.`;
  }
  if (error.code === "health_http_error") {
    return `PostHog live smoke preflight failed: /api/health returned HTTP ${error.details.status}.`;
  }
  if (error.code === "missing_base_url") {
    return "PostHog live smoke preflight failed: pass the target Paperclip URL or run inside a Paperclip heartbeat.";
  }
  if (error.code === "invalid_arguments") {
    return "PostHog live smoke preflight failed: expected an optional Paperclip URL or --base-url <url>.";
  }
  return `PostHog live smoke preflight failed: ${error.code}.`;
}
