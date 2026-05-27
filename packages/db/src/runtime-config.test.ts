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
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.example.com:5432/valadrien_os";

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://env-user:env-pass@db.example.com:5432/valadrien_os",
      source: "DATABASE_URL",
    });
  });

  it("uses DATABASE_URL from repo-local .valadrien-os/.env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "valadrien-os-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    delete process.env.VALADRIEN_OS_CONFIG;
    writeJson(path.join(projectDir, ".valadrien-os", "config.json"), {
      database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
    });
    writeText(
      path.join(projectDir, ".valadrien-os", ".env"),
      'DATABASE_URL="postgres://file-user:file-pass@db.example.com:6543/valadrien_os"\n',
    );

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://file-user:file-pass@db.example.com:6543/valadrien_os",
      source: "valadrien-os-env",
    });
  });

  it("uses config postgres connection string when configured", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "valadrien-os-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.VALADRIEN_OS_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "postgres",
        connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/valadrien_os",
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/valadrien_os",
      source: "config.database.connectionString",
    });
  });

  it("falls back to embedded postgres settings from config", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "valadrien-os-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.VALADRIEN_OS_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "embedded-postgres",
        embeddedPostgresDataDir: "~/valadrien-os-test-db",
        embeddedPostgresPort: 55444,
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.resolve(os.homedir(), "valadrien-os-test-db"),
      port: 55444,
      source: "embedded-postgres@55444",
    });
  });

  it("uses the instance root for a fresh default embedded postgres target", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "valadrien-os-db-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "valadrien-os-db-cwd-"));
    process.chdir(cwd);
    process.env.VALADRIEN_OS_HOME = home;
    delete process.env.VALADRIEN_OS_CONFIG;
    delete process.env.VALADRIEN_OS_INSTANCE_ID;
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
