import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLocalOperatorKey, verifyLocalOperatorSignInLink } from "@paperclipai/shared/local-operator-credential";
import {
  buildLocalBoardSignInUrl,
  instanceIdForConfigPath,
  localBoardEntryUrl,
  resolveLocalBoardTarget,
  resolveOpenApiBase,
} from "../commands/open.js";
import { writeRuntimeInfo } from "../runtime-info.js";

let home: string;
const saved = {
  home: process.env.PAPERCLIP_HOME,
  instance: process.env.PAPERCLIP_INSTANCE_ID,
  config: process.env.PAPERCLIP_CONFIG,
  mode: process.env.PAPERCLIP_DEPLOYMENT_MODE,
};

function writeInstanceConfig(instanceId: string, deploymentMode: "local_trusted" | "authenticated"): string {
  const configPath = path.join(home, "instances", instanceId, "config.json");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    $meta: { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", source: "configure" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip-db",
      embeddedPostgresPort: 54329,
      backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: "/tmp/paperclip-backups" },
    },
    logging: { mode: "file", logDir: "/tmp/paperclip-logs" },
    server: { deploymentMode, exposure: "private", host: "127.0.0.1", port: 3100, allowedHostnames: [], serveUi: true },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: true },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/paperclip-storage" },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: "/tmp/paperclip-secrets/master.key" } },
  }));
  return configPath;
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "paperclip-open-"));
  process.env.PAPERCLIP_HOME = home;
  delete process.env.PAPERCLIP_INSTANCE_ID;
  delete process.env.PAPERCLIP_CONFIG;
  delete process.env.PAPERCLIP_DEPLOYMENT_MODE;
});

afterEach(() => {
  for (const [key, value] of [
    ["PAPERCLIP_HOME", saved.home],
    ["PAPERCLIP_INSTANCE_ID", saved.instance],
    ["PAPERCLIP_CONFIG", saved.config],
    ["PAPERCLIP_DEPLOYMENT_MODE", saved.mode],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("paperclipai open", () => {
  it("builds a sign-in link the local server accepts", () => {
    const keyPath = path.join(home, "local-operator.key");
    const url = new URL(buildLocalBoardSignInUrl("http://localhost:3100", keyPath));
    expect(url.origin).toBe("http://localhost:3100");
    expect(url.pathname).toBe("/api/local-operator/sign-in");
    const link = { nonce: url.searchParams.get("n"), expiresAt: url.searchParams.get("e"), signature: url.searchParams.get("s") };
    expect(verifyLocalOperatorSignInLink(readLocalOperatorKey(keyPath)!, link)).toBe(true);
  });

  it("refuses to sign in to a Paperclip that is not on this computer", () => {
    const keyPath = path.join(home, "unused.key");
    expect(() => buildLocalBoardSignInUrl("https://paperclip.example.com", keyPath)).toThrow(/not local/);
    expect(() => buildLocalBoardSignInUrl("http://127.attacker.example:3100", keyPath)).toThrow(/not local/);
    expect(() => buildLocalBoardSignInUrl("http://localhost.attacker.example:3100", keyPath)).toThrow(/not local/);
  });

  it("uses the instance that a config file belongs to", () => {
    expect(instanceIdForConfigPath("/home/me/.paperclip/instances/foo/config.json", "/home/me/.paperclip")).toBe("foo");
    expect(instanceIdForConfigPath("/elsewhere/config.json", "/home/me/.paperclip")).toBeNull();
  });

  it("signs a named instance in with that instance's own key and mode", () => {
    writeInstanceConfig("default", "authenticated");
    const fooConfig = writeInstanceConfig("foo", "local_trusted");
    for (const target of [resolveLocalBoardTarget({ instance: "foo" }), resolveLocalBoardTarget({ config: fooConfig })]) {
      expect(target).toMatchObject({
        instanceId: "foo",
        configPath: fooConfig,
        keyPath: path.join(home, "instances", "foo", "secrets", "local-operator.key"),
        deploymentMode: "local_trusted",
      });
      expect(new URL(localBoardEntryUrl("http://127.0.0.1:3100", target)).pathname).toBe("/api/local-operator/sign-in");
    }
    const defaultTarget = resolveLocalBoardTarget({ instance: "default" });
    expect(defaultTarget.deploymentMode).toBe("authenticated");
    expect(localBoardEntryUrl("http://127.0.0.1:3100", defaultTarget)).toBe("http://127.0.0.1:3100");
  });

  it("resolves the same instance as \`paperclipai run\` for the same config file", async () => {
    const { resolveRunInstanceId } = await import("../commands/run.js");
    const fooConfig = writeInstanceConfig("foo", "local_trusted");
    expect(resolveRunInstanceId({ config: fooConfig })).toBe("foo");
    expect(resolveRunInstanceId({ config: fooConfig })).toBe(resolveLocalBoardTarget({ config: fooConfig }).instanceId);
    expect(resolveRunInstanceId({ config: fooConfig, instance: "bar" })).toBe("bar");
    expect(resolveRunInstanceId({ config: "/elsewhere/config.json" })).toBe("default");
  });

  it("follows the server's deployment mode override from the environment", () => {
    writeInstanceConfig("default", "local_trusted");
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    expect(resolveLocalBoardTarget({ instance: "default" }).deploymentMode).toBe("authenticated");
  });

  it("reports a config file it cannot read instead of guessing the mode", () => {
    const configPath = path.join(home, "instances", "broken", "config.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{ not json");
    expect(() => resolveLocalBoardTarget({ config: configPath })).toThrow();
  });

  it("prefers the running server's address to the configured port", () => {
    writeRuntimeInfo({
      schemaVersion: 1, instanceId: "foo", pid: process.pid, host: "127.0.0.1", port: 3191,
      dashboardUrl: "http://127.0.0.1:3191", startedAt: new Date().toISOString(),
    });
    const target = { instanceId: "foo", configPath: path.join(home, "instances", "foo", "config.json") };
    expect(resolveOpenApiBase({}, target)).toBe("http://127.0.0.1:3191");
    expect(resolveOpenApiBase({ apiBase: "http://localhost:4000/" }, target)).toBe("http://localhost:4000");
  });
});
