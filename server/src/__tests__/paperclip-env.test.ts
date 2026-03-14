import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPaperclipEnv } from "../adapters/utils.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

function writeText(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

async function importConfigModule() {
  vi.resetModules();
  return await import("../config.js");
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
  vi.resetModules();
});

describe("buildPaperclipEnv", () => {
  it("prefers an explicit PAPERCLIP_API_URL", () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:4100";
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:4100");
  });

  it("uses runtime listen host/port when explicit URL is not set", () => {
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";
    process.env.PORT = "3100";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3101");
  });

  it("formats IPv6 hosts safely in fallback URL generation", () => {
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "::1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://[::1]:3101");
  });
});

describe("loadConfig env file loading", () => {
  it.each([
    {
      name: "repo root .env",
      cwdParts: [] as string[],
      envRelativePath: ".env",
      databaseUrl: "postgres://repo-user:repo-pass@db.example.com:5432/paperclip",
    },
    {
      name: "packages/db/.env when repo root .env is absent",
      cwdParts: ["packages", "db"],
      envRelativePath: path.join("packages", "db", ".env"),
      databaseUrl: "postgres://pkg-user:pkg-pass@db.example.com:6543/paperclip",
    },
  ])("loads DATABASE_URL from $name", async ({ cwdParts, envRelativePath, databaseUrl }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-server-config-"));
    const cwd = path.join(tempDir, ...cwdParts);
    fs.mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);
    process.env.PAPERCLIP_HOME = path.join(tempDir, "paperclip-home");
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.DATABASE_URL;
    writeText(path.join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeText(path.join(tempDir, envRelativePath), `DATABASE_URL=${databaseUrl}\n`);

    const { loadConfig } = await importConfigModule();

    expect(loadConfig().databaseUrl).toBe(databaseUrl);
  });
});
