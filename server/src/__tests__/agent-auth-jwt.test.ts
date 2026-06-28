import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

type AgentAuthJwtModule = typeof import("../agent-auth-jwt.js");

const isPosix = process.platform !== "win32";

// Env vars that influence secret resolution, for the auto-provision/describe
// suites below. Saved/restored around each test so nothing leaks.
const AUTO_ENV_KEYS = [
  "PAPERCLIP_CONFIG",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_DEPLOYMENT_MODE",
] as const;

describe("agent local JWT", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const betterAuthSecretEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "PAPERCLIP_AGENT_JWT_ISSUER";
  const audienceEnv = "PAPERCLIP_AGENT_JWT_AUDIENCE";
  const disableLegacyFallbackEnv = "PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK";
  const configEnv = "PAPERCLIP_CONFIG";
  const deploymentModeEnv = "PAPERCLIP_DEPLOYMENT_MODE";

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuthSecret: process.env[betterAuthSecretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
    disableLegacyFallback: process.env[disableLegacyFallbackEnv],
    config: process.env[configEnv],
    deploymentMode: process.env[deploymentModeEnv],
  };

  const tmpDirs: string[] = [];
  let secretPath = "";

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthSecretEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    delete process.env[disableLegacyFallbackEnv];
    delete process.env[deploymentModeEnv];

    // Isolate PAPERCLIP_CONFIG to a temp dir so any auto-provisioned secret
    // lands in a throwaway location, never the real install.
    const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-agent-jwt-cfg-"));
    tmpDirs.push(root);
    const envDir = path.join(root, ".paperclip");
    mkdirSync(envDir, { recursive: true });
    process.env[configEnv] = path.join(envDir, "config.json");
    secretPath = path.join(envDir, "agent-jwt-secret");

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.betterAuthSecret === undefined) delete process.env[betterAuthSecretEnv];
    else process.env[betterAuthSecretEnv] = originalEnv.betterAuthSecret;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
    if (originalEnv.issuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[audienceEnv];
    else process.env[audienceEnv] = originalEnv.audience;
    if (originalEnv.disableLegacyFallback === undefined) delete process.env[disableLegacyFallbackEnv];
    else process.env[disableLegacyFallbackEnv] = originalEnv.disableLegacyFallback;
    if (originalEnv.config === undefined) delete process.env[configEnv];
    else process.env[configEnv] = originalEnv.config;
    if (originalEnv.deploymentMode === undefined) delete process.env[deploymentModeEnv];
    else process.env[deploymentModeEnv] = originalEnv.deploymentMode;
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates and verifies a token", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iss: "paperclip",
      aud: "paperclip-api",
    });
  });

  it("returns null when no secret is available outside local_trusted", () => {
    // Empty configured secret + a non-local deployment mode -> no fallback and
    // no auto-provisioning, so no secret file is written.
    process.env[secretEnv] = "";
    process.env[deploymentModeEnv] = "authenticated";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeNull();
    expect(verifyLocalAgentJwt("abc.def.ghi")).toBeNull();
    expect(existsSync(secretPath)).toBe(false);
  });

  it("falls back to BETTER_AUTH_SECRET when PAPERCLIP_AGENT_JWT_SECRET is absent", () => {
    delete process.env[secretEnv];
    process.env[betterAuthSecretEnv] = "fallback-secret";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
    });
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects issuer/audience mismatch", () => {
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    process.env[issuerEnv] = "paperclip";
    process.env[audienceEnv] = "paperclip-api";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("does not verify a token across companies (per-company isolation)", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const tokenA = createLocalAgentJwt("agent-1", "company-A", "claude_local", "run-1");
    expect(tokenA).not.toBeNull();

    // A token whose body claims company-A must verify successfully under its
    // own company-A derived key.
    expect(verifyLocalAgentJwt(tokenA!)?.company_id).toBe("company-A");

    // Tamper: forge a token by copying tokenA's header+signature and swapping
    // the claim's company_id to company-B. The signature was bound to the
    // company-A derived key over the original claims; once we re-encode with a
    // different company_id (or rebind to company-B's key) verification must
    // fail because the signature is over the original signing input.
    const [headerB64, claimsB64, signature] = tokenA!.split(".");
    const claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"));
    claims.company_id = "company-B";
    const tamperedClaimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const tampered = `${headerB64}.${tamperedClaimsB64}.${signature}`;
    expect(verifyLocalAgentJwt(tampered)).toBeNull();
  });

  it("accepts legacy tokens signed with the master secret (backward compat)", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const masterSecret = process.env[secretEnv]!;

    // Hand-craft a token signed directly with the master secret, simulating a
    // JWT issued before per-company derivation existed.
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const claims = {
      sub: "agent-legacy",
      company_id: "company-legacy",
      adapter_type: "claude_local",
      run_id: "run-legacy",
      iat: now,
      exp: now + 3600,
      iss: "paperclip",
      aud: "paperclip-api",
    };
    const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
    const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = `${headerB64}.${claimsB64}`;
    const legacySig = createHmac("sha256", masterSecret).update(signingInput).digest("base64url");
    const legacyToken = `${signingInput}.${legacySig}`;

    const verified = verifyLocalAgentJwt(legacyToken);
    expect(verified).toMatchObject({
      sub: "agent-legacy",
      company_id: "company-legacy",
      adapter_type: "claude_local",
      run_id: "run-legacy",
    });
  });

  it("defaults TTL to 1h when PAPERCLIP_AGENT_JWT_TTL_SECONDS is unset", () => {
    delete process.env[ttlEnv];
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    const claims = verifyLocalAgentJwt(token!);
    expect(claims).not.toBeNull();
    expect(claims!.exp - claims!.iat).toBe(60 * 60);
  });

  // Helper: hand-craft a token signed with the raw master secret (legacy path).
  function craftLegacyMasterSecretToken(masterSecret: string, companyId: string) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const claims = {
      sub: "agent-legacy",
      company_id: companyId,
      adapter_type: "claude_local",
      run_id: "run-legacy",
      iat: now,
      exp: now + 3600,
      iss: "paperclip",
      aud: "paperclip-api",
    };
    const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
    const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = `${headerB64}.${claimsB64}`;
    const legacySig = createHmac("sha256", masterSecret).update(signingInput).digest("base64url");
    return `${signingInput}.${legacySig}`;
  }

  it("accepts master-secret-signed tokens when PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK is unset", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    delete process.env[disableLegacyFallbackEnv];
    const legacyToken = craftLegacyMasterSecretToken(process.env[secretEnv]!, "company-legacy");
    const verified = verifyLocalAgentJwt(legacyToken);
    expect(verified).not.toBeNull();
    expect(verified!.company_id).toBe("company-legacy");
  });

  it("rejects master-secret-signed tokens when PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK is enabled", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    process.env[disableLegacyFallbackEnv] = "true";
    const legacyToken = craftLegacyMasterSecretToken(process.env[secretEnv]!, "company-legacy");
    expect(verifyLocalAgentJwt(legacyToken)).toBeNull();
  });

  it("still verifies per-company-signed tokens when PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK is enabled", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    process.env[disableLegacyFallbackEnv] = "true";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).not.toBeNull();
    const verified = verifyLocalAgentJwt(token!);
    expect(verified).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
    });
  });
});

