/**
 * Provider Authentication Service
 *
 * Manages OAuth/device-code auth flows for Claude Code and Codex CLI tools.
 * Adapted from AgentOS reference implementation.
 *
 * Claude Code: OAuth PKCE flow via claude.ai
 * Codex: Device authorization flow via OpenAI
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../middleware/logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type ProviderAuthStatus = "idle" | "starting" | "waiting" | "complete" | "failed" | "canceled";

export interface AnthropicAuthSnapshot {
  apiProvider: string | null;
  authMethod: string | null;
  email: string | null;
  loggedIn: boolean;
  organizationId: string | null;
  organizationName: string | null;
  subscriptionType: string | null;
}

export interface AnthropicAuthResponse {
  apiProvider: string | null;
  authDetected: boolean;
  authMethod: string | null;
  codeRequired: boolean;
  completedAt: string | null;
  createdAt: string | null;
  email: string | null;
  error: string | null;
  organizationId: string | null;
  organizationName: string | null;
  sessionId: string | null;
  status: ProviderAuthStatus;
  subscriptionType: string | null;
  updatedAt: string | null;
  verificationUrl: string | null;
}

export interface OpenAiDeviceAuthResponse {
  authDetected: boolean;
  completedAt: string | null;
  createdAt: string | null;
  error: string | null;
  expiresAt: string | null;
  sessionId: string | null;
  status: ProviderAuthStatus;
  updatedAt: string | null;
  userCode: string | null;
  verificationUrl: string | null;
}

// ── Internal session types ──────────────────────────────────────────────────

interface AnthropicSession {
  authDetected: boolean;
  codeVerifier: string;
  completedAt: string | null;
  createdAt: string;
  error: string | null;
  id: string;
  killedByOperator: boolean;
  oauthState: string;
  snapshot: AnthropicAuthSnapshot;
  status: ProviderAuthStatus;
  updatedAt: string;
  verificationUrl: string | null;
}

interface OpenAiSession {
  authDetected: boolean;
  child: ChildProcess | null;
  completedAt: string | null;
  createdAt: string;
  error: string | null;
  expiresAt: string | null;
  id: string;
  killedByOperator: boolean;
  status: ProviderAuthStatus;
  updatedAt: string;
  userCode: string | null;
  verificationUrl: string | null;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
const ANTHROPIC_OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const ANTHROPIC_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

// ── State ───────────────────────────────────────────────────────────────────

let anthropicSession: AnthropicSession | null = null;
let openAiSession: OpenAiSession | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getAgentHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/home/paperclip";
}

function buildCommonAuthEnv(): NodeJS.ProcessEnv {
  const home = getAgentHomeDir();
  return {
    ...process.env,
    FORCE_COLOR: "0",
    HOME: home,
    NO_COLOR: "1",
    TERM: "dumb",
    USERPROFILE: home,
  };
}

function buildAnthropicAuthEnv(): NodeJS.ProcessEnv {
  const home = getAgentHomeDir();
  return {
    ...buildCommonAuthEnv(),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_CREDENTIALS_PATH: join(home, ".claude", ".credentials.json"),
    CLAUDE_LEGACY_CREDENTIALS_PATH: join(home, ".claude.json"),
  };
}

function buildOpenAiAuthEnv(): NodeJS.ProcessEnv {
  const home = getAgentHomeDir();
  return {
    ...buildCommonAuthEnv(),
    CODEX_HOME: join(home, ".codex"),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generateCodeVerifier(): string {
  return encodeBase64Url(randomBytes(32));
}

function generateOAuthState(): string {
  return encodeBase64Url(randomBytes(32));
}

function createCodeChallenge(codeVerifier: string): string {
  return encodeBase64Url(createHash("sha256").update(codeVerifier).digest());
}

function buildVerificationUrl(codeVerifier: string, state: string): string {
  const url = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTHROPIC_OAUTH_MANUAL_REDIRECT_URL);
  url.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", createCodeChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

function parseAuthCallback(value: string): { code: string; state: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code")?.trim();
      const state = url.searchParams.get("state")?.trim();
      if (code && state) return { code, state };
    } catch { return null; }
  }

  const parts = trimmed.match(/^([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)$/);
  if (!parts) return null;
  return { code: parts[1], state: parts[2] };
}

function parseScopeList(value: unknown): string[] {
  return typeof value === "string" ? value.split(/\s+/).map((s) => s.trim()).filter(Boolean) : [];
}

// ── Anthropic Auth Detection ────────────────────────────────────────────────

async function anthropicAuthDetected(): Promise<boolean> {
  const home = getAgentHomeDir();
  return (
    (await pathExists(join(home, ".claude", ".credentials.json"))) ||
    (await pathExists(join(home, ".claude.json")))
  );
}

function parseAuthStatusPayload(result: Pick<SpawnSyncReturns<string>, "stdout">): AnthropicAuthSnapshot | null {
  const raw = String(result.stdout || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      apiProvider: optionalString(parsed.apiProvider),
      authMethod: optionalString(parsed.authMethod),
      email: optionalString(parsed.email),
      loggedIn: parsed.loggedIn === true,
      organizationId: optionalString(parsed.orgId),
      organizationName: optionalString(parsed.orgName),
      subscriptionType: optionalString(parsed.subscriptionType),
    };
  } catch {
    return null;
  }
}

export async function getAnthropicAuthSnapshot(): Promise<AnthropicAuthSnapshot> {
  const result = spawnSync("claude", ["auth", "status", "--json"], {
    cwd: getAgentHomeDir(),
    encoding: "utf8",
    env: buildAnthropicAuthEnv(),
  });

  const parsed = parseAuthStatusPayload(result);
  if (parsed) return parsed;

  const detected = await anthropicAuthDetected();
  return {
    apiProvider: null,
    authMethod: detected ? "unknown" : "none",
    email: null,
    loggedIn: detected,
    organizationId: null,
    organizationName: null,
    subscriptionType: null,
  };
}

async function refreshAnthropicSession(session: AnthropicSession): Promise<void> {
  session.snapshot = await getAnthropicAuthSnapshot();
  session.authDetected = session.snapshot.loggedIn;

  if (session.authDetected && session.status !== "canceled") {
    session.status = "complete";
    if (!session.completedAt) session.completedAt = new Date().toISOString();
  } else if (session.status === "starting" && session.verificationUrl) {
    session.status = "waiting";
  }
  session.updatedAt = new Date().toISOString();
}

async function exchangeAuthorizationCode(input: {
  authorizationCode: string;
  codeVerifier: string;
  state: string;
}): Promise<Record<string, unknown>> {
  const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    body: JSON.stringify({
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code: input.authorizationCode,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: ANTHROPIC_OAUTH_MANUAL_REDIRECT_URL,
      state: input.state,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      body
        ? `Claude token exchange failed (${response.status}): ${body}`
        : `Claude token exchange failed (${response.status}).`,
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

function installRefreshToken(refreshToken: string, scopes: string[]): void {
  const result = spawnSync("claude", ["auth", "login"], {
    cwd: getAgentHomeDir(),
    encoding: "utf8",
    env: {
      ...buildAnthropicAuthEnv(),
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken,
      CLAUDE_CODE_OAUTH_SCOPES: scopes.join(" "),
    },
  });

  if (result.status === 0) return;

  const detail = [String(result.stderr || "").trim(), String(result.stdout || "").trim()]
    .filter(Boolean)
    .join("\n");
  throw new Error(detail ? `Claude credential install failed: ${detail}` : `Claude credential install failed with code ${result.status ?? "unknown"}.`);
}

// ── Anthropic Serializers ───────────────────────────────────────────────────

function serializeAnthropicIdle(snapshot: AnthropicAuthSnapshot): AnthropicAuthResponse {
  return {
    apiProvider: snapshot.apiProvider, authDetected: snapshot.loggedIn, authMethod: snapshot.authMethod,
    codeRequired: !snapshot.loggedIn, completedAt: null, createdAt: null, email: snapshot.email,
    error: null, organizationId: snapshot.organizationId, organizationName: snapshot.organizationName,
    sessionId: null, status: snapshot.loggedIn ? "complete" : "idle",
    subscriptionType: snapshot.subscriptionType, updatedAt: null, verificationUrl: null,
  };
}

function serializeAnthropicSession(session: AnthropicSession): AnthropicAuthResponse {
  return {
    apiProvider: session.snapshot.apiProvider, authDetected: session.authDetected,
    authMethod: session.snapshot.authMethod, codeRequired: !session.authDetected,
    completedAt: session.completedAt, createdAt: session.createdAt, email: session.snapshot.email,
    error: session.error, organizationId: session.snapshot.organizationId,
    organizationName: session.snapshot.organizationName, sessionId: session.id,
    status: session.status, subscriptionType: session.snapshot.subscriptionType,
    updatedAt: session.updatedAt, verificationUrl: session.verificationUrl,
  };
}

// ── Anthropic Public API ────────────────────────────────────────────────────

export async function getAnthropicAuthState(): Promise<AnthropicAuthResponse> {
  const snapshot = await getAnthropicAuthSnapshot();
  if (!anthropicSession) return serializeAnthropicIdle(snapshot);
  await refreshAnthropicSession(anthropicSession);
  return serializeAnthropicSession(anthropicSession);
}

export async function startAnthropicAuth(): Promise<AnthropicAuthResponse> {
  const snapshot = await getAnthropicAuthSnapshot();

  if (snapshot.loggedIn) {
    const now = new Date().toISOString();
    return { ...serializeAnthropicIdle(snapshot), status: "complete", completedAt: now, updatedAt: now };
  }

  if (anthropicSession) {
    await refreshAnthropicSession(anthropicSession);
    if (anthropicSession.status === "starting" || anthropicSession.status === "waiting") {
      return serializeAnthropicSession(anthropicSession);
    }
  }

  await mkdir(join(getAgentHomeDir(), ".claude"), { recursive: true });

  const codeVerifier = generateCodeVerifier();
  const oauthState = generateOAuthState();
  const now = new Date().toISOString();

  anthropicSession = {
    authDetected: false, codeVerifier, completedAt: null, createdAt: now, error: null,
    id: randomUUID(), killedByOperator: false, oauthState, snapshot,
    status: "waiting", updatedAt: now,
    verificationUrl: buildVerificationUrl(codeVerifier, oauthState),
  };

  logger.info("Anthropic OAuth flow started");
  return serializeAnthropicSession(anthropicSession);
}

export async function submitAnthropicAuthCode(value: string): Promise<AnthropicAuthResponse> {
  if (!anthropicSession) return serializeAnthropicIdle(await getAnthropicAuthSnapshot());

  await refreshAnthropicSession(anthropicSession);
  const payload = parseAuthCallback(value);
  if (!payload) throw new Error("Paste the Claude callback URL or the full code#state value.");

  if (anthropicSession.status !== "starting" && anthropicSession.status !== "waiting") {
    throw new Error("Claude sign-in is not waiting for an authentication code.");
  }

  if (payload.state !== anthropicSession.oauthState) {
    anthropicSession.error = "This callback belongs to a different sign-in attempt. Start again.";
    anthropicSession.updatedAt = new Date().toISOString();
    throw new Error(anthropicSession.error);
  }

  anthropicSession.error = null;
  anthropicSession.status = "starting";
  anthropicSession.updatedAt = new Date().toISOString();

  try {
    const tokenResponse = await exchangeAuthorizationCode({
      authorizationCode: payload.code,
      codeVerifier: anthropicSession.codeVerifier,
      state: anthropicSession.oauthState,
    });

    const refreshToken = optionalString(tokenResponse.refresh_token);
    if (!refreshToken) throw new Error("Token exchange did not return a refresh token.");

    const scopes = parseScopeList(tokenResponse.scope);
    installRefreshToken(refreshToken, scopes.length ? scopes : ANTHROPIC_OAUTH_SCOPES);

    await refreshAnthropicSession(anthropicSession);
    if (!anthropicSession.authDetected) throw new Error("Login finished without persisting credentials.");

    anthropicSession.error = null;
    anthropicSession.status = "complete";
    if (!anthropicSession.completedAt) anthropicSession.completedAt = new Date().toISOString();
    anthropicSession.updatedAt = new Date().toISOString();
    logger.info("Anthropic OAuth flow completed");
  } catch (error) {
    anthropicSession.error = error instanceof Error ? error.message : String(error);
    anthropicSession.status = "failed";
    anthropicSession.updatedAt = new Date().toISOString();
    throw error;
  }

  return serializeAnthropicSession(anthropicSession);
}

export async function cancelAnthropicAuth(): Promise<AnthropicAuthResponse> {
  const snapshot = await getAnthropicAuthSnapshot();
  if (!anthropicSession) return serializeAnthropicIdle(snapshot);
  anthropicSession.killedByOperator = true;
  anthropicSession.status = "canceled";
  anthropicSession.updatedAt = new Date().toISOString();
  await refreshAnthropicSession(anthropicSession);
  return serializeAnthropicSession(anthropicSession);
}

// ── OpenAI Auth Detection ───────────────────────────────────────────────────

async function openAiAuthDetected(): Promise<boolean> {
  return pathExists(join(getAgentHomeDir(), ".codex", "auth.json"));
}

// ── OpenAI Serializers ──────────────────────────────────────────────────────

function serializeOpenAiIdle(authDetected: boolean): OpenAiDeviceAuthResponse {
  return {
    authDetected, completedAt: null, createdAt: null, error: null, expiresAt: null,
    sessionId: null, status: authDetected ? "complete" : "idle", updatedAt: null,
    userCode: null, verificationUrl: null,
  };
}

function serializeOpenAiSession(session: OpenAiSession): OpenAiDeviceAuthResponse {
  return {
    authDetected: session.authDetected, completedAt: session.completedAt,
    createdAt: session.createdAt, error: session.error, expiresAt: session.expiresAt,
    sessionId: session.id, status: session.status, updatedAt: session.updatedAt,
    userCode: session.userCode, verificationUrl: session.verificationUrl || DEVICE_AUTH_URL,
  };
}

async function refreshOpenAiSession(session: OpenAiSession): Promise<void> {
  session.authDetected = await openAiAuthDetected();
  if (session.authDetected && session.status !== "canceled") {
    session.status = "complete";
    if (!session.completedAt) session.completedAt = new Date().toISOString();
  } else if (session.status === "starting" && (session.verificationUrl || session.userCode)) {
    session.status = "waiting";
  }
  if (!session.verificationUrl) session.verificationUrl = DEVICE_AUTH_URL;
  session.updatedAt = new Date().toISOString();
}

// ── OpenAI Public API ───────────────────────────────────────────────────────

export async function getOpenAiAuthState(): Promise<OpenAiDeviceAuthResponse> {
  if (!openAiSession) return serializeOpenAiIdle(await openAiAuthDetected());
  await refreshOpenAiSession(openAiSession);
  return serializeOpenAiSession(openAiSession);
}

export async function startOpenAiAuth(): Promise<OpenAiDeviceAuthResponse> {
  if (await openAiAuthDetected()) {
    const now = new Date().toISOString();
    return { ...serializeOpenAiIdle(true), status: "complete", completedAt: now, updatedAt: now };
  }

  if (openAiSession) {
    await refreshOpenAiSession(openAiSession);
    if (openAiSession.status === "starting" || openAiSession.status === "waiting") {
      return serializeOpenAiSession(openAiSession);
    }
  }

  await mkdir(join(getAgentHomeDir(), ".codex"), { recursive: true });

  const now = new Date().toISOString();
  const session: OpenAiSession = {
    authDetected: false, child: null, completedAt: null, createdAt: now, error: null,
    expiresAt: null, id: randomUUID(), killedByOperator: false, status: "starting",
    updatedAt: now, userCode: null, verificationUrl: null,
  };

  const child = spawn("codex", ["login", "--device-auth"], {
    cwd: getAgentHomeDir(),
    env: buildOpenAiAuthEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  session.child = child;
  openAiSession = session;

  const handleChunk = (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString("utf8"));
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (!session.verificationUrl) {
        const match = trimmed.match(/https:\/\/\S+/);
        if (match) {
          session.verificationUrl = match[0];
          if (!session.expiresAt) {
            session.expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS).toISOString();
          }
        }
      }

      if (!session.userCode) {
        const codeMatch = trimmed.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/);
        if (codeMatch) session.userCode = codeMatch[0];
      }

      if (trimmed.toLowerCase().includes("error") && !trimmed.toLowerCase().startsWith("follow these steps")) {
        session.error = trimmed;
      }
    }

    if (session.verificationUrl || session.userCode) session.status = "waiting";
    session.updatedAt = new Date().toISOString();
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);

  child.on("error", (error) => {
    session.error = error.message;
    session.status = "failed";
    session.updatedAt = new Date().toISOString();
    session.child = null;
  });

  child.on("exit", async (code, signal) => {
    session.child = null;
    await refreshOpenAiSession(session);

    if (session.authDetected) {
      session.status = "complete";
      if (!session.completedAt) session.completedAt = new Date().toISOString();
    } else if (session.killedByOperator) {
      session.status = "canceled";
    } else if (code === 0) {
      session.status = "complete";
      session.completedAt = new Date().toISOString();
    } else {
      session.status = "failed";
      if (!session.error) {
        session.error = signal
          ? `Codex login exited on signal ${signal}.`
          : `Codex login exited with code ${code ?? "unknown"}.`;
      }
    }
    session.updatedAt = new Date().toISOString();
  });

  logger.info("OpenAI device auth flow started");
  return serializeOpenAiSession(session);
}

export async function cancelOpenAiAuth(): Promise<OpenAiDeviceAuthResponse> {
  if (!openAiSession) return serializeOpenAiIdle(await openAiAuthDetected());

  openAiSession.killedByOperator = true;
  openAiSession.status = "canceled";
  openAiSession.updatedAt = new Date().toISOString();

  if (openAiSession.child && openAiSession.child.exitCode === null) {
    openAiSession.child.kill("SIGTERM");
  }

  await refreshOpenAiSession(openAiSession);
  return serializeOpenAiSession(openAiSession);
}

// ── Combined status ─────────────────────────────────────────────────────────

export async function getProviderStatus(): Promise<{
  anthropic: AnthropicAuthResponse;
  openai: OpenAiDeviceAuthResponse;
}> {
  const [anthropic, openai] = await Promise.all([
    getAnthropicAuthState(),
    getOpenAiAuthState(),
  ]);
  return { anthropic, openai };
}
