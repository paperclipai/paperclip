import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { connectionCell, type ConnectionMode } from "./connection-cases.js";
import type { MatrixExecution } from "./types.js";

export interface ConnectionRoute {
  model: string; credentialEnv?: string; baseURL?: string; region?: string; auth: "bearer" | "api_key" | "none";
}
export interface ConnectionConfig {
  target: { mode: "managed-local" } | { mode: "attach"; baseURL: string; expectedCommit: string; deploymentMode: "local_trusted" | "authenticated"; companyId?: string; environmentId?: string };
  browser: { headed: boolean; channel: "chrome" | "chromium"; profileDir?: string; accountAlias: string; freshness: "signed-in" | "signed-out"; loginTimeoutMs: number };
  secretFile?: string;
  models: Record<string, string>;
  routes: Record<string, ConnectionRoute>;
  credentials: Record<string, string>;
  budgetCents: number; maxRuns: number; turnTimeoutMs: number; retainCompany: boolean;
}

/** Strict, dependency-free private configuration parser. Never echo bad input. */
export function parseConnectionConfig(input: unknown): ConnectionConfig {
  const invalid = (): never => { throw new ConnectionBlock("blocked_target", "invalid_connection_configuration"); };
  const object = (value: unknown, allowed?: string[]): Record<string, any> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    if (allowed && Object.keys(value).some(key => !allowed.includes(key))) return invalid();
    return value as Record<string, any>;
  };
  const text = (value: unknown, fallback?: string): string => {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "string" || !value.trim() || value.length > 2048) return invalid();
    return value;
  };
  const choice = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => value === undefined ? fallback : options.includes(value as T) ? value as T : invalid();
  const flag = (value: unknown, fallback: boolean): boolean => value === undefined ? fallback : typeof value === "boolean" ? value : invalid();
  const number = (value: unknown, fallback: number, min: number, max: number): number => value === undefined ? fallback : typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
  const name = (value: unknown) => { const result = text(value); if (!/^[A-Z][A-Z0-9_]+$/.test(result)) return invalid(); return result; };
  const uuid = (value: unknown) => { const result = text(value); if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(result)) return invalid(); return result; };
  const root = object(input, ["target", "browser", "secretFile", "models", "routes", "credentials", "budgetCents", "maxRuns", "turnTimeoutMs", "retainCompany"]);
  const t = object(root.target ?? { mode: "managed-local" });
  let target: ConnectionConfig["target"];
  if (t.mode === "managed-local") { object(t, ["mode"]); target = { mode: "managed-local" }; }
  else if (t.mode === "attach") {
    object(t, ["mode", "baseURL", "expectedCommit", "deploymentMode", "companyId", "environmentId"]);
    const expectedCommit = text(t.expectedCommit);
    if (!/^[a-f0-9]{40}$/.test(expectedCommit)) return invalid();
    target = { mode: "attach", baseURL: targetOrigin(text(t.baseURL)), expectedCommit, deploymentMode: choice(t.deploymentMode, ["local_trusted", "authenticated"], "authenticated"),
      ...(t.companyId === undefined ? {} : { companyId: uuid(t.companyId) }), ...(t.environmentId === undefined ? {} : { environmentId: uuid(t.environmentId) }) };
  } else return invalid();
  const b = object(root.browser ?? {}, ["headed", "channel", "profileDir", "accountAlias", "freshness", "loginTimeoutMs"]);
  const accountAlias = text(b.accountAlias, "local-qa");
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(accountAlias)) return invalid();
  const routes = Object.fromEntries(Object.entries(object(root.routes ?? {})).map(([key, value]) => {
    const r = object(value, ["model", "credentialEnv", "baseURL", "region", "auth"]);
    return [key, { model: text(r.model), auth: choice(r.auth, ["bearer", "api_key", "none"], "bearer"),
      ...(r.credentialEnv === undefined ? {} : { credentialEnv: name(r.credentialEnv) }), ...(r.baseURL === undefined ? {} : { baseURL: text(r.baseURL) }), ...(r.region === undefined ? {} : { region: text(r.region) }) }];
  }));
  return { target, browser: { headed: flag(b.headed, true), channel: choice(b.channel, ["chrome", "chromium"], "chrome"), accountAlias, freshness: choice(b.freshness, ["signed-in", "signed-out"], "signed-in"), loginTimeoutMs: number(b.loginTimeoutMs, 600_000, 1000, 1200_000), ...(b.profileDir === undefined ? {} : { profileDir: text(b.profileDir) }) },
    ...(root.secretFile === undefined ? {} : { secretFile: text(root.secretFile) }),
    models: Object.fromEntries(Object.entries(object(root.models ?? {})).map(([key, value]) => [key, text(value)])), routes,
    credentials: Object.fromEntries(Object.entries(object(root.credentials ?? {})).map(([key, value]) => [key, name(value)])),
    budgetCents: number(root.budgetCents, 200, 1, 10_000), maxRuns: number(root.maxRuns, 3, 2, 5), turnTimeoutMs: number(root.turnTimeoutMs, 300_000, 10_000, 600_000), retainCompany: flag(root.retainCompany, false) };
}

