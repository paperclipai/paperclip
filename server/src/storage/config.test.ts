import { afterEach, describe, expect, it, vi } from "vitest";
import { paperclipConfigSchema } from "@paperclipai/shared";
import { loadStorageConfig } from "./config.js";
import { resolveRunEvidenceStorage } from "../services/run-evidence-storage.js";
import {
  projectCloudRuntimeConfig,
  setCloudRuntimeConfigSnapshot,
} from "../services/cloud-runtime-config-snapshot.js";

afterEach(() => {
  setCloudRuntimeConfigSnapshot(null);
  vi.unstubAllEnvs();
});

const file = paperclipConfigSchema.parse({
  $meta: { version: 1, updatedAt: "2026-10-30T00:00:00Z", source: "configure" },
  database: { mode: "embedded-postgres" },
  logging: { mode: "file" },
  server: {},
  storage: {
    provider: "s3",
    s3: {
      bucket: "stack-file",
      region: "auto",
      endpoint: "https://objects.example.test",
      prefix: "existing-stack-root",
      forcePathStyle: true,
    },
  },
});
describe("shared instance storage configuration", () => {
  it("reuses the saved Cloud storage profile after its legacy config file is gone", () => {
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", "");
    vi.stubEnv("PAPERCLIP_CONFIG", "/nonexistent/legacy-config.json");
    for (const name of [
      "PROVIDER",
      "S3_BUCKET",
      "S3_REGION",
      "S3_ENDPOINT",
      "S3_PREFIX",
      "S3_FORCE_PATH_STYLE",
    ])
      vi.stubEnv(`PAPERCLIP_STORAGE_${name}`, undefined);
    setCloudRuntimeConfigSnapshot({
      version: 1,
      revision: 4,
      config: projectCloudRuntimeConfig(file),
    });
    expect(loadStorageConfig()).toMatchObject({
      storageProvider: "s3",
      storageS3Bucket: "stack-file",
      storageS3Prefix: "existing-stack-root",
    });
    expect(resolveRunEvidenceStorage()).toMatchObject({
      keyPrefix: "run-logs",
      tracePrefix: "provider-traces",
    });
  });
  it("keeps the existing config-file defaults and S3 connection fields", () => {
    expect(loadStorageConfig(file, {})).toMatchObject({
      storageProvider: "s3",
      storageS3Bucket: "stack-file",
      storageS3Region: "auto",
      storageS3Endpoint: "https://objects.example.test",
      storageS3Prefix: "existing-stack-root",
      storageS3ForcePathStyle: true,
    });
  });
  it("preserves environment precedence and an explicit false path-style setting", () => {
    expect(
      loadStorageConfig(file, {
        PAPERCLIP_STORAGE_PROVIDER: "s3",
        PAPERCLIP_STORAGE_S3_BUCKET: "stack-env",
        PAPERCLIP_STORAGE_S3_REGION: "us-east-1",
        PAPERCLIP_STORAGE_S3_ENDPOINT: "https://other.example.test",
        PAPERCLIP_STORAGE_S3_PREFIX: "",
        PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE: "false",
      }),
    ).toMatchObject({
      storageProvider: "s3",
      storageS3Bucket: "stack-env",
      storageS3Region: "us-east-1",
      storageS3Endpoint: "https://other.example.test",
      storageS3Prefix: "",
      storageS3ForcePathStyle: false,
    });
  });
  it("keeps an unconfigured instance local when only a legacy mirror is configured", () => {
    const config = loadStorageConfig(null, {
      RUN_LOG_S3_BUCKET: "legacy-mirror",
    });
    expect(config.storageProvider).toBe("local_disk");
    expect(resolveRunEvidenceStorage(config)).toBeUndefined();
  });
});
