import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseEnvFileContents } from "dotenv";
import { ensureLocalAgentJwtSecret } from "../agent-jwt-secret.js";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

// AIC-119. A `local_trusted` server without a signing secret mints no run
// token, so every agent falls back to the implicit board principal — which
// carries `isInstanceAdmin: true`. A missing secret is therefore a silent
// privilege escalation, not a missing feature.
describe("ensureLocalAgentJwtSecret", () => {
  let dir: string;
  let envFilePath: string;
  const savedEnv = {
    jwt: process.env.PAPERCLIP_AGENT_JWT_SECRET,
    betterAuth: process.env.BETTER_AUTH_SECRET,
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-jwt-secret-"));
    envFilePath = path.join(dir, ".env");
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedEnv.jwt === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = savedEnv.jwt;
    if (savedEnv.betterAuth === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = savedEnv.betterAuth;
  });

  it("generates and persists a secret when local_trusted has none", () => {
    const outcome = ensureLocalAgentJwtSecret({ deploymentMode: "local_trusted", envFilePath });

    expect(outcome).toMatchObject({ status: "created", source: "generated" });
    const persisted = parseEnvFileContents(fs.readFileSync(envFilePath, "utf-8"));
    expect(persisted.PAPERCLIP_AGENT_JWT_SECRET).toBeTruthy();
    // The live process must be able to mint for runs spawned during this boot,
    // not only after a restart re-reads the file.
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe(persisted.PAPERCLIP_AGENT_JWT_SECRET);
  });

  it("makes agent run tokens mintable and verifiable end to end", () => {
    ensureLocalAgentJwtSecret({ deploymentMode: "local_trusted", envFilePath });

    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeTruthy();
    expect(verifyLocalAgentJwt(token!)).toMatchObject({ sub: "agent-1", run_id: "run-1" });
  });

  it("writes the env file with owner-only permissions", () => {
    ensureLocalAgentJwtSecret({ deploymentMode: "local_trusted", envFilePath });
    expect(fs.statSync(envFilePath).mode & 0o777).toBe(0o600);
  });

  it("is idempotent across restarts and does not rotate a live secret", () => {
    const first = ensureLocalAgentJwtSecret({ deploymentMode: "local_trusted", envFilePath });
    expect(first.status).toBe("created");
    const created = process.env.PAPERCLIP_AGENT_JWT_SECRET;

    // Simulate a fresh process that has the file but not the value loaded.
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const second = ensureLocalAgentJwtSecret({ deploymentMode: "local_trusted", envFilePath });

    expect(second).toMatchObject({ status: "loaded", source: "env_file" });
    // Rotating here would invalidate the tokens of every run already in flight.
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe(created);
  });

  it("leaves an existing process secret alone", () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "already-configured";
    const outcome = ensureLocalAgentJwtSecret({ deploymentMode: "local_trusted", envFilePath });

    expect(outcome).toMatchObject({ status: "present", source: "process_env" });
    expect(fs.existsSync(envFilePath)).toBe(false);
  });

  it("accepts BETTER_AUTH_SECRET as the signing secret", () => {
    process.env.BETTER_AUTH_SECRET = "shared-auth-secret";
    const outcome = ensureLocalAgentJwtSecret({ deploymentMode: "local_trusted", envFilePath });

    expect(outcome).toMatchObject({ status: "present" });
    expect(fs.existsSync(envFilePath)).toBe(false);
  });

  it("refuses to invent a secret for a multi-user deployment", () => {
    // `authenticated` mode already refuses to boot without BETTER_AUTH_SECRET.
    // Generating one here would hide a real misconfiguration.
    const outcome = ensureLocalAgentJwtSecret({ deploymentMode: "authenticated", envFilePath });

    expect(outcome).toMatchObject({ status: "absent", reason: "not_local_trusted" });
    expect(fs.existsSync(envFilePath)).toBe(false);
  });

  it("preserves unrelated entries already in the env file", () => {
    fs.writeFileSync(envFilePath, "# existing\nPAPERCLIP_SOMETHING_ELSE=keep-me\n", { mode: 0o600 });
    ensureLocalAgentJwtSecret({ deploymentMode: "local_trusted", envFilePath });

    const persisted = parseEnvFileContents(fs.readFileSync(envFilePath, "utf-8"));
    expect(persisted.PAPERCLIP_SOMETHING_ELSE).toBe("keep-me");
    expect(persisted.PAPERCLIP_AGENT_JWT_SECRET).toBeTruthy();
  });

  it("reports a failure instead of throwing when the file cannot be written", () => {
    const readOnlyDir = path.join(dir, "read-only");
    fs.mkdirSync(readOnlyDir, { mode: 0o500 });
    const outcome = ensureLocalAgentJwtSecret({
      deploymentMode: "local_trusted",
      envFilePath: path.join(readOnlyDir, ".env"),
    });

    expect(outcome.status).toBe("failed");
    fs.chmodSync(readOnlyDir, 0o700);
  });
});
