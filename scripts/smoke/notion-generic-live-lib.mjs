const REQUIRED_ENVIRONMENT = [
  "PAPERCLIP_E2E_BASE_URL",
  "PAPERCLIP_E2E_EMAIL",
  "PAPERCLIP_DEV_LOGIN_PASSWORD",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
];

// Agent secret APIs expose access.notion_generic_flow_test_account under this
// normalized delivery key; the live harness never reads any other binding.
export const NOTION_SECRET_BINDING_KEY = "generic-flow-test-account";

const NOTION_LOGIN_MAIL_DOMAINS = ["notion.so", "makenotion.com"];

export class NotionGenericLivePreflightError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "NotionGenericLivePreflightError";
    this.code = code;
    this.details = details;
  }
}

function emailDomain(value) {
  const match = String(value ?? "").match(/@([A-Za-z0-9.-]+)/);
  return match?.[1]?.toLowerCase().replace(/\.$/, "") ?? "";
}

function notionMailDomain(value) {
  const domain = emailDomain(value);
  return NOTION_LOGIN_MAIL_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

export function isFreshNotionVerificationMessage(message, { notBefore }) {
  const timestamp = new Date(message?.timestamp ?? message?.createdAt ?? Number.NaN).getTime();
  const lowerSubject = String(message?.subject ?? "").toLowerCase();
  const challengeSubject = /(?:login|verification|one[-\s]?time|temporary|security).*(?:code|pin)|(?:code|pin).*(?:login|verification|one[-\s]?time|temporary|security)/i.test(lowerSubject);
  return notionMailDomain(message?.from)
    && challengeSubject
    && Number.isFinite(timestamp)
    && timestamp >= new Date(notBefore).getTime();
}

export function notionVerificationAuthenticationPassed(message) {
  const headers = message?.headers && typeof message.headers === "object" && !Array.isArray(message.headers)
    ? message.headers
    : {};
  const authentication = Object.entries(headers)
    .filter(([key]) => key.toLowerCase().includes("authentication-results"))
    .map(([, value]) => String(value).toLowerCase())
    .join(" ");
  return authentication.includes("dkim=pass")
    && (authentication.includes("dmarc=pass")
      || authentication.includes("spf=pass")
      || authentication.includes("arc=pass"));
}

export function extractNotionVerificationCode(message) {
  const content = [
    message?.subject,
    message?.extractedText,
    message?.text,
    message?.extractedHtml,
    message?.html,
  ]
    .filter((value) => typeof value === "string")
    .join("\n")
    .replace(/<[^>]+>/g, " ");
  const digitSequence = "([0-9](?:[\\s-]?[0-9]){5})";
  const patterns = [
    new RegExp(`(?:login|verification|one[-\\s]?time|temporary|security)[^\\n]{0,40}(?:code|pin)[^0-9]{0,40}${digitSequence}`, "gi"),
    new RegExp(`(?:code|pin)[^0-9]{0,40}${digitSequence}`, "gi"),
    new RegExp(`${digitSequence}[^\\n]{0,40}(?:login|verification|one[-\\s]?time|temporary|security)?[^\\n]{0,20}(?:code|pin)`, "gi"),
  ];
  const codes = new Set();
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const code = match[1].replace(/[^0-9]/g, "");
      if (code.length === 6) codes.add(code);
    }
  }
  for (const label of content.matchAll(/(?:code|pin)/gi)) {
    const window = content.slice(label.index, label.index + 120);
    for (const match of window.matchAll(/(^|[^0-9])([0-9](?:[\s-]?[0-9]){5})(?![0-9])/g)) {
      codes.add(match[2].replace(/[^0-9]/g, ""));
    }
  }
  return codes.size === 1 ? [...codes][0] : null;
}

function requiredValue(environment, key) {
  const value = environment[key];
  return typeof value === "string" ? value.trim() : "";
}

function explicitHttpsOrigin(raw, code) {
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new NotionGenericLivePreflightError(code);
  }
  if (value.protocol !== "https:"
    || value.username
    || value.password
    || value.search
    || value.hash
    || (value.pathname !== "/" && value.pathname !== "/api" && value.pathname !== "/api/")) {
    throw new NotionGenericLivePreflightError(code);
  }
  return value;
}

