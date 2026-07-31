import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRestoreCapacity, assertSecretDecryptionReadiness, validateRestoreAuthority } from "./db-restore.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-restore-authority-"));
  tempDirs.push(value);
  return value;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createAuthorityFixture(): {
  backupFile: string;
  countLedger: string;
  authorityManifest: string;
  expectedManifestSha256: string;
  recoveryConfig: string;
  recoveryMasterKey: string;
} {
  const dir = tempDir();
  const backupFile = path.join(dir, "snapshot.sql.gz");
  const countLedger = path.join(dir, "snapshot.counts.json");
  const authorityManifest = path.join(dir, "snapshot.restore.json");
  const recoveryConfig = path.join(dir, "config.json");
  const recoveryMasterKey = path.join(dir, "master.key");
  fs.writeFileSync(backupFile, "backup-content");
  fs.writeFileSync(recoveryConfig, "{}\n");
  fs.writeFileSync(recoveryMasterKey, randomBytes(32).toString("base64"));
  const ledger = {
    format: "paperclip-table-count-ledger-v1",
    databaseSizeBytes: 4096,
    tables: [{ schema: "public", table: "issues", rowCount: 7 }],
  };
  fs.writeFileSync(countLedger, `${JSON.stringify(ledger, null, 2)}\n`);
  const manifest = {
    format: "paperclip-restore-authority-v2",
    backup: {
      file: path.basename(backupFile),
      sha256: sha256(fs.readFileSync(backupFile)),
      sizeBytes: fs.statSync(backupFile).size,
    },
    ledger: {
      file: path.basename(countLedger),
      sha256: sha256(fs.readFileSync(countLedger)),
    },
    restoreFootprintBytes: 4096,
    recovery: {
      config: {
        file: path.basename(recoveryConfig),
        sha256: sha256(fs.readFileSync(recoveryConfig)),
        sizeBytes: fs.statSync(recoveryConfig).size,
      },
      masterKey: {
        file: path.basename(recoveryMasterKey),
        sha256: sha256(fs.readFileSync(recoveryMasterKey)),
        sizeBytes: fs.statSync(recoveryMasterKey).size,
        requiredMode: "0600",
      },
    },
  };
  fs.writeFileSync(authorityManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    backupFile,
    countLedger,
    authorityManifest,
    expectedManifestSha256: sha256(fs.readFileSync(authorityManifest)),
    recoveryConfig,
    recoveryMasterKey,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("restore authority", () => {
  it("accepts a manifest-bound backup and deterministic table-count ledger", async () => {
    const fixture = createAuthorityFixture();
    const result = await validateRestoreAuthority({
      ...fixture,
      backupStat: fs.statSync(fixture.backupFile),
    });
    expect(result.manifest.restoreFootprintBytes).toBe(4096);
    expect(result.ledger.tables).toEqual([{ schema: "public", table: "issues", rowCount: 7 }]);
  });

  it("rejects backup, ledger, and manifest tampering before opening a target", async () => {
    for (const tamper of ["backup", "ledger", "manifest", "config", "key"] as const) {
      const fixture = createAuthorityFixture();
      if (tamper === "backup") fs.appendFileSync(fixture.backupFile, "tampered");
      if (tamper === "ledger") fs.appendFileSync(fixture.countLedger, " ");
      if (tamper === "manifest") fs.appendFileSync(fixture.authorityManifest, " ");
      if (tamper === "config") fs.appendFileSync(fixture.recoveryConfig, " ");
      if (tamper === "key") fs.appendFileSync(fixture.recoveryMasterKey, " ");
      await expect(validateRestoreAuthority({
        ...fixture,
        backupStat: fs.statSync(fixture.backupFile),
      })).rejects.toThrow(/mismatch|does not match/i);
    }
  });
});

describe("secret-decryption readiness", () => {
  it("checks encrypted records without returning plaintext and rejects a mismatched key", () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update("must-not-appear", "utf8"), cipher.final()]);
    const material = {
      scheme: "local_encrypted_v1",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    expect(assertSecretDecryptionReadiness([material], key.toString("base64"))).toBe(1);
    expect(() => assertSecretDecryptionReadiness([material], randomBytes(32).toString("base64")))
      .toThrow(/does not match/);
  });
});

describe("restore capacity preflight", () => {
  it("fails closed below footprint plus margin before initialization", () => {
    const databaseDir = path.join(tempDir(), "not-created", "db");
    expect(() => assertRestoreCapacity({
      databaseDir,
      restoreFootprintBytes: 5_000,
      safetyMarginBytes: 2_000,
      availableBytes: 6_999,
    })).toThrow(/Target was not initialized/);
    expect(fs.existsSync(databaseDir)).toBe(false);
  });

  it("allows a validated filesystem with footprint plus margin", () => {
    const databaseDir = path.join(tempDir(), "not-created", "db");
    expect(assertRestoreCapacity({
      databaseDir,
      restoreFootprintBytes: 5_000,
      safetyMarginBytes: 2_000,
      availableBytes: 7_000,
    }).requiredBytes).toBe(7_000);
    expect(fs.existsSync(databaseDir)).toBe(false);
  });
});
