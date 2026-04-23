import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLocalSecretsKeyFile } from "./secrets-key.js";
import type { PaperclipConfig } from "./schema.js";

beforeEach(() => {
  // Clear key-file env overrides that may be set in the outer environment
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});


// Minimal config factory to keep tests concise
function makeConfig(
  provider: "local_encrypted" | "env" | "none" = "local_encrypted",
  keyFilePath = ".paperclip/secrets/master.key",
): Pick<PaperclipConfig, "secrets"> {
  return {
    secrets: {
      provider,
      localEncrypted: { keyFilePath },
    } as PaperclipConfig["secrets"],
  };
}

// ============================================================================
// skipped_provider
// ============================================================================

describe("ensureLocalSecretsKeyFile — skipped_provider", () => {
  it("returns skipped_provider when provider is not local_encrypted", () => {
    const result = ensureLocalSecretsKeyFile(makeConfig("env"));
    expect(result.status).toBe("skipped_provider");
    expect(result.path).toBeNull();
  });

  it("returns skipped_provider when provider is 'none'", () => {
    const result = ensureLocalSecretsKeyFile(makeConfig("none"));
    expect(result.status).toBe("skipped_provider");
    expect(result.path).toBeNull();
  });
});

// ============================================================================
// skipped_env
// ============================================================================

describe("ensureLocalSecretsKeyFile — skipped_env", () => {
  it("returns skipped_env when PAPERCLIP_SECRETS_MASTER_KEY is set", () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "some-secret-value");
    const result = ensureLocalSecretsKeyFile(makeConfig("local_encrypted"));
    expect(result.status).toBe("skipped_env");
    expect(result.path).toBeNull();
  });

  it("does not skip when PAPERCLIP_SECRETS_MASTER_KEY is empty", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-test-"));
    try {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
      const keyFilePath = path.join(tmpDir, "master.key");
      const result = ensureLocalSecretsKeyFile(makeConfig("local_encrypted", keyFilePath));
      // should proceed to create or find the file, not skip
      expect(result.status).not.toBe("skipped_env");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not skip when PAPERCLIP_SECRETS_MASTER_KEY is whitespace only", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-test-"));
    try {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "   ");
      const keyFilePath = path.join(tmpDir, "master.key");
      const result = ensureLocalSecretsKeyFile(makeConfig("local_encrypted", keyFilePath));
      expect(result.status).not.toBe("skipped_env");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// existing
// ============================================================================

describe("ensureLocalSecretsKeyFile — existing", () => {
  it("returns existing when the key file already exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-test-"));
    const keyFilePath = path.join(tmpDir, "master.key");
    fs.writeFileSync(keyFilePath, "existing-key-content");

    try {
      const result = ensureLocalSecretsKeyFile(makeConfig("local_encrypted", keyFilePath));
      expect(result.status).toBe("existing");
      if (result.status === "existing") {
        expect(result.path).toBe(keyFilePath);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing key file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-test-"));
    const keyFilePath = path.join(tmpDir, "master.key");
    const originalContent = "my-original-key";
    fs.writeFileSync(keyFilePath, originalContent);

    try {
      ensureLocalSecretsKeyFile(makeConfig("local_encrypted", keyFilePath));
      expect(fs.readFileSync(keyFilePath, "utf8")).toBe(originalContent);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// created
// ============================================================================

describe("ensureLocalSecretsKeyFile — created", () => {
  it("creates a new key file and returns created status", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-test-"));
    const keyFilePath = path.join(tmpDir, "subdir", "master.key");

    try {
      const result = ensureLocalSecretsKeyFile(makeConfig("local_encrypted", keyFilePath));
      expect(result.status).toBe("created");
      if (result.status === "created") {
        expect(result.path).toBe(keyFilePath);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates parent directories recursively", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-test-"));
    const keyFilePath = path.join(tmpDir, "a", "b", "c", "master.key");

    try {
      ensureLocalSecretsKeyFile(makeConfig("local_encrypted", keyFilePath));
      expect(fs.existsSync(keyFilePath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes a non-empty base64 key to the new file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-test-"));
    const keyFilePath = path.join(tmpDir, "master.key");

    try {
      ensureLocalSecretsKeyFile(makeConfig("local_encrypted", keyFilePath));
      const content = fs.readFileSync(keyFilePath, "utf8");
      expect(content.length).toBeGreaterThan(0);
      // base64 alphabet check
      expect(content).toMatch(/^[A-Za-z0-9+/=]+$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses PAPERCLIP_SECRETS_MASTER_KEY_FILE env override for the key file path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-test-"));
    const overridePath = path.join(tmpDir, "override-key.key");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", overridePath);

    try {
      const result = ensureLocalSecretsKeyFile(makeConfig("local_encrypted", "/should/not/be/used"));
      expect(result.status).toBe("created");
      if (result.status === "created") {
        expect(result.path).toBe(overridePath);
      }
      expect(fs.existsSync(overridePath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