export function preflightNotionGenericLive(environment = process.env) {
  const missing = REQUIRED_ENVIRONMENT.filter((key) => requiredValue(environment, key) === "");
  if (missing.length > 0) {
    throw new NotionGenericLivePreflightError("missing_environment", { missing });
  }

  const base = explicitHttpsOrigin(requiredValue(environment, "PAPERCLIP_E2E_BASE_URL"), "unsafe_base_url");
  const api = explicitHttpsOrigin(requiredValue(environment, "PAPERCLIP_API_URL"), "unsafe_api_url");

  const email = requiredValue(environment, "PAPERCLIP_E2E_EMAIL");
  if (!email.includes("@")) throw new NotionGenericLivePreflightError("invalid_paperclip_email");

  return {
    baseUrl: base.origin,
    apiBaseUrl: `${api.origin}/api`,
    callbackUrl: `${base.origin}/api/tools/oauth/callback`,
    paperclipEmail: email,
    paperclipPassword: environment.PAPERCLIP_DEV_LOGIN_PASSWORD,
    agentApiKey: environment.PAPERCLIP_API_KEY,
    runId: environment.PAPERCLIP_RUN_ID,
    taskId: environment.PAPERCLIP_TASK_ID,
    secretBindingKey: NOTION_SECRET_BINDING_KEY,
  };
}

async function responseJson(response, code) {
  try {
    return await response.json();
  } catch {
    throw new NotionGenericLivePreflightError(code);
  }
}

async function fetchWithTimeout(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new NotionGenericLivePreflightError("request_failed");
  }
}

export async function prepareNotionGenericLiveSmoke({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  loadBrowser,
}) {
  const config = preflightNotionGenericLive(environment);
  const healthResponse = await fetchWithTimeout(
    fetchImpl,
    new URL("/api/health", config.baseUrl),
    { headers: { accept: "application/json" } },
  );
  if (!healthResponse.ok) {
    throw new NotionGenericLivePreflightError("health_http_error", { status: healthResponse.status });
  }
  const health = await responseJson(healthResponse, "health_invalid_json");
  if (health?.status !== "ok") throw new NotionGenericLivePreflightError("health_not_ok");

  const secretsResponse = await fetchWithTimeout(
    fetchImpl,
    `${config.apiBaseUrl}/agents/me/secrets`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.agentApiKey}`,
      },
    },
  );
  if (!secretsResponse.ok) {
    throw new NotionGenericLivePreflightError("secret_metadata_http_error", { status: secretsResponse.status });
  }
  const secretMetadata = await responseJson(secretsResponse, "secret_metadata_invalid_json");
  const available = Array.isArray(secretMetadata?.secrets)
    && secretMetadata.secrets.some((entry) => entry?.key === config.secretBindingKey && entry?.delivery === "api");
  if (!available) throw new NotionGenericLivePreflightError("secret_binding_unavailable");

  return { config, browserModule: await loadBrowser() };
}

export async function fetchNotionTestCredentials(config, fetchImpl = globalThis.fetch) {
  const response = await fetchWithTimeout(
    fetchImpl,
    `${config.apiBaseUrl}/agents/me/secrets/${encodeURIComponent(config.secretBindingKey)}/value`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.agentApiKey}`,
      },
    },
  );
  if (!response.ok) {
    throw new NotionGenericLivePreflightError("secret_value_http_error", { status: response.status });
  }
  const body = await responseJson(response, "secret_value_invalid_json");
  if (typeof body?.value !== "string") {
    throw new NotionGenericLivePreflightError("secret_value_missing");
  }
  let credential;
  try {
    credential = JSON.parse(body.value);
  } catch {
    throw new NotionGenericLivePreflightError("secret_value_invalid_shape");
  }
  const username = [credential?.email, credential?.username, credential?.login]
    .find((value) => typeof value === "string" && value.trim());
  const password = typeof credential?.password === "string" ? credential.password : "";
  if (!username || !password) {
    throw new NotionGenericLivePreflightError("secret_value_invalid_shape");
  }
  return { username: username.trim(), password };
}

