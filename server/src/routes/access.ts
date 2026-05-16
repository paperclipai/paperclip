import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs";
import type { IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import type { Request } from "express";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assets,
  agentApiKeys,
  authUsers,
  companies,
  companyLogos,
  companyMemberships,
  instanceUserRoles,
  invites,
  joinRequests,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  acceptInviteSchema,
  createCliAuthChallengeSchema,
  claimJoinRequestApiKeySchema,
  createCompanyInviteSchema,
  createOpenClawInvitePromptSchema,
  listCompanyInvitesQuerySchema,
  listJoinRequestsQuerySchema,
  resolveCliAuthChallengeSchema,
  searchAdminUsersQuerySchema,
  updateCompanyMemberWithPermissionsSchema,
  updateCompanyMemberSchema,
  archiveCompanyMemberSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
  PERMISSION_KEYS
} from "@paperclipai/shared";
import type { DeploymentExposure, DeploymentMode, HumanCompanyMembershipRole, PermissionKey } from "@paperclipai/shared";
import {
  forbidden,
  conflict,
  notFound,
  unauthorized,
  badRequest
} from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { collectReachableInterfaceHosts } from "../runtime-api.js";
import {
  accessService,
  agentService,
  boardAuthService,
  deduplicateAgentName,
  logActivity,
  notifyHireApproved
} from "../services/index.js";
import {
  grantsForHumanRole,
  normalizeHumanRole,
  resolveHumanInviteRole,
} from "../services/company-member-roles.js";
import { humanJoinGrantsFromDefaults } from "../services/invite-grants.js";
import {
  collapseDuplicatePendingHumanJoinRequests,
  findReusableHumanJoinRequest,
} from "../lib/join-request-dedupe.js";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";
import {
  claimBoardOwnership,
  inspectBoardClaimChallenge
} from "../board-claim.js";
import { getStorageService } from "../storage/index.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const INVITE_TOKEN_PREFIX = "pcp_invite_";
const INVITE_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const INVITE_TOKEN_SUFFIX_LENGTH = 8;
const INVITE_TOKEN_MAX_RETRIES = 5;
const COMPANY_INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const INVITE_RESOLUTION_DNS_TIMEOUT_MS = 3_000;

type MemberGrantPayload = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

function createInviteToken() {
  const bytes = randomBytes(INVITE_TOKEN_SUFFIX_LENGTH);
  let suffix = "";
  for (let idx = 0; idx < INVITE_TOKEN_SUFFIX_LENGTH; idx += 1) {
    suffix += INVITE_TOKEN_ALPHABET[bytes[idx]! % INVITE_TOKEN_ALPHABET.length];
  }
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

function createClaimSecret() {
  return `pcp_claim_${randomBytes(24).toString("hex")}`;
}

export function companyInviteExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + COMPANY_INVITE_TTL_MS);
}

function tokenHashesMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function requestBaseUrl(req: Request) {
  const forwardedProto = req.header("x-forwarded-proto");
  const proto = forwardedProto?.split(",")[0]?.trim() || req.protocol || "http";
  const host =
    req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  if (!host) return "";
  return `${proto}://${host}`;
}

function buildCliAuthApprovalPath(challengeId: string, token: string) {
  return `/cli-auth/${challengeId}?token=${encodeURIComponent(token)}`;
}

function readSkillMarkdown(skillName: string): string | null {
  const normalized = skillName.trim().toLowerCase();
  if (
    normalized !== "paperclip" &&
    normalized !== "paperclip-create-agent" &&
    normalized !== "paperclip-create-plugin" &&
    normalized !== "paperclip-converting-plans-to-tasks" &&
    normalized !== "para-memory-files"
  )
    return null;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../skills", normalized, "SKILL.md"), // published: dist/routes/ -> <pkg>/skills/
    path.resolve(process.cwd(), "skills", normalized, "SKILL.md"), // cwd (e.g. monorepo root)
    path.resolve(moduleDir, "../../../skills", normalized, "SKILL.md") // dev: src/routes/ -> repo root/skills/
  ];
  for (const skillPath of candidates) {
    try {
      return fs.readFileSync(skillPath, "utf8");
    } catch {
      // Continue to next candidate.
    }
  }
  return null;
}

/** Resolve the Paperclip repo skills directory (built-in / managed skills). */
function resolvePaperclipSkillsDir(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../skills"),         // published
    path.resolve(process.cwd(), "skills"),           // cwd (monorepo root)
    path.resolve(moduleDir, "../../../skills"),       // dev
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* skip */ }
  }
  return null;
}

