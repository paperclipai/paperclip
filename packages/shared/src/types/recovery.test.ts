import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECOVERY_STATUS_FILE,
  evaluateRecoveryStatus,
  type RecoveryDrillRecord,
  type RecoveryManifestRecord,
} from "./recovery.js";

function createManifest(createdAt: string): RecoveryManifestRecord {
  return {
    manifestId: "manifest-1",
    createdAt,
    manifestObjectKey: "manifests/20260428-120000-manifest-1.json",
    sourceBackupFile: "/tmp/paperclip-20260428.sql.gz",
    sourceBackupCreatedAt: createdAt,
    storageProvider: "s3",
    assetCutoverComplete: true,
    assetSampleKeys: ["assets/sample-1"],
    backupArtifacts: [
      {
        tier: "hourly",
        objectKey: "db/hourly/paperclip-20260428.sql.gz",
        sizeBytes: 128,
        sha256: "backup-sha",
        uploadedAt: createdAt,
      },
    ],
    keySnapshot: {
      objectKey: "keys/fingerprint/20260428-120000.json",
      sizeBytes: 64,
      sha256: "key-sha",
      uploadedAt: createdAt,
      fingerprint: "fingerprint",
      encrypted: true,
    },
    configSnapshot: {
      objectKey: "manifests/config/20260428-120000-manifest-1.json",
      sizeBytes: 96,
      sha256: "config-sha",
      uploadedAt: createdAt,
    },
    warnings: [],
  };
}

function createDrill(input: {
  drillId: string;
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  failures?: string[];
}): RecoveryDrillRecord {
  return {
    drillId: input.drillId,
    manifestId: "manifest-1",
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: 60_000,
    verifiedChecks: input.status === "passed" ? ["database_restore", "asset_samples_present"] : ["database_restore"],
    failures: input.failures ?? [],
    evidenceObjectKey: "drills/20260428-120000-drill.json",
  };
}

describe("evaluateRecoveryStatus", () => {
  it("reports restore verified when manifest, cutover, and verified drill are healthy", () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const manifest = createManifest("2026-04-28T11:30:00.000Z");
    const verifiedDrill = createDrill({
      drillId: "drill-verified",
      status: "passed",
      startedAt: "2026-04-28T11:40:00.000Z",
      finishedAt: "2026-04-28T11:41:00.000Z",
    });

    const status = evaluateRecoveryStatus(
      {
        ...DEFAULT_RECOVERY_STATUS_FILE,
        backupIntervalMinutes: 60,
        storageProvider: "s3",
        vault: {
          bucket: "recovery-vault",
          region: "us-east-1",
          endpoint: null,
          prefix: "paperclip",
        },
        latestUploadedManifest: manifest,
        latestDrillAttempt: verifiedDrill,
        latestVerifiedRestore: verifiedDrill,
        assetCutover: {
          lastRunAt: "2026-04-28T11:20:00.000Z",
          switchedAt: "2026-04-28T11:25:00.000Z",
          migratedAssetCount: 12,
          migratedByteCount: 4096,
          remainingLocalAssetCount: 0,
          sampleObjectKeys: ["assets/sample-1"],
          lastError: null,
        },
      },
      now,
    );

    expect(status.state).toBe("RestoreVerified");
    expect(status.manifestFreshness).toBe("fresh");
    expect(status.degradedReasons).toEqual([]);
  });

  it("preserves the last verified restore when the newest drill fails", () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const manifest = createManifest("2026-04-28T11:30:00.000Z");
    const verifiedDrill = createDrill({
      drillId: "drill-verified",
      status: "passed",
      startedAt: "2026-04-28T10:00:00.000Z",
      finishedAt: "2026-04-28T10:01:00.000Z",
    });
    const failedDrill = createDrill({
      drillId: "drill-failed",
      status: "failed",
      startedAt: "2026-04-28T11:50:00.000Z",
      finishedAt: "2026-04-28T11:51:00.000Z",
      failures: ["Restored database does not contain any companies."],
    });

    const status = evaluateRecoveryStatus(
      {
        ...DEFAULT_RECOVERY_STATUS_FILE,
        backupIntervalMinutes: 60,
        storageProvider: "s3",
        vault: {
          bucket: "recovery-vault",
          region: "us-east-1",
          endpoint: null,
          prefix: "paperclip",
        },
        latestUploadedManifest: manifest,
        latestDrillAttempt: failedDrill,
        latestVerifiedRestore: verifiedDrill,
        assetCutover: {
          lastRunAt: "2026-04-28T11:20:00.000Z",
          switchedAt: "2026-04-28T11:25:00.000Z",
          migratedAssetCount: 12,
          migratedByteCount: 4096,
          remainingLocalAssetCount: 0,
          sampleObjectKeys: ["assets/sample-1"],
          lastError: null,
        },
      },
      now,
    );

    expect(status.state).toBe("RestoreDrillFailed");
    expect(status.latestVerifiedRestore?.drillId).toBe("drill-verified");
    expect(status.degradedReasons).toContain("Latest restore drill failed.");
  });
});