describe("agent JWT secret auto-provisioning (local_trusted)", () => {
  const saved: Record<string, string | undefined> = {};
  const tmpDirs: string[] = [];
  let secretPath: string;

  beforeEach(() => {
    for (const key of AUTO_ENV_KEYS) saved[key] = process.env[key];

    const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-agent-jwt-auto-"));
    tmpDirs.push(root);
    const envDir = path.join(root, ".paperclip");
    mkdirSync(envDir, { recursive: true });
    process.env.PAPERCLIP_CONFIG = path.join(envDir, "config.json");
    secretPath = path.join(envDir, "agent-jwt-secret");

    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_DEPLOYMENT_MODE;

    // Drop the module-level cachedLocalFileSecret between tests.
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of AUTO_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  async function loadModule(): Promise<AgentAuthJwtModule> {
    return import("../agent-auth-jwt.js");
  }

  it("auto-provisions a persistent 0600 secret and signs a verifiable token", async () => {
    // No configured secret, deployment mode unset -> defaults to local_trusted.
    const mod = await loadModule();

    const token = mod.createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeTruthy();

    expect(existsSync(secretPath)).toBe(true);
    const secret = readFileSync(secretPath, "utf8");
    expect(secret.trim().length).toBeGreaterThan(0);
    expect(secret.endsWith("\n")).toBe(true);

    if (isPosix) {
      expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    }

    expect(mod.verifyLocalAgentJwt(token as string)).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
    });
  });

  it("generates the secret once and reuses it on subsequent calls", async () => {
    const mod = await loadModule();

    expect(mod.createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1")).toBeTruthy();
    const secretAfterFirst = readFileSync(secretPath, "utf8");

    expect(mod.createLocalAgentJwt("agent-2", "company-1", "claude_local", "run-2")).toBeTruthy();
    expect(readFileSync(secretPath, "utf8")).toBe(secretAfterFirst);
  });

  it("reuses the secret file across a process restart (does not regenerate)", async () => {
    const mod = await loadModule();
    const token = mod.createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeTruthy();
    const provisioned = readFileSync(secretPath, "utf8");

    // Simulate a fresh process: clear in-memory cache, re-import the module.
    vi.resetModules();
    const reloaded = await loadModule();

    expect(readFileSync(secretPath, "utf8")).toBe(provisioned);
    // Token minted before the "restart" still verifies -> same secret reused.
    expect(reloaded.verifyLocalAgentJwt(token as string)).toMatchObject({ sub: "agent-1" });
  });

  it("reads a pre-existing secret file rather than overwriting it", async () => {
    const preset = "preset-secret-value-for-reuse-test";
    writeFileSync(secretPath, `${preset}\n`, { mode: 0o600 });

    const mod = await loadModule();
    const token = mod.createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    expect(token).toBeTruthy();
    expect(readFileSync(secretPath, "utf8")).toBe(`${preset}\n`);
    expect(mod.verifyLocalAgentJwt(token as string)).toMatchObject({ sub: "agent-1" });
  });

  it("returns null and writes no secret file for non-local_trusted without a configured secret", async () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    const mod = await loadModule();

    expect(mod.createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1")).toBeNull();
    expect(mod.verifyLocalAgentJwt("a.b.c")).toBeNull();
    expect(existsSync(secretPath)).toBe(false);
  });
});

describe("describeAgentJwtSecret", () => {
  const saved: Record<string, string | undefined> = {};
  const tmpDirs: string[] = [];
  let secretPath: string;

  beforeEach(() => {
    for (const key of AUTO_ENV_KEYS) saved[key] = process.env[key];

    const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-agent-jwt-desc-"));
    tmpDirs.push(root);
    const envDir = path.join(root, ".paperclip");
    mkdirSync(envDir, { recursive: true });
    process.env.PAPERCLIP_CONFIG = path.join(envDir, "config.json");
    secretPath = path.join(envDir, "agent-jwt-secret");

    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_DEPLOYMENT_MODE;
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of AUTO_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("reports 'set' when PAPERCLIP_AGENT_JWT_SECRET is configured", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "explicit";
    const { describeAgentJwtSecret } = await import("../agent-auth-jwt.js");
    expect(describeAgentJwtSecret()).toEqual({ status: "pass", message: "set" });
    expect(existsSync(secretPath)).toBe(false);
  });

  it("reports 'set' when only BETTER_AUTH_SECRET is configured", async () => {
    process.env.BETTER_AUTH_SECRET = "fallback";
    const { describeAgentJwtSecret } = await import("../agent-auth-jwt.js");
    expect(describeAgentJwtSecret()).toEqual({ status: "pass", message: "set" });
    expect(existsSync(secretPath)).toBe(false);
  });

  it("reports auto-provisioned in local_trusted and creates the secret file", async () => {
    const { describeAgentJwtSecret } = await import("../agent-auth-jwt.js");
    expect(describeAgentJwtSecret()).toEqual({
      status: "pass",
      message: "auto-provisioned (local_trusted)",
    });
    expect(existsSync(secretPath)).toBe(true);
  });

  it("warns 'missing' for non-local_trusted without a configured secret", async () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    const { describeAgentJwtSecret } = await import("../agent-auth-jwt.js");
    expect(describeAgentJwtSecret()).toEqual({
      status: "warn",
      message: "missing (run `pnpm paperclipai onboard`)",
    });
    expect(existsSync(secretPath)).toBe(false);
  });
});