export function assertAutomaticRegistrationSource(source) {
  if (source !== "cimd" && source !== "dcr") {
    throw new NotionGenericLivePreflightError("unexpected_registration_source");
  }
  return source;
}

export function persistedOAuthStartResult(connection, authorizationUrl) {
  const cleanAuthorizationUrl = typeof authorizationUrl === "string" ? authorizationUrl.trim() : "";
  const oauth = connection?.config?.oauth;
  if (!connection?.id || !cleanAuthorizationUrl || !oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
    return null;
  }
  return {
    connectionId: connection.id,
    authorizationUrl: cleanAuthorizationUrl,
    registrationSource: oauth.clientRegistrationSource ?? null,
    issuer: oauth.issuer ?? null,
    resource: oauth.resource ?? null,
  };
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Normalize the server's sanitized removal receipt. Partial-flow cleanup may
 * legitimately remove zero installs or credentials; the completed smoke uses
 * the stricter mode to prove the installed/authenticated state was revoked.
 */
export function connectionRemovalFacts(receipt, { requireInstalled = false } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const numericFields = [
    "installsRemoved",
    "appProfileBindingsRemoved",
    "credentialRefsCleared",
    "secretsRevoked",
    "secretBindingsRemoved",
    "grantsRevoked",
    "oauthStatesDiscarded",
    "runtimeSlotsStopped",
  ];
  if (numericFields.some((key) => !nonNegativeInteger(receipt[key]))) return null;
  const credentialsRemoved = receipt.credentialRefsCleared + receipt.secretsRevoked;
  if (!["absent", "deleted", "archived"].includes(receipt.appProfile)) return null;
  if (requireInstalled && (
    receipt.installsRemoved !== 1
    || receipt.appProfileBindingsRemoved < 1
    || credentialsRemoved < 1
    || !["deleted", "archived"].includes(receipt.appProfile)
  )) return null;
  return {
    credentialsRemoved,
    secretBindingsRemoved: receipt.secretBindingsRemoved,
    grantsRevoked: receipt.grantsRevoked,
    accessBindingsRemoved: receipt.appProfileBindingsRemoved,
    installsRemoved: receipt.installsRemoved,
    oauthStatesDiscarded: receipt.oauthStatesDiscarded,
    runtimeSlotsStopped: receipt.runtimeSlotsStopped,
    appProfile: receipt.appProfile,
  };
}

export function safeEndpointSummary(raw, label) {
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new NotionGenericLivePreflightError(`unsafe_${label}_endpoint`);
  }
  if (endpoint.protocol !== "https:"
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash) {
    throw new NotionGenericLivePreflightError(`unsafe_${label}_endpoint`);
  }
  return { origin: endpoint.origin, path: endpoint.pathname };
}

export function inspectAuthorizationUrl(raw, {
  callbackUrl,
  resource,
  registrationSource,
  baseUrl,
}) {
  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new NotionGenericLivePreflightError("unsafe_authorization_endpoint");
  }
  if (target.protocol !== "https:" || target.username || target.password || target.hash) {
    throw new NotionGenericLivePreflightError("unsafe_authorization_endpoint");
  }
  const required = ["client_id", "state", "code_challenge", "redirect_uri", "resource"];
  if (required.some((key) => !target.searchParams.get(key))) {
    throw new NotionGenericLivePreflightError("authorization_parameter_missing");
  }
  if (target.searchParams.get("code_challenge_method") !== "S256") {
    throw new NotionGenericLivePreflightError("pkce_s256_missing");
  }
  if (target.searchParams.get("redirect_uri") !== callbackUrl) {
    throw new NotionGenericLivePreflightError("callback_uri_mismatch");
  }
  if (target.searchParams.get("resource") !== resource) {
    throw new NotionGenericLivePreflightError("resource_mismatch");
  }
  if (target.searchParams.get("response_type") !== "code") {
    throw new NotionGenericLivePreflightError("response_type_mismatch");
  }
  if (registrationSource === "cimd") {
    const expectedClientId = new URL("/api/tools/oauth/client-metadata", baseUrl).toString();
    if (target.searchParams.get("client_id") !== expectedClientId) {
      throw new NotionGenericLivePreflightError("cimd_client_id_mismatch");
    }
  }
  return {
    endpoint: { origin: target.origin, path: target.pathname },
    parameters: {
      clientId: true,
      state: true,
      pkceS256: true,
      callbackUri: true,
      resource: true,
    },
  };
}

