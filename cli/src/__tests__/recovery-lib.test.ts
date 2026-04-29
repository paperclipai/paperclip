import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canSkipRemoteAssetUpload,
  detectConcurrentLocalAssetIds,
  deriveRecoveryManifestAssetProof,
  getRecoveryDrillAssetProofFailures,
  publishRecoveryArtifacts,
  verifyRecoveredLocalEncryptedSecretValue,
} from "../commands/recovery-lib.js";

function createLocalEncryptedMaterial(masterKey: Buffer, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    scheme: "local_encrypted_v1" as const,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

describe("publishRecoveryArtifacts", () => {
  it("uploads backup artifacts before config and writes the manifest last", async () => {
    const writes: string[] = [];
    const now = new Date("2026-04-28T12:00:00.000Z");
    const manifest = await publishRecoveryArtifacts({
      writer: {
        async putObject({ objectKey, body }) {
          writes.push(objectKey);
          return {
            objectKey,
            sizeBytes: body.length,
            sha256: createHash("sha256").update(body).digest("hex"),
            uploadedAt: now.toISOString(),
          };
        },
      },
      now,
      previousManifest: null,
      backupFilePath: "/tmp/paperclip-20260428.sql.gz",
      backupBuffer: Buffer.from("backup-bytes"),
      backupSha256: "backup-sha",
      backupCreatedAt: "2026-04-28T11:55:00.000Z",
      storageProvider: "s3",
      assetCutoverComplete: true,
      assetSampleKeys: ["assets/sample-1"],
      keySnapshotBuffer: Buffer.from("{\"encrypted\":true}"),
      keySnapshotFingerprint: "fingerprint-123",
      configSnapshotBuffer: Buffer.from("{\"storage\":{\"provider\":\"s3\"}}"),
      warnings: [],
    });

    expect(manifest.backupArtifacts.map((artifact) => artifact.tier)).toEqual([
      "hourly",
      "daily",
      "weekly",
      "monthly",
    ]);
    expect(writes.slice(0, 4)).toEqual([
      "db/hourly/paperclip-20260428.sql.gz",
      "db/daily/paperclip-20260428.sql.gz",
      "db/weekly/paperclip-20260428.sql.gz",
      "db/monthly/paperclip-20260428.sql.gz",
    ]);
    expect(writes[4]).toBe("keys/fingerprint-123/20260428-120000.json");
    expect(writes[5]).toMatch(/^manifests\/config\/20260428-120000-/);
    expect(writes[6]).toBe(manifest.manifestObjectKey);
  });
});

describe("asset cutover safeguards", () => {
  it("does not skip an existing remote object when the bytes differ but the size matches", () => {
    const original = Buffer.from("correct-bytes");
    const stale = Buffer.from("stale-bytes!!");

    expect(original.length).toBe(stale.length);
    expect(canSkipRemoteAssetUpload({
      remoteBody: stale,
      expectedSha256: createHash("sha256").update(original).digest("hex"),
      expectedByteSize: original.length,
    })).toBe(false);
  });

  it("detects local asset rows that appeared after the migration snapshot", () => {
    expect(
      detectConcurrentLocalAssetIds(
        ["asset-1", "asset-2"],
        [{ id: "asset-1" }, { id: "asset-2" }, { id: "asset-3" }],
      ),
    ).toEqual(["asset-3"]);
  });

  it("does not mark asset cutover complete without authoritative asset samples", () => {
    expect(deriveRecoveryManifestAssetProof({
      storageProvider: "s3",
      remainingLocalAssetCount: 0,
      sampleObjectKeys: [],
    })).toEqual({
      assetCutoverComplete: false,
      assetSampleKeys: [],
    });
  });
});

describe("drill asset proof guards", () => {
  it("fails drills that do not have manifest asset samples to verify", () => {
    expect(getRecoveryDrillAssetProofFailures({
      assetCutoverComplete: true,
      assetSampleKeys: [],
    })).toContain("Recovery manifest does not include any asset sample keys to verify.");
  });
});

describe("verifyRecoveredLocalEncryptedSecretValue", () => {
  it("proves recovered key material can decrypt stored local_encrypted secret versions", () => {
    const masterKey = randomBytes(32);
    const value = "OPENAI_API_KEY=pc-secret";
    const material = createLocalEncryptedMaterial(masterKey, value);

    expect(verifyRecoveredLocalEncryptedSecretValue({
      masterKeyFileContents: Buffer.from(masterKey.toString("base64"), "utf8"),
      material,
      valueSha256: createHash("sha256").update(value).digest("hex"),
    })).toBe(value);
  });
});
