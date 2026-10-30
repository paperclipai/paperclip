import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";
import { createLocalEncryptedCipher } from "../secrets/local-encrypted-provider.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { readConfigFile } from "../config-file.js";
import { readLegacyCloudRuntimeConfig } from "../services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../services/cloud-runtime-config-snapshot.js";
const managed = JSON.stringify({
  v: 1, mode: "cloud", catalogVersion: "2026.720.0", features: {}, plugins: { autoInstall: [] },
});

let configDir: string;

beforeEach(() => {
  setCloudRuntimeConfigSnapshot({ version: 1, revision: 0, config: null });
  configDir = mkdtempSync(path.join(tmpdir(), "paperclip-cloud-config-"));
  vi.stubEnv("PAPERCLIP_CONFIG", path.join(configDir, "config.json"));
  vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", managed);
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
  vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", "test-bucket");
  vi.stubEnv("PAPERCLIP_STORAGE_S3_REGION", undefined);
  vi.stubEnv("PAPERCLIP_STORAGE_S3_ENDPOINT", undefined);
  vi.stubEnv("DATABASE_URL", "postgresql://user:private@db.example.test/paperclip");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "12345678901234567890123456789012");
});
afterEach(() => {
  setCloudRuntimeConfigSnapshot(null);
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

function writeConfig(storage: Record<string, unknown>) {
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    $meta: { version: 1, updatedAt: "2026-10-30T00:00:00.000Z", source: "configure" },
    logging: { mode: "file" },
    server: {},
    storage,
    database: { mode: "postgres", connectionString: "postgres://db.example.test/paperclip" },
  }));
}

describe("managed cloud configuration boundary", () => {
  it("accepts configured S3, external PostgreSQL, and the existing master-key formats", () => {
    for (const key of ["12345678901234567890123456789012", Buffer.alloc(32, 7).toString("hex"), Buffer.alloc(32, 7).toString("base64")]) {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", key);
      expect(loadConfig()).toMatchObject({ storageProvider: "s3", storageS3Bucket: "test-bucket", storageS3Region: "us-east-1" });
    }
  });

  it.each([undefined, "", "local_disk", "typo"])("rejects storage provider %j without silent fallback", (value) => {
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", value);
    expect(() => loadConfig()).toThrow(/PAPERCLIP_STORAGE_PROVIDER=s3/);
  });

  it.each([undefined, "", "   "])("requires an explicit bucket (%j)", (value) => {
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", value);
    expect(() => loadConfig()).toThrow(/PAPERCLIP_STORAGE_S3_BUCKET/);
  });

  it.each(["", "  "])("rejects blank region %j", (value) => {
    vi.stubEnv("PAPERCLIP_STORAGE_S3_REGION", value);
    expect(() => loadConfig()).toThrow(/PAPERCLIP_STORAGE_S3_REGION/);
  });

  it.each(["", "ftp://store.test", "https://user:private@store.test"])("rejects invalid endpoint without exposing it", (value) => {
    vi.stubEnv("PAPERCLIP_STORAGE_S3_ENDPOINT", value);
    expect(() => loadConfig()).toThrow(/PAPERCLIP_STORAGE_S3_ENDPOINT/);
    try { loadConfig(); } catch (error) { expect(String(error)).not.toContain("private"); }
  });

  it.each([undefined, "", "sqlite://local/data", "postgresql://"])("requires an external database URL (%j)", (value) => {
    vi.stubEnv("DATABASE_URL", value);
    expect(() => loadConfig()).toThrow(/external PostgreSQL URL/);
  });

  it.each([undefined, "", " ", "short"])("rejects missing or invalid env key (%j), even with a configured key file", (value) => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", value);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", "/tmp/unused-master-key");
    expect(() => loadConfig()).toThrow(/stable PAPERCLIP_SECRETS_MASTER_KEY/);
  });

  it("requires the Cloud bootstrap key even when an external secret provider is selected", () => {
    vi.stubEnv("PAPERCLIP_SECRETS_PROVIDER", "aws_secrets_manager");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", undefined);
    expect(() => loadConfig()).toThrow(/stable PAPERCLIP_SECRETS_MASTER_KEY/);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "12345678901234567890123456789012");
    expect(loadConfig().secretsProvider).toBe("aws_secrets_manager");
  });

  it.each(["", "{bad", JSON.stringify({ v: 1, mode: "cloud" })])("rejects malformed managed config before startup (%j)", (value) => {
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", value);
    expect(() => loadConfig()).toThrow(/PAPERCLIP_MANAGED_CONFIG/);
  });

  it("accepts imported explicit file storage with an environment-owned database", async () => {
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", undefined);
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", undefined);
    writeConfig({ provider: "s3", s3: { bucket: "file-bucket", region: "eu-west-1" } });
    setCloudRuntimeConfigSnapshot({ version: 1, revision: 0, config: await readLegacyCloudRuntimeConfig() });
    expect(loadConfig()).toMatchObject({ storageProvider: "s3", storageS3Bucket: "file-bucket", storageS3Region: "eu-west-1" });
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "typo");
    expect(() => loadConfig()).toThrow(/PAPERCLIP_STORAGE_PROVIDER=s3/);
  });

  it.each([{ provider: "s3" }, { provider: "s3", s3: { region: "us-east-1" } }])("rejects a real config file with an omitted bucket before import (%j)", async storage => {
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", undefined);
    writeConfig(storage);
    // Self-hosted readers still expose their default and raw-file provenance.
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    expect(readConfigFile({ includeProvenance: true })).toMatchObject({ config: { storage: { s3: { bucket: "paperclip" } } }, explicitStorageS3Bucket: false });
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", managed);
    await expect(readLegacyCloudRuntimeConfig()).rejects.toThrow(/storage.s3.bucket/);
  });

  it.each(["", "   "])("rejects an explicitly blank bucket in a real file (%j)", async bucket => {
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", undefined);
    writeConfig({ provider: "s3", s3: { bucket } });
    await expect(readLegacyCloudRuntimeConfig()).rejects.toThrow(/storage.s3.bucket/);
  });

  it.each([undefined, "", "   "].flatMap(bucket => [undefined, "environment-bucket"].map(environmentBucket => ({ bucket, environmentBucket }))))("rejects a legacy local-disk file with no explicit bucket before an S3 environment overlay (%j)", async ({ bucket, environmentBucket }) => {
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", environmentBucket);
    writeConfig({ provider: "local_disk", s3: { bucket } });
    await expect(readLegacyCloudRuntimeConfig()).rejects.toThrow(/storage.s3.bucket/);
  });

  it("accepts an explicitly supplied default bucket name in a real file", async () => {
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", undefined);
    writeConfig({ provider: "s3", s3: { bucket: "paperclip" } });
    setCloudRuntimeConfigSnapshot({ version: 1, revision: 0, config: await readLegacyCloudRuntimeConfig() });
    expect(loadConfig().storageS3Bucket).toBe("paperclip");
  });

  it("accepts an environment bucket with an authoritative absent-file snapshot", () => {
    writeConfig({ provider: "s3" });
    expect(loadConfig().storageS3Bucket).toBe("test-bucket");
  });

  it("preserves ordinary self-hosted defaults, including key-file use", () => {
    for (const name of ["PAPERCLIP_MANAGED_CONFIG", "PAPERCLIP_STORAGE_PROVIDER", "PAPERCLIP_STORAGE_S3_BUCKET", "DATABASE_URL", "PAPERCLIP_SECRETS_MASTER_KEY"]) vi.stubEnv(name, undefined);
    expect(loadConfig()).toMatchObject({ storageProvider: "local_disk", storageS3Bucket: "paperclip", databaseUrl: undefined, databaseMode: "embedded-postgres" });
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "typo");
    expect(loadConfig().storageProvider).toBe("local_disk");
  });
});

