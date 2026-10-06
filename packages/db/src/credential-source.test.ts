import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDatabaseConnectionString } from "./credential-source.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function credentialFile(mode = 0o600) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-source-"));
  roots.push(root);
  const file = path.join(root, "database-url");
  fs.writeFileSync(file, "postgres://synthetic:synthetic@127.0.0.1/synthetic\n", { mode });
  return file;
}

describe("file-backed database credential", () => {
  it("loads a private file without setting DATABASE_URL in the process environment", () => {
    const env = { PAPERCLIP_DATABASE_URL_FILE: credentialFile() };
    const url = resolveDatabaseConnectionString({ env });
    expect(url).toMatch(/^postgres:\/\/synthetic:/);
    expect(env).not.toHaveProperty("DATABASE_URL");
  });

  it("rejects mixed sources, world-readable files, symlinks and invalid URLs", () => {
    const file = credentialFile();
    expect(() => resolveDatabaseConnectionString({
      env: { PAPERCLIP_DATABASE_URL_FILE: file, DATABASE_URL: "postgres://other:other@localhost/db" },
    })).toThrow("cannot be combined");
    expect(() => resolveDatabaseConnectionString({
      env: { PAPERCLIP_DATABASE_URL_FILE: file },
      configConnectionString: "postgres://other:other@localhost/db",
    })).toThrow("cannot be combined");
    fs.chmodSync(file, 0o644);
    expect(() => resolveDatabaseConnectionString({ env: { PAPERCLIP_DATABASE_URL_FILE: file } })).toThrow("private regular file");
    fs.chmodSync(file, 0o600);
    const link = `${file}-link`;
    fs.symlinkSync(file, link);
    expect(() => resolveDatabaseConnectionString({ env: { PAPERCLIP_DATABASE_URL_FILE: link } })).toThrow("private regular file");
    fs.writeFileSync(file, "not-a-url\n");
    expect(() => resolveDatabaseConnectionString({ env: { PAPERCLIP_DATABASE_URL_FILE: file } })).toThrow("PostgreSQL URL");
    expect(() => resolveDatabaseConnectionString({ env: { PAPERCLIP_DATABASE_URL_FILE: "relative-url" } })).toThrow("absolute path");
  });
});