/** Parse YAML frontmatter from a SKILL.md file to extract the description. */
function parseSkillFrontmatter(markdown: string): { description: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { description: "" };
  const yaml = match[1];
  // Extract description — handles both single-line and multi-line YAML values
  const descMatch = yaml.match(
    /^description:\s*(?:>\s*\n((?:\s{2,}[^\n]*\n?)+)|[|]\s*\n((?:\s{2,}[^\n]*\n?)+)|["']?(.*?)["']?\s*$)/m
  );
  if (!descMatch) return { description: "" };
  const raw = descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? "";
  return {
    description: raw
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean)
      .join(" ")
      .trim(),
  };
}

interface AvailableSkill {
  name: string;
  description: string;
  isPaperclipManaged: boolean;
}

/** Discover all available Claude Code skills from ~/.claude/skills/. */
function listAvailableSkills(): AvailableSkill[] {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const claudeSkillsDir = path.join(homeDir, ".claude", "skills");
  const paperclipSkillsDir = resolvePaperclipSkillsDir();

  // Build set of Paperclip-managed skill names
  const paperclipSkillNames = new Set<string>();
  if (paperclipSkillsDir) {
    try {
      for (const entry of fs.readdirSync(paperclipSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) paperclipSkillNames.add(entry.name);
      }
    } catch { /* skip */ }
  }

  const skills: AvailableSkill[] = [];

  try {
    const entries = fs.readdirSync(claudeSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(claudeSkillsDir, entry.name, "SKILL.md");
      let description = "";
      try {
        const md = fs.readFileSync(skillMdPath, "utf8");
        description = parseSkillFrontmatter(md).description;
      } catch { /* no SKILL.md or unreadable */ }
      skills.push({
        name: entry.name,
        description,
        isPaperclipManaged: paperclipSkillNames.has(entry.name),
      });
    }
  } catch { /* ~/.claude/skills/ doesn't exist */ }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function toJoinRequestResponse(row: typeof joinRequests.$inferSelect) {
  const { claimSecretHash: _claimSecretHash, ...safe } = row;
  return safe;
}

type JoinDiagnostic = {
  code: string;
  level: "info" | "warn";
  message: string;
  hint?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1
      ? trimmed.slice(1, end).toLowerCase()
      : trimmed.toLowerCase();
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon > -1) return trimmed.slice(0, firstColon).toLowerCase();
  return trimmed.toLowerCase();
}

function normalizeHeaderValue(
  value: unknown,
  depth: number = 0
): string | null {
  const direct = nonEmptyTrimmedString(value);
  if (direct) return direct;
  if (!isPlainObject(value) || depth >= 3) return null;

  const candidateKeys = [
    "value",
    "token",
    "secret",
    "apiKey",
    "api_key",
    "auth",
    "authToken",
    "auth_token",
    "accessToken",
    "access_token",
    "authorization",
    "bearer",
    "header",
    "raw",
    "text",
    "string"
  ];
  for (const key of candidateKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const normalized = normalizeHeaderValue(
      (value as Record<string, unknown>)[key],
      depth + 1
    );
    if (normalized) return normalized;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [singleKey, singleValue] = entries[0];
    const normalizedKey = singleKey.trim().toLowerCase();
    if (
      normalizedKey !== "type" &&
      normalizedKey !== "version" &&
      normalizedKey !== "secretid" &&
      normalizedKey !== "secret_id"
    ) {
      const normalized = normalizeHeaderValue(singleValue, depth + 1);
      if (normalized) return normalized;
    }
  }

  return null;
}

function extractHeaderEntries(input: unknown): Array<[string, unknown]> {
  if (isPlainObject(input)) {
    return Object.entries(input);
  }
  if (!Array.isArray(input)) {
    return [];
  }

  const entries: Array<[string, unknown]> = [];
  for (const item of input) {
    if (Array.isArray(item)) {
      const key = nonEmptyTrimmedString(item[0]);
      if (!key) continue;
      entries.push([key, item[1]]);
      continue;
    }
    if (!isPlainObject(item)) continue;

    const mapped = item as Record<string, unknown>;
    const explicitKey =
      nonEmptyTrimmedString(mapped.key) ??
      nonEmptyTrimmedString(mapped.name) ??
      nonEmptyTrimmedString(mapped.header);
    if (explicitKey) {
      const explicitValue = Object.prototype.hasOwnProperty.call(
        mapped,
        "value"
      )
        ? mapped.value
        : Object.prototype.hasOwnProperty.call(mapped, "token")
        ? mapped.token
        : Object.prototype.hasOwnProperty.call(mapped, "secret")
        ? mapped.secret
        : mapped;
      entries.push([explicitKey, explicitValue]);
      continue;
    }

    const singleEntry = Object.entries(mapped);
    if (singleEntry.length === 1) {
      entries.push(singleEntry[0] as [string, unknown]);
    }
  }

  return entries;
}

function normalizeHeaderMap(
  input: unknown
): Record<string, string> | undefined {
  const entries = extractHeaderEntries(input);
  if (entries.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const normalizedValue = normalizeHeaderValue(value);
    if (!normalizedValue) continue;
    const trimmedKey = key.trim();
    const trimmedValue = normalizedValue.trim();
    if (!trimmedKey || !trimmedValue) continue;
    out[trimmedKey] = trimmedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function nonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function headerMapHasKeyIgnoreCase(
  headers: Record<string, string>,
  targetKey: string
): boolean {
  const normalizedTarget = targetKey.trim().toLowerCase();
  return Object.keys(headers).some(
    (key) => key.trim().toLowerCase() === normalizedTarget
  );
}

function headerMapGetIgnoreCase(
  headers: Record<string, string>,
  targetKey: string
): string | null {
  const normalizedTarget = targetKey.trim().toLowerCase();
  const key = Object.keys(headers).find(
    (candidate) => candidate.trim().toLowerCase() === normalizedTarget
  );
  if (!key) return null;
  const value = headers[key];
  return typeof value === "string" ? value : null;
}

function tokenFromAuthorizationHeader(rawHeader: string | null): string | null {
  const trimmed = nonEmptyTrimmedString(rawHeader);
  if (!trimmed) return null;
  const bearerMatch = trimmed.match(/^bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) {
    return nonEmptyTrimmedString(bearerMatch[1]);
  }
  return trimmed;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return null;
}

function generateEd25519PrivateKeyPem(): string {
  const generated = generateKeyPairSync("ed25519");
  return generated.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}

export function buildJoinDefaultsPayloadForAccept(input: {
  adapterType: string | null;
  defaultsPayload: unknown;
  paperclipApiUrl?: unknown;
  inboundOpenClawAuthHeader?: string | null;
  inboundOpenClawTokenHeader?: string | null;
}): unknown {
  if (input.adapterType !== "openclaw_gateway") {
    return input.defaultsPayload;
  }

  const merged = isPlainObject(input.defaultsPayload)
    ? { ...(input.defaultsPayload as Record<string, unknown>) }
    : ({} as Record<string, unknown>);

  if (!nonEmptyTrimmedString(merged.paperclipApiUrl)) {
    const legacyPaperclipApiUrl = nonEmptyTrimmedString(input.paperclipApiUrl);
    if (legacyPaperclipApiUrl) merged.paperclipApiUrl = legacyPaperclipApiUrl;
  }
  const mergedHeaders = normalizeHeaderMap(merged.headers) ?? {};

  const inboundOpenClawAuthHeader = nonEmptyTrimmedString(
    input.inboundOpenClawAuthHeader
  );
  const inboundOpenClawTokenHeader = nonEmptyTrimmedString(
    input.inboundOpenClawTokenHeader
  );
  if (
    inboundOpenClawTokenHeader &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-token")
  ) {
    mergedHeaders["x-openclaw-token"] = inboundOpenClawTokenHeader;
  }
  if (
    inboundOpenClawAuthHeader &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-auth")
  ) {
    mergedHeaders["x-openclaw-auth"] = inboundOpenClawAuthHeader;
  }

  if (Object.keys(mergedHeaders).length > 0) {
    merged.headers = mergedHeaders;
  } else {
    delete merged.headers;
  }

  const discoveredToken =
    headerMapGetIgnoreCase(mergedHeaders, "x-openclaw-token") ??
    headerMapGetIgnoreCase(mergedHeaders, "x-openclaw-auth") ??
    tokenFromAuthorizationHeader(
      headerMapGetIgnoreCase(mergedHeaders, "authorization")
    );
  if (
    discoveredToken &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-token")
  ) {
    mergedHeaders["x-openclaw-token"] = discoveredToken;
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

export function mergeJoinDefaultsPayloadForReplay(
  existingDefaultsPayload: unknown,
  nextDefaultsPayload: unknown
): unknown {
  if (
    !isPlainObject(existingDefaultsPayload) &&
    !isPlainObject(nextDefaultsPayload)
  ) {
    return nextDefaultsPayload ?? existingDefaultsPayload;
  }
  if (!isPlainObject(existingDefaultsPayload)) {
    return nextDefaultsPayload;
  }
  if (!isPlainObject(nextDefaultsPayload)) {
    return existingDefaultsPayload;
  }

  const merged: Record<string, unknown> = {
    ...(existingDefaultsPayload as Record<string, unknown>),
    ...(nextDefaultsPayload as Record<string, unknown>)
  };

  const existingHeaders = normalizeHeaderMap(
    (existingDefaultsPayload as Record<string, unknown>).headers
  );
  const nextHeaders = normalizeHeaderMap(
    (nextDefaultsPayload as Record<string, unknown>).headers
  );
  if (existingHeaders || nextHeaders) {
    merged.headers = {
      ...(existingHeaders ?? {}),
      ...(nextHeaders ?? {})
    };
  } else if (Object.prototype.hasOwnProperty.call(merged, "headers")) {
    delete merged.headers;
  }

  return merged;
}

export function canReplayOpenClawGatewayInviteAccept(input: {
  requestType: "human" | "agent";
  adapterType: string | null;
  existingJoinRequest: Pick<
    typeof joinRequests.$inferSelect,
    "requestType" | "adapterType" | "status"
  > | null;
}): boolean {
  if (
    input.requestType !== "agent" ||
    input.adapterType !== "openclaw_gateway"
  ) {
    return false;
  }
  if (!input.existingJoinRequest) {
    return false;
  }
  if (
    input.existingJoinRequest.requestType !== "agent" ||
    input.existingJoinRequest.adapterType !== "openclaw_gateway"
  ) {
    return false;
  }
  return (
    input.existingJoinRequest.status === "pending_approval" ||
    input.existingJoinRequest.status === "approved"
  );
}

function summarizeSecretForLog(
  value: unknown
): { present: true; length: number; sha256Prefix: string } | null {
  const trimmed = nonEmptyTrimmedString(value);
  if (!trimmed) return null;
  return {
    present: true,
    length: trimmed.length,
    sha256Prefix: hashToken(trimmed).slice(0, 12)
  };
}

function summarizeOpenClawGatewayDefaultsForLog(defaultsPayload: unknown) {
  const defaults = isPlainObject(defaultsPayload)
    ? (defaultsPayload as Record<string, unknown>)
    : null;
  const headers = defaults ? normalizeHeaderMap(defaults.headers) : undefined;
  const gatewayTokenValue = headers
    ? headerMapGetIgnoreCase(headers, "x-openclaw-token") ??
      headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
      tokenFromAuthorizationHeader(
        headerMapGetIgnoreCase(headers, "authorization")
      )
    : null;
  return {
    present: Boolean(defaults),
    keys: defaults ? Object.keys(defaults).sort() : [],
    url: defaults ? nonEmptyTrimmedString(defaults.url) : null,
    paperclipApiUrl: defaults
      ? nonEmptyTrimmedString(defaults.paperclipApiUrl)
      : null,
    headerKeys: headers ? Object.keys(headers).sort() : [],
    sessionKeyStrategy: defaults
      ? nonEmptyTrimmedString(defaults.sessionKeyStrategy)
      : null,
    disableDeviceAuth: defaults
      ? parseBooleanLike(defaults.disableDeviceAuth)
      : null,
    waitTimeoutMs:
      defaults && typeof defaults.waitTimeoutMs === "number"
        ? defaults.waitTimeoutMs
        : null,
    devicePrivateKeyPem: defaults
      ? summarizeSecretForLog(defaults.devicePrivateKeyPem)
      : null,
    gatewayToken: summarizeSecretForLog(gatewayTokenValue)
  };
}

export function normalizeAgentDefaultsForJoin(input: {
  adapterType: string | null;
  defaultsPayload: unknown;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
}) {
  const fatalErrors: string[] = [];
  const diagnostics: JoinDiagnostic[] = [];
  if (input.adapterType !== "openclaw_gateway") {
    const normalized = isPlainObject(input.defaultsPayload)
      ? (input.defaultsPayload as Record<string, unknown>)
      : null;
    return { normalized, diagnostics, fatalErrors };
  }

  if (!isPlainObject(input.defaultsPayload)) {
    diagnostics.push({
      code: "openclaw_gateway_defaults_missing",
      level: "warn",
      message:
        "No OpenClaw gateway config was provided in agentDefaultsPayload.",
      hint:
        "Include agentDefaultsPayload.url and headers.x-openclaw-token for OpenClaw gateway joins."
    });
    fatalErrors.push(
      "agentDefaultsPayload is required for adapterType=openclaw_gateway"
    );
    return {
      normalized: null as Record<string, unknown> | null,
      diagnostics,
      fatalErrors
    };
  }

  const defaults = input.defaultsPayload as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  let gatewayUrl: URL | null = null;
  const rawGatewayUrl = nonEmptyTrimmedString(defaults.url);
  if (!rawGatewayUrl) {
    diagnostics.push({
      code: "openclaw_gateway_url_missing",
      level: "warn",
      message: "OpenClaw gateway URL is missing.",
      hint: "Set agentDefaultsPayload.url to ws:// or wss:// gateway URL."
    });
    fatalErrors.push("agentDefaultsPayload.url is required");
  } else {
    try {
      gatewayUrl = new URL(rawGatewayUrl);
      if (gatewayUrl.protocol !== "ws:" && gatewayUrl.protocol !== "wss:") {
        diagnostics.push({
          code: "openclaw_gateway_url_protocol",
          level: "warn",
          message: `OpenClaw gateway URL must use ws:// or wss:// (got ${gatewayUrl.protocol}).`
        });
        fatalErrors.push(
          "agentDefaultsPayload.url must use ws:// or wss:// for openclaw_gateway"
        );
      } else {
        normalized.url = gatewayUrl.toString();
        diagnostics.push({
          code: "openclaw_gateway_url_configured",
          level: "info",
          message: `Gateway endpoint set to ${gatewayUrl.toString()}`
        });
      }
    } catch {
      diagnostics.push({
        code: "openclaw_gateway_url_invalid",
        level: "warn",
        message: `Invalid OpenClaw gateway URL: ${rawGatewayUrl}`
      });
      fatalErrors.push("agentDefaultsPayload.url is not a valid URL");
    }
  }

  const headers = normalizeHeaderMap(defaults.headers) ?? {};
  const gatewayToken =
    headerMapGetIgnoreCase(headers, "x-openclaw-token") ??
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    tokenFromAuthorizationHeader(headerMapGetIgnoreCase(headers, "authorization"));
  if (gatewayToken && !headerMapHasKeyIgnoreCase(headers, "x-openclaw-token")) {
    headers["x-openclaw-token"] = gatewayToken;
  }
  if (Object.keys(headers).length > 0) {
    normalized.headers = headers;
  }

  if (!gatewayToken) {
    diagnostics.push({
      code: "openclaw_gateway_auth_header_missing",
      level: "warn",
      message: "Gateway auth token is missing from agent defaults.",
      hint:
        "Set agentDefaultsPayload.headers.x-openclaw-token (or legacy x-openclaw-auth)."
    });
    fatalErrors.push(
      "agentDefaultsPayload.headers.x-openclaw-token (or x-openclaw-auth) is required"
    );
  } else if (gatewayToken.trim().length < 16) {
    diagnostics.push({
      code: "openclaw_gateway_auth_header_too_short",
      level: "warn",
      message: `Gateway auth token appears too short (${gatewayToken.trim().length} chars).`,
      hint:
        "Use the full gateway auth token from ~/.openclaw/openclaw.json (typically long random string)."
    });
    fatalErrors.push(
      "agentDefaultsPayload.headers.x-openclaw-token is too short; expected a full gateway token"
    );
  } else {
    diagnostics.push({
      code: "openclaw_gateway_auth_header_configured",
      level: "info",
      message: "Gateway auth token configured."
    });
  }

  if (isPlainObject(defaults.payloadTemplate)) {
    normalized.payloadTemplate = defaults.payloadTemplate;
  }

  const parsedDisableDeviceAuth = parseBooleanLike(defaults.disableDeviceAuth);
  const disableDeviceAuth = parsedDisableDeviceAuth === true;
  if (parsedDisableDeviceAuth !== null) {
    normalized.disableDeviceAuth = parsedDisableDeviceAuth;
  }

  const configuredDevicePrivateKeyPem = nonEmptyTrimmedString(
    defaults.devicePrivateKeyPem
  );
  if (configuredDevicePrivateKeyPem) {
    normalized.devicePrivateKeyPem = configuredDevicePrivateKeyPem;
    diagnostics.push({
      code: "openclaw_gateway_device_key_configured",
      level: "info",
      message:
        "Gateway device key configured. Pairing approvals should persist for this agent."
    });
  } else if (!disableDeviceAuth) {
    try {
      normalized.devicePrivateKeyPem = generateEd25519PrivateKeyPem();
      diagnostics.push({
        code: "openclaw_gateway_device_key_generated",
        level: "info",
        message:
          "Generated persistent gateway device key for this join. Pairing approvals should persist for this agent."
      });
    } catch (err) {
      diagnostics.push({
        code: "openclaw_gateway_device_key_generate_failed",
        level: "warn",
        message: `Failed to generate gateway device key: ${
          err instanceof Error ? err.message : String(err)
        }`,
        hint:
          "Set agentDefaultsPayload.devicePrivateKeyPem explicitly or set disableDeviceAuth=true."
      });
      fatalErrors.push(
        "Failed to generate gateway device key. Set devicePrivateKeyPem or disableDeviceAuth=true."
      );
    }
  }

  const waitTimeoutMs =
    typeof defaults.waitTimeoutMs === "number" &&
    Number.isFinite(defaults.waitTimeoutMs)
      ? Math.floor(defaults.waitTimeoutMs)
      : typeof defaults.waitTimeoutMs === "string"
      ? Number.parseInt(defaults.waitTimeoutMs.trim(), 10)
      : NaN;
  if (Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0) {
    normalized.waitTimeoutMs = waitTimeoutMs;
  }

  const timeoutSec =
    typeof defaults.timeoutSec === "number" && Number.isFinite(defaults.timeoutSec)
      ? Math.floor(defaults.timeoutSec)
      : typeof defaults.timeoutSec === "string"
      ? Number.parseInt(defaults.timeoutSec.trim(), 10)
      : NaN;
  if (Number.isFinite(timeoutSec) && timeoutSec > 0) {
    normalized.timeoutSec = timeoutSec;
  }

  const sessionKeyStrategy = nonEmptyTrimmedString(defaults.sessionKeyStrategy);
  if (
    sessionKeyStrategy === "fixed" ||
    sessionKeyStrategy === "issue" ||
    sessionKeyStrategy === "run"
  ) {
    normalized.sessionKeyStrategy = sessionKeyStrategy;
  }

  const sessionKey = nonEmptyTrimmedString(defaults.sessionKey);
  if (sessionKey) {
    normalized.sessionKey = sessionKey;
  }

  const role = nonEmptyTrimmedString(defaults.role);
  if (role) {
    normalized.role = role;
  }

  if (Array.isArray(defaults.scopes)) {
    const scopes = defaults.scopes
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (scopes.length > 0) {
      normalized.scopes = scopes;
    }
  }

  const rawPaperclipApiUrl =
    typeof defaults.paperclipApiUrl === "string"
      ? defaults.paperclipApiUrl.trim()
      : "";
  if (rawPaperclipApiUrl) {
    try {
      const parsedPaperclipApiUrl = new URL(rawPaperclipApiUrl);
      if (
        parsedPaperclipApiUrl.protocol !== "http:" &&
        parsedPaperclipApiUrl.protocol !== "https:"
      ) {
        diagnostics.push({
          code: "openclaw_gateway_paperclip_api_url_protocol",
          level: "warn",
          message: `paperclipApiUrl must use http:// or https:// (got ${parsedPaperclipApiUrl.protocol}).`
        });
      } else {
        normalized.paperclipApiUrl = parsedPaperclipApiUrl.toString();
        diagnostics.push({
          code: "openclaw_gateway_paperclip_api_url_configured",
          level: "info",
          message: `paperclipApiUrl set to ${parsedPaperclipApiUrl.toString()}`
        });
      }
    } catch {
      diagnostics.push({
        code: "openclaw_gateway_paperclip_api_url_invalid",
        level: "warn",
        message: `Invalid paperclipApiUrl: ${rawPaperclipApiUrl}`
      });
    }
  }

  return { normalized, diagnostics, fatalErrors };
}

function toInviteSummaryResponse(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  company:
    | string
    | {
      name: string | null;
      brandColor: string | null;
      logoUrl: string | null;
    }
    | null = null
) {
  const companyInfo = typeof company === "string"
    ? { name: company, brandColor: null, logoUrl: null }
    : company;
  const baseUrl = requestBaseUrl(req);
  const invitePath = `/invite/${token}`;
  const onboardingPath = `/api/invites/${token}/onboarding`;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const skillIndexPath = `/api/invites/${token}/skills/index`;
  const inviteMessage = extractInviteMessage(invite);
  return {
    id: invite.id,
    companyId: invite.companyId,
    companyName: companyInfo?.name ?? null,
    companyLogoUrl: companyInfo?.logoUrl ?? null,
    companyBrandColor: companyInfo?.brandColor ?? null,
    inviteType: invite.inviteType,
    allowedJoinTypes: invite.allowedJoinTypes,
    humanRole: extractInviteHumanRole(invite),
    expiresAt: invite.expiresAt,
    invitePath,
    inviteUrl: baseUrl ? `${baseUrl}${invitePath}` : invitePath,
    onboardingPath,
    onboardingUrl: baseUrl ? `${baseUrl}${onboardingPath}` : onboardingPath,
    onboardingTextPath,
    onboardingTextUrl: baseUrl
      ? `${baseUrl}${onboardingTextPath}`
      : onboardingTextPath,
    skillIndexPath,
    skillIndexUrl: baseUrl
      ? `${baseUrl}${skillIndexPath}`
      : skillIndexPath,
    inviteMessage
  };
}

function actorHasActiveUserMembership(req: Request, companyId: string) {
  return (
    req.actor.type === "board" &&
    typeof req.actor.userId === "string" &&
    Array.isArray(req.actor.memberships) &&
    req.actor.memberships.some(
      (membership) =>
        membership.companyId === companyId && membership.status === "active",
    )
  );
}

async function loadUsersById(db: Db, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, ReturnType<typeof toUserProfile>>();
  const rows = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
    })
    .from(authUsers)
    .where(inArray(authUsers.id, userIds));
  return new Map(rows.map((row) => [row.id, toUserProfile(row)]));
}

async function loadCompanyAccessSummary(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
) {
  if (req.actor.type !== "board") {
    return {
      currentUserRole: null,
      canManageMembers: false,
      canInviteUsers: false,
      canApproveJoinRequests: false,
    };
  }
  if (isLocalImplicit(req)) {
    return {
      currentUserRole: "owner" as const,
      canManageMembers: true,
      canInviteUsers: true,
      canApproveJoinRequests: true,
    };
  }
  const userId = req.actor.userId ?? null;
  const membership =
    userId ? await access.getMembership(companyId, "user", userId) : null;
  const [canManageMembers, canInviteUsers, canApproveJoinRequests] =
    await Promise.all([
      access.canUser(companyId, userId, "users:manage_permissions"),
      access.canUser(companyId, userId, "users:invite"),
      access.canUser(companyId, userId, "joins:approve"),
    ]);

  return {
    currentUserRole:
      membership?.status === "active" && membership.membershipRole
        ? normalizeHumanRole(membership.membershipRole, "operator")
        : null,
    canManageMembers,
    canInviteUsers,
    canApproveJoinRequests,
  };
}

async function loadCompanyMemberRecords(
  db: Db,
  companyId: string,
  options: { includeArchived?: boolean } = {},
) {
  const members = await db
    .select()
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        options.includeArchived ? undefined : ne(companyMemberships.status, "archived"),
      ),
    )
    .orderBy(desc(companyMemberships.updatedAt));

  const userIds = [...new Set(members.map((member) => member.principalId))];
  const [userMap, grants] = await Promise.all([
    loadUsersById(db, userIds),
    userIds.length > 0
      ? db
          .select()
          .from(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, companyId),
              eq(principalPermissionGrants.principalType, "user"),
              inArray(principalPermissionGrants.principalId, userIds),
            ),
          )
      : Promise.resolve([]),
  ]);

  const grantsByPrincipalId = new Map<string, typeof grants>();
  for (const grant of grants) {
    const existing = grantsByPrincipalId.get(grant.principalId) ?? [];
    existing.push(grant);
    grantsByPrincipalId.set(grant.principalId, existing);
  }

  return members.map((member) => ({
    ...member,
    principalType: "user" as const,
    membershipRole: member.membershipRole
      ? normalizeHumanRole(member.membershipRole, "operator")
      : null,
    user: userMap.get(member.principalId) ?? null,
    grants: grantsByPrincipalId.get(member.principalId) ?? [],
  }));
}

