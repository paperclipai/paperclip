import { describe, it, expect } from "vitest";
import { parseRepo, resolveConfig, ConfigError } from "../src/config.js";

describe("parseRepo", () => {
  it("splits owner/name", () => {
    expect(parseRepo("djcowork-ai/djcowork2.0")).toEqual({
      owner: "djcowork-ai",
      name: "djcowork2.0",
    });
  });

  it("rejects missing slash", () => {
    expect(() => parseRepo("no-slash")).toThrow(ConfigError);
  });

  it("rejects extra path segments", () => {
    expect(() => parseRepo("owner/repo/extra")).toThrow(ConfigError);
  });

  it("rejects unsafe path characters", () => {
    expect(() => parseRepo("owner/repo?x=1")).toThrow(ConfigError);
  });

  it("rejects empty name", () => {
    expect(() => parseRepo("owner/")).toThrow(ConfigError);
  });

  it("rejects empty owner", () => {
    expect(() => parseRepo("/repo")).toThrow(ConfigError);
  });
});

describe("resolveConfig", () => {
  const secrets = new Map([
    ["APP_ID_REF", "123456"],
    ["KEY_REF", "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"],
    ["INSTALL_REF", "987654"],
  ]);
  const resolver = async (ref: string) => {
    const v = secrets.get(ref);
    if (!v) throw new Error(`missing secret ${ref}`);
    return v;
  };

  it("resolves all three secret refs", async () => {
    const cfg = await resolveConfig(
      { appId: "APP_ID_REF", privateKeyPem: "KEY_REF", installationId: "INSTALL_REF", repo: "x/y" },
      resolver,
    );
    expect(cfg.appId).toBe(123456);
    expect(cfg.installationId).toBe(987654);
    expect(cfg.privateKeyPem).toContain("BEGIN RSA");
    expect(cfg.repo).toBe("x/y");
    expect(cfg.defaultBranch).toBe("main");
    expect(cfg.mergeQueueEnabled).toBe(true);
  });

  it("respects overrides", async () => {
    const cfg = await resolveConfig(
      {
        appId: "APP_ID_REF",
        privateKeyPem: "KEY_REF",
        installationId: "INSTALL_REF",
        repo: "x/y",
        defaultBranch: "trunk",
        mergeQueueEnabled: false,
      },
      resolver,
    );
    expect(cfg.defaultBranch).toBe("trunk");
    expect(cfg.mergeQueueEnabled).toBe(false);
  });

  it("rejects missing required fields", async () => {
    await expect(resolveConfig({ repo: "x/y" }, resolver)).rejects.toThrow(ConfigError);
    await expect(
      resolveConfig({ appId: "APP_ID_REF", privateKeyPem: "KEY_REF", installationId: "INSTALL_REF" }, resolver),
    ).rejects.toThrow(ConfigError);
  });

  it("rejects when appId secret resolves to non-positive number", async () => {
    const bad = new Map(secrets);
    bad.set("APP_ID_REF", "not-a-number");
    const badResolver = async (ref: string) => bad.get(ref) ?? "";
    await expect(
      resolveConfig(
        { appId: "APP_ID_REF", privateKeyPem: "KEY_REF", installationId: "INSTALL_REF", repo: "x/y" },
        badResolver,
      ),
    ).rejects.toThrow(ConfigError);
  });
});