/** Only harness-owned error codes may enter a retained report. */
export class ConnectionFailure extends Error {}

export class ConnectionBlock extends Error {
  constructor(readonly reason: "awaiting_user" | "missing_credential" | "blocked_target", readonly code: string) {
    super(code);
  }
}

export function targetOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
    throw new ConnectionBlock("blocked_target", "target_requires_https_or_loopback_origin");
  }
  return url.origin;
}

export async function loadConnectionConfig(file?: string): Promise<ConnectionConfig> {
  try {
    const config = parseConnectionConfig(file ? JSON.parse(await readFile(file, "utf8")) : {});
    if (config.target.mode === "attach") config.target.baseURL = targetOrigin(config.target.baseURL);
    return config;
  } catch (error) {
    if (error instanceof ConnectionBlock) throw error;
    // Parsing errors can contain configuration values. Never echo input.
    throw new ConnectionBlock("blocked_target", "invalid_connection_configuration");
  }
}

export async function assertPrivateFile(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new ConnectionBlock("missing_credential", "credential_file_requires_owner_only_regular_file");
  }
}

/** Literal dotenv only: never evaluate shell expansions or source an entire file. */
export function selectedSecret(text: string, name: string): string | undefined {
  let found: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, "");
    const match = /^\s*([A-Z][A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== name) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!value || /[`\r\n]|\$\(/.test(value)) throw new ConnectionBlock("missing_credential", "credential_must_be_a_literal_value");
    found = value;
  }
  return found;
}

export async function resolveConnectionSecret(config: ConnectionConfig, name?: string, env: NodeJS.ProcessEnv = process.env) {
  if (!name) return undefined;
  if (env[name]?.trim()) return env[name]!.trim();
  if (config.secretFile) {
    await assertPrivateFile(config.secretFile);
    const value = selectedSecret(await readFile(config.secretFile, "utf8"), name);
    if (value) return value;
  }
  throw new ConnectionBlock("missing_credential", `missing_${name}`);
}

export function resolveConnectionSettings(execution: MatrixExecution, config: ConnectionConfig) {
  const { harness, mode } = connectionCell(execution);
  const route = config.routes[`${harness.id}.${mode}`] ?? config.routes[mode];
  const advanced = mode !== "subscription" && mode !== "api-key";
  if (advanced && !route) throw new ConnectionBlock("missing_credential", "route_configuration_required");
  const selectedModel = route?.model ?? config.models[harness.id] ?? execution.profile.model;
  if (selectedModel === "configured-in-connection-file") throw new ConnectionBlock("blocked_target", "explicit_model_required");
  if (["responses", "messages", "chat"].includes(mode)) {
    if (!route?.baseURL) throw new ConnectionBlock("blocked_target", "gateway_url_required");
    const url = new URL(route.baseURL);
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new ConnectionBlock("blocked_target", "invalid_gateway_url");
  }
  if (mode === "bedrock" && (!route?.region || route.auth !== "bearer")) throw new ConnectionBlock("blocked_target", "bedrock_region_and_bearer_required");
  if (route?.auth === "api_key" && mode !== "messages") throw new ConnectionBlock("blocked_target", "api_key_header_requires_messages");
  if (mode === "openrouter" && route?.auth !== "bearer") throw new ConnectionBlock("blocked_target", "openrouter_requires_bearer");
  const defaultKey = mode === "bedrock" ? "AWS_BEARER_TOKEN_BEDROCK" : mode === "openrouter" ? "OPENROUTER_API_KEY" : harness.key;
  const credentialEnv = mode === "subscription" || route?.auth === "none" ? undefined : route?.credentialEnv ?? config.credentials[harness.id] ?? (advanced && !["bedrock", "openrouter"].includes(mode) ? undefined : defaultKey);
  if (mode !== "subscription" && route?.auth !== "none" && !credentialEnv) throw new ConnectionBlock("missing_credential", "gateway_credential_reference_required");
  return { model: selectedModel, route, credentialEnv };
}

export function connectionCatalogSource(mode: ConnectionMode, provider: string) {
  return ({ responses: "responses-api", messages: "messages-api", chat: "chat-completions-api", bedrock: "bedrock", openrouter: "openrouter" } as Record<string, string>)[mode] ?? provider;
}

export async function assertOutsideRepository(file: string, repositoryRoot: string) {
  // Resolve an existing ancestor too, so a missing child below a symlink cannot evade containment.
  let existing = path.resolve(file);
  while (true) {
    try { existing = await realpath(existing); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = path.dirname(existing); if (parent === existing) throw error; existing = parent; }
  }
  const root = await realpath(repositoryRoot);
  const relative = path.relative(root, existing);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new ConnectionBlock("blocked_target", "browser_profile_must_be_outside_repository");
}
