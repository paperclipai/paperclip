import {
  createHash,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  toolCallEvents,
  toolGovnaAuthorityOperations,
  toolInvocations,
  type Db,
} from "@paperclipai/db";

export type AuthorityHostOperation = "prepare" | "status" | "cancel" | "dispatch";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const HOST_DIGEST_PREFIX = "govna-authority-host-request-v1\n";
const TOOL_DIGEST_PREFIX = "govna-authority-request-v1\n";
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RESERVATION_PATTERN = /^arv_[0-9a-hjkmnp-tv-z]{26}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMPACT_JWS_BYTES = 16 * 1024;
const PUBLIC_ID_BODY = "[0-9a-hjkmnp-tv-z]{26}";

const AUTHORITY_BINDING_FIELDS = [
  "iss", "aud", "version", "challenge", "host_request_hash", "trust_id",
  "trust_revision", "revocation_epoch", "host_key_id", "organization_id",
  "oauth_client_id", "actor_id", "agent_id", "session_id", "grant_id",
  "operation_id", "host_context_id", "local_policy_revision",
  "connection_generation", "resource", "connector_identity_id", "tool_id",
  "tool_name", "snapshot_digest", "request_hash", "evaluated_action_digest",
  "enforcement_revision", "reservation_id", "approval_id",
  "approval_expires_at", "approval_route_digest", "human_approval_required",
] as const;
const TIME_FIELDS = ["iat", "nbf", "exp", "jti"] as const;
const STATEMENT_FIELDS = {
  pending: [...AUTHORITY_BINDING_FIELDS, ...TIME_FIELDS, "state", "approval_url", "safe_summary"],
  status: [
    ...AUTHORITY_BINDING_FIELDS,
    ...TIME_FIELDS,
    "state",
    "approval_url",
    "safe_summary",
    "ticket_generation",
    "decision_actor_id",
    "decision_at",
    "decision_evidence_id",
  ],
  ticket: [
    ...AUTHORITY_BINDING_FIELDS,
    ...TIME_FIELDS,
    "state",
    "ticket_generation",
    "decision_actor_id",
    "decision_at",
    "decision_evidence_id",
  ],
} as const;
const STATEMENT_TYPE = {
  pending: "govna-approval-authority+jwt",
  status: "govna-authority-status+jwt",
  ticket: "govna-dispatch-ticket+jwt",
} as const;

const OPERATION_FIELDS: Record<AuthorityHostOperation, readonly string[]> = {
  prepare: [
    "trust_revision",
    "operation_id",
    "host_context_id",
    "local_policy_revision",
    "connection_generation",
    "name",
    "arguments",
  ],
  status: ["reservation_id", "operation_id", "trust_revision"],
  cancel: ["reservation_id", "operation_id", "trust_revision"],
  dispatch: [
    "reservation_id",
    "operation_id",
    "trust_revision",
    "ticket_digest",
    "request_hash",
    "local_claim_id",
  ],
};

const AUTHORITY_CONFIG_FIELDS = [
  "mode",
  "prepareEndpoint",
  "statusEndpoint",
  "cancelEndpoint",
  "approvalOrigin",
  "resource",
  "trustId",
  "trustRevision",
  "hostContextId",
  "localPolicyRevision",
  "connectionGeneration",
  "issuer",
  "audience",
  "hostKeyId",
  "hostSigningKeySecretId",
  "statementKeyId",
  "statementPublicKeyPem",
  "tools",
] as const;

export type GovnaApprovalAuthorityConfig = {
  mode: "required";
  prepareEndpoint: string;
  statusEndpoint: string;
  cancelEndpoint: string;
  approvalOrigin: string;
  resource: string;
  trustId: string;
  trustRevision: number;
  hostContextId: string;
  localPolicyRevision: string;
  connectionGeneration: number;
  issuer: string;
  audience: string;
  hostKeyId: string;
  hostSigningKeySecretId: string;
  statementKeyId: string;
  statementPublicKeyPem: string;
  tools: string[];
};

function sha256Base64Url(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}

function assertGraphicText(value: unknown, label: string, maxBytes = 256): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    [...value].some((character) => /[\p{Cc}\p{Cf}\p{Cs}]/u.test(character))
  ) {
    throw new Error(`Invalid Govna authority ${label}`);
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Invalid Govna authority ${label}`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid Govna authority ${label}`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new Error(`Invalid Govna authority ${label}`);
  }
}

function assertHttpsEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Invalid Govna authority endpoint");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.toString() !== endpoint
  ) {
    throw new Error("Invalid Govna authority endpoint");
  }
}

function assertHttpsOrigin(origin: unknown): asserts origin is string {
  if (typeof origin !== "string") throw new Error("Invalid Govna approval origin");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("Invalid Govna approval origin");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== origin
  ) {
    throw new Error("Invalid Govna approval origin");
  }
}

/**
 * Govna is opt-in twice: the connection selects required authority for an
 * exact tool allowlist, and the matched local approval policy marks itself as
 * delegable. Missing configuration always retains Paperclip's local approval.
 */
export function parseGovnaAuthorityConfig(
  connectionConfig: Record<string, unknown>,
  matchedPolicies: Array<{ policyType: string; config: unknown }>,
  toolName: string,
): GovnaApprovalAuthorityConfig | null {
  const raw = connectionConfig.govnaApprovalAuthority;
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid Govna approval-authority configuration");
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((field) => !AUTHORITY_CONFIG_FIELDS.includes(field as typeof AUTHORITY_CONFIG_FIELDS[number]))) {
    throw new Error("Govna approval-authority configuration contains an unknown field");
  }
  if (AUTHORITY_CONFIG_FIELDS.some((field) => !(field in value))) {
    throw new Error("Govna approval-authority configuration is incomplete");
  }
  if (value.mode !== "required") throw new Error("Unsupported Govna approval-authority mode");
  for (const field of ["prepareEndpoint", "statusEndpoint", "cancelEndpoint", "resource"] as const) {
    if (typeof value[field] !== "string") throw new Error(`Invalid Govna ${field}`);
    assertHttpsEndpoint(value[field]);
  }
  assertHttpsOrigin(value.approvalOrigin);
  assertGraphicText(value.trustId, "trust id");
  assertPositiveSafeInteger(value.trustRevision, "trust revision");
  assertGraphicText(value.hostContextId, "host context id");
  assertGraphicText(value.localPolicyRevision, "local policy revision");
  assertPositiveSafeInteger(value.connectionGeneration, "connection generation");
  assertHttpsStatementUrl(value.issuer, "host issuer");
  assertGraphicText(value.audience, "audience");
  assertGraphicText(value.hostKeyId, "host key id", 128);
  assertGraphicText(value.hostSigningKeySecretId, "host signing key secret id", 160);
  assertGraphicText(value.statementKeyId, "statement key id", 128);
  if (
    typeof value.statementPublicKeyPem !== "string" ||
    Buffer.byteLength(value.statementPublicKeyPem, "utf8") > 8 * 1024 ||
    !value.statementPublicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
    !value.statementPublicKeyPem.endsWith("\n-----END PUBLIC KEY-----")
  ) {
    throw new Error("Invalid Govna statement public key");
  }
  if (
    !Array.isArray(value.tools) ||
    value.tools.length === 0 ||
    !value.tools.every((name) => typeof name === "string" && name.length > 0) ||
    new Set(value.tools).size !== value.tools.length
  ) {
    throw new Error("Invalid Govna tool allowlist");
  }
  if (!value.tools.includes(toolName)) {
    throw new Error("Tool is not allowlisted for Govna approval authority");
  }
  const delegated = matchedPolicies.some((policy) => {
    if (policy.policyType !== "require_approval" || !policy.config || typeof policy.config !== "object" || Array.isArray(policy.config)) {
      return false;
    }
    return (policy.config as Record<string, unknown>).govnaDelegation === "delegable_exact_call";
  });
  return delegated ? value as GovnaApprovalAuthorityConfig : null;
}

function assertHttpsStatementUrl(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`Invalid Govna ${label}`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Govna ${label}`);
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Invalid Govna ${label}`);
  }
}

