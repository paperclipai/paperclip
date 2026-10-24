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
  stageAgyHomeForSync,
  copyBackAgyAuth,
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
      refresh_token: "shared-refresh-token",
      expiry: new Date(now + 7200000).toISOString(),
    }));
    fs.writeFileSync(dest, JSON.stringify({
      access_token: "tok1",
      refresh_token: "shared-refresh-token",
      expiry: new Date(now + 3600000).toISOString(),
    }));

    const { decideAgyAuthMerge } = await import("./credentials.js");
    const decision = await decideAgyAuthMerge(source, dest);
    expect(decision).toBe(10);
  });

  it("returns 20 when the newer source belongs to a different account", async () => {
    const dir = makeTmpDir();
    const source = path.join(dir, "source.json");
    const dest = path.join(dir, "dest.json");
    const now = Date.now();
    fs.writeFileSync(source, JSON.stringify({
      access_token: "other-account-token",
      refresh_token: "other-refresh-token",
      expiry: new Date(now + 7200000).toISOString(),
    }));
    fs.writeFileSync(dest, JSON.stringify({
      access_token: "host-token",
      refresh_token: "host-refresh-token",
      expiry: new Date(now + 3600000).toISOString(),
    }));

    const { decideAgyAuthMerge } = await import("./credentials.js");
    const decision = await decideAgyAuthMerge(source, dest);
    expect(decision).toBe(20);
  });

  it("returns 20 when the source is non-JSON content with no verifiable identity", async () => {
    const dir = makeTmpDir();
    const source = path.join(dir, "source.json");
    const dest = path.join(dir, "dest.json");
    fs.writeFileSync(source, "some-opaque-token-string");
    fs.writeFileSync(dest, JSON.stringify({
      access_token: "host-token",
      refresh_token: "host-refresh-token",
      expiry: new Date(Date.now() + 3600000).toISOString(),
    }));

    const { decideAgyAuthMerge } = await import("./credentials.js");
    const decision = await decideAgyAuthMerge(source, dest);
    expect(decision).toBe(20);
  });

  it("returns 20 when only a forged id_token subject matches but the refresh token rotated", async () => {
    const dir = makeTmpDir();
    const source = path.join(dir, "source.json");
    const dest = path.join(dir, "dest.json");
    const now = Date.now();
    const idToken = (sub: string) =>
      `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`;
    fs.writeFileSync(source, JSON.stringify({
      access_token: "refreshed-token",
      refresh_token: "rotated-refresh-token",
      id_token: idToken("user-123"),
      expiry: new Date(now + 7200000).toISOString(),
    }));
    fs.writeFileSync(dest, JSON.stringify({
      access_token: "host-token",
      refresh_token: "original-refresh-token",
      id_token: idToken("user-123"),
      expiry: new Date(now + 3600000).toISOString(),
    }));

    const { decideAgyAuthMerge } = await import("./credentials.js");
    const decision = await decideAgyAuthMerge(source, dest);
    expect(decision).toBe(20);
  });

  it("returns 20 when payload identity fields match but the refresh token differs", async () => {
    const dir = makeTmpDir();
    const source = path.join(dir, "source.json");
    const dest = path.join(dir, "dest.json");
    const now = Date.now();
    // Identity fields carried as plain payload data are as forgeable as
    // decoded JWT claims: only the refresh token proves the same grant.
    fs.writeFileSync(source, JSON.stringify({
      access_token: "source-access",
      refresh_token: "source-refresh",
      account_id: "account-42",
      expiry: new Date(now + 7200000).toISOString(),
    }));
    fs.writeFileSync(dest, JSON.stringify({
      access_token: "dest-access",
      refresh_token: "dest-refresh",
      account_id: "account-42",
      expiry: new Date(now + 3600000).toISOString(),
    }));

    const { decideAgyAuthMerge } = await import("./credentials.js");
    const decision = await decideAgyAuthMerge(source, dest);
    expect(decision).toBe(20);
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

describe("stageAgyHomeForSync", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stage-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("stages OAuth token when present on host", async () => {
    const fakeHome = makeTmpDir();
    const tokenDir = path.join(fakeHome, ".gemini", "antigravity-cli");
    fs.mkdirSync(tokenDir, { recursive: true });
    const tokenFile = path.join(tokenDir, "antigravity-oauth-token");
    const tokenPayload = { token: "oauth-test-token", access_token: "ya29.test" };
    fs.writeFileSync(tokenFile, JSON.stringify(tokenPayload));

    const staged = await stageAgyHomeForSync({ homedir: fakeHome });
    tmpDirs.push(staged);

    const stagedToken = path.join(staged, "antigravity-oauth-token");
    expect(fs.existsSync(stagedToken)).toBe(true);
    const content = JSON.parse(fs.readFileSync(stagedToken, "utf8"));
    expect(content.access_token).toBe("ya29.test");
  });

  it("stages settings.json with modelProvider: gemini when API key is in env and settings.json is missing", async () => {
    const fakeHome = makeTmpDir();
    const staged = await stageAgyHomeForSync({
      homedir: fakeHome,
      env: { GEMINI_API_KEY: "test-gemini-key" } as NodeJS.ProcessEnv,
    });
    tmpDirs.push(staged);

    const stagedSettings = path.join(staged, "settings.json");
    expect(fs.existsSync(stagedSettings)).toBe(true);
    const content = JSON.parse(fs.readFileSync(stagedSettings, "utf8"));
    expect(content.modelProvider).toBe("gemini");
  });

  it("copies existing settings.json when present", async () => {
    const fakeHome = makeTmpDir();
    const dir = path.join(fakeHome, ".gemini", "antigravity-cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ customSetting: "abc" }));

    const staged = await stageAgyHomeForSync({ homedir: fakeHome });
    tmpDirs.push(staged);

    const stagedSettings = path.join(staged, "settings.json");
    expect(fs.existsSync(stagedSettings)).toBe(true);
    const content = JSON.parse(fs.readFileSync(stagedSettings, "utf8"));
    expect(content.customSetting).toBe("abc");
  });
});

describe("copyBackAgyAuth", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-copyback-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("copies newer token from sandbox to host (decision 10)", async () => {
    const dir = makeTmpDir();
    const hostTokenPath = path.join(dir, "antigravity-oauth-token");
    const now = Date.now();
    fs.writeFileSync(
      hostTokenPath,
      JSON.stringify({
        access_token: "old-host-token",
        refresh_token: "shared-refresh-token",
        expiry: new Date(now + 1000).toISOString(),
      }),
    );

    const sandboxToken = Buffer.from(
      JSON.stringify({
        access_token: "new-sandbox-token",
        refresh_token: "shared-refresh-token",
        expiry: new Date(now + 7200000).toISOString(),
      }),
    );

    const logs: string[] = [];
    const outcome = await copyBackAgyAuth({
      readSandboxAuth: async () => sandboxToken,
      hostTokenPath,
      log: (line) => {
        logs.push(line);
      },
    });

    expect(outcome).toBe("copied");
    const updated = JSON.parse(fs.readFileSync(hostTokenPath, "utf8"));
    expect(updated.access_token).toBe("new-sandbox-token");
    expect(logs.some((l) => l.includes("updated host credential"))).toBe(true);
  });

  it("retains host token when host token is newer (decision 20)", async () => {
    const dir = makeTmpDir();
    const hostTokenPath = path.join(dir, "antigravity-oauth-token");
    const now = Date.now();
    fs.writeFileSync(
      hostTokenPath,
      JSON.stringify({
        access_token: "newer-host-token",
        expiry: new Date(now + 7200000).toISOString(),
      }),
    );

    const sandboxToken = Buffer.from(
      JSON.stringify({
        access_token: "older-sandbox-token",
        expiry: new Date(now + 1000).toISOString(),
      }),
    );

    const logs: string[] = [];
    const outcome = await copyBackAgyAuth({
      readSandboxAuth: async () => sandboxToken,
      hostTokenPath,
      log: (line) => {
        logs.push(line);
      },
    });

    expect(outcome).toBe("kept-host");
    const retained = JSON.parse(fs.readFileSync(hostTokenPath, "utf8"));
    expect(retained.access_token).toBe("newer-host-token");
    expect(logs.some((l) => l.includes("host credential is newer or equivalent"))).toBe(true);
  });

  it("is a benign no-op returning kept-host when sandbox token does not exist (ENOENT)", async () => {
    const dir = makeTmpDir();
    const hostTokenPath = path.join(dir, "antigravity-oauth-token");
    fs.writeFileSync(hostTokenPath, JSON.stringify({ access_token: "host-token" }));

    const outcome = await copyBackAgyAuth({
      readSandboxAuth: async () => {
        const err = new Error("File not found") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
      hostTokenPath,
      log: () => {},
    });

    expect(outcome).toBe("kept-host");
    const retained = JSON.parse(fs.readFileSync(hostTokenPath, "utf8"));
    expect(retained.access_token).toBe("host-token");
  });
});
