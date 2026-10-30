import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";
import { createLocalEncryptedCipher } from "../secrets/local-encrypted-provider.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { readConfigFile } from "../config-file.js";
import { paperclipConfigSchema } from "@paperclipai/shared";

vi.mock("../config-file.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config-file.js")>(),
  readConfigFile: vi.fn(() => null),
}));

const managed = JSON.stringify({
  v: 1, mode: "cloud", catalogVersion: "2026.720.0", features: {}, plugins: { autoInstall: [] },
});

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", managed);
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
  vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", "test-bucket");
  vi.stubEnv("PAPERCLIP_STORAGE_S3_REGION", undefined);
  vi.stubEnv("PAPERCLIP_STORAGE_S3_ENDPOINT", undefined);
  vi.stubEnv("DATABASE_URL", "postgresql://user:private@db.example.test/paperclip");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "12345678901234567890123456789012");
  vi.mocked(readConfigFile).mockReturnValue(null);
});
afterEach(() => vi.unstubAllEnvs());

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

  it.each(["", "{bad", JSON.stringify({ v: 1, mode: "cloud" })])("rejects malformed managed config before startup (%j)", (value) => {
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", value);
    expect(() => loadConfig()).toThrow(/PAPERCLIP_MANAGED_CONFIG/);
  });

  it("accepts explicit config-file storage and database values", () => {
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", undefined);
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", undefined);
    vi.stubEnv("DATABASE_URL", undefined);
    vi.mocked(readConfigFile).mockReturnValue(paperclipConfigSchema.parse({
      $meta: { version: 1, updatedAt: "2026-10-30T00:00:00.000Z", source: "configure" },
      logging: { mode: "file" },
      server: {},
      storage: { provider: "s3", s3: { bucket: "file-bucket", region: "eu-west-1" } },
      database: { mode: "postgres", connectionString: "postgres://db.example.test/paperclip" },
    }));
    expect(loadConfig()).toMatchObject({ storageProvider: "s3", storageS3Bucket: "file-bucket", storageS3Region: "eu-west-1" });
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "typo");
    expect(() => loadConfig()).toThrow(/PAPERCLIP_STORAGE_PROVIDER=s3/);
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
