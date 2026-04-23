import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { secretsCheck } from "./secrets-check.js";

function makeConfig(overrides: {
  provider?: "local_encrypted" | "none" | string;
  keyFilePath?: string;
  strictMode?: boolean;
  databaseMode?: "embedded-postgres" | "postgres";
}): PaperclipConfig {
  return {
    secrets: {
      provider: overrides.provider ?? "local_encrypted",
      localEncrypted: {
        keyFilePath: overrides.keyFilePath ?? "/tmp/master.key",
      },
      strictMode: overrides.strictMode,
    },
    database: {
      mode: overrides.databaseMode ?? "embedded-postgres",
    },
  } as unknown as PaperclipConfig;
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-check-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// secretsCheck — unsupported provider
// ============================================================================

describe("secretsCheck — unsupported provider", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "");
  });

  it("returns fail for non-local_encrypted provider", () => {
    const result = secretsCheck(makeConfig({ provider: "none" }));
    expect(result.status).toBe("fail");
  });

  it("includes the provider name in the fail message", () => {
    const result = secretsCheck(makeConfig({ provider: "external_vault" }));
    expect(result.message).toContain("external_vault");
  });
});

// ============================================================================
// secretsCheck — PAPERCLIP_SECRETS_MASTER_KEY env var
// ============================================================================

describe("secretsCheck — PAPERCLIP_SECRETS_MASTER_KEY env", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "");
  });

  it("returns pass for a valid 32-byte base64 key", () => {
    // 32 random bytes as base64
    const key = Buffer.from("a".repeat(32)).toString("base64");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", key);
    const result = secretsCheck(makeConfig({}));
    expect(result.status).toBe("pass");
  });

  it("returns pass for a valid 64-char hex key", () => {
    const key = "a".repeat(64);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", key);
    const result = secretsCheck(makeConfig({}));
    expect(result.status).toBe("pass");
  });

  it("returns pass for a raw 32-character string key", () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "12345678901234567890123456789012");
    const result = secretsCheck(makeConfig({}));
    expect(result.status).toBe("pass");
  });

  it("returns fail for an invalid/short key", () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "tooshort");
    const result = secretsCheck(makeConfig({}));
    expect(result.status).toBe("fail");
  });

  it("pass message mentions PAPERCLIP_SECRETS_MASTER_KEY", () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    const result = secretsCheck(makeConfig({}));
    expect(result.message).toContain("PAPERCLIP_SECRETS_MASTER_KEY");
  });
});

// ============================================================================
// secretsCheck — key file
// ============================================================================

describe("secretsCheck — key file missing", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "");
  });

  it("returns warn when key file does not exist", () => {
    const dir = makeTempDir();
    const config = makeConfig({ keyFilePath: path.join(dir, "master.key") });
    const result = secretsCheck(config);
    expect(result.status).toBe("warn");
  });

  it("sets canRepair to true when key file is missing", () => {
    const dir = makeTempDir();
    const config = makeConfig({ keyFilePath: path.join(dir, "master.key") });
    const result = secretsCheck(config);
    expect(result.canRepair).toBe(true);
  });

  it("repair function creates the key file", () => {
    const dir = makeTempDir();
    const keyFile = path.join(dir, "master.key");
    const config = makeConfig({ keyFilePath: keyFile });
    const result = secretsCheck(config);
    result.repair?.();
    expect(fs.existsSync(keyFile)).toBe(true);
  });
});

describe("secretsCheck — key file present with valid key", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "");
  });

  it("returns pass when key file contains a valid 64-char hex key", () => {
    const dir = makeTempDir();
    const keyFile = path.join(dir, "master.key");
    fs.writeFileSync(keyFile, "a".repeat(64));
    const config = makeConfig({ keyFilePath: keyFile });
    const result = secretsCheck(config);
    expect(result.status).toBe("pass");
  });

  it("returns fail when key file contains invalid content", () => {
    const dir = makeTempDir();
    const keyFile = path.join(dir, "master.key");
    fs.writeFileSync(keyFile, "bad");
    const config = makeConfig({ keyFilePath: keyFile });
    const result = secretsCheck(config);
    expect(result.status).toBe("fail");
  });

  it("pass message includes the key file path", () => {
    const dir = makeTempDir();
    const keyFile = path.join(dir, "master.key");
    fs.writeFileSync(keyFile, "a".repeat(64));
    const config = makeConfig({ keyFilePath: keyFile });
    const result = secretsCheck(config);
    expect(result.message).toContain(keyFile);
  });
});

// ============================================================================
// secretsCheck — strictMode downgrade
// ============================================================================

describe("secretsCheck — strictMode disabled for postgres", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "");
  });

  it("downgrades pass to warn when strictMode=false and postgres mode", () => {
    const dir = makeTempDir();
    const keyFile = path.join(dir, "master.key");
    fs.writeFileSync(keyFile, "a".repeat(64));
    const config = makeConfig({
      keyFilePath: keyFile,
      strictMode: false,
      databaseMode: "postgres",
    });
    const result = secretsCheck(config);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("strict");
  });

  it("does not downgrade when strictMode=false but embedded-postgres", () => {
    const dir = makeTempDir();
    const keyFile = path.join(dir, "master.key");
    fs.writeFileSync(keyFile, "a".repeat(64));
    const config = makeConfig({
      keyFilePath: keyFile,
      strictMode: false,
      databaseMode: "embedded-postgres",
    });
    const result = secretsCheck(config);
    expect(result.status).toBe("pass");
  });
});
