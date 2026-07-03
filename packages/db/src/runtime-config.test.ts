import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDatabaseTarget } from "./runtime-config.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveDatabaseTarget", () => {
  it("uses DATABASE_URL from process env first", () => {
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.example.com:5432/paperclip";

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://env-user:env-pass@db.example.com:5432/paperclip",
      source: "DATABASE_URL",
    });
  });

  it("uses DATABASE_URL from repo-local .paperclip/.env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    delete process.env.PAPERCLIP_CONFIG;
    writeJson(path.join(projectDir, ".paperclip", "config.json"), {
      database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
    });
    writeText(
      path.join(projectDir, ".paperclip", ".env"),
      'DATABASE_URL="postgres://file-user:file-pass@db.example.com:6543/paperclip"\n',
    );

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://file-user:file-pass@db.example.com:6543/paperclip",
      source: "paperclip-env",
    });
  });

  it("uses config postgres connection string when configured", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "postgres",
        connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      source: "config.database.connectionString",
    });
  });

  it("falls back to embedded postgres settings from config", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "embedded-postgres",
        embeddedPostgresDataDir: "~/paperclip-test-db",
        embeddedPostgresPort: 55444,
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.resolve(os.homedir(), "paperclip-test-db"),
      port: 55444,
      source: "embedded-postgres@55444",
    });
  });

  it("migrates legacy pglite config values to embedded postgres", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.DATABASE_URL;
    writeJson(configPath, {
      database: {
        mode: "pglite",
        pgliteDataDir: "~/paperclip-legacy-db",
        pglitePort: 55123,
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.resolve(os.homedir(), "paperclip-legacy-db"),
      port: 55123,
      source: "embedded-postgres@55123",
    });
  });

  it("prefers explicit embedded postgres settings over legacy pglite values", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.DATABASE_URL;
    writeJson(configPath, {
      database: {
        mode: "pglite",
        pgliteDataDir: "~/paperclip-legacy-db",
        pglitePort: 55123,
        embeddedPostgresDataDir: "~/paperclip-new-db",
        embeddedPostgresPort: 55321,
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.resolve(os.homedir(), "paperclip-new-db"),
      port: 55321,
    });
  });

  it("throws a descriptive error when the config file is not valid JSON", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.DATABASE_URL;
    writeText(configPath, "{not-json");

    expect(() => resolveDatabaseTarget()).toThrow(`Failed to parse config at ${configPath}`);
  });

  it("parses export-prefixed and comment-trailing values from .paperclip/.env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.DATABASE_URL;
    writeJson(path.join(projectDir, ".paperclip", "config.json"), {
      database: { mode: "embedded-postgres" },
    });
    writeText(
      path.join(projectDir, ".paperclip", ".env"),
      [
        "# database connection",
        "export DATABASE_URL=postgres://exported:secret@db.example.com:5432/paperclip # primary",
        "",
      ].join("\n"),
    );

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://exported:secret@db.example.com:5432/paperclip",
      source: "paperclip-env",
    });
  });

  it("ignores comments and blank DATABASE_URL entries in .paperclip/.env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.DATABASE_URL;
    writeJson(path.join(projectDir, ".paperclip", "config.json"), {
      database: { mode: "embedded-postgres", embeddedPostgresPort: 55777 },
    });
    writeText(
      path.join(projectDir, ".paperclip", ".env"),
      ["# DATABASE_URL=postgres://commented@db.example.com/paperclip", "DATABASE_URL=", ""].join("\n"),
    );

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      port: 55777,
      source: "embedded-postgres@55777",
    });
  });

  it("uses the instance root for a fresh default embedded postgres target", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cwd-"));
    process.chdir(cwd);
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.DATABASE_URL;

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.join(home, "instances", "default", "db"),
      port: 54329,
      source: "embedded-postgres@54329",
      configPath: path.join(home, "instances", "default", "config.json"),
      envPath: path.join(home, "instances", "default", ".env"),
    });
  });
});
