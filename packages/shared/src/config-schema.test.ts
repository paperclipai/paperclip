import { describe, expect, it } from "vitest";
import { paperclipConfigSchema } from "./config-schema.js";

function baseConfig() {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-03-15T00:00:00.000Z",
      source: "doctor" as const,
    },
    database: {
      mode: "embedded-postgres" as const,
      embeddedPostgresDataDir: "~/.paperclip/instances/default/db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "~/.paperclip/instances/default/data/backups",
      },
    },
    logging: {
      mode: "file" as const,
      logDir: "~/.paperclip/instances/default/logs",
    },
    server: {
      deploymentMode: "local_trusted" as const,
      exposure: "private" as const,
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto" as const,
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk" as const,
      localDisk: {
        baseDir: "~/.paperclip/instances/default/data/storage",
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted" as const,
      strictMode: false,
      localEncrypted: {
        keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
      },
    },
  };
}

describe("paperclipConfigSchema", () => {
  it("rejects local_trusted deployments that expose a public host", () => {
    const result = paperclipConfigSchema.safeParse({
      ...baseConfig(),
      server: {
        ...baseConfig().server,
        exposure: "public",
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("server.exposure must be private");
  });

  it("requires an explicit public base URL for authenticated public deployments", () => {
    const result = paperclipConfigSchema.safeParse({
      ...baseConfig(),
      server: {
        ...baseConfig().server,
        deploymentMode: "authenticated",
        exposure: "public",
      },
      auth: {
        baseUrlMode: "auto",
        disableSignUp: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "auth.baseUrlMode must be explicit when deploymentMode=authenticated and exposure=public",
        "auth.publicBaseUrl is required when deploymentMode=authenticated and exposure=public",
      ]),
    );
  });

  it("accepts authenticated public deployments once the URL contract is explicit", () => {
    const result = paperclipConfigSchema.safeParse({
      ...baseConfig(),
      server: {
        ...baseConfig().server,
        deploymentMode: "authenticated",
        exposure: "public",
      },
      auth: {
        baseUrlMode: "explicit",
        publicBaseUrl: "https://paperclip.example.com",
        disableSignUp: false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.auth.publicBaseUrl).toBe("https://paperclip.example.com");
  });
});
