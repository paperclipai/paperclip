import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configure } from "../commands/configure.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_EXIT_CODE = process.exitCode;

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
  vi.restoreAllMocks();
});

function writeBaseConfig(configPath: string) {
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
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
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

  describe("--list-options", () => {
    it("lists all configuration options when no section is specified", async () => {
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      await configure({ listOptions: true });

      expect(process.exitCode).toBeFalsy();
      const output = logs.join("\n");
      expect(output).toContain("Section: database");
      expect(output).toContain("Section: server");
      expect(output).toContain("database.mode: 'embedded-postgres' | 'postgres'");
    });

    it("lists options for a specific section", async () => {
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      await configure({ listOptions: true, section: "database" });

      expect(process.exitCode).toBeFalsy();
      const output = logs.join("\n");
      expect(output).toContain("Section: database");
      expect(output).toContain("database.mode: 'embedded-postgres' | 'postgres'");
      expect(output).not.toContain("Section: server");
    });

    it("outputs options in JSON format when requested", async () => {
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      await configure({ listOptions: true, section: "database", json: true });

      expect(process.exitCode).toBeFalsy();
      const parsed = JSON.parse(logs.join("\n"));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.some((opt: { key: string }) => opt.key === "database.mode")).toBe(true);
    });

    it("fails with exit code 1 for unknown section", async () => {
      await configure({ listOptions: true, section: "unknown-section" });

      expect(process.exitCode).toBe(1);
    });

    it("does not require a config file to exist", async () => {
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      await configure({ config: "/non/existent/config.json", listOptions: true });

      expect(process.exitCode).toBeFalsy();
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  describe("--validate", () => {
    it("validates a valid configuration file", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-valid-"));
      const configPath = path.join(root, "config.json");
      writeBaseConfig(configPath);

      try {
        await configure({ config: configPath, validate: true });
        expect(process.exitCode).toBe(0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails when configuration file is invalid", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-invalid-val-"));
      const configPath = path.join(root, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ database: { mode: "invalid-mode" } }, null, 2));

      try {
        await configure({ config: configPath, validate: true });
        expect(process.exitCode).toBe(1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("outputs validation result in JSON format", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-json-val-"));
      const configPath = path.join(root, "config.json");
      writeBaseConfig(configPath);

      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(String(msg));
      });

      try {
        await configure({ config: configPath, validate: true, json: true });
        expect(process.exitCode).toBe(0);
        const result = JSON.parse(logs.join("\n"));
        expect(result.valid).toBe(true);
        expect(result.filePath).toBe(path.resolve(configPath));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails when config file is missing", async () => {
      await configure({ config: "/non/existent/config.json", validate: true });
      expect(process.exitCode).toBe(1);
    });
  });
});