type CompanyMemberRecord = Awaited<ReturnType<typeof loadCompanyMemberRecords>>[number];

const humanRoleRank: Record<HumanCompanyMembershipRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
  owner: 4,
};

async function resolveActorHumanRole(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
): Promise<HumanCompanyMembershipRole | null> {
  if (req.actor.type !== "board") return null;
  if (isLocalImplicit(req) || req.actor.isInstanceAdmin) return "owner";
  const userId = req.actor.userId ?? null;
  if (!userId) return null;
  const membership = await access.getMembership(companyId, "user", userId);
  if (membership?.status !== "active" || !membership.membershipRole) return null;
  return normalizeHumanRole(membership.membershipRole, "operator");
}

async function getProtectedMemberReason(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
  member: { principalId: string; principalType: string; membershipRole: string | null },
  opts?: {
    actorRole?: HumanCompanyMembershipRole | null;
    instanceAdminUserIds?: ReadonlySet<string>;
    operation?: "archive" | "update";
  },
): Promise<string | null> {
  if (member.principalType !== "user") return "Only human company members can be removed.";
  if (req.actor.type !== "board") return "Board access is required to remove members.";
  if (member.principalId === req.actor.userId) return "You cannot remove yourself.";
  const isTargetInstanceAdmin = opts?.instanceAdminUserIds
    ? opts.instanceAdminUserIds.has(member.principalId)
    : await access.isInstanceAdmin(member.principalId);
  if (isTargetInstanceAdmin) {
    return "Instance admins cannot be removed from company access.";
  }

  const targetRole = member.membershipRole
    ? normalizeHumanRole(member.membershipRole, "operator")
    : "operator";
  if (opts?.operation === "archive") {
    if (targetRole === "owner") return "Board owners cannot be removed from company access.";
    if (targetRole === "admin") return "Company admins cannot be removed from company access.";
  }

  const actorRole = opts?.actorRole ?? await resolveActorHumanRole(req, access, companyId);
  if (!actorRole) return "Only active company members can remove users.";
  if (humanRoleRank[targetRole] >= humanRoleRank[actorRole]) {
    return "You can only remove users below your company role.";
  }

  return null;
}

async function assertCanManageCompanyMember(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
  member: { principalId: string; principalType: string; membershipRole: string | null },
  operation: "archive" | "update" = "update",
) {
  const reason = await getProtectedMemberReason(req, access, companyId, member, { operation });
  if (reason) throw forbidden(reason);
}

