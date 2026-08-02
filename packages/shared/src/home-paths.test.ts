import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PAPERCLIP_X10_SENTINEL_BASENAME,
  readPaperclipCompanyConfig,
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolvePaperclipCompanyConfigPath,
  resolvePaperclipCompanyRoot,
  resolvePaperclipCompanyWorkProductsDir,
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipInstanceRoot,
} from "./home-paths.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("home path resolution", () => {
  it("resolves config and runtime data directly under the instance root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-home-paths-"));
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const instanceRoot = path.join(home, "instances", "default");
    expect(resolvePaperclipInstanceRoot()).toBe(instanceRoot);
    expect(resolvePaperclipConfigPathForInstance()).toBe(path.join(instanceRoot, "config.json"));
    expect(resolveDefaultEmbeddedPostgresDir()).toBe(path.join(instanceRoot, "db"));
    expect(resolveDefaultBackupDir()).toBe(path.join(instanceRoot, "data", "backups"));
    expect(resolveDefaultLogsDir()).toBe(path.join(instanceRoot, "logs"));
    expect(resolveDefaultStorageDir()).toBe(path.join(instanceRoot, "data", "storage"));
    expect(resolveDefaultSecretsKeyFilePath()).toBe(path.join(instanceRoot, "secrets", "master.key"));
  });

  it("resolves company-scoped roots under the instance", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-home-paths-company-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "instance-a";

    const companyRoot = path.join(home, "instances", "instance-a", "companies", "company-1");
    expect(resolvePaperclipCompanyRoot("company-1")).toBe(companyRoot);
    expect(resolvePaperclipCompanyWorkProductsDir("company-1")).toBe(path.join(companyRoot, "work-products"));
  });

  it("uses a configured per-company work-products root when present", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-home-paths-config-"));
    const configuredRoot = path.join(home, "external-storage", "company-1-work-products");
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "instance-a";

    fs.mkdirSync(path.dirname(resolvePaperclipCompanyConfigPath("company-1")), { recursive: true });
    fs.writeFileSync(
      resolvePaperclipCompanyConfigPath("company-1"),
      `${JSON.stringify({ workProductsRoot: configuredRoot }, null, 2)}\n`,
      "utf8",
    );

    expect(readPaperclipCompanyConfig("company-1")).toEqual({ workProductsRoot: configuredRoot });
    expect(resolvePaperclipCompanyWorkProductsDir("company-1")).toBe(configuredRoot);
  });

  it("fails loudly when a configured X10-backed root is missing the sentinel", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-home-paths-x10-missing-"));
    const fakeX10Root = path.join(home, "Volumes", "X10 Pro");
    const configuredRoot = path.join(fakeX10Root, "render-archive", "company-1");
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "instance-a";
    process.env.PAPERCLIP_X10_VOLUME_ROOT = fakeX10Root;

    fs.mkdirSync(path.dirname(resolvePaperclipCompanyConfigPath("company-1")), { recursive: true });
    fs.mkdirSync(configuredRoot, { recursive: true });
    fs.writeFileSync(
      resolvePaperclipCompanyConfigPath("company-1"),
      `${JSON.stringify({ workProductsRoot: configuredRoot }, null, 2)}\n`,
      "utf8",
    );

    expect(() => resolvePaperclipCompanyWorkProductsDir("company-1")).toThrow(/sentinel/i);
  });

  it("accepts a configured X10-backed root when the sentinel is present", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-home-paths-x10-ok-"));
    const fakeX10Root = path.join(home, "Volumes", "X10 Pro");
    const configuredRoot = path.join(fakeX10Root, "render-archive", "company-1");
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "instance-a";
    process.env.PAPERCLIP_X10_VOLUME_ROOT = fakeX10Root;

    fs.mkdirSync(path.dirname(resolvePaperclipCompanyConfigPath("company-1")), { recursive: true });
    fs.mkdirSync(configuredRoot, { recursive: true });
    fs.writeFileSync(
      resolvePaperclipCompanyConfigPath("company-1"),
      `${JSON.stringify({ workProductsRoot: configuredRoot }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(fakeX10Root, PAPERCLIP_X10_SENTINEL_BASENAME), "{\"volume\":\"X10 Pro\"}\n", "utf8");

    expect(resolvePaperclipCompanyWorkProductsDir("company-1")).toBe(configuredRoot);
  });
});