function parsedJsonString(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200_000) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  for (const candidate of fenced ? [fenced[1], trimmed] : [trimmed]) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // A later recursive branch may still contain structured content.
    }
  }
  return null;
}

export function extractNotionIdentity(value) {
  const seen = new Set();
  const facts = { workspaceId: null, workspaceName: null, botId: null };
  const visit = (candidate, depth) => {
    if (depth > 12 || candidate === null || candidate === undefined) return;
    if (typeof candidate === "string") {
      const parsed = parsedJsonString(candidate);
      if (parsed !== null) visit(parsed, depth + 1);
      return;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (!Array.isArray(candidate)) {
      const workspaceId = candidate.workspace_id ?? candidate.workspaceId;
      const workspaceName = candidate.workspace_name ?? candidate.workspaceName;
      if (!facts.workspaceId && typeof workspaceId === "string" && workspaceId.trim()) facts.workspaceId = workspaceId.trim();
      if (!facts.workspaceName && typeof workspaceName === "string" && workspaceName.trim()) facts.workspaceName = workspaceName.trim();
      if (!facts.botId && candidate.type === "bot" && typeof candidate.id === "string" && candidate.id.trim()) {
        facts.botId = candidate.id.trim();
      }
    }
    for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate)) visit(child, depth + 1);
  };
  visit(value, 0);
  return (facts.workspaceId || facts.botId) && facts.workspaceName ? facts : null;
}

export function parseSanitizedAgentProof(commentBody, expectedIdentity) {
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
  if (Object.keys(parsed).sort().join(",") !== "invocationId,workspaceId,workspaceName") return null;
  if (parsed.workspaceId !== expectedIdentity.workspaceId || parsed.workspaceName !== expectedIdentity.workspaceName) return null;
  if (typeof parsed.invocationId !== "string" || !parsed.invocationId.trim()) return null;
  return {
    workspaceId: parsed.workspaceId,
    workspaceName: parsed.workspaceName,
    invocationId: parsed.invocationId.trim(),
  };
}

export function parseRuntimeAbsenceProof(commentBody, connectionId) {
  if (typeof commentBody !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(commentBody.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).sort().join(",") !== "connectionId,toolPresent") return null;
  return parsed.connectionId === connectionId && parsed.toolPresent === false
    ? { connectionId, toolPresent: false }
    : null;
}

const FORBIDDEN_EVIDENCE_KEYS = /(?:password|access[_-]?token|refresh[_-]?token|authorization|cookie|oauth[_-]?code|client[_-]?secret|session)/i;
const FORBIDDEN_EVIDENCE_TEXT = /(?:authorization:\s*bearer|cookie:|[?&](?:code|state|token|access_token|refresh_token)=)/i;

export function assertSanitizedEvidence(value) {
  const seen = new Set();
  const visit = (candidate, path) => {
    if (candidate === null || candidate === undefined) return;
    if (typeof candidate === "string") {
      if (FORBIDDEN_EVIDENCE_TEXT.test(candidate)) throw new Error(`unsafe_evidence_text:${path}`);
      return;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (FORBIDDEN_EVIDENCE_KEYS.test(key)) throw new Error(`unsafe_evidence_key:${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "$");
}

export function preflightFailureMessage(error) {
  if (!(error instanceof NotionGenericLivePreflightError)) {
    return "Notion generic live smoke preflight failed.";
  }
  if (error.code === "missing_environment") {
    return `Notion generic live smoke preflight failed: missing ${error.details.missing.join(", ")}.`;
  }
  if (error.code === "health_http_error") {
    return `Notion generic live smoke preflight failed: /api/health returned HTTP ${error.details.status}.`;
  }
  return `Notion generic live smoke preflight failed: ${error.code}.`;
}
