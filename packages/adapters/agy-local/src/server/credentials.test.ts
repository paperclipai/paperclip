import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  evaluateAgyCredentialReadiness,
  hasUsableAgyOAuthToken,
  resolveAgyOAuthTokenPath,
} from "./credentials.js";

describe("evaluateAgyCredentialReadiness", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cred-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("returns ready: true with authMode: 'api' when configuredApiKey is provided", () => {
    const res = evaluateAgyCredentialReadiness({ configuredApiKey: "test-key" });
    expect(res.ready).toBe(true);
    expect(res.authMode).toBe("api");
    expect(res.detail).toBe("configured_api_key");
  });

  it("returns ready: true with authMode: 'api' when GEMINI_API_KEY is in env", () => {
    const res = evaluateAgyCredentialReadiness({ env: { GEMINI_API_KEY: "gemini-key" } as NodeJS.ProcessEnv });
    expect(res.ready).toBe(true);
    expect(res.authMode).toBe("api");
    expect(res.detail).toBe("env_api_key");
  });

  it("returns ready: true with authMode: 'api' when AGY_API_KEY is in env", () => {
    const res = evaluateAgyCredentialReadiness({ env: { AGY_API_KEY: "agy-key" } as NodeJS.ProcessEnv });
    expect(res.ready).toBe(true);
    expect(res.authMode).toBe("api");
  });

  it("returns ready: true with authMode: 'subscription' when OAuth token file exists in ~/.gemini/antigravity-cli", () => {
    const fakeHome = makeTmpDir();
    const tokenDir = path.join(fakeHome, ".gemini", "antigravity-cli");
    fs.mkdirSync(tokenDir, { recursive: true });
    const tokenFile = path.join(tokenDir, "antigravity-oauth-token");
    fs.writeFileSync(tokenFile, JSON.stringify({ token: "oauth-token-123", auth_method: "oauth" }));

    const res = evaluateAgyCredentialReadiness({ homedir: fakeHome, env: {} as NodeJS.ProcessEnv });
    expect(res.ready).toBe(true);
    expect(res.authMode).toBe("subscription");
    expect(res.tokenPath).toBe(tokenFile);
    expect(res.detail).toBe("oauth_token_file");
  });

  it("returns ready: true with authMode: 'subscription' when OAuth token file exists in ~/.gemini/antigravity", () => {
    const fakeHome = makeTmpDir();
    const tokenDir = path.join(fakeHome, ".gemini", "antigravity");
    fs.mkdirSync(tokenDir, { recursive: true });
    const tokenFile = path.join(tokenDir, "antigravity-oauth-token");
    fs.writeFileSync(tokenFile, JSON.stringify({ access_token: "access-token-456" }));

    const res = evaluateAgyCredentialReadiness({ homedir: fakeHome, env: {} as NodeJS.ProcessEnv });
    expect(res.ready).toBe(true);
    expect(res.authMode).toBe("subscription");
    expect(res.tokenPath).toBe(tokenFile);
  });

  it("respects ANTIGRAVITY_CLI_HOME environment override", () => {
    const customHome = makeTmpDir();
    const tokenFile = path.join(customHome, "antigravity-oauth-token");
    fs.writeFileSync(tokenFile, JSON.stringify({ id_token: "id-token-789" }));

    const res = evaluateAgyCredentialReadiness({
      homedir: "/nonexistent",
      env: { ANTIGRAVITY_CLI_HOME: customHome } as NodeJS.ProcessEnv,
    });
    expect(res.ready).toBe(true);
    expect(res.authMode).toBe("subscription");
    expect(res.tokenPath).toBe(tokenFile);
  });

  it("returns ready: false when no credentials exist", () => {
    const emptyHome = makeTmpDir();
    const res = evaluateAgyCredentialReadiness({ homedir: emptyHome, env: {} as NodeJS.ProcessEnv });
    expect(res.ready).toBe(false);
    expect(res.authMode).toBe("none");
    expect(res.detail).toBe("missing_credentials");
  });

  it("returns ready: false when OAuth token file is empty", () => {
    const fakeHome = makeTmpDir();
    const tokenDir = path.join(fakeHome, ".gemini", "antigravity-cli");
    fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(path.join(tokenDir, "antigravity-oauth-token"), "");

    const res = evaluateAgyCredentialReadiness({ homedir: fakeHome, env: {} as NodeJS.ProcessEnv });
    expect(res.ready).toBe(false);
  });
});
