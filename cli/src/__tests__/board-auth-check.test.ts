import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardAuthCheck } from "../checks/board-auth-check.js";
import { getStoredBoardCredential, setStoredBoardCredential } from "../client/board-auth.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };

function createTempAuthPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-board-auth-check-"));
  return path.join(dir, "auth.json");
}

function config(): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-05-05T00:00:00.000Z",
      source: "doctor",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip/db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/paperclip/backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip/logs",
    },
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      host: "0.0.0.0",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: "/tmp/paperclip/storage",
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: "/tmp/paperclip/secrets/master.key",
      },
    },
  };
}

describe("boardAuthCheck", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("fails repairably when the current instance rejects the cached board credential", async () => {
    const authPath = createTempAuthPath();
    process.env.PAPERCLIP_AUTH_STORE = authPath;
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "stale-token",
      storePath: authPath,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Board authentication required" }), { status: 403 }),
      ),
    );

    const result = await boardAuthCheck(config());
    expect(result).toMatchObject({
      name: "CLI board auth cache",
      status: "fail",
      canRepair: true,
    });

    await result.repair?.();
    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toBeNull();
  });
});
