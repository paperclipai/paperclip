import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  evaluateAgyCredentialReadiness,
  hasUsableAgyOAuthToken,
  resolveAgyOAuthTokenPath,
  parseAgyOAuthToken,
  ensureAgyApiKeySettings,
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

describe("parseAgyOAuthToken", () => {
  it("parses nested token object with access_token and refresh_token", () => {
    const content = JSON.stringify({
      token: {
        access_token: "ya29.access-token",
        refresh_token: "1//refresh-token",
        id_token: "header.payload.signature",
        expiry: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    const parsed = parseAgyOAuthToken(content);
    expect(parsed.valid).toBe(true);
    expect(parsed.accessToken).toBe("ya29.access-token");
    expect(parsed.refreshToken).toBe("1//refresh-token");
    expect(parsed.idToken).toBe("header.payload.signature");
    expect(parsed.isExpired).toBe(false);
    expect(parsed.expiryMs).toBeGreaterThan(Date.now());
  });

  it("handles expired access token if refresh_token is present", () => {
    const content = JSON.stringify({
      access_token: "expired-access",
      refresh_token: "valid-refresh",
      expiry: new Date(Date.now() - 3600000).toISOString(),
    });
    const parsed = parseAgyOAuthToken(content);
    expect(parsed.isExpired).toBe(true);
    expect(parsed.valid).toBe(true); // Still valid because refresh token is available
  });

  it("marks expired token as invalid if no refresh_token is present", () => {
    const content = JSON.stringify({
      access_token: "expired-access",
      expiry: new Date(Date.now() - 3600000).toISOString(),
    });
    const parsed = parseAgyOAuthToken(content);
    expect(parsed.isExpired).toBe(true);
    expect(parsed.valid).toBe(false);
  });
});

describe("ensureAgyApiKeySettings", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-settings-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("creates settings.json with modelProvider: gemini when file does not exist", async () => {
    const fakeHome = makeTmpDir();
    const settingsPath = await ensureAgyApiKeySettings(fakeHome);
    expect(fs.existsSync(settingsPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(content.modelProvider).toBe("gemini");
  });

  it("updates existing settings.json preserving other keys", async () => {
    const fakeHome = makeTmpDir();
    const dir = path.join(fakeHome, ".gemini", "antigravity-cli");
    fs.mkdirSync(dir, { recursive: true });
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ otherSetting: true, modelProvider: "other" }));

    await ensureAgyApiKeySettings(fakeHome);
    const content = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(content.modelProvider).toBe("gemini");
    expect(content.otherSetting).toBe(true);
  });
});

describe("decideAgyAuthMerge", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-merge-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("returns 10 (use source) when destination does not exist", async () => {
    const dir = makeTmpDir();
    const source = path.join(dir, "source.json");
    const dest = path.join(dir, "dest.json");
    fs.writeFileSync(source, JSON.stringify({ access_token: "tok1", refresh_token: "ref1" }));

    const { decideAgyAuthMerge } = await import("./credentials.js");
    const decision = await decideAgyAuthMerge(source, dest);
    expect(decision).toBe(10);
  });

  it("returns 10 (use source) when source has newer expiry", async () => {
    const dir = makeTmpDir();
    const source = path.join(dir, "source.json");
    const dest = path.join(dir, "dest.json");
    const now = Date.now();
    fs.writeFileSync(source, JSON.stringify({
      access_token: "tok2",
      expiry: new Date(now + 7200000).toISOString(),
    }));
    fs.writeFileSync(dest, JSON.stringify({
      access_token: "tok1",
      expiry: new Date(now + 3600000).toISOString(),
    }));

    const { decideAgyAuthMerge } = await import("./credentials.js");
    const decision = await decideAgyAuthMerge(source, dest);
    expect(decision).toBe(10);
  });

  it("returns 20 (keep destination) when source is invalid", async () => {
    const dir = makeTmpDir();
    const source = path.join(dir, "source.json");
    const dest = path.join(dir, "dest.json");
    fs.writeFileSync(source, "");
    fs.writeFileSync(dest, JSON.stringify({ access_token: "tok1" }));

    const { decideAgyAuthMerge } = await import("./credentials.js");
    const decision = await decideAgyAuthMerge(source, dest);
    expect(decision).toBe(20);
  });
});
