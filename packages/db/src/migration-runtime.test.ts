import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMigrationConnection } from "./migration-runtime.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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

describe("resolveMigrationConnection", () => {
  it("passes through DATABASE_URL without starting embedded postgres", async () => {
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.example.com:5432/paperclip";

    const connection = await resolveMigrationConnection();

    expect(connection.connectionString).toBe(
      "postgres://env-user:env-pass@db.example.com:5432/paperclip",
    );
    expect(connection.source).toBe("DATABASE_URL");
    await expect(connection.stop()).resolves.toBeUndefined();
  });

  it("passes through a configured postgres connection string", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-migration-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.DATABASE_URL;
    writeJson(configPath, {
      database: {
        mode: "postgres",
        connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      },
    });

    const connection = await resolveMigrationConnection();

    expect(connection.connectionString).toBe(
      "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
    );
    expect(connection.source).toBe("config.database.connectionString");
    await expect(connection.stop()).resolves.toBeUndefined();
  });
});
