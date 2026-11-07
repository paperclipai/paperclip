import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configure } from "../commands/configure.js";
import { readConfig } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";

vi.mock("../prompts/server.js", () => ({
  promptServer: vi.fn(async ({ currentServer }) => ({
    server: currentServer,
    auth: { baseUrlMode: "auto", disableSignUp: false },
  })),
}));

const ORIGINAL_EXIT_CODE = process.exitCode;

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
});

const oidc = {
  providerId: "idp",
  displayName: "Company sign-in",
  discoveryUrl: "https://idp.example.test/.well-known/openid-configuration",
  clientId: "paperclip",
};

function writeBaseConfig(configPath: string, auth: PaperclipConfig["auth"] = { baseUrlMode: "auto", disableSignUp: false }) {
  const base: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip-db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/paperclip-backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip-logs",
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth,
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/paperclip-storage" },
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
      localEncrypted: { keyFilePath: "/tmp/paperclip-secrets/master.key" },
    },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
}

describe("configure command", () => {
  it("sets a failing exit code for unknown sections", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-"));
    const configPath = path.join(root, "config.json");
    writeBaseConfig(configPath);

    try {
      await configure({ config: configPath, section: "invalid-section" });

      expect(process.exitCode).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sets a failing exit code when no config exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-missing-"));
    const configPath = path.join(root, "missing.json");

    try {
      await configure({ config: configPath, section: "server" });

      expect(process.exitCode).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("backs up invalid config bytes and refuses non-interactive replacement", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-invalid-"));
    const configPath = path.join(root, "config.json");
    const invalidBytes = Buffer.from('{"server": invalid}\n', "utf8");
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    fs.writeFileSync(configPath, invalidBytes);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    try {
      await configure({ config: configPath, section: "server" });

      expect(process.exitCode).toBe(1);
      expect(fs.readFileSync(configPath)).toEqual(invalidBytes);
      expect(fs.readFileSync(`${configPath}.invalid-1`)).toEqual(invalidBytes);
      expect(fs.existsSync(`${configPath}.backup`)).toBe(false);
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the OpenID Connect provider when server settings change", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-oidc-"));
    const configPath = path.join(root, "config.json");
    writeBaseConfig(configPath, { baseUrlMode: "auto", disableSignUp: false, oidc });

    try {
      await configure({ config: configPath, section: "server" });

      expect(readConfig(configPath)?.auth.oidc).toEqual(oidc);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