// Real provider + AWS SDK over loopback. The remote S3 service and credentials
// are simulated; this does not establish deployment bucket permissions.
it("uses the validated config for normal S3 put/read/delete and stable env-key encryption", async () => {
  const objects = new Map<string, Buffer>();
  const operations: string[] = [];
  const server = createServer(async (req, res) => {
    const key = new URL(req.url!, "http://localhost").pathname;
    operations.push(`${req.method} ${key}`);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      res.end();
    } else if (req.method === "GET" && objects.has(key)) {
      const body = objects.get(key)!;
      res.writeHead(200, { "content-type": "text/plain", "content-length": body.length });
      res.end(body);
    } else if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret-key");
  vi.stubEnv("AWS_SESSION_TOKEN", undefined);
  vi.stubEnv("PAPERCLIP_STORAGE_S3_ENDPOINT", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv("PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE", "true");
  vi.stubEnv("PAPERCLIP_STORAGE_S3_PREFIX", "disposable-qualification");
  try {
    const config = loadConfig();
    const first = createStorageProviderFromConfig(config);
    await first.putObject({ objectKey: "company/object.txt", body: Buffer.from("retained"), contentType: "text/plain", contentLength: 8 });
    const replacement = createStorageProviderFromConfig(loadConfig());
    const result = await replacement.getObject({ objectKey: "company/object.txt" });
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("retained");
    await replacement.deleteObject({ objectKey: "company/object.txt" });
    expect(objects.size).toBe(0);
    expect(operations).toEqual(["PUT", "GET", "DELETE"].map(method => `${method} /test-bucket/disposable-qualification/company/object.txt`));
    const encrypted = createLocalEncryptedCipher("write").encrypt("saved credential");
    expect(createLocalEncryptedCipher("read").decrypt(encrypted)).toBe("saved credential");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
