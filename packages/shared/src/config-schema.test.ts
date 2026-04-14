import { describe, expect, it } from "vitest";
import {
  configMetaSchema,
  databaseConfigSchema,
  serverConfigSchema,
  authConfigSchema,
  storageConfigSchema,
  llmConfigSchema,
  loggingConfigSchema,
  databaseBackupConfigSchema,
} from "./config-schema.js";

describe("configMetaSchema", () => {
  it("accepts valid meta", () => {
    const result = configMetaSchema.safeParse({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "onboard",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid version", () => {
    const result = configMetaSchema.safeParse({
      version: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "onboard",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid source", () => {
    const result = configMetaSchema.safeParse({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("databaseConfigSchema", () => {
  it("applies defaults for embedded-postgres mode", () => {
    const result = databaseConfigSchema.parse({ mode: "embedded-postgres" });
    expect(result.mode).toBe("embedded-postgres");
    expect(result.embeddedPostgresPort).toBe(54329);
    expect(result.backup.enabled).toBe(true);
  });

  it("accepts postgres mode with connection string", () => {
    const result = databaseConfigSchema.parse({
      mode: "postgres",
      connectionString: "postgresql://localhost:5432/test",
    });
    expect(result.mode).toBe("postgres");
    expect(result.connectionString).toBe("postgresql://localhost:5432/test");
  });
});

describe("databaseBackupConfigSchema", () => {
  it("applies defaults", () => {
    const result = databaseBackupConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.intervalMinutes).toBe(60);
    expect(result.retentionDays).toBe(30);
  });

  it("rejects interval below minimum", () => {
    const result = databaseBackupConfigSchema.safeParse({ intervalMinutes: 0 });
    expect(result.success).toBe(false);
  });
});

describe("serverConfigSchema", () => {
  it("applies defaults", () => {
    const result = serverConfigSchema.parse({});
    expect(result.deploymentMode).toBe("local_trusted");
    expect(result.exposure).toBe("private");
    expect(result.host).toBe("127.0.0.1");
    expect(result.port).toBe(3100);
    expect(result.serveUi).toBe(true);
  });

  it("accepts custom port", () => {
    const result = serverConfigSchema.parse({ port: 8080 });
    expect(result.port).toBe(8080);
  });

  it("rejects invalid port", () => {
    expect(serverConfigSchema.safeParse({ port: 0 }).success).toBe(false);
    expect(serverConfigSchema.safeParse({ port: 70000 }).success).toBe(false);
  });
});

describe("authConfigSchema", () => {
  it("applies defaults", () => {
    const result = authConfigSchema.parse({});
    expect(result.baseUrlMode).toBe("auto");
    expect(result.disableSignUp).toBe(false);
  });

  it("accepts explicit mode with public URL", () => {
    const result = authConfigSchema.parse({
      baseUrlMode: "explicit",
      publicBaseUrl: "https://paperclip.example.com",
    });
    expect(result.baseUrlMode).toBe("explicit");
  });
});

describe("storageConfigSchema", () => {
  it("defaults to local_disk", () => {
    const result = storageConfigSchema.parse({});
    expect(result.provider).toBe("local_disk");
  });

  it("accepts s3 configuration", () => {
    const result = storageConfigSchema.parse({
      provider: "s3",
      s3: { bucket: "my-bucket", region: "eu-west-1" },
    });
    expect(result.provider).toBe("s3");
    expect(result.s3.bucket).toBe("my-bucket");
  });
});

describe("llmConfigSchema", () => {
  it("accepts claude provider", () => {
    const result = llmConfigSchema.parse({ provider: "claude" });
    expect(result.provider).toBe("claude");
  });

  it("accepts openai provider with API key", () => {
    const result = llmConfigSchema.parse({ provider: "openai", apiKey: "sk-test" });
    expect(result.provider).toBe("openai");
    expect(result.apiKey).toBe("sk-test");
  });

  it("rejects unknown provider", () => {
    expect(llmConfigSchema.safeParse({ provider: "gemini" }).success).toBe(false);
  });
});

describe("loggingConfigSchema", () => {
  it("accepts file mode with defaults", () => {
    const result = loggingConfigSchema.parse({ mode: "file" });
    expect(result.mode).toBe("file");
    expect(result.logDir).toContain("logs");
  });
});
