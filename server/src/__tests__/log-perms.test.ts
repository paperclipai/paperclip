import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLogPathPermissions } from "../middleware/logger.js";

describe("ensureLogPathPermissions", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-log-perms-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("creates the log directory at mode 0700", () => {
    const dir = path.join(tempRoot, "logs");
    const file = path.join(dir, "server.log");

    ensureLogPathPermissions(dir, file);

    const dirStat = fs.statSync(dir);
    expect(dirStat.isDirectory()).toBe(true);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("pre-creates a new log file at mode 0600", () => {
    const dir = path.join(tempRoot, "logs");
    const file = path.join(dir, "server.log");

    ensureLogPathPermissions(dir, file);

    const fileStat = fs.statSync(file);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("tightens an existing 0644 log file to 0600", () => {
    const dir = path.join(tempRoot, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "server.log");
    fs.writeFileSync(file, "pre-existing content\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);

    ensureLogPathPermissions(dir, file);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("pre-existing content\n");
  });

  it("tightens the directory from 0755 to 0700 on second call", () => {
    const dir = path.join(tempRoot, "logs");
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const file = path.join(dir, "server.log");

    ensureLogPathPermissions(dir, file);

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

});