async function addCompanyMemberRemovalAccess(
  req: Request,
  db: Db,
  access: ReturnType<typeof accessService>,
  companyId: string,
  members: CompanyMemberRecord[],
) {
  const actorRole = await resolveActorHumanRole(req, access, companyId);
  const userIds = [...new Set(members
    .filter((member) => member.principalType === "user")
    .map((member) => member.principalId))];
  const instanceAdminUserIds = userIds.length > 0
    ? new Set(
      await db
        .select({ userId: instanceUserRoles.userId })
        .from(instanceUserRoles)
        .where(and(inArray(instanceUserRoles.userId, userIds), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows.map((row) => row.userId)),
    )
    : new Set<string>();
  return Promise.all(
    members.map(async (member) => {
      const reason = await getProtectedMemberReason(req, access, companyId, member, {
        actorRole,
        instanceAdminUserIds,
        operation: "archive",
      });
      return {
        ...member,
        removal: {
          canArchive: !reason,
          reason,
        },
      };
    }),
  );
}

async function loadCompanyUserDirectory(db: Db, companyId: string) {
  const members = await db
    .select({
      principalId: companyMemberships.principalId,
      status: companyMemberships.status,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    )
    .orderBy(desc(companyMemberships.updatedAt));

  const userIds = [...new Set(members.map((member) => member.principalId))];
  const userMap = await loadUsersById(db, userIds);

  return members.map((member) => ({
    principalId: member.principalId,
    status: "active" as const,
    user: userMap.get(member.principalId) ?? null,
  }));
}

function inviteStateWhereClause(
  state: "active" | "accepted" | "expired" | "revoked" | undefined,
) {
  const now = new Date();
  switch (state) {
    case "active":
      return and(
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now),
      );
    case "accepted":
      return isNotNull(invites.acceptedAt);
    case "expired":
      return and(
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        lte(invites.expiresAt, now),
      );
    case "revoked":
      return isNotNull(invites.revokedAt);
    default:
      return undefined;
  }
}

async function loadCompanyInviteRecords(
  db: Db,
  companyId: string,
  options: {
    state?: "active" | "accepted" | "expired" | "revoked";
    limit: number;
    offset: number;
  },
) {
  const whereClause = inviteStateWhereClause(options.state);
  const rows = await db
    .select()
    .from(invites)
    .where(whereClause ? and(eq(invites.companyId, companyId), whereClause) : eq(invites.companyId, companyId))
    .orderBy(desc(invites.createdAt))
    .limit(options.limit + 1)
    .offset(options.offset);
  const hasMore = rows.length > options.limit;
  const visibleRows = hasMore ? rows.slice(0, options.limit) : rows;
  const userIds = [
    ...new Set(
      visibleRows
        .map((invite) => invite.invitedByUserId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const [userMap, joinRows, companyName] = await Promise.all([
    loadUsersById(db, userIds),
    visibleRows.length
      ? db
          .select({ id: joinRequests.id, inviteId: joinRequests.inviteId })
          .from(joinRequests)
          .where(
            and(
              eq(joinRequests.companyId, companyId),
              inArray(
                joinRequests.inviteId,
                visibleRows.map((invite) => invite.id),
              ),
            ),
          )
      : Promise.resolve([]),
    db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((companyRows) => companyRows[0]?.name ?? null),
  ]);
  const joinRequestIdByInviteId = new Map(
    joinRows.map((row: { inviteId: string; id: string }) => [row.inviteId, row.id]),
  );

  return {
    invites: visibleRows.map((invite) => ({
      ...invite,
      companyName,
      humanRole: extractInviteHumanRole(invite),
      inviteMessage: extractInviteMessage(invite),
      state: inviteState(invite),
      invitedByUser: invite.invitedByUserId
        ? userMap.get(invite.invitedByUserId) ?? null
        : null,
      relatedJoinRequestId: joinRequestIdByInviteId.get(invite.id) ?? null,
    })),
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
}

async function loadJoinRequestRecords(db: Db, companyId: string) {
  const rows = collapseDuplicatePendingHumanJoinRequests(
    await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.companyId, companyId))
      .orderBy(desc(joinRequests.createdAt))
  );
  const inviteIds = [...new Set(rows.map((row) => row.inviteId))];
  const inviteRows = inviteIds.length
    ? await db
        .select()
        .from(invites)
        .where(inArray(invites.id, inviteIds))
    : [];
  const userIds = [
    ...new Set(
      [
        ...rows.map((row) => row.requestingUserId),
        ...rows.map((row) => row.approvedByUserId),
        ...rows.map((row) => row.rejectedByUserId),
        ...inviteRows.map((invite) => invite.invitedByUserId),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  const userMap = await loadUsersById(db, userIds);
  const inviteMap = new Map(inviteRows.map((invite) => [invite.id, invite]));

  return rows.map((row) => {
    const invite = inviteMap.get(row.inviteId) ?? null;
    return {
      ...toJoinRequestResponse(row),
      requesterUser: row.requestingUserId
        ? userMap.get(row.requestingUserId) ?? null
        : null,
      approvedByUser: row.approvedByUserId
        ? userMap.get(row.approvedByUserId) ?? null
        : null,
      rejectedByUser: row.rejectedByUserId
        ? userMap.get(row.rejectedByUserId) ?? null
        : null,
      invite: invite
        ? {
            id: invite.id,
            inviteType: invite.inviteType,
            allowedJoinTypes: invite.allowedJoinTypes,
            humanRole: extractInviteHumanRole(invite),
            inviteMessage: extractInviteMessage(invite),
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            revokedAt: invite.revokedAt,
            acceptedAt: invite.acceptedAt,
            invitedByUser: invite.invitedByUserId
              ? userMap.get(invite.invitedByUserId) ?? null
              : null,
          }
        : null,
    };
  });
}

async function loadUserCompanyAccessResponse(
  db: Db,
  access: ReturnType<typeof accessService>,
  userId: string,
) {
  const [memberships, user, isInstanceAdmin] = await Promise.all([
    access.listUserCompanyAccess(userId),
    db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0] ?? null),
    access.isInstanceAdmin(userId),
  ]);
  const companyIds = [...new Set(memberships.map((membership) => membership.companyId))];
  const companyRows = companyIds.length
    ? await db
        .select({
          id: companies.id,
          name: companies.name,
          status: companies.status,
        })
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : [];
  const companyMap = new Map(companyRows.map((company) => [company.id, company]));

  return {
    user: user
      ? {
          ...toUserProfile(user),
          isInstanceAdmin,
        }
      : null,
    companyAccess: memberships.map((membership) => {
      const company = companyMap.get(membership.companyId) ?? null;
      return {
        ...membership,
        principalType: "user" as const,
        companyName: company?.name ?? null,
        companyStatus: company?.status ?? null,
      };
    }),
  };
}

function buildOnboardingDiscoveryDiagnostics(input: {
  apiBaseUrl: string;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
}): JoinDiagnostic[] {
  const diagnostics: JoinDiagnostic[] = [];
  let apiHost: string | null = null;
  if (input.apiBaseUrl) {
    try {
      apiHost = normalizeHostname(new URL(input.apiBaseUrl).hostname);
    } catch {
      apiHost = null;
    }
  }

  const bindHost = normalizeHostname(input.bindHost);
  const allowSet = new Set(
    input.allowedHostnames
      .map((entry) => normalizeHostname(entry))
      .filter((entry): entry is string => Boolean(entry))
  );

  if (apiHost && isLoopbackHost(apiHost)) {
    diagnostics.push({
      code: "openclaw_onboarding_api_loopback",
      level: "warn",
      message:
        "Onboarding URL resolves to loopback hostname. Remote OpenClaw agents cannot reach localhost on your Paperclip host.",
      hint: "Use a reachable hostname/IP (for example Tailscale hostname, Docker host alias, or public domain)."
    });
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private" &&
    (!bindHost || isLoopbackHost(bindHost))
  ) {
    diagnostics.push({
      code: "openclaw_onboarding_private_loopback_bind",
      level: "warn",
      message: "Paperclip is bound to loopback in authenticated/private mode.",
      hint: "Use a reachable private bind mode such as `pnpm dev --bind lan` or `pnpm dev --bind tailnet` for private-network onboarding."
    });
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private" &&
    apiHost &&
    !isLoopbackHost(apiHost) &&
    allowSet.size > 0 &&
    !allowSet.has(apiHost)
  ) {
    diagnostics.push({
      code: "openclaw_onboarding_private_host_not_allowed",
      level: "warn",
      message: `Onboarding host "${apiHost}" is not in allowed hostnames for authenticated/private mode.`,
      hint: `Run pnpm paperclipai allowed-hostname ${apiHost}`
    });
  }

  return diagnostics;
}

function buildOnboardingConnectionCandidates(input: {
  apiBaseUrl: string;
  bindHost: string;
  allowedHostnames: string[];
}): string[] {
  let base: URL | null = null;
  try {
    if (input.apiBaseUrl) {
      base = new URL(input.apiBaseUrl);
    }
  } catch {
    base = null;
  }

  const protocol = base?.protocol ?? "http:";
  const port = base?.port ? `:${base.port}` : "";
  const candidates = new Set<string>();

  if (base) {
    candidates.add(base.origin);
  }

  const bindHost = normalizeHostname(input.bindHost);
  if (bindHost && !isLoopbackHost(bindHost)) {
    candidates.add(`${protocol}//${bindHost}${port}`);
  }

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHostname(rawHost);
    if (!host) continue;
    candidates.add(`${protocol}//${host}${port}`);
  }

  if (base && isLoopbackHost(base.hostname)) {
    candidates.add(`${protocol}//host.docker.internal${port}`);
  }

  for (const host of collectReachableInterfaceHosts()) {
    const formattedHost = host.includes(":") && !host.startsWith("[") && !host.endsWith("]") ? `[${host}]` : host;
    candidates.add(`${protocol}//${formattedHost}${port}`);
  }

  return Array.from(candidates);
}

function buildInviteOnboardingManifest(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  opts: {
    companyName?: string | null;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  }
) {
  const baseUrl = requestBaseUrl(req);
  const skillPath = `/api/invites/${token}/skills/paperclip`;
  const skillUrl = baseUrl ? `${baseUrl}${skillPath}` : skillPath;
  const registrationEndpointPath = `/api/invites/${token}/accept`;
  const registrationEndpointUrl = baseUrl
    ? `${baseUrl}${registrationEndpointPath}`
    : registrationEndpointPath;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const onboardingTextUrl = baseUrl
    ? `${baseUrl}${onboardingTextPath}`
    : onboardingTextPath;
  const discoveryDiagnostics = buildOnboardingDiscoveryDiagnostics({
    apiBaseUrl: baseUrl,
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames
  });
  const connectionCandidates = buildOnboardingConnectionCandidates({
    apiBaseUrl: baseUrl,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames
  });

  return {
    invite: toInviteSummaryResponse(
      req,
      token,
      invite,
      opts.companyName ?? null
    ),
    onboarding: {
      instructions:
        "Join as an OpenClaw Gateway agent, save your one-time claim secret, wait for board approval, then claim your API key. Save the claim response token to ~/.openclaw/workspace/paperclip-claimed-api-key.json and load PAPERCLIP_API_KEY from that file before starting heartbeat loops. You MUST submit adapterType='openclaw_gateway', set agentDefaultsPayload.url to your ws:// or wss:// OpenClaw gateway endpoint, and include agentDefaultsPayload.headers.x-openclaw-token (or legacy x-openclaw-auth).",
      inviteMessage: extractInviteMessage(invite),
      recommendedAdapterType: "openclaw_gateway",
      requiredFields: {
        requestType: "agent",
        agentName: "Display name for this agent",
        adapterType: "Use 'openclaw_gateway' for OpenClaw Gateway agents",
        capabilities: "Optional capability summary",
        agentDefaultsPayload:
          "Adapter config for OpenClaw gateway. MUST include url (ws:// or wss://) and headers.x-openclaw-token (or legacy x-openclaw-auth). Optional fields: paperclipApiUrl, waitTimeoutMs, sessionKeyStrategy, sessionKey, role, scopes, disableDeviceAuth, devicePrivateKeyPem."
      },
      registrationEndpoint: {
        method: "POST",
        path: registrationEndpointPath,
        url: registrationEndpointUrl
      },
      claimEndpointTemplate: {
        method: "POST",
        path: "/api/join-requests/{requestId}/claim-api-key",
        body: {
          claimSecret:
            "one-time claim secret returned when the join request is created"
        }
      },
      connectivity: {
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        bindHost: opts.bindHost,
        allowedHostnames: opts.allowedHostnames,
        connectionCandidates,
        diagnostics: discoveryDiagnostics,
        guidance:
          opts.deploymentMode === "authenticated" &&
          opts.deploymentExposure === "private"
            ? "If OpenClaw runs on another machine, ensure the Paperclip hostname is reachable and allowed via `pnpm paperclipai allowed-hostname <host>`."
            : "Ensure OpenClaw can reach this Paperclip API base URL for invite, claim, and skill bootstrap calls."
      },
      textInstructions: {
        path: onboardingTextPath,
        url: onboardingTextUrl,
        contentType: "text/plain"
      },
      skill: {
        name: "paperclip",
        path: skillPath,
        url: skillUrl,
        installPath: "~/.openclaw/skills/paperclip/SKILL.md"
      }
    }
  };
}

export function buildInviteOnboardingTextDocument(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  opts: {
    companyName?: string | null;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  }
) {
  const manifest = buildInviteOnboardingManifest(req, token, invite, opts);
  const onboarding = manifest.onboarding as {
    inviteMessage?: string | null;
    registrationEndpoint: { method: string; path: string; url: string };
    claimEndpointTemplate: { method: string; path: string };
    textInstructions: { path: string; url: string };
    skill: { path: string; url: string; installPath: string };
    connectivity: {
      diagnostics?: JoinDiagnostic[];
      guidance?: string;
      connectionCandidates?: string[];
      testResolutionEndpoint?: { method?: string; path?: string; url?: string };
    };
  };
  const diagnostics = Array.isArray(onboarding.connectivity?.diagnostics)
    ? onboarding.connectivity.diagnostics
    : [];

  const lines: string[] = [];
  const appendBlock = (block: string) => {
    const trimmed = block.replace(/^\n/, "").replace(/\n\s*$/, "");
    const lineIndentation = trimmed
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.match(/^(\s*)/)?.[0].length ?? 0);
    const minIndent =
      lineIndentation.length > 0 ? Math.min(...lineIndentation) : 0;
    for (const line of trimmed.split("\n")) {
      lines.push(line.slice(minIndent));
    }
  };

  appendBlock(`
    # Paperclip OpenClaw Gateway Onboarding

    This document is meant to be readable by both humans and agents.

    ## Invite
    - inviteType: ${invite.inviteType}
    - allowedJoinTypes: ${invite.allowedJoinTypes}
    - expiresAt: ${invite.expiresAt.toISOString()}
  `);

  if (manifest.invite.companyName) {
    lines.push(`- companyName: ${manifest.invite.companyName}`);
  }

  if (onboarding.inviteMessage) {
    appendBlock(`
      ## Message from inviter
      ${onboarding.inviteMessage}
    `);
  }

  appendBlock(`
    ## Step 0

    Get the OpenClaw gateway auth token (THIS MUST BE SENT)
    Token lives in:

    ~/.openclaw/openclaw.json -> gateway.auth.token
    Extract:

    TOKEN="$(node -p 'require(process.env.HOME+\"/.openclaw/openclaw.json\").gateway.auth.token')"
    test -n "$TOKEN" || (echo "Missing TOKEN" && exit 1)
    test "\${#TOKEN}" -ge 16 || (echo "Gateway token unexpectedly short (\${#TOKEN})" && exit 1)

    3) IMPORTANT: Don't accidentally drop the token when generating JSON
    If you build JSON with Node, pass the token explicitly (argv), don't rely on an un-exported env var.

    Safe payload build looks sort of like this (substitute where necessary):

    BODY="$(node -e '
      const token = process.argv[1];
      if (!token) process.exit(2);
      const body = {
        requestType: "agent",
        agentName: "OpenClaw",
        adapterType: "openclaw_gateway",
        capabilities: "OpenClaw agent adapter",
        agentDefaultsPayload: {
          url: "ws://127.0.0.1:18789",
          paperclipApiUrl: "http://host.docker.internal:3100",
          headers: { "x-openclaw-token": token },
          waitTimeoutMs: 120000,
          sessionKeyStrategy: "issue",
          role: "operator",
          scopes: ["operator.admin"]
        }
      };
      process.stdout.write(JSON.stringify(body));
    ' "$TOKEN")"

    ## Step 1: Submit agent join request
    ${onboarding.registrationEndpoint.method} ${
    onboarding.registrationEndpoint.url
  }

    IMPORTANT: You MUST include agentDefaultsPayload.headers.x-openclaw-token with your gateway token.
    Legacy x-openclaw-auth is also accepted, but x-openclaw-token is preferred.
    Use adapterType "openclaw_gateway" and a ws:// or wss:// gateway URL.
    Pairing mode requirement:
    - Keep device auth enabled (recommended). If devicePrivateKeyPem is omitted, Paperclip generates and persists one during join so pairing approvals are stable.
    - You may set disableDeviceAuth=true only for special environments that cannot support pairing.
    - First run may return "pairing required" once; approve the pending pairing request in OpenClaw, then retry.
    Do NOT use /v1/responses or /hooks/* in this gateway join flow.

    Body (JSON):
    {
      "requestType": "agent",
      "agentName": "My OpenClaw Agent",
      "adapterType": "openclaw_gateway",
      "capabilities": "Optional summary",
      "agentDefaultsPayload": {
        "url": "wss://your-openclaw-gateway.example",
        "paperclipApiUrl": "https://paperclip-hostname-your-agent-can-reach:3100",
        "headers": { "x-openclaw-token": "replace-me" },
        "waitTimeoutMs": 120000,
        "sessionKeyStrategy": "issue",
        "role": "operator",
        "scopes": ["operator.admin"]
      }
    }

    Expected response includes:
    - request id
    - one-time claimSecret
    - claimApiKeyPath

    ## Step 2: Wait for board approval
    The board approves the join request in Paperclip before key claim is allowed.

    ## Step 3: Claim API key (one-time)
    ${
      onboarding.claimEndpointTemplate.method
    } /api/join-requests/{requestId}/claim-api-key

    Body (JSON):
    {
      "claimSecret": "<one-time-claim-secret>"
    }

    On successful claim, save the full JSON response to:

    - ~/.openclaw/workspace/paperclip-claimed-api-key.json
    chmod 600 ~/.openclaw/workspace/paperclip-claimed-api-key.json

    And set the PAPERCLIP_API_KEY and PAPERCLIP_API_URL in your environment variables as specified here:
    https://docs.openclaw.ai/help/environment

    e.g. 

    {
      env: {
        PAPERCLIP_API_KEY: "...",
        PAPERCLIP_API_URL: "...",
      },
    }

    Then set PAPERCLIP_API_KEY and PAPERCLIP_API_URL from the saved token field for every heartbeat run.

    Important:
    - claim secrets expire
    - claim secrets are single-use
    - claim fails before board approval

    ## Step 4: Install Paperclip skill in OpenClaw
    GET ${onboarding.skill.url}
    Install path: ${onboarding.skill.installPath}

    Be sure to prepend your PAPERCLIP_API_URL to the top of your skill and note the path to your PAPERCLIP_API_URL

    ## Text onboarding URL
    ${onboarding.textInstructions.url}

    ## Connectivity guidance
    ${
      onboarding.connectivity?.guidance ??
      "Ensure Paperclip is reachable from your OpenClaw runtime."
    }
  `);

  const connectionCandidates = Array.isArray(
    onboarding.connectivity?.connectionCandidates
  )
    ? onboarding.connectivity.connectionCandidates.filter(
        (entry): entry is string => Boolean(entry)
      )
    : [];

  if (connectionCandidates.length > 0) {
    lines.push("## Suggested Paperclip base URLs to try");
    for (const candidate of connectionCandidates) {
      lines.push(`- ${candidate}`);
    }
    appendBlock(`

      Test each candidate with:
      - GET <candidate>/api/health
      - set the first reachable candidate as agentDefaultsPayload.paperclipApiUrl when submitting your join request

      If none are reachable: ask your human operator for a reachable hostname/address and help them update network configuration.
      For authenticated/private mode, they may need:
      - pnpm paperclipai allowed-hostname <host>
      - then restart Paperclip and retry onboarding.
    `);
  }

  if (diagnostics.length > 0) {
    lines.push("## Connectivity diagnostics");
    for (const diag of diagnostics) {
      lines.push(`- [${diag.level}] ${diag.message}`);
      if (diag.hint) lines.push(`  hint: ${diag.hint}`);
    }
  }

  appendBlock(`

    ## Helpful endpoints
    ${onboarding.registrationEndpoint.path}
    ${onboarding.claimEndpointTemplate.path}
    ${onboarding.skill.path}
    ${manifest.invite.onboardingPath}
  `);

  return `${lines.join("\n")}\n`;
}

function extractInviteMessage(
  invite: typeof invites.$inferSelect
): string | null {
  const rawDefaults = invite.defaultsPayload;
  if (
    !rawDefaults ||
    typeof rawDefaults !== "object" ||
    Array.isArray(rawDefaults)
  ) {
    return null;
  }
  const rawMessage = (rawDefaults as Record<string, unknown>).agentMessage;
  if (typeof rawMessage !== "string") {
    return null;
  }
  const trimmed = rawMessage.trim();
  return trimmed.length ? trimmed : null;
}

function mergeInviteDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  agentMessage: string | null,
  humanRole: "owner" | "admin" | "operator" | "viewer" | null = null,
): Record<string, unknown> | null {
  const merged =
    defaultsPayload && typeof defaultsPayload === "object"
      ? { ...defaultsPayload }
      : {};
  if (humanRole) {
    const existingHuman =
      isPlainObject(merged.human) ? { ...(merged.human as Record<string, unknown>) } : {};
    merged.human = {
      ...existingHuman,
      role: humanRole,
      grants: grantsForHumanRole(humanRole),
    };
  }
  if (agentMessage) {
    merged.agentMessage = agentMessage;
  }
  return Object.keys(merged).length ? merged : null;
}

function requestIp(req: Request) {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || "unknown";
}

function inviteExpired(invite: typeof invites.$inferSelect) {
  return invite.expiresAt.getTime() <= Date.now();
}

function inviteState(invite: typeof invites.$inferSelect) {
  if (invite.revokedAt) return "revoked" as const;
  if (invite.acceptedAt) return "accepted" as const;
  if (inviteExpired(invite)) return "expired" as const;
  return "active" as const;
}

function extractInviteHumanRole(invite: typeof invites.$inferSelect) {
  if (invite.allowedJoinTypes === "agent") return null;
  return resolveHumanInviteRole(
    invite.defaultsPayload as Record<string, unknown> | null | undefined,
  );
}

function isLocalImplicit(req: Request) {
  return req.actor.type === "board" && req.actor.source === "local_implicit";
}

function toUserProfile(
  user:
    | {
      id: string;
      email: string | null;
      name: string | null;
      image?: string | null;
    }
    | null
    | undefined,
) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  };
}

async function resolveActorEmail(db: Db, req: Request): Promise<string | null> {
  if (isLocalImplicit(req)) return "local@paperclip.local";
  const userId = req.actor.userId;
  if (!userId) return null;
  const user = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
  return user?.email ?? null;
}

async function resolveAcceptedInviteJoinRequest(
  db: Db,
  req: Request,
  invite: typeof invites.$inferSelect | null,
) {
  if (!invite?.acceptedAt) return null;

  const directJoinRequest = await db
    .select({
      requestType: joinRequests.requestType,
      status: joinRequests.status,
      requestingUserId: joinRequests.requestingUserId,
      requestEmailSnapshot: joinRequests.requestEmailSnapshot,
    })
    .from(joinRequests)
    .where(eq(joinRequests.inviteId, invite.id))
    .then((rows) => rows[0] ?? null);
  if (directJoinRequest) return directJoinRequest;

  if (!invite.companyId) return null;

  const actorRequestingUserId = isLocalImplicit(req)
    ? "local-board"
    : req.actor.userId ?? null;
  const actorEmail = await resolveActorEmail(db, req);
  if (!actorRequestingUserId && !actorEmail) return null;

  return findReusableHumanJoinRequest(
    await db
      .select({
        id: joinRequests.id,
        requestType: joinRequests.requestType,
        status: joinRequests.status,
        requestingUserId: joinRequests.requestingUserId,
        requestEmailSnapshot: joinRequests.requestEmailSnapshot,
      })
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.companyId, invite.companyId),
          eq(joinRequests.requestType, "human"),
        ),
      )
      .orderBy(desc(joinRequests.createdAt)),
    {
      requestingUserId: actorRequestingUserId,
      requestEmailSnapshot: actorEmail,
    },
  );
}

function grantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent"
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return [];
  const scoped = defaultsPayload[key];
  if (!scoped || typeof scoped !== "object") return [];
  const grants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return [];
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const result: Array<{
    permissionKey: (typeof PERMISSION_KEYS)[number];
    scope: Record<string, unknown> | null;
  }> = [];
  for (const item of grants) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.permissionKey !== "string") continue;
    if (!validPermissionKeys.has(record.permissionKey)) continue;
    result.push({
      permissionKey: record.permissionKey as (typeof PERMISSION_KEYS)[number],
      scope:
        record.scope &&
        typeof record.scope === "object" &&
        !Array.isArray(record.scope)
          ? (record.scope as Record<string, unknown>)
          : null
    });
  }
  return result;
}

