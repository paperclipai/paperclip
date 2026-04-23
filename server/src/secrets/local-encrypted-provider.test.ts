import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localEncryptedProvider } from "./local-encrypted-provider.js";

// We inject a known 32-byte key via the env var so loadOrCreateMasterKey()
// never touches the filesystem in these tests.
const TEST_MASTER_KEY_HEX = randomBytes(32).toString("hex");

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", TEST_MASTER_KEY_HEX);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ============================================================================
// localEncryptedProvider — module identity
// ============================================================================

describe("localEncryptedProvider — identity", () => {
  it("has id 'local_encrypted'", () => {
    expect(localEncryptedProvider.id).toBe("local_encrypted");
  });

  it("has descriptor id 'local_encrypted'", () => {
    expect(localEncryptedProvider.descriptor.id).toBe("local_encrypted");
  });
});

// ============================================================================
// localEncryptedProvider.createVersion
// ============================================================================

describe("localEncryptedProvider.createVersion", () => {
  it("returns material with scheme 'local_encrypted_v1'", async () => {
    const result = await localEncryptedProvider.createVersion({ value: "my-secret", externalRef: null });
    expect((result.material as { scheme: string }).scheme).toBe("local_encrypted_v1");
  });

  it("returns material with iv, tag, and ciphertext fields", async () => {
    const result = await localEncryptedProvider.createVersion({ value: "test-value", externalRef: null });
    const m = result.material as Record<string, unknown>;
    expect(typeof m.iv).toBe("string");
    expect(typeof m.tag).toBe("string");
    expect(typeof m.ciphertext).toBe("string");
  });

  it("returns externalRef as null", async () => {
    const result = await localEncryptedProvider.createVersion({ value: "secret", externalRef: null });
    expect(result.externalRef).toBeNull();
  });

  it("returns correct SHA-256 hash of the value", async () => {
    const value = "my-test-secret";
    const expected = createHash("sha256").update(value).digest("hex");
    const result = await localEncryptedProvider.createVersion({ value, externalRef: null });
    expect(result.valueSha256).toBe(expected);
  });

  it("produces different ciphertexts for the same value (random IV)", async () => {
    const r1 = await localEncryptedProvider.createVersion({ value: "same", externalRef: null });
    const r2 = await localEncryptedProvider.createVersion({ value: "same", externalRef: null });
    const m1 = r1.material as Record<string, string>;
    const m2 = r2.material as Record<string, string>;
    // IVs should differ (random), so ciphertexts should differ
    expect(m1.iv).not.toBe(m2.iv);
    expect(m1.ciphertext).not.toBe(m2.ciphertext);
  });
});

// ============================================================================
// localEncryptedProvider.resolveVersion — round-trip
// ============================================================================

describe("localEncryptedProvider.resolveVersion — round-trip", () => {
  it("round-trips a simple ASCII secret", async () => {
    const original = "hello-world";
    const { material } = await localEncryptedProvider.createVersion({ value: original, externalRef: null });
    const resolved = await localEncryptedProvider.resolveVersion({ material, externalRef: null });
    expect(resolved).toBe(original);
  });

  it("round-trips a secret with special characters", async () => {
    const original = "p@ssw0rd!#$%^&*()";
    const { material } = await localEncryptedProvider.createVersion({ value: original, externalRef: null });
    const resolved = await localEncryptedProvider.resolveVersion({ material, externalRef: null });
    expect(resolved).toBe(original);
  });

  it("round-trips a secret with unicode characters", async () => {
    const original = "🔑 secret key 日本語";
    const { material } = await localEncryptedProvider.createVersion({ value: original, externalRef: null });
    const resolved = await localEncryptedProvider.resolveVersion({ material, externalRef: null });
    expect(resolved).toBe(original);
  });

  it("round-trips an empty string", async () => {
    const original = "";
    const { material } = await localEncryptedProvider.createVersion({ value: original, externalRef: null });
    const resolved = await localEncryptedProvider.resolveVersion({ material, externalRef: null });
    expect(resolved).toBe(original);
  });

  it("round-trips a long secret (1 KB of random hex)", async () => {
    const original = randomBytes(512).toString("hex");
    const { material } = await localEncryptedProvider.createVersion({ value: original, externalRef: null });
    const resolved = await localEncryptedProvider.resolveVersion({ material, externalRef: null });
    expect(resolved).toBe(original);
  });
});

// ============================================================================
// localEncryptedProvider.resolveVersion — error handling
// ============================================================================

describe("localEncryptedProvider.resolveVersion — invalid material", () => {
  it("throws when scheme is missing", async () => {
    await expect(
      localEncryptedProvider.resolveVersion({
        material: { iv: "abc", tag: "def", ciphertext: "ghi" },
        externalRef: null,
      }),
    ).rejects.toThrow();
  });

  it("throws when scheme is wrong", async () => {
    await expect(
      localEncryptedProvider.resolveVersion({
        material: { scheme: "plaintext", iv: "abc", tag: "def", ciphertext: "ghi" },
        externalRef: null,
      }),
    ).rejects.toThrow();
  });

  it("throws when iv is missing", async () => {
    await expect(
      localEncryptedProvider.resolveVersion({
        material: { scheme: "local_encrypted_v1", tag: "def", ciphertext: "ghi" },
        externalRef: null,
      }),
    ).rejects.toThrow();
  });

  it("throws when ciphertext has been tampered with (auth tag mismatch)", async () => {
    const { material } = await localEncryptedProvider.createVersion({ value: "original", externalRef: null });
    const tampered = {
      ...material,
      ciphertext: randomBytes(16).toString("base64"),
    };
    await expect(
      localEncryptedProvider.resolveVersion({ material: tampered, externalRef: null }),
    ).rejects.toThrow();
  });
});

// ============================================================================
// localEncryptedProvider — key formats
// ============================================================================

describe("localEncryptedProvider — master key from env", () => {
  it("accepts a 64-char hex key and decrypts correctly", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", TEST_MASTER_KEY_HEX);
    const value = "test-hex-key";
    const { material } = await localEncryptedProvider.createVersion({ value, externalRef: null });
    const resolved = await localEncryptedProvider.resolveVersion({ material, externalRef: null });
    expect(resolved).toBe(value);
  });

  it("accepts a 32-byte base64 key and decrypts correctly", async () => {
    const base64Key = randomBytes(32).toString("base64");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", base64Key);
    const value = "test-base64-key";
    const { material } = await localEncryptedProvider.createVersion({ value, externalRef: null });
    const resolved = await localEncryptedProvider.resolveVersion({ material, externalRef: null });
    expect(resolved).toBe(value);
  });

  it("throws when master key env var is an invalid format", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "not-a-valid-key");
    await expect(
      localEncryptedProvider.createVersion({ value: "test", externalRef: null }),
    ).rejects.toThrow();
  });
});
