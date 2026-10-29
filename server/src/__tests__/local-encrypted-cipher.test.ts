import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalEncryptedCipher, localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

describe("operation-scoped local encryption", () => {
  let root: string;
  let keyFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paperclip-encryption-batch-"));
    keyFile = join(root, "master.key");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", keyFile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("encrypts and recovers 4096 records without reading the key again within a batch", () => {
    const writer = createLocalEncryptedCipher("write");
    const reader = createLocalEncryptedCipher("read");
    unlinkSync(keyFile);
    const records = Array.from({ length: 4096 }, (_, i) => writer.encrypt(`control-record-${i}`));
    expect(new Set(records.map(record => record.iv)).size).toBe(records.length);
    expect(records.map(record => reader.decrypt(record))).toEqual(
      Array.from({ length: 4096 }, (_, i) => `control-record-${i}`),
    );
    expect(() => createLocalEncryptedCipher("read")).toThrow("Secrets master key file is missing");
  });

  it("reloads a replaced key for the next operation and keeps decryption failures typed", () => {
    const old = createLocalEncryptedCipher("write");
    const material = old.encrypt("original control state");
    writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
    const replacement = createLocalEncryptedCipher("read");
    expect(old.decrypt(material)).toBe("original control state");
    expect(() => replacement.decrypt(material)).toThrow(expect.objectContaining({
      code: "provider_unavailable", provider: "local_encrypted", operation: "resolveVersion",
    }));
  });

  it("reads existing provider material and writes material the existing provider can read", async () => {
    const original = await localEncryptedProvider.createVersion({ value: "existing secret" });
    const batch = createLocalEncryptedCipher("read");
    expect(batch.decrypt(original.material)).toBe("existing secret");
    await expect(localEncryptedProvider.resolveVersion({
      material: batch.encrypt("checkpoint part"), externalRef: null,
    })).resolves.toBe("checkpoint part");
    await expect(localEncryptedProvider.resolveVersion({ material: {}, externalRef: null }))
      .rejects.toMatchObject({ code: "provider_unavailable", operation: "resolveVersion" });
  });

  it("never creates a replacement key when recovering a missing key", () => {
    expect(() => createLocalEncryptedCipher("read")).toThrow(expect.objectContaining({
      code: "provider_unavailable", operation: "resolveVersion",
    }));
  });
});