export function agentJoinGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  const grants = grantsFromDefaults(defaultsPayload, "agent");
  if (grants.some((grant) => grant.permissionKey === "tasks:assign")) {
    return grants;
  }
  return [
    ...grants,
    {
      permissionKey: "tasks:assign",
      scope: null
    }
  ];
}

type JoinRequestManagerCandidate = {
  id: string;
  role: string;
  reportsTo: string | null;
};

export function resolveJoinRequestAgentManagerId(
  candidates: JoinRequestManagerCandidate[]
): string | null {
  const ceoCandidates = candidates.filter(
    (candidate) => candidate.role === "ceo"
  );
  if (ceoCandidates.length === 0) return null;
  const rootCeo = ceoCandidates.find(
    (candidate) => candidate.reportsTo === null
  );
  return (rootCeo ?? ceoCandidates[0] ?? null)?.id ?? null;
}

function isInviteTokenHashCollisionError(error: unknown) {
  const candidates = [
    error,
    (error as { cause?: unknown } | null)?.cause ?? null
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const code =
      "code" in candidate && typeof candidate.code === "string"
        ? candidate.code
        : null;
    const message =
      "message" in candidate && typeof candidate.message === "string"
        ? candidate.message
        : "";
    const constraint =
      "constraint" in candidate && typeof candidate.constraint === "string"
        ? candidate.constraint
        : null;
    if (code !== "23505") continue;
    if (constraint === "invites_token_hash_unique_idx") return true;
    if (message.includes("invites_token_hash_unique_idx")) return true;
  }
  return false;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

type InviteResolutionProbe = {
  status: "reachable" | "timeout" | "unreachable";
  method: "HEAD";
  durationMs: number;
  httpStatus: number | null;
  message: string;
};

type InviteResolutionLookupResult = {
  address: string;
  family?: number;
};

type ResolvedInviteResolutionTarget = {
  url: URL;
  resolvedAddress: string;
  resolvedAddresses: string[];
  hostHeader: string;
  tlsServername?: string;
};

type InviteResolutionHeadResponse = {
  httpStatus: number | null;
};

type InviteResolutionNetwork = {
  lookup(hostname: string): Promise<InviteResolutionLookupResult[]>;
  requestHead(
    target: ResolvedInviteResolutionTarget,
    timeoutMs: number
  ): Promise<InviteResolutionHeadResponse>;
};

function parseIpv4Address(address: string) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const parsed = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN;
    return Number(part);
  });
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parsed as [number, number, number, number];
}

function isPrivateOrReservedIpv4(address: string) {
  const octets = parseIpv4Address(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseMappedIpv4Hex(address: string) {
  const match = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const hi = Number.parseInt(match[1]!, 16);
  const lo = Number.parseInt(match[2]!, 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateOrReservedIpv6(address: string) {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const mappedIpv4 = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedIpv4?.[1]) return isPrivateOrReservedIpv4(mappedIpv4[1]);
    const mappedIpv4Hex = parseMappedIpv4Hex(lower);
    if (mappedIpv4Hex) return isPrivateOrReservedIpv4(mappedIpv4Hex);
    return true;
  }
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith("ff")) return true;
  if (lower === "100::" || lower.startsWith("100:")) return true;
  if (lower.startsWith("2001:db8:") || lower === "2001:db8::") return true;
  if (lower.startsWith("2001:2:") || lower === "2001:2::") return true;
  if (lower.startsWith("2002:")) return true;
  if (lower.startsWith("64:ff9b:")) return true;
  return false;
}

function isPublicIpAddress(address: string) {
  const ipVersion = isIP(address);
  if (ipVersion === 4) return !isPrivateOrReservedIpv4(address);
  if (ipVersion === 6) return !isPrivateOrReservedIpv6(address);
  return false;
}

function hostnameForResolution(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, "");
}

async function defaultInviteResolutionLookup(
  hostname: string
): Promise<InviteResolutionLookupResult[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function defaultInviteResolutionHeadRequest(
  target: ResolvedInviteResolutionTarget,
  timeoutMs: number
): Promise<InviteResolutionHeadResponse> {
  return new Promise((resolve, reject) => {
    const url = target.url;
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const options: HttpRequestOptions & { servername?: string } = {
      protocol: url.protocol,
      hostname: target.resolvedAddress,
      port: url.port || undefined,
      method: "HEAD",
      path: `${url.pathname}${url.search}`,
      headers: {
        Host: target.hostHeader
      }
    };
    if (target.tlsServername) {
      options.servername = target.tlsServername;
    }

    let settled = false;
    const req = request(options, (response: IncomingMessage) => {
      settled = true;
      response.resume();
      resolve({ httpStatus: response.statusCode ?? null });
    });
    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      const error = new Error("Invite resolution probe timed out");
      error.name = "AbortError";
      req.destroy(error);
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.end();
  });
}

const defaultInviteResolutionNetwork: InviteResolutionNetwork = {
  lookup: defaultInviteResolutionLookup,
  requestHead: defaultInviteResolutionHeadRequest
};

let inviteResolutionNetwork = defaultInviteResolutionNetwork;

export function setInviteResolutionNetworkForTest(
  network: Partial<InviteResolutionNetwork> | null
) {
  inviteResolutionNetwork = network
    ? { ...defaultInviteResolutionNetwork, ...network }
    : defaultInviteResolutionNetwork;
}

async function lookupInviteResolutionHostname(
  hostname: string,
  network: InviteResolutionNetwork = inviteResolutionNetwork
) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      network.lookup(hostname),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              badRequest(
                `url hostname DNS lookup timed out after ${INVITE_RESOLUTION_DNS_TIMEOUT_MS}ms`
              )
            ),
          INVITE_RESOLUTION_DNS_TIMEOUT_MS
        );
      })
    ]);
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    throw badRequest("url hostname could not be resolved");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function resolveInviteResolutionTarget(
  url: URL,
  network: InviteResolutionNetwork = inviteResolutionNetwork
): Promise<ResolvedInviteResolutionTarget> {
  const hostname = hostnameForResolution(url);
  if (parseIpv4Address(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw badRequest(
        "url resolves to a private, local, multicast, or reserved address"
      );
    }
    return {
      url,
      resolvedAddress: hostname,
      resolvedAddresses: [hostname],
      hostHeader: url.host,
      tlsServername: undefined,
    };
  }
  const literalIpVersion = isIP(hostname);
  if (literalIpVersion !== 0) {
    if (!isPublicIpAddress(hostname)) {
      throw badRequest(
        "url resolves to a private, local, multicast, or reserved address"
      );
    }
    return {
      url,
      resolvedAddress: hostname,
      resolvedAddresses: [hostname],
      hostHeader: url.host,
      tlsServername: undefined,
    };
  }
  const results = await lookupInviteResolutionHostname(hostname, network);
  if (results.length === 0) {
    throw badRequest("url hostname did not resolve to any addresses");
  }

  const resolvedAddresses = results.map((result) => result.address);
  const unsafeAddress = resolvedAddresses.find((address) => !isPublicIpAddress(address));
  if (unsafeAddress) {
    throw badRequest(
      "url resolves to a private, local, multicast, or reserved address"
    );
  }

  return {
    url,
    resolvedAddress: resolvedAddresses[0]!,
    resolvedAddresses,
    hostHeader: url.host,
    tlsServername: url.protocol === "https:" && isIP(hostname) === 0
      ? hostname
      : undefined
  };
}