function assertJsonValue(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > 32) throw new Error("Govna authority JSON nesting exceeds 32 levels");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    for (const character of value) {
      const codePoint = character.codePointAt(0)!;
      if (
        (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
        (codePoint & 0xffff) === 0xfffe ||
        (codePoint & 0xffff) === 0xffff
      ) {
        throw new Error("Govna authority JSON contains a Unicode noncharacter");
      }
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error("Govna authority JSON contains a non-interoperable number");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  if (typeof value !== "object") {
    throw new Error("Govna authority JSON is not interoperable JSON");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Govna authority JSON must use plain objects");
  }
  for (const [key, item] of Object.entries(value)) {
    assertJsonValue(key, depth + 1);
    assertJsonValue(item, depth + 1);
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function validateAuthorityBody(
  operation: AuthorityHostOperation,
  input: Record<string, unknown>,
): Record<string, JsonValue> {
  const allowed = OPERATION_FIELDS[operation];
  if (Object.keys(input).some((field) => !allowed.includes(field))) {
    throw new Error("Govna authority body contains an unknown field");
  }
  const required = operation === "prepare" ? allowed.filter((field) => field !== "arguments") : allowed;
  if (required.some((field) => !(field in input))) {
    throw new Error("Govna authority body is missing a required field");
  }
  assertPositiveSafeInteger(input.trust_revision, "trust revision");
  assertGraphicText(input.operation_id, "operation id", 160);

  if (operation === "prepare") {
    assertGraphicText(input.host_context_id, "host context id");
    assertGraphicText(input.local_policy_revision, "local policy revision");
    assertPositiveSafeInteger(input.connection_generation, "connection generation");
    assertGraphicText(input.name, "tool name");
    const argumentsValue = input.arguments ?? {};
    if (
      !argumentsValue ||
      typeof argumentsValue !== "object" ||
      Array.isArray(argumentsValue)
    ) {
      throw new Error("Govna authority arguments must be an object");
    }
    const normalized = { ...input, arguments: argumentsValue };
    assertJsonValue(normalized);
    return normalized as Record<string, JsonValue>;
  }

  if (typeof input.reservation_id !== "string" || !RESERVATION_PATTERN.test(input.reservation_id)) {
    throw new Error("Invalid Govna authority reservation id");
  }
  if (operation === "dispatch") {
    assertDigest(input.ticket_digest, "ticket digest");
    assertDigest(input.request_hash, "request hash");
    assertGraphicText(input.local_claim_id, "local claim id", 160);
  }
  assertJsonValue(input);
  return input as Record<string, JsonValue>;
}

export function authorityHostEnvelopeHash(
  operation: AuthorityHostOperation,
  endpoint: string,
  input: Record<string, unknown>,
): string {
  assertHttpsEndpoint(endpoint);
  const body = validateAuthorityBody(operation, input);
  const canonical = canonicalJson({ operation, endpoint, body });
  if (Buffer.byteLength(canonical, "utf8") > MAX_BODY_BYTES) {
    throw new Error("Govna authority request exceeds 64 KiB");
  }
  return sha256Base64Url(`${HOST_DIGEST_PREFIX}${canonical}`);
}

export function authorityRequestHash(
  name: string,
  argumentsValue: Record<string, unknown> | undefined,
): string {
  assertGraphicText(name, "tool name");
  const request = {
    method: "tools/call",
    name,
    arguments: argumentsValue ?? {},
  };
  assertJsonValue(request);
  return sha256Base64Url(`${TOOL_DIGEST_PREFIX}${canonicalJson(request)}`);
}

export function digestAuthorityBearer(bearer: string): string {
  if (!bearer || /\s/.test(bearer)) throw new Error("Invalid Govna authority bearer");
  return sha256Base64Url(bearer);
}

export function digestDispatchTicket(ticket: string): string {
  if (!ticket || Buffer.byteLength(ticket, "utf8") > MAX_COMPACT_JWS_BYTES || /\s/.test(ticket)) {
    throw new Error("Invalid Govna dispatch ticket");
  }
  return sha256Base64Url(ticket);
}

export function parseCompactJws(compact: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Buffer;
  signingInput: string;
} {
  if (!compact || Buffer.byteLength(compact, "utf8") > MAX_COMPACT_JWS_BYTES || /\s/.test(compact)) {
    throw new Error("Invalid compact JWS");
  }
  const parts = compact.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("Invalid compact JWS");
  const decodeObject = (part: string): Record<string, unknown> => {
    const bytes = Buffer.from(part, "base64url");
    if (bytes.toString("base64url") !== part) throw new Error("Invalid compact JWS encoding");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid compact JWS object");
    }
    return parsed as Record<string, unknown>;
  };
  const signature = Buffer.from(parts[2]!, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== parts[2]) {
    throw new Error("Invalid ES256 signature encoding");
  }
  return {
    header: decodeObject(parts[0]!),
    payload: decodeObject(parts[1]!),
    signature,
    signingInput: `${parts[0]}.${parts[1]}`,
  };
}

function assertPublicId(value: unknown, prefix: string, label: string): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_${PUBLIC_ID_BODY}$`).test(value)) {
    throw new Error(`Invalid Govna ${label}`);
  }
}

function assertAuthorityBinding(payload: Record<string, unknown>): void {
  if (payload.version !== 1 || payload.human_approval_required !== true) {
    throw new Error("Invalid Govna authority protocol binding");
  }
  assertHttpsStatementUrl(payload.iss, "statement issuer");
  assertHttpsStatementUrl(payload.resource, "statement resource");
  assertGraphicText(payload.aud, "statement audience");
  assertDigest(payload.challenge, "statement challenge");
  assertDigest(payload.host_request_hash, "statement host request hash");
  assertPositiveSafeInteger(payload.trust_revision, "statement trust revision");
  if (!Number.isSafeInteger(payload.revocation_epoch) || Number(payload.revocation_epoch) < 0) {
    throw new Error("Invalid Govna authority revocation epoch");
  }
  assertGraphicText(payload.host_key_id, "statement host key id", 128);
  assertPublicId(payload.trust_id, "atr", "trust id");
  assertPublicId(payload.organization_id, "org", "organization id");
  assertPublicId(payload.oauth_client_id, "agt", "OAuth client id");
  assertPublicId(payload.actor_id, "usr", "actor id");
  if (payload.agent_id !== null) assertPublicId(payload.agent_id, "agt", "agent id");
  assertPublicId(payload.session_id, "ses", "session id");
  assertPublicId(payload.grant_id, "grn", "grant id");
  assertPublicId(payload.connector_identity_id, "idn", "connector identity id");
  assertPublicId(payload.tool_id, "ctl", "tool id");
  assertPublicId(payload.reservation_id, "arv", "reservation id");
  assertPublicId(payload.approval_id, "apr", "approval id");
  for (const field of ["operation_id", "host_context_id", "local_policy_revision", "tool_name"] as const) {
    assertGraphicText(payload[field], `statement ${field}`);
  }
  assertPositiveSafeInteger(payload.connection_generation, "statement connection generation");
  for (const field of ["snapshot_digest", "evaluated_action_digest", "enforcement_revision", "approval_route_digest"] as const) {
    if (typeof payload[field] !== "string" || !/^[0-9a-f]{64}$/.test(payload[field])) {
      throw new Error(`Invalid Govna authority ${field}`);
    }
  }
  assertDigest(payload.request_hash, "statement request hash");
  assertPositiveSafeInteger(payload.approval_expires_at, "approval expiry");
}

function assertStatementTime(
  payload: Record<string, unknown>,
  now: number,
  maximumLifetimeSeconds: number,
): void {
  const { iat, nbf, exp } = payload;
  if (
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(nbf) ||
    !Number.isSafeInteger(exp) ||
    Number(iat) < 0 ||
    Number(iat) > Number(nbf) ||
    Number(nbf) >= Number(exp) ||
    Number(iat) > now + 5 ||
    Number(nbf) > now + 5 ||
    Number(exp) <= now ||
    Number(exp) - Number(iat) > maximumLifetimeSeconds
  ) {
    throw new Error("Invalid Govna authority statement time");
  }
  assertDigest(payload.jti, "statement id");
}

function assertApprovalUrl(
  value: unknown,
  approvalOrigin: string | undefined,
  payload: Record<string, unknown>,
): void {
  if (!approvalOrigin || typeof value !== "string") throw new Error("Invalid Govna approval URL");
  const expected = `${approvalOrigin}/authority-approval?org=${payload.organization_id}&reservation=${payload.reservation_id}`;
  if (value !== expected) throw new Error("Invalid Govna approval URL");
}

function assertDecisionTuple(payload: Record<string, unknown>, requireGeneration: boolean): void {
  if (requireGeneration) assertPositiveSafeInteger(payload.ticket_generation, "ticket generation");
  else if (payload.ticket_generation !== undefined) throw new Error("Unexpected Govna ticket generation");
  assertPublicId(payload.decision_actor_id, "usr", "decision actor id");
  if (
    !Number.isSafeInteger(payload.decision_at) ||
    Number(payload.decision_at) < 0 ||
    Number(payload.decision_at) > Number(payload.iat)
  ) {
    throw new Error("Invalid Govna decision time");
  }
  assertPublicId(payload.decision_evidence_id, "evt", "decision evidence id");
}

export function verifyAuthorityStatement(input: {
  compact: string;
  publicKey: KeyObject;
  keyId: string;
  type: keyof typeof STATEMENT_FIELDS;
  now: number;
  expected: Record<string, unknown>;
  approvalOrigin?: string;
}): { payload: Record<string, unknown> } {
  const parsed = parseCompactJws(input.compact);
  const expectedHeader = {
    alg: "ES256",
    typ: STATEMENT_TYPE[input.type],
    kid: input.keyId,
  };
  if (
    Object.keys(parsed.header).length !== 3 ||
    Object.entries(expectedHeader).some(([key, value]) => parsed.header[key] !== value)
  ) {
    throw new Error("Invalid Govna authority JOSE header");
  }
  if (!verify("sha256", Buffer.from(parsed.signingInput), {
    key: input.publicKey,
    dsaEncoding: "ieee-p1363",
  }, parsed.signature)) {
    throw new Error("Invalid Govna authority signature");
  }
  const allowed = new Set<string>(STATEMENT_FIELDS[input.type]);
  if (Object.keys(parsed.payload).some((field) => !allowed.has(field))) {
    throw new Error("Govna authority statement contains an unknown claim");
  }
  const required = input.type === "status"
    ? [...AUTHORITY_BINDING_FIELDS, ...TIME_FIELDS, "state"]
    : STATEMENT_FIELDS[input.type];
  if (required.some((field) => !(field in parsed.payload))) {
    throw new Error("Govna authority statement is missing a claim");
  }
  assertAuthorityBinding(parsed.payload);
  assertStatementTime(parsed.payload, input.now, input.type === "ticket" ? 30 : 60);
  for (const [field, expected] of Object.entries(input.expected)) {
    if (JSON.stringify(parsed.payload[field]) !== JSON.stringify(expected)) {
      throw new Error(`Govna authority binding mismatch: ${field}`);
    }
  }

  const state = parsed.payload.state;
  if (input.type === "pending") {
    if (state !== "pending" || Number(parsed.payload.exp) > Number(parsed.payload.approval_expires_at)) {
      throw new Error("Invalid Govna pending authority state");
    }
    assertApprovalUrl(parsed.payload.approval_url, input.approvalOrigin, parsed.payload);
    assertGraphicText(parsed.payload.safe_summary, "safe summary", 2048);
    if ([...String(parsed.payload.safe_summary)].length > 512) throw new Error("Govna safe summary is too long");
  } else if (input.type === "ticket") {
    if (state !== "approved" || Number(parsed.payload.exp) > Number(parsed.payload.approval_expires_at)) {
      throw new Error("Invalid Govna dispatch ticket state");
    }
    assertDecisionTuple(parsed.payload, true);
  } else if (state === "pending") {
    assertApprovalUrl(parsed.payload.approval_url, input.approvalOrigin, parsed.payload);
    assertGraphicText(parsed.payload.safe_summary, "safe summary", 2048);
    if (parsed.payload.ticket_generation !== undefined || parsed.payload.decision_actor_id !== undefined || parsed.payload.decision_at !== undefined || parsed.payload.decision_evidence_id !== undefined) {
      throw new Error("Pending Govna status contains decision claims");
    }
  } else if (["approved", "dispatched", "completed"].includes(String(state))) {
    if (parsed.payload.approval_url !== undefined || parsed.payload.safe_summary !== undefined) throw new Error("Decided Govna status contains pending display claims");
    assertDecisionTuple(parsed.payload, true);
  } else if (state === "denied") {
    if (parsed.payload.approval_url !== undefined || parsed.payload.safe_summary !== undefined) throw new Error("Denied Govna status contains pending display claims");
    assertDecisionTuple(parsed.payload, false);
  } else if (["expired", "revoked", "outcome_unknown"].includes(String(state))) {
    if (parsed.payload.approval_url !== undefined || parsed.payload.safe_summary !== undefined) throw new Error("Terminal Govna status contains pending display claims");
    const hasDecision = parsed.payload.decision_actor_id !== undefined || parsed.payload.decision_at !== undefined || parsed.payload.decision_evidence_id !== undefined || parsed.payload.ticket_generation !== undefined;
    if (hasDecision) assertDecisionTuple(parsed.payload, parsed.payload.ticket_generation !== undefined);
  } else {
    throw new Error("Invalid Govna authority status state");
  }
  return { payload: parsed.payload };
}

export function createAuthorityHostProof(input: {
  privateKey: KeyObject;
  keyId: string;
  issuer: string;
  audience: string;
  trustId: string;
  trustRevision: number;
  bearer: string;
  operation: AuthorityHostOperation;
  endpoint: string;
  hostRequestHash: string;
  localClaimId?: string;
  now: number;
  challenge?: string;
  statementId?: string;
}): string {
  assertGraphicText(input.keyId, "host key id", 128);
  assertGraphicText(input.issuer, "host issuer");
  assertGraphicText(input.audience, "proof audience");
  assertGraphicText(input.trustId, "trust id");
  assertPositiveSafeInteger(input.trustRevision, "trust revision");
  assertHttpsEndpoint(input.endpoint);
  assertDigest(input.hostRequestHash, "host request hash");
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("Invalid proof time");
  if (input.operation === "dispatch") {
    assertGraphicText(input.localClaimId, "local claim id", 160);
  } else if (input.localClaimId !== undefined) {
    throw new Error("A local claim id is valid only for dispatch");
  }
  const challenge = input.challenge ?? randomBytes(32).toString("base64url");
  const statementId = input.statementId ?? randomBytes(32).toString("base64url");
  assertDigest(challenge, "challenge");
  assertDigest(statementId, "statement id");
  const header = {
    alg: "ES256",
    typ: "govna-host-proof+jwt",
    kid: input.keyId,
  };
  const payload = {
    iss: input.issuer,
    aud: input.audience,
    version: 1,
    challenge,
    host_request_hash: input.hostRequestHash,
    ath: digestAuthorityBearer(input.bearer),
    operation: input.operation,
    endpoint: input.endpoint,
    trust_id: input.trustId,
    trust_revision: input.trustRevision,
    host_key_id: input.keyId,
    local_claim_id: input.operation === "dispatch" ? input.localClaimId : null,
    iat: input.now,
    nbf: input.now,
    exp: input.now + 30,
    jti: statementId,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export class GovnaAuthorityStateError extends Error {
  constructor(
    public readonly code:
      | "binding_mismatch"
      | "invocation_invalid"
      | "not_approvable"
      | "not_dispatchable"
      | "not_claimed",
    message: string,
  ) {
    super(message);
    this.name = "GovnaAuthorityStateError";
  }
}

type ReserveAuthorityOperationInput = {
  companyId: string;
  invocationId: string;
  connectionId: string;
  operationId: string;
  hostContextId: string;
  localPolicyRevision: string;
  connectionGeneration: number;
  requestHash: string;
  signedArguments: string;
  authorityBinding: Record<string, unknown>;
  reservationId: string;
  approvalUrl: string;
  safeSummary: string;
  approvalExpiresAt: Date;
};

type AuthorityDispatchBinding = {
  companyId: string;
  operationId: string;
  reservationId: string;
  requestHash: string;
  localPolicyRevision: string;
  connectionGeneration: number;
  ticketGeneration: number;
};

function sameJson(left: unknown, right: unknown): boolean {
  assertJsonValue(left);
  assertJsonValue(right);
  return canonicalJson(left) === canonicalJson(right);
}

function assertStoredBinding(
  operation: typeof toolGovnaAuthorityOperations.$inferSelect,
  input: Omit<AuthorityDispatchBinding, "companyId" | "ticketGeneration">,
): void {
  if (
    operation.operationId !== input.operationId ||
    operation.reservationId !== input.reservationId ||
    operation.requestHash !== input.requestHash ||
    operation.localPolicyRevision !== input.localPolicyRevision ||
    operation.connectionGeneration !== input.connectionGeneration
  ) {
    throw new GovnaAuthorityStateError("binding_mismatch", "Govna authority binding changed");
  }
}

function assertReservationReplay(
  operation: typeof toolGovnaAuthorityOperations.$inferSelect,
  input: ReserveAuthorityOperationInput,
): void {
  if (
    operation.companyId !== input.companyId ||
    operation.invocationId !== input.invocationId ||
    operation.connectionId !== input.connectionId ||
    operation.operationId !== input.operationId ||
    operation.hostContextId !== input.hostContextId ||
    operation.localPolicyRevision !== input.localPolicyRevision ||
    operation.connectionGeneration !== input.connectionGeneration ||
    operation.requestHash !== input.requestHash ||
    operation.signedArguments !== input.signedArguments ||
    operation.reservationId !== input.reservationId ||
    operation.approvalUrl !== input.approvalUrl ||
    operation.safeSummary !== input.safeSummary ||
    operation.approvalExpiresAt.getTime() !== input.approvalExpiresAt.getTime() ||
    !sameJson(operation.authorityBinding, input.authorityBinding)
  ) {
    throw new GovnaAuthorityStateError("binding_mismatch", "Govna authority reservation replay changed");
  }
}

/**
 * Persists the Paperclip half of Govna's exact-call authorization protocol.
 * A dispatch claim and its local audit intent are committed together. Once a
 * claim exists, callers must reconcile its outcome and must never replay it.
 */
export function govnaAuthorityOperationService(db: Db) {
  async function reserve(input: ReserveAuthorityOperationInput) {
    assertPositiveSafeInteger(input.connectionGeneration, "connection generation");
    assertJsonValue(input.authorityBinding);
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(toolGovnaAuthorityOperations)
        .where(and(
          eq(toolGovnaAuthorityOperations.companyId, input.companyId),
          eq(toolGovnaAuthorityOperations.operationId, input.operationId),
        ))
        .for("update");
      if (existing) {
        assertReservationReplay(existing, input);
        return { operation: existing, replayed: true };
      }
      const [invocation] = await tx
        .select()
        .from(toolInvocations)
        .where(and(
          eq(toolInvocations.id, input.invocationId),
          eq(toolInvocations.companyId, input.companyId),
        ))
        .for("update");
      if (
        !invocation ||
        invocation.connectionId !== input.connectionId ||
        invocation.policyDecision !== "require_approval" ||
        invocation.approvalState !== "pending" ||
        invocation.status !== "awaiting_approval"
      ) {
        throw new GovnaAuthorityStateError("invocation_invalid", "Invocation cannot be delegated to Govna");
      }
      const [operation] = await tx.insert(toolGovnaAuthorityOperations).values(input).returning();
      return { operation: operation!, replayed: false };
    });
  }

  async function approve(input: AuthorityDispatchBinding) {
    return db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(toolGovnaAuthorityOperations)
        .where(and(
          eq(toolGovnaAuthorityOperations.companyId, input.companyId),
          eq(toolGovnaAuthorityOperations.operationId, input.operationId),
        ))
        .for("update");
      if (!operation) throw new GovnaAuthorityStateError("not_approvable", "Govna authority operation not found");
      assertStoredBinding(operation, input);
      if (operation.state === "approved" && operation.ticketGeneration === input.ticketGeneration) return operation;
      if (operation.state !== "pending") {
        throw new GovnaAuthorityStateError("not_approvable", "Govna authority operation is not pending");
      }
      const [approved] = await tx
        .update(toolGovnaAuthorityOperations)
        .set({ state: "approved", ticketGeneration: input.ticketGeneration, updatedAt: new Date() })
        .where(eq(toolGovnaAuthorityOperations.id, operation.id))
        .returning();
      return approved!;
    });
  }

  async function claimDispatch(input: AuthorityDispatchBinding) {
    return db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(toolGovnaAuthorityOperations)
        .where(and(
          eq(toolGovnaAuthorityOperations.companyId, input.companyId),
          eq(toolGovnaAuthorityOperations.operationId, input.operationId),
        ))
        .for("update");
      if (!operation) throw new GovnaAuthorityStateError("not_dispatchable", "Govna authority operation not found");
      assertStoredBinding(operation, input);
      if (operation.state !== "approved" || operation.ticketGeneration !== input.ticketGeneration) {
        throw new GovnaAuthorityStateError("not_dispatchable", "Govna authority operation is not dispatchable");
      }
      const [invocation] = await tx
        .select()
        .from(toolInvocations)
        .where(and(
          eq(toolInvocations.id, operation.invocationId),
          eq(toolInvocations.companyId, input.companyId),
        ))
        .for("update");
      if (
        !invocation ||
        invocation.connectionId !== operation.connectionId ||
        invocation.approvalState !== "pending" ||
        invocation.status !== "awaiting_approval"
      ) {
        throw new GovnaAuthorityStateError("invocation_invalid", "Invocation changed before Govna dispatch");
      }
      const localClaimId = `gcl_${randomUUID()}`;
      const now = new Date();
      const [claimed] = await tx
        .update(toolGovnaAuthorityOperations)
        .set({ state: "dispatch_claimed", localClaimId, claimedAt: now, updatedAt: now })
        .where(eq(toolGovnaAuthorityOperations.id, operation.id))
        .returning();
      await tx
        .update(toolInvocations)
        .set({ approvalState: "approved", status: "executing", startedAt: now, updatedAt: now })
        .where(eq(toolInvocations.id, invocation.id));
      await tx.insert(toolCallEvents).values({
        companyId: input.companyId,
        invocationId: invocation.id,
        eventType: "call_started",
        outcome: "pending",
        actorType: invocation.actorType,
        actorId: invocation.actorId,
        agentId: invocation.agentId,
        runId: invocation.runId,
        issueId: invocation.issueId,
        applicationId: invocation.applicationId,
        connectionId: invocation.connectionId,
        catalogEntryId: invocation.catalogEntryId,
        toolName: invocation.toolName,
        decision: "require_approval",
        matchedPolicyIds: invocation.matchedPolicyIds,
        reasonCode: "govna_dispatch_claimed",
        requestHash: operation.requestHash,
        requestSummary: invocation.argumentsSummary,
        metadata: {
          authority: "govna",
          authorityOperationId: operation.operationId,
          reservationId: operation.reservationId,
          ticketGeneration: input.ticketGeneration,
          localClaimId,
        },
      });
      return claimed!;
    });
  }

  async function markOutcomeUnknown(input: {
    companyId: string;
    operationId: string;
    errorCode: string;
  }) {
    return db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(toolGovnaAuthorityOperations)
        .where(and(
          eq(toolGovnaAuthorityOperations.companyId, input.companyId),
          eq(toolGovnaAuthorityOperations.operationId, input.operationId),
        ))
        .for("update");
      if (!operation || operation.state !== "dispatch_claimed") {
        throw new GovnaAuthorityStateError("not_claimed", "Govna authority operation has no dispatch claim");
      }
      const now = new Date();
      const [updated] = await tx
        .update(toolGovnaAuthorityOperations)
        .set({ state: "outcome_unknown", errorCode: input.errorCode, completedAt: now, updatedAt: now })
        .where(eq(toolGovnaAuthorityOperations.id, operation.id))
        .returning();
      await tx
        .update(toolInvocations)
        .set({ status: "failed", errorCode: input.errorCode, completedAt: now, updatedAt: now })
        .where(eq(toolInvocations.id, operation.invocationId));
      await tx.insert(toolCallEvents).values({
        companyId: input.companyId,
        invocationId: operation.invocationId,
        connectionId: operation.connectionId,
        eventType: "call_failed",
        outcome: "failure",
        decision: "require_approval",
        reasonCode: "govna_outcome_unknown",
        requestHash: operation.requestHash,
        errorCode: input.errorCode,
        metadata: {
          authority: "govna",
          authorityOperationId: operation.operationId,
          reservationId: operation.reservationId,
          localClaimId: operation.localClaimId,
        },
      });
      return updated!;
    });
  }

  async function complete(input: {
    companyId: string;
    operationId: string;
    outcome: "succeeded" | "failed";
    upstreamRequestId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }) {
    return db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(toolGovnaAuthorityOperations)
        .where(and(
          eq(toolGovnaAuthorityOperations.companyId, input.companyId),
          eq(toolGovnaAuthorityOperations.operationId, input.operationId),
        ))
        .for("update");
      if (!operation || operation.state !== "dispatch_claimed") {
        throw new GovnaAuthorityStateError("not_claimed", "Govna authority operation has no dispatch claim");
      }
      const now = new Date();
      const [updated] = await tx
        .update(toolGovnaAuthorityOperations)
        .set({ state: input.outcome, errorCode: input.errorCode ?? null, completedAt: now, updatedAt: now })
        .where(eq(toolGovnaAuthorityOperations.id, operation.id))
        .returning();
      await tx
        .update(toolInvocations)
        .set({
          status: input.outcome,
          upstreamRequestId: input.upstreamRequestId ?? null,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(toolInvocations.id, operation.invocationId));
      return updated!;
    });
  }

  return { reserve, approve, claimDispatch, markOutcomeUnknown, complete };
}