async function probeInviteResolutionTarget(
  target: ResolvedInviteResolutionTarget,
  timeoutMs: number,
  network: InviteResolutionNetwork = inviteResolutionNetwork
): Promise<InviteResolutionProbe> {
  const startedAt = Date.now();
  try {
    const response = await network.requestHead(target, timeoutMs);
    const durationMs = Date.now() - startedAt;
    if (
      response.httpStatus !== null &&
      (
        (response.httpStatus >= 200 && response.httpStatus < 300) ||
        response.httpStatus === 401 ||
        response.httpStatus === 403 ||
        response.httpStatus === 404 ||
        response.httpStatus === 405 ||
        response.httpStatus === 422 ||
        response.httpStatus === 500 ||
        response.httpStatus === 501
      )
    ) {
      return {
        status: "reachable",
        method: "HEAD",
        durationMs,
        httpStatus: response.httpStatus,
        message: `Webhook endpoint responded to HEAD with HTTP ${response.httpStatus}.`
      };
    }
    return {
      status: "unreachable",
      method: "HEAD",
      durationMs,
      httpStatus: response.httpStatus,
      message: response.httpStatus === null
        ? "Webhook endpoint probe did not return an HTTP status."
        : `Webhook endpoint probe returned HTTP ${response.httpStatus}.`
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (isAbortError(error)) {
      return {
        status: "timeout",
        method: "HEAD",
        durationMs,
        httpStatus: null,
        message: `Webhook endpoint probe timed out after ${timeoutMs}ms.`
      };
    }
    return {
      status: "unreachable",
      method: "HEAD",
      durationMs,
      httpStatus: null,
      message:
        error instanceof Error
          ? error.message
          : "Webhook endpoint probe failed."
    };
  }
}

export function accessRoutes(
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
    inviteResolutionNetwork?: Partial<InviteResolutionNetwork>;
  }
) {
  const router = Router();
  const access = accessService(db);
  const boardAuth = boardAuthService(db);
  const agents = agentService(db);
  const routeInviteResolutionNetwork = opts.inviteResolutionNetwork
    ? { ...defaultInviteResolutionNetwork, ...opts.inviteResolutionNetwork }
    : inviteResolutionNetwork;

  async function assertInstanceAdmin(req: Request) {
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.isInstanceAdmin(req.actor.userId);
    if (!allowed) throw forbidden("Instance admin required");
  }

  router.get("/board-claim/:token", async (req, res) => {
    const token = (req.params.token as string).trim();
    const code =
      typeof req.query.code === "string" ? req.query.code.trim() : undefined;
    if (!token) throw notFound("Board claim challenge not found");
    const challenge = inspectBoardClaimChallenge(token, code);
    if (challenge.status === "invalid")
      throw notFound("Board claim challenge not found");
    res.json(challenge);
  });

  router.post("/board-claim/:token/claim", async (req, res) => {
    const token = (req.params.token as string).trim();
    const code =
      typeof req.body?.code === "string" ? req.body.code.trim() : undefined;
    if (!token) throw notFound("Board claim challenge not found");
    if (!code) throw badRequest("Claim code is required");
    if (
      req.actor.type !== "board" ||
      req.actor.source !== "session" ||
      !req.actor.userId
    ) {
      throw unauthorized("Sign in before claiming board ownership");
    }

    const claimed = await claimBoardOwnership(db, {
      token,
      code,
      userId: req.actor.userId
    });

    if (claimed.status === "invalid")
      throw notFound("Board claim challenge not found");
    if (claimed.status === "expired")
      throw conflict(
        "Board claim challenge expired. Restart server to generate a new one."
      );
    if (claimed.status === "claimed") {
      res.json({
        claimed: true,
        userId: claimed.claimedByUserId ?? req.actor.userId
      });
      return;
    }

    throw conflict("Board claim challenge is no longer available");
  });

  router.post(
    "/cli-auth/challenges",
    validate(createCliAuthChallengeSchema),
    async (req, res) => {
      const created = await boardAuth.createCliAuthChallenge(req.body);
      const approvalPath = buildCliAuthApprovalPath(
        created.challenge.id,
        created.challengeSecret,
      );
      const baseUrl = requestBaseUrl(req);
      res.status(201).json({
        id: created.challenge.id,
        token: created.challengeSecret,
        boardApiToken: created.pendingBoardToken,
        approvalPath,
        approvalUrl: baseUrl ? `${baseUrl}${approvalPath}` : null,
        pollPath: `/cli-auth/challenges/${created.challenge.id}`,
        expiresAt: created.challenge.expiresAt.toISOString(),
        suggestedPollIntervalMs: 1000,
      });
    },
  );

  router.get("/cli-auth/challenges/:id", async (req, res) => {
    const id = (req.params.id as string).trim();
    const token =
      typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!id || !token) throw notFound("CLI auth challenge not found");
    const challenge = await boardAuth.describeCliAuthChallenge(id, token);
    if (!challenge) throw notFound("CLI auth challenge not found");

    const isSignedInBoardUser =
      req.actor.type === "board" &&
      (req.actor.source === "session" || isLocalImplicit(req)) &&
      Boolean(req.actor.userId);
    const canApprove =
      isSignedInBoardUser &&
      (challenge.requestedAccess !== "instance_admin_required" ||
        isLocalImplicit(req) ||
        Boolean(req.actor.isInstanceAdmin));

    res.json({
      ...challenge,
      requiresSignIn: !isSignedInBoardUser,
      canApprove,
      currentUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
  });

  router.post(
    "/cli-auth/challenges/:id/approve",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = (req.params.id as string).trim();
      if (
        req.actor.type !== "board" ||
        (!req.actor.userId && !isLocalImplicit(req))
      ) {
        throw unauthorized("Sign in before approving CLI access");
      }

      const userId = req.actor.userId ?? "local-board";
      const approved = await boardAuth.approveCliAuthChallenge(
        id,
        req.body.token,
        userId,
      );

      if (approved.status === "approved") {
        const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
          userId,
          requestedCompanyId: approved.challenge.requestedCompanyId,
          boardApiKeyId: approved.challenge.boardApiKeyId,
        });
        for (const companyId of companyIds) {
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "board_api_key.created",
            entityType: "user",
            entityId: userId,
            details: {
              boardApiKeyId: approved.challenge.boardApiKeyId,
              requestedAccess: approved.challenge.requestedAccess,
              requestedCompanyId: approved.challenge.requestedCompanyId,
              challengeId: approved.challenge.id,
            },
          });
        }
      }

      res.json({
        approved: approved.status === "approved",
        status: approved.status,
        userId,
        keyId: approved.challenge.boardApiKeyId ?? null,
        expiresAt: approved.challenge.expiresAt.toISOString(),
      });
    },
  );

  router.post(
    "/cli-auth/challenges/:id/cancel",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = (req.params.id as string).trim();
      const cancelled = await boardAuth.cancelCliAuthChallenge(id, req.body.token);
      res.json({
        status: cancelled.status,
        cancelled: cancelled.status === "cancelled",
      });
    },
  );

  router.get("/cli-auth/me", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const accessSnapshot = await boardAuth.resolveBoardAccess(req.actor.userId);
    res.json({
      user: accessSnapshot.user,
      userId: req.actor.userId,
      isInstanceAdmin: accessSnapshot.isInstanceAdmin,
      companyIds: accessSnapshot.companyIds,
      memberships: accessSnapshot.memberships,
      source: req.actor.source ?? "none",
      keyId: req.actor.source === "board_key" ? req.actor.keyId ?? null : null,
    });
  });

  router.post("/cli-auth/revoke-current", async (req, res) => {
    if (req.actor.type !== "board" || req.actor.source !== "board_key") {
      throw badRequest("Current board API key context is required");
    }
    const key = await boardAuth.assertCurrentBoardKey(
      req.actor.keyId,
      req.actor.userId,
    );
    await boardAuth.revokeBoardApiKey(key.id);
    const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
      userId: key.userId,
      boardApiKeyId: key.id,
    });
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: key.userId,
        action: "board_api_key.revoked",
        entityType: "user",
        entityId: key.userId,
        details: {
          boardApiKeyId: key.id,
          revokedVia: "cli_auth_logout",
        },
      });
    }
    res.json({ revoked: true, keyId: key.id });
  });

  async function assertCompanyPermission(
    req: Request,
    companyId: string,
    permissionKey: any
  ) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden();
      const allowed = await access.hasPermission(
        companyId,
        "agent",
        req.actor.agentId,
        permissionKey
      );
      if (!allowed) throw forbidden("Permission denied");
      return;
    }
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.canUser(
      companyId,
      req.actor.userId,
      permissionKey
    );
    if (!allowed) throw forbidden("Permission denied");
  }

  async function assertCanGenerateOpenClawInvitePrompt(
    req: Request,
    companyId: string
  ) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const actorAgent = await agents.getById(req.actor.agentId);
      if (!actorAgent || actorAgent.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
      if (actorAgent.role !== "ceo") {
        throw forbidden("Only CEO agents can generate OpenClaw invite prompts");
      }
      return;
    }
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "users:invite");
    if (!allowed) throw forbidden("Permission denied");
  }

  async function createCompanyInviteForCompany(input: {
    req: Request;
    companyId: string;
    allowedJoinTypes: "human" | "agent" | "both";
    humanRole?: "owner" | "admin" | "operator" | "viewer" | null;
    defaultsPayload?: Record<string, unknown> | null;
    agentMessage?: string | null;
  }) {
    const normalizedAgentMessage =
      typeof input.agentMessage === "string"
        ? input.agentMessage.trim() || null
        : null;
    const effectiveHumanRole =
      input.allowedJoinTypes === "agent"
        ? null
        : input.humanRole ?? "operator";
    const insertValues = {
      companyId: input.companyId,
      inviteType: "company_join" as const,
      allowedJoinTypes: input.allowedJoinTypes,
      defaultsPayload: mergeInviteDefaults(
        input.defaultsPayload ?? null,
        normalizedAgentMessage,
        effectiveHumanRole,
      ),
      expiresAt: companyInviteExpiresAt(),
      invitedByUserId: input.req.actor.userId ?? null
    };

    let token: string | null = null;
    let created: typeof invites.$inferSelect | null = null;
    for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
      const candidateToken = createInviteToken();
      try {
        const row = await db
          .insert(invites)
          .values({
            ...insertValues,
            tokenHash: hashToken(candidateToken)
          })
          .returning()
          .then((rows) => rows[0]);
        token = candidateToken;
        created = row;
        break;
      } catch (error) {
        if (!isInviteTokenHashCollisionError(error)) {
          throw error;
        }
      }
    }
    if (!token || !created) {
      throw conflict("Failed to generate a unique invite token. Please retry.");
    }

    return { token, created, normalizedAgentMessage };
  }

  async function getInviteCompanyBranding(
    companyId: string | null,
    inviteToken: string | null = null,
  ): Promise<{
    name: string | null;
    brandColor: string | null;
    logoAssetId: string | null;
    logoUrl: string | null;
  }> {
    if (!companyId) {
      return { name: null, brandColor: null, logoAssetId: null, logoUrl: null };
    }
    const company = await db
      .select({
        name: companies.name,
        brandColor: companies.brandColor,
        logoAssetId: companyLogos.assetId,
      })
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id))
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    let logoUrl: string | null = null;
    if (inviteToken && company?.logoAssetId) {
      const logoAsset = await getInviteLogoAsset(companyId);
      if (logoAsset?.companyId) {
        try {
          const storage = getStorageService();
          const logoObject = await storage.headObject(logoAsset.companyId, logoAsset.objectKey);
          if (logoObject.exists) {
            logoUrl = `/api/invites/${inviteToken}/logo`;
          }
        } catch (err) {
          logger.warn(
            {
              err,
              companyId,
              logoAssetId: company.logoAssetId,
            },
            "invite logo storage check failed",
          );
        }
      }
    }

    return {
      name: company?.name ?? null,
      brandColor: company?.brandColor ?? null,
      logoAssetId: company?.logoAssetId ?? null,
      logoUrl,
    };
  }

  async function getInviteLogoAsset(companyId: string | null): Promise<{
    companyId: string | null;
    objectKey: string;
    contentType: string | null;
    byteSize: number | null;
    originalFilename: string | null;
  } | null> {
    if (!companyId) return null;
    const logoAsset = await db
      .select({
        companyId: companies.id,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        originalFilename: assets.originalFilename,
      })
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id))
      .leftJoin(assets, eq(assets.id, companyLogos.assetId))
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    if (!logoAsset?.objectKey) return null;
    return {
      companyId: logoAsset.companyId,
      objectKey: logoAsset.objectKey,
      contentType: logoAsset.contentType,
      byteSize: logoAsset.byteSize,
      originalFilename: logoAsset.originalFilename,
    };
  }

  router.get("/skills/available", (req, res) => {
    assertAuthenticated(req);
    res.json({ skills: listAvailableSkills() });
  });

  router.get("/skills/index", (req, res) => {
    assertAuthenticated(req);
    res.json({
      skills: [
        { name: "paperclip", path: "/api/skills/paperclip" },
        {
          name: "para-memory-files",
          path: "/api/skills/para-memory-files"
        },
        {
          name: "paperclip-create-agent",
          path: "/api/skills/paperclip-create-agent"
        },
        {
          name: "paperclip-converting-plans-to-tasks",
          path: "/api/skills/paperclip-converting-plans-to-tasks"
        }
      ]
    });
  });

  router.get("/skills/:skillName", (req, res) => {
    assertAuthenticated(req);
    const skillName = (req.params.skillName as string).trim().toLowerCase();
    const markdown = readSkillMarkdown(skillName);
    if (!markdown) throw notFound("Skill not found");
    res.type("text/markdown").send(markdown);
  });

  router.post(
    "/companies/:companyId/invites",
    validate(createCompanyInviteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyPermission(req, companyId, "users:invite");
      const { token, created, normalizedAgentMessage } =
        await createCompanyInviteForCompany({
          req,
          companyId,
          allowedJoinTypes: req.body.allowedJoinTypes,
          humanRole: req.body.humanRole ?? null,
          defaultsPayload: req.body.defaultsPayload ?? null,
          agentMessage: req.body.agentMessage ?? null
        });

      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.created",
        entityType: "invite",
        entityId: created.id,
        details: {
          inviteType: created.inviteType,
          allowedJoinTypes: created.allowedJoinTypes,
          expiresAt: created.expiresAt.toISOString(),
          humanRole: extractInviteHumanRole(created),
          hasAgentMessage: Boolean(normalizedAgentMessage)
        }
      });

      const companyBranding = await getInviteCompanyBranding(created.companyId, token);
      const inviteSummary = toInviteSummaryResponse(
        req,
        token,
        created,
        companyBranding
      );
      res.status(201).json({
        ...created,
        token,
        invitePath: inviteSummary.invitePath,
        inviteUrl: inviteSummary.inviteUrl,
        companyName: companyBranding.name,
        onboardingTextPath: inviteSummary.onboardingTextPath,
        onboardingTextUrl: inviteSummary.onboardingTextUrl,
        inviteMessage: inviteSummary.inviteMessage
      });
    }
  );

  router.post(
    "/companies/:companyId/openclaw/invite-prompt",
    validate(createOpenClawInvitePromptSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanGenerateOpenClawInvitePrompt(req, companyId);
      const { token, created, normalizedAgentMessage } =
        await createCompanyInviteForCompany({
          req,
          companyId,
          allowedJoinTypes: "agent",
          humanRole: null,
          defaultsPayload: null,
          agentMessage: req.body.agentMessage ?? null
        });

      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.openclaw_prompt_created",
        entityType: "invite",
        entityId: created.id,
        details: {
          inviteType: created.inviteType,
          allowedJoinTypes: created.allowedJoinTypes,
          expiresAt: created.expiresAt.toISOString(),
          hasAgentMessage: Boolean(normalizedAgentMessage)
        }
      });

      const companyBranding = await getInviteCompanyBranding(created.companyId, token);
      const inviteSummary = toInviteSummaryResponse(
        req,
        token,
        created,
        companyBranding
      );
      res.status(201).json({
        ...created,
        token,
        invitePath: inviteSummary.invitePath,
        inviteUrl: inviteSummary.inviteUrl,
        companyName: companyBranding.name,
        onboardingTextPath: inviteSummary.onboardingTextPath,
        onboardingTextUrl: inviteSummary.onboardingTextUrl,
        inviteMessage: inviteSummary.inviteMessage
      });
    }
  );

  router.get("/invites/:token", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    const inviteJoinRequest = await resolveAcceptedInviteJoinRequest(db, req, invite);
    if (
      !invite ||
      invite.revokedAt ||
      inviteExpired(invite) ||
      (invite.acceptedAt && !inviteJoinRequest)
    ) {
      throw notFound("Invite not found");
    }

    const companyBranding = await getInviteCompanyBranding(invite.companyId, token);
    const inviterName = invite.invitedByUserId
      ? await loadUsersById(db, [invite.invitedByUserId]).then(
          (m) => m.get(invite.invitedByUserId!)?.name ?? null
        )
      : null;
    res.json({
      ...toInviteSummaryResponse(req, token, invite, companyBranding),
      invitedByUserName: inviterName,
      joinRequestStatus: inviteJoinRequest?.status ?? null,
      joinRequestType: inviteJoinRequest?.requestType ?? null,
    });
  });

  router.get("/invites/:token/logo", async (req, res, next) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    const inviteJoinRequest = await resolveAcceptedInviteJoinRequest(db, req, invite);
    if (
      !invite ||
      invite.revokedAt ||
      inviteExpired(invite) ||
      (invite.acceptedAt && !inviteJoinRequest)
    ) {
      throw notFound("Invite not found");
    }

    const logoAsset = await getInviteLogoAsset(invite.companyId);
    if (!logoAsset || !logoAsset.companyId) {
      throw notFound("Invite logo not found");
    }
    const companyId = logoAsset.companyId;

    const storage = getStorageService();
    const logoHead = await storage.headObject(companyId, logoAsset.objectKey);
    if (!logoHead.exists) {
      throw notFound("Invite logo not found");
    }
    const object = await storage.getObject(companyId, logoAsset.objectKey);
    const responseContentType =
      logoAsset.contentType ||
      logoHead.contentType ||
      object.contentType ||
      "application/octet-stream";
    res.setHeader("Content-Type", responseContentType);
    res.setHeader(
      "Content-Length",
      String(logoAsset.byteSize || logoHead.contentLength || object.contentLength || 0),
    );
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === "image/svg+xml") {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = logoAsset.originalFilename ?? "company-logo";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.get("/invites/:token/onboarding", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    const companyBranding = await getInviteCompanyBranding(invite.companyId);
    res.json(buildInviteOnboardingManifest(req, token, invite, {
      ...opts,
      companyName: companyBranding.name
    }));
  });

  router.get("/invites/:token/onboarding.txt", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    const companyBranding = await getInviteCompanyBranding(invite.companyId);
    res
      .type("text/plain; charset=utf-8")
      .send(
        buildInviteOnboardingTextDocument(req, token, invite, {
          ...opts,
          companyName: companyBranding.name
        })
      );
  });

  router.get("/invites/:token/skills/index", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    res.json({
      skills: [
        {
          name: "paperclip",
          path: `/api/invites/${token}/skills/paperclip`,
        },
      ],
    });
  });

  router.get("/invites/:token/skills/:skillName", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    const skillName = (req.params.skillName as string).trim().toLowerCase();
    if (skillName !== "paperclip") throw notFound("Skill not found");
    const markdown = readSkillMarkdown(skillName);
    if (!markdown) throw notFound("Skill not found");
    res.type("text/markdown").send(markdown);
  });

  router.get("/invites/:token/test-resolution", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    const rawUrl =
      typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!rawUrl) throw badRequest("url query parameter is required");
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      throw badRequest("url must be an absolute http(s) URL");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw badRequest("url must use http or https");
    }

    const parsedTimeoutMs =
      typeof req.query.timeoutMs === "string"
        ? Number(req.query.timeoutMs)
        : NaN;
    const timeoutMs = Number.isFinite(parsedTimeoutMs)
      ? Math.max(1000, Math.min(15000, Math.floor(parsedTimeoutMs)))
      : 5000;
    const resolvedTarget = await resolveInviteResolutionTarget(target, routeInviteResolutionNetwork);
    const probe = await probeInviteResolutionTarget(resolvedTarget, timeoutMs, routeInviteResolutionNetwork);
    res.json({
      inviteId: invite.id,
      testResolutionPath: `/api/invites/${token}/test-resolution`,
      requestedUrl: target.toString(),
      timeoutMs,
      ...probe
    });
  });

  router.post(
    "/invites/:token/accept",
    validate(acceptInviteSchema),
    async (req, res) => {
      const token = (req.params.token as string).trim();
      if (!token) throw notFound("Invite not found");

      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, hashToken(token)))
        .then((rows) => rows[0] ?? null);
      if (!invite || invite.revokedAt || inviteExpired(invite)) {
        throw notFound("Invite not found");
      }
      const inviteAlreadyAccepted = Boolean(invite.acceptedAt);
      const existingJoinRequestForInvite = inviteAlreadyAccepted
        ? await db
            .select()
            .from(joinRequests)
            .where(eq(joinRequests.inviteId, invite.id))
            .then((rows) => rows[0] ?? null)
        : null;

      if (invite.inviteType === "bootstrap_ceo") {
        if (inviteAlreadyAccepted) throw notFound("Invite not found");
        if (req.body.requestType !== "human") {
          throw badRequest("Bootstrap invite requires human request type");
        }
        if (
          req.actor.type !== "board" ||
          (!req.actor.userId && !isLocalImplicit(req))
        ) {
          throw unauthorized(
            "Authenticated user required for bootstrap acceptance"
          );
        }
        const userId = req.actor.userId ?? "local-board";
        const existingAdmin = await access.isInstanceAdmin(userId);
        if (!existingAdmin) {
          await access.promoteInstanceAdmin(userId);
        }
        const updatedInvite = await db
          .update(invites)
          .set({ acceptedAt: new Date(), updatedAt: new Date() })
          .where(eq(invites.id, invite.id))
          .returning()
          .then((rows) => rows[0] ?? invite);
        res.status(202).json({
          inviteId: updatedInvite.id,
          inviteType: updatedInvite.inviteType,
          bootstrapAccepted: true,
          userId
        });
        return;
      }

      const requestType = req.body.requestType as "human" | "agent";
      const companyId = invite.companyId;
      if (!companyId) throw conflict("Invite is missing company scope");
      if (
        invite.allowedJoinTypes !== "both" &&
        invite.allowedJoinTypes !== requestType
      ) {
        throw badRequest(`Invite does not allow ${requestType} joins`);
      }

      if (requestType === "human" && req.actor.type !== "board") {
        throw unauthorized(
          "Human invite acceptance requires authenticated user"
        );
      }
      if (
        requestType === "human" &&
        !req.actor.userId &&
        !isLocalImplicit(req)
      ) {
        throw unauthorized("Authenticated user is required");
      }
      if (
        requestType === "human" &&
        actorHasActiveUserMembership(req, companyId)
      ) {
        throw conflict("You already belong to this company");
      }
      if (requestType === "agent" && !req.body.agentName) {
        if (
          !inviteAlreadyAccepted ||
          !existingJoinRequestForInvite?.agentName
        ) {
          throw badRequest("agentName is required for agent join requests");
        }
      }

      const adapterType = req.body.adapterType ?? null;
      if (
        inviteAlreadyAccepted &&
        !canReplayOpenClawGatewayInviteAccept({
          requestType,
          adapterType,
          existingJoinRequest: existingJoinRequestForInvite
        })
      ) {
        throw notFound("Invite not found");
      }
      const replayJoinRequestId = inviteAlreadyAccepted
        ? existingJoinRequestForInvite?.id ?? null
        : null;
      if (inviteAlreadyAccepted && !replayJoinRequestId) {
        throw conflict("Join request not found");
      }

      const replayMergedDefaults = inviteAlreadyAccepted
        ? mergeJoinDefaultsPayloadForReplay(
            existingJoinRequestForInvite?.agentDefaultsPayload ?? null,
            req.body.agentDefaultsPayload ?? null
          )
        : req.body.agentDefaultsPayload ?? null;

      const gatewayDefaultsPayload =
        requestType === "agent"
          ? buildJoinDefaultsPayloadForAccept({
              adapterType,
              defaultsPayload: replayMergedDefaults,
              paperclipApiUrl: req.body.paperclipApiUrl ?? null,
              inboundOpenClawAuthHeader: req.header("x-openclaw-auth") ?? null,
              inboundOpenClawTokenHeader: req.header("x-openclaw-token") ?? null
            })
          : null;

      const joinDefaults =
        requestType === "agent"
          ? normalizeAgentDefaultsForJoin({
              adapterType,
              defaultsPayload: gatewayDefaultsPayload,
              deploymentMode: opts.deploymentMode,
              deploymentExposure: opts.deploymentExposure,
              bindHost: opts.bindHost,
              allowedHostnames: opts.allowedHostnames
            })
          : {
              normalized: null as Record<string, unknown> | null,
              diagnostics: [] as JoinDiagnostic[],
              fatalErrors: [] as string[]
            };

      if (requestType === "agent" && joinDefaults.fatalErrors.length > 0) {
        throw badRequest(joinDefaults.fatalErrors.join("; "));
      }

      if (requestType === "agent" && adapterType === "openclaw_gateway") {
        logger.info(
          {
            inviteId: invite.id,
            joinRequestDiagnostics: joinDefaults.diagnostics.map((diag) => ({
              code: diag.code,
              level: diag.level
            })),
            normalizedAgentDefaults: summarizeOpenClawGatewayDefaultsForLog(
              joinDefaults.normalized
            )
          },
          "invite accept normalized OpenClaw gateway defaults"
        );
      }

      const claimSecret =
        requestType === "agent" && !inviteAlreadyAccepted
          ? createClaimSecret()
          : null;
      const claimSecretHash = claimSecret ? hashToken(claimSecret) : null;
      const claimSecretExpiresAt = claimSecret
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null;

      const actorEmail =
        requestType === "human" ? await resolveActorEmail(db, req) : null;
      const existingHumanJoinRequest =
        requestType === "human"
          ? findReusableHumanJoinRequest(
              await db
                .select()
                .from(joinRequests)
                .where(
                  and(
                    eq(joinRequests.companyId, companyId),
                    eq(joinRequests.requestType, "human")
                  )
                )
                .orderBy(desc(joinRequests.createdAt)),
              {
                requestingUserId: req.actor.userId ?? "local-board",
                requestEmailSnapshot: actorEmail
              }
            )
          : null;
      const created = !inviteAlreadyAccepted
        ? existingHumanJoinRequest
          ? await db.transaction(async (tx) => {
              await tx
                .update(invites)
                .set({ acceptedAt: new Date(), updatedAt: new Date() })
                .where(
                  and(
                    eq(invites.id, invite.id),
                    isNull(invites.acceptedAt),
                    isNull(invites.revokedAt)
                  )
                );
              return existingHumanJoinRequest;
            })
          : await db.transaction(async (tx) => {
              await tx
                .update(invites)
                .set({ acceptedAt: new Date(), updatedAt: new Date() })
                .where(
                  and(
                    eq(invites.id, invite.id),
                    isNull(invites.acceptedAt),
                    isNull(invites.revokedAt)
                  )
                );

              const row = await tx
                .insert(joinRequests)
                .values({
                  inviteId: invite.id,
                  companyId,
                  requestType,
                  status: "pending_approval",
                  requestIp: requestIp(req),
                  requestingUserId:
                    requestType === "human"
                      ? req.actor.userId ?? "local-board"
                      : null,
                  requestEmailSnapshot:
                    requestType === "human" ? actorEmail : null,
                  agentName:
                    requestType === "agent" ? req.body.agentName : null,
                  adapterType: requestType === "agent" ? adapterType : null,
                  capabilities:
                    requestType === "agent"
                      ? req.body.capabilities ?? null
                      : null,
                  agentDefaultsPayload:
                    requestType === "agent" ? joinDefaults.normalized : null,
                  claimSecretHash,
                  claimSecretExpiresAt
                })
                .returning()
                .then((rows) => rows[0]);
              return row;
            })
        : await db
            .update(joinRequests)
            .set({
              requestIp: requestIp(req),
              agentName:
                requestType === "agent"
                  ? req.body.agentName ??
                    existingJoinRequestForInvite?.agentName ??
                    null
                  : null,
              capabilities:
                requestType === "agent"
                  ? req.body.capabilities ??
                    existingJoinRequestForInvite?.capabilities ??
                    null
                  : null,
              adapterType: requestType === "agent" ? adapterType : null,
              agentDefaultsPayload:
                requestType === "agent" ? joinDefaults.normalized : null,
              updatedAt: new Date()
            })
            .where(eq(joinRequests.id, replayJoinRequestId as string))
            .returning()
            .then((rows) => rows[0]);

      if (!created) {
        throw conflict("Join request not found");
      }

      if (
        inviteAlreadyAccepted &&
        requestType === "agent" &&
        adapterType === "openclaw_gateway" &&
        created.status === "approved" &&
        created.createdAgentId
      ) {
        const existingAgent = await agents.getById(created.createdAgentId);
        if (!existingAgent) {
          throw conflict("Approved join request agent not found");
        }
        const existingAdapterConfig = isPlainObject(existingAgent.adapterConfig)
          ? (existingAgent.adapterConfig as Record<string, unknown>)
          : {};
        const nextAdapterConfig = {
          ...existingAdapterConfig,
          ...(joinDefaults.normalized ?? {})
        };
        const updatedAgent = await agents.update(created.createdAgentId, {
          adapterType,
          adapterConfig: nextAdapterConfig
        });
        if (!updatedAgent) {
          throw conflict("Approved join request agent not found");
        }
        await logActivity(db, {
          companyId,
          actorType: req.actor.type === "agent" ? "agent" : "user",
          actorId:
            req.actor.type === "agent"
              ? req.actor.agentId ?? "invite-agent"
              : req.actor.userId ?? "board",
          action: "agent.updated_from_join_replay",
          entityType: "agent",
          entityId: updatedAgent.id,
          details: { inviteId: invite.id, joinRequestId: created.id }
        });
      }

      if (requestType === "agent" && adapterType === "openclaw_gateway") {
        const expectedDefaults = summarizeOpenClawGatewayDefaultsForLog(
          joinDefaults.normalized
        );
        const persistedDefaults = summarizeOpenClawGatewayDefaultsForLog(
          created.agentDefaultsPayload
        );
        const missingPersistedFields: string[] = [];

        if (expectedDefaults.url && !persistedDefaults.url)
          missingPersistedFields.push("url");
        if (
          expectedDefaults.paperclipApiUrl &&
          !persistedDefaults.paperclipApiUrl
        ) {
          missingPersistedFields.push("paperclipApiUrl");
        }
        if (expectedDefaults.gatewayToken && !persistedDefaults.gatewayToken) {
          missingPersistedFields.push("headers.x-openclaw-token");
        }
        if (
          expectedDefaults.devicePrivateKeyPem &&
          !persistedDefaults.devicePrivateKeyPem
        ) {
          missingPersistedFields.push("devicePrivateKeyPem");
        }
        if (
          expectedDefaults.headerKeys.length > 0 &&
          persistedDefaults.headerKeys.length === 0
        ) {
          missingPersistedFields.push("headers");
        }

        logger.info(
          {
            inviteId: invite.id,
            joinRequestId: created.id,
            joinRequestStatus: created.status,
            expectedDefaults,
            persistedDefaults,
            diagnostics: joinDefaults.diagnostics.map((diag) => ({
              code: diag.code,
              level: diag.level,
              message: diag.message,
              hint: diag.hint ?? null
            }))
          },
          "invite accept persisted OpenClaw gateway join request"
        );

        if (missingPersistedFields.length > 0) {
          logger.warn(
            {
              inviteId: invite.id,
              joinRequestId: created.id,
              missingPersistedFields
            },
            "invite accept detected missing persisted OpenClaw gateway defaults"
          );
        }
      }

      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "invite-agent"
            : req.actor.userId ??
              (requestType === "agent" ? "invite-anon" : "board"),
        action: inviteAlreadyAccepted
          ? "join.request_replayed"
          : "join.requested",
        entityType: "join_request",
        entityId: created.id,
        details: {
          requestType,
          requestIp: requestIp(req),
          inviteReplay: inviteAlreadyAccepted,
          reusedExistingJoinRequest:
            Boolean(existingHumanJoinRequest) && !inviteAlreadyAccepted
        }
      });

      const response = toJoinRequestResponse(created);
      if (claimSecret) {
        const companyBranding = await getInviteCompanyBranding(invite.companyId);
        const onboardingManifest = buildInviteOnboardingManifest(
          req,
          token,
          invite,
          {
            ...opts,
            companyName: companyBranding.name
          }
        );
        res.status(202).json({
          ...response,
          claimSecret,
          claimApiKeyPath: `/api/join-requests/${created.id}/claim-api-key`,
          onboarding: onboardingManifest.onboarding,
          diagnostics: joinDefaults.diagnostics
        });
        return;
      }
      res.status(202).json({
        ...response,
        ...(joinDefaults.diagnostics.length > 0
          ? { diagnostics: joinDefaults.diagnostics }
          : {})
      });
    }
  );

  router.post("/invites/:inviteId/revoke", async (req, res) => {
    const id = req.params.inviteId as string;
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.id, id))
      .then((rows) => rows[0] ?? null);
    if (!invite) throw notFound("Invite not found");
    if (invite.inviteType === "bootstrap_ceo") {
      await assertInstanceAdmin(req);
    } else {
      if (!invite.companyId) throw conflict("Invite is missing company scope");
      await assertCompanyPermission(req, invite.companyId, "users:invite");
    }
    if (invite.acceptedAt) throw conflict("Invite already consumed");
    if (invite.revokedAt) return res.json(invite);

    const revoked = await db
      .update(invites)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(invites.id, id))
      .returning()
      .then((rows) => rows[0]);

    if (invite.companyId) {
      await logActivity(db, {
        companyId: invite.companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.revoked",
        entityType: "invite",
        entityId: id
      });
    }

    res.json(revoked);
  });

  router.get("/companies/:companyId/invites", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "users:invite");
    const query = listCompanyInvitesQuerySchema.parse(req.query);
    const invitesForCompany = await loadCompanyInviteRecords(db, companyId, query);
    res.json(invitesForCompany);
  });

  router.get("/companies/:companyId/join-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "joins:approve");
    const query = listJoinRequestsQuerySchema.parse(req.query);
    const all = await loadJoinRequestRecords(db, companyId);
    const filtered = all.filter((row) => {
      if (query.status && row.status !== query.status) return false;
      if (query.requestType && row.requestType !== query.requestType)
        return false;
      return true;
    });
    res.json(filtered);
  });

  router.post(
    "/companies/:companyId/join-requests/:requestId/approve",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const requestId = req.params.requestId as string;
      await assertCompanyPermission(req, companyId, "joins:approve");

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.companyId, companyId),
            eq(joinRequests.id, requestId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Join request not found");
      if (existing.status !== "pending_approval")
        throw conflict("Join request is not pending");

      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.id, existing.inviteId))
        .then((rows) => rows[0] ?? null);
      if (!invite) throw notFound("Invite not found");

      let createdAgentId: string | null = existing.createdAgentId ?? null;
      if (existing.requestType === "human") {
        if (!existing.requestingUserId)
          throw conflict("Join request missing user identity");
        const membershipRole = resolveHumanInviteRole(
          invite.defaultsPayload as Record<string, unknown> | null,
        );
        await access.ensureMembership(
          companyId,
          "user",
          existing.requestingUserId,
          membershipRole,
          "active"
        );
        const grants = humanJoinGrantsFromDefaults(
          invite.defaultsPayload as Record<string, unknown> | null,
          membershipRole
        );
        await access.setPrincipalGrants(
          companyId,
          "user",
          existing.requestingUserId,
          grants,
          req.actor.userId ?? null
        );
      } else {
        const existingAgents = await agents.list(companyId);
        const managerId = resolveJoinRequestAgentManagerId(existingAgents);
        if (!managerId) {
          throw conflict(
            "Join request cannot be approved because this company has no active CEO"
          );
        }

        const agentName = deduplicateAgentName(
          existing.agentName ?? "New Agent",
          existingAgents.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status
          }))
        );

        const created = await agents.create(companyId, {
          name: agentName,
          role: "general",
          title: null,
          status: "idle",
          reportsTo: managerId,
          capabilities: existing.capabilities ?? null,
          adapterType: existing.adapterType ?? "process",
          adapterConfig:
            existing.agentDefaultsPayload &&
            typeof existing.agentDefaultsPayload === "object"
              ? (existing.agentDefaultsPayload as Record<string, unknown>)
              : {},
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          permissions: {},
          lastHeartbeatAt: null,
          metadata: null
        });
        createdAgentId = created.id;
        await access.ensureMembership(
          companyId,
          "agent",
          created.id,
          "member",
          "active"
        );
        const grants = agentJoinGrantsFromDefaults(
          invite.defaultsPayload as Record<string, unknown> | null
        );
        await access.setPrincipalGrants(
          companyId,
          "agent",
          created.id,
          grants,
          req.actor.userId ?? null
        );
      }

      const approved = await db
        .update(joinRequests)
        .set({
          status: "approved",
          approvedByUserId:
            req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null),
          approvedAt: new Date(),
          createdAgentId,
          updatedAt: new Date()
        })
        .where(eq(joinRequests.id, requestId))
        .returning()
        .then((rows) => rows[0]);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "join.approved",
        entityType: "join_request",
        entityId: requestId,
        details: { requestType: existing.requestType, createdAgentId }
      });

      if (createdAgentId) {
        void notifyHireApproved(db, {
          companyId,
          agentId: createdAgentId,
          source: "join_request",
          sourceId: requestId,
          approvedAt: new Date()
        }).catch(() => {});
      }

      res.json(toJoinRequestResponse(approved));
    }
  );

  router.post(
    "/companies/:companyId/join-requests/:requestId/reject",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const requestId = req.params.requestId as string;
      await assertCompanyPermission(req, companyId, "joins:approve");

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.companyId, companyId),
            eq(joinRequests.id, requestId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Join request not found");
      if (existing.status !== "pending_approval")
        throw conflict("Join request is not pending");

      const rejected = await db
        .update(joinRequests)
        .set({
          status: "rejected",
          rejectedByUserId:
            req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null),
          rejectedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(joinRequests.id, requestId))
        .returning()
        .then((rows) => rows[0]);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "join.rejected",
        entityType: "join_request",
        entityId: requestId,
        details: { requestType: existing.requestType }
      });

      res.json(toJoinRequestResponse(rejected));
    }
  );

  router.post(
    "/join-requests/:requestId/claim-api-key",
    validate(claimJoinRequestApiKeySchema),
    async (req, res) => {
      const requestId = req.params.requestId as string;
      const presentedClaimSecretHash = hashToken(req.body.claimSecret);
      const joinRequest = await db
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.id, requestId))
        .then((rows) => rows[0] ?? null);
      if (!joinRequest) throw notFound("Join request not found");
      if (joinRequest.requestType !== "agent")
        throw badRequest("Only agent join requests can claim API keys");
      if (joinRequest.status !== "approved")
        throw conflict("Join request must be approved before key claim");
      if (!joinRequest.createdAgentId)
        throw conflict("Join request has no created agent");
      if (!joinRequest.claimSecretHash)
        throw conflict("Join request is missing claim secret metadata");
      if (
        !tokenHashesMatch(joinRequest.claimSecretHash, presentedClaimSecretHash)
      ) {
        throw forbidden("Invalid claim secret");
      }
      if (
        joinRequest.claimSecretExpiresAt &&
        joinRequest.claimSecretExpiresAt.getTime() <= Date.now()
      ) {
        throw conflict("Claim secret expired");
      }
      if (joinRequest.claimSecretConsumedAt)
        throw conflict("Claim secret already used");

      const existingKey = await db
        .select({ id: agentApiKeys.id })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, joinRequest.createdAgentId))
        .then((rows) => rows[0] ?? null);
      if (existingKey) throw conflict("API key already claimed");

      const consumed = await db
        .update(joinRequests)
        .set({ claimSecretConsumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(joinRequests.id, requestId),
            isNull(joinRequests.claimSecretConsumedAt)
          )
        )
        .returning({ id: joinRequests.id })
        .then((rows) => rows[0] ?? null);
      if (!consumed) throw conflict("Claim secret already used");

      const created = await agents.createApiKey(
        joinRequest.createdAgentId,
        "initial-join-key"
      );

      await logActivity(db, {
        companyId: joinRequest.companyId,
        actorType: "system",
        actorId: "join-claim",
        action: "agent_api_key.claimed",
        entityType: "agent_api_key",
        entityId: created.id,
        details: {
          agentId: joinRequest.createdAgentId,
          joinRequestId: requestId
        }
      });

      res.status(201).json({
        keyId: created.id,
        token: created.token,
        agentId: joinRequest.createdAgentId,
        createdAt: created.createdAt
      });
    }
  );

  router.get("/companies/:companyId/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "users:manage_permissions");
    const [members, currentAccess] = await Promise.all([
      loadCompanyMemberRecords(db, companyId),
      loadCompanyAccessSummary(req, access, companyId),
    ]);
    res.json({
      members: await addCompanyMemberRemovalAccess(req, db, access, companyId, members),
      access: currentAccess,
    });
  });

  router.get("/companies/:companyId/user-directory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const users = await loadCompanyUserDirectory(db, companyId);
    res.json({ users });
  });

  router.patch(
    "/companies/:companyId/members/:memberId",
    validate(updateCompanyMemberSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const memberToUpdate = await access.getMemberById(companyId, memberId);
      if (!memberToUpdate) throw notFound("Member not found");
      await assertCanManageCompanyMember(req, access, companyId, memberToUpdate);

      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`
          select ${companyMemberships.id}
          from ${companyMemberships}
          where ${companyMemberships.companyId} = ${companyId}
            and ${companyMemberships.principalType} = 'user'
            and ${companyMemberships.status} = 'active'
            and ${companyMemberships.membershipRole} = 'owner'
          for update
        `);

        const existing = await tx
          .select()
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.id, memberId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const nextMembershipRole =
          req.body.membershipRole !== undefined
            ? req.body.membershipRole
            : existing.membershipRole;
        const nextStatus = req.body.status ?? existing.status;

        if (
          existing.principalType === "user" &&
          existing.status === "active" &&
          existing.membershipRole === "owner" &&
          (nextStatus !== "active" || nextMembershipRole !== "owner")
        ) {
          const activeOwnerCount = await tx
            .select({ id: companyMemberships.id })
            .from(companyMemberships)
            .where(
              and(
                eq(companyMemberships.companyId, companyId),
                eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.status, "active"),
                eq(companyMemberships.membershipRole, "owner"),
              ),
            )
            .then((rows) => rows.length);
          if (activeOwnerCount <= 1) {
            throw conflict("Cannot remove the last active owner");
          }
        }

        return tx
          .update(companyMemberships)
          .set({
            membershipRole: nextMembershipRole,
            status: nextStatus,
            updatedAt: new Date(),
          })
          .where(eq(companyMemberships.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? existing);
      });
      if (!updated) throw notFound("Member not found");

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company_member.updated",
        entityType: "company_membership",
        entityId: memberId,
        details: {
          membershipRole: updated.membershipRole,
          status: updated.status,
        },
      });

      const member = (await loadCompanyMemberRecords(db, companyId)).find(
        (entry) => entry.id === memberId,
      );
      if (!member) throw notFound("Member not found");
      res.json(member);
    }
  );

  router.patch(
    "/companies/:companyId/members/:memberId/role-and-grants",
    validate(updateCompanyMemberWithPermissionsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const memberToUpdate = await access.getMemberById(companyId, memberId);
      if (!memberToUpdate) throw notFound("Member not found");
      await assertCanManageCompanyMember(req, access, companyId, memberToUpdate);

      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`
          select ${companyMemberships.id}
          from ${companyMemberships}
          where ${companyMemberships.companyId} = ${companyId}
            and ${companyMemberships.principalType} = 'user'
            and ${companyMemberships.status} = 'active'
            and ${companyMemberships.membershipRole} = 'owner'
          for update
        `);

        const existing = await tx
          .select()
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.id, memberId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const nextMembershipRole =
          req.body.membershipRole !== undefined
            ? req.body.membershipRole
            : existing.membershipRole;
        const nextStatus = req.body.status ?? existing.status;

        if (
          existing.principalType === "user" &&
          existing.status === "active" &&
          existing.membershipRole === "owner" &&
          (nextStatus !== "active" || nextMembershipRole !== "owner")
        ) {
          const activeOwnerCount = await tx
            .select({ id: companyMemberships.id })
            .from(companyMemberships)
            .where(
              and(
                eq(companyMemberships.companyId, companyId),
                eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.status, "active"),
                eq(companyMemberships.membershipRole, "owner"),
              ),
            )
            .then((rows) => rows.length);
          if (activeOwnerCount <= 1) {
            throw conflict("Cannot remove the last active owner");
          }
        }

        const now = new Date();
        const updatedMember = await tx
          .update(companyMemberships)
          .set({
            membershipRole: nextMembershipRole,
            status: nextStatus,
            updatedAt: now,
          })
          .where(eq(companyMemberships.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? existing);

        await tx
          .delete(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, companyId),
              eq(principalPermissionGrants.principalType, existing.principalType),
              eq(principalPermissionGrants.principalId, existing.principalId),
            ),
          );

        const grants = (req.body.grants ?? []) as MemberGrantPayload[];
        if (grants.length > 0) {
          await tx.insert(principalPermissionGrants).values(
            grants.map((grant) => ({
              companyId,
              principalType: existing.principalType,
              principalId: existing.principalId,
              permissionKey: grant.permissionKey,
              scope: grant.scope ?? null,
              grantedByUserId: req.actor.userId ?? null,
              createdAt: now,
              updatedAt: now,
            })),
          );
        }

        return updatedMember;
      });
      if (!updated) throw notFound("Member not found");

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company_member.access_updated",
        entityType: "company_membership",
        entityId: memberId,
        details: {
          membershipRole: updated.membershipRole,
          status: updated.status,
          grantCount: req.body.grants?.length ?? 0,
        },
      });

      const member = (await loadCompanyMemberRecords(db, companyId)).find(
        (entry) => entry.id === memberId,
      );
      if (!member) throw notFound("Member not found");
      res.json(member);
    }
  );

  router.post(
    "/companies/:companyId/members/:memberId/archive",
    validate(archiveCompanyMemberSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const memberToArchive = await access.getMemberById(companyId, memberId);
      if (!memberToArchive) throw notFound("Member not found");
      await assertCanManageCompanyMember(req, access, companyId, memberToArchive, "archive");

      const result = await access.archiveMember(companyId, memberId, {
        reassignment: req.body.reassignment ?? null,
      });
      if (!result) throw notFound("Member not found");

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company_member.archived",
        entityType: "company_membership",
        entityId: memberId,
        details: {
          principalId: result.member.principalId,
          reassignedIssueCount: result.reassignedIssueCount,
          reassignment: req.body.reassignment ?? null,
        },
      });

      const member = (await loadCompanyMemberRecords(db, companyId, { includeArchived: true })).find(
        (entry) => entry.id === memberId,
      );
      if (!member) throw notFound("Member not found");
      res.json({
        member,
        reassignedIssueCount: result.reassignedIssueCount,
      });
    }
  );

  router.patch(
    "/companies/:companyId/members/:memberId/permissions",
    validate(updateMemberPermissionsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const memberToUpdate = await access.getMemberById(companyId, memberId);
      if (!memberToUpdate) throw notFound("Member not found");
      await assertCanManageCompanyMember(req, access, companyId, memberToUpdate);
      const updated = await access.setMemberPermissions(
        companyId,
        memberId,
        req.body.grants ?? [],
        req.actor.userId ?? null
      );
      if (!updated) throw notFound("Member not found");
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "company_member.permissions_updated",
        entityType: "company_membership",
        entityId: memberId,
        details: {
          grantCount: req.body.grants?.length ?? 0,
        },
      });
      const member = (await loadCompanyMemberRecords(db, companyId)).find(
        (entry) => entry.id === memberId,
      );
      if (!member) throw notFound("Member not found");
      res.json(member);
    }
  );

  router.post(
    "/admin/users/:userId/promote-instance-admin",
    async (req, res) => {
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      const result = await access.promoteInstanceAdmin(userId);
      res.status(201).json(result);
    }
  );

  router.get("/admin/users", async (req, res) => {
    await assertInstanceAdmin(req);
    const query = searchAdminUsersQuerySchema.parse(req.query);
    const needle = query.query.trim().toLowerCase();
    const users = await db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .from(authUsers)
      .orderBy(desc(authUsers.updatedAt));
    const filteredUsers = needle
      ? users.filter((user) =>
          [user.name, user.email]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase().includes(needle)),
        )
      : users;
    const userIds = filteredUsers.slice(0, 50).map((user) => user.id);
    const memberships = userIds.length
      ? await db
          .select({
            principalId: companyMemberships.principalId,
          })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              inArray(companyMemberships.principalId, userIds),
            ),
          )
      : [];
    const membershipCountByUserId = new Map<string, number>();
    for (const membership of memberships) {
      membershipCountByUserId.set(
        membership.principalId,
        (membershipCountByUserId.get(membership.principalId) ?? 0) + 1,
      );
    }
    const adminIds = new Set(
      await Promise.all(
        userIds.map(async (userId) =>
          (await access.isInstanceAdmin(userId)) ? userId : null,
        ),
      ).then((values) => values.filter((value): value is string => Boolean(value))),
    );

    res.json(
      filteredUsers.slice(0, 50).map((user) => ({
        ...toUserProfile(user),
        isInstanceAdmin: adminIds.has(user.id),
        activeCompanyMembershipCount:
          membershipCountByUserId.get(user.id) ?? 0,
      })),
    );
  });

  router.post(
    "/admin/users/:userId/demote-instance-admin",
    async (req, res) => {
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      const removed = await access.demoteInstanceAdmin(userId);
      if (!removed) throw notFound("Instance admin role not found");
      res.json(removed);
    }
  );

  router.get("/admin/users/:userId/company-access", async (req, res) => {
    await assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    res.json(await loadUserCompanyAccessResponse(db, access, userId));
  });

  router.put(
    "/admin/users/:userId/company-access",
    validate(updateUserCompanyAccessSchema),
    async (req, res) => {
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      await access.setUserCompanyAccess(
        userId,
        req.body.companyIds ?? [],
        { actorUserId: req.actor.userId ?? null },
      );
      res.json(await loadUserCompanyAccessResponse(db, access, userId));
    }
  );

  return router;
}
