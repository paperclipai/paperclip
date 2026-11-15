import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DETECTED_TAILNET_ADDRESS = "100.64.0.7";

const tailscale = vi.hoisted(() => ({ installed: true, execFileSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  tailscale.execFileSync.mockImplementation((command: string, ...rest: unknown[]) => {
    if (command !== "tailscale") {
      return (actual.execFileSync as (...args: unknown[]) => unknown)(command, ...rest);
    }
    if (!tailscale.installed) throw new Error("spawnSync tailscale ENOENT");
    return `${DETECTED_TAILNET_ADDRESS}\n`;
  });
  return { ...actual, execFileSync: tailscale.execFileSync };
});

let home: string;
let configPath: string;

function tailscaleExecCount(): number {
  return tailscale.execFileSync.mock.calls.filter(([command]) => command === "tailscale").length;
}

function writeServerConfig(server: Record<string, unknown>) {
  fs.writeFileSync(configPath, JSON.stringify({
    $meta: { version: 1, updatedAt: "2026-11-11T00:00:00.000Z", source: "configure" },
    database: { mode: "embedded-postgres" },
    logging: { mode: "file" },
    server: { deploymentMode: "authenticated", exposure: "private", ...server },
  }));
}

async function importFreshConfigModules() {
  vi.resetModules();
  const [{ loadConfig }, { getStorageService }] = await Promise.all([
    import("../config.js"),
    import("../storage/index.js"),
  ]);
  return { loadConfig, getStorageService };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-config-tailnet-"));
  configPath = path.join(home, "config.json");
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_CONFIG", configPath);
  for (const name of [
    "PAPERCLIP_BIND", "PAPERCLIP_BIND_HOST", "PAPERCLIP_TAILNET_BIND_HOST", "HOST", "PAPERCLIP_DEPLOYMENT_MODE",
    "PAPERCLIP_DEPLOYMENT_EXPOSURE", "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "PAPERCLIP_MANAGED_CONFIG",
    "PAPERCLIP_STORAGE_PROVIDER",
  ]) vi.stubEnv(name, undefined);
  tailscale.installed = true;
  tailscale.execFileSync.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("tailnet bind host detection in loadConfig", () => {
  it.each([
    { server: { bind: "loopback" }, host: "127.0.0.1" },
    { server: { bind: "lan" }, host: "0.0.0.0" },
    { server: { bind: "custom", customBindHost: "10.0.0.5" }, host: "10.0.0.5" },
    { server: { host: "127.0.0.1" }, host: "127.0.0.1" },
    { server: { host: "0.0.0.0" }, host: "0.0.0.0" },
  ])("does not start tailscale when the bind needs no tailnet address: $server", async ({ server, host }) => {
    writeServerConfig(server);
    const { loadConfig } = await importFreshConfigModules();

    for (let call = 0; call < 3; call += 1) expect(loadConfig().host).toBe(host);

    expect(tailscaleExecCount()).toBe(0);
  });

  it("does not start tailscale when getStorageService() runs again and again", async () => {
    writeServerConfig({ bind: "lan" });
    const { getStorageService } = await importFreshConfigModules();

    const first = getStorageService();
    for (let call = 0; call < 5; call += 1) expect(getStorageService()).toBe(first);

    expect(tailscaleExecCount()).toBe(0);
  });

  it("detects the tailnet address one time for server.bind=tailnet", async () => {
    writeServerConfig({ bind: "tailnet" });
    const { loadConfig } = await importFreshConfigModules();

    for (let call = 0; call < 3; call += 1) {
      expect(loadConfig()).toMatchObject({ bind: "tailnet", host: DETECTED_TAILNET_ADDRESS });
    }

    expect(tailscaleExecCount()).toBe(1);
  });

  it("detects one time when it infers the bind mode from a host without a bind mode", async () => {
    const { loadConfig } = await importFreshConfigModules();

    writeServerConfig({ host: DETECTED_TAILNET_ADDRESS });
    expect(loadConfig()).toMatchObject({ bind: "tailnet", host: DETECTED_TAILNET_ADDRESS });
    writeServerConfig({ host: "10.0.0.5" });
    expect(loadConfig()).toMatchObject({ bind: "custom", host: "10.0.0.5" });
    expect(loadConfig()).toMatchObject({ bind: "custom", host: "10.0.0.5" });

    expect(tailscaleExecCount()).toBe(1);
  });

  it("uses PAPERCLIP_TAILNET_BIND_HOST without tailscale and sees each change to it", async () => {
    writeServerConfig({ bind: "tailnet" });
    const { loadConfig } = await importFreshConfigModules();

    vi.stubEnv("PAPERCLIP_TAILNET_BIND_HOST", "100.64.0.9");
    expect(loadConfig().host).toBe("100.64.0.9");
    vi.stubEnv("PAPERCLIP_TAILNET_BIND_HOST", "100.64.0.10");
    expect(loadConfig().host).toBe("100.64.0.10");
    expect(tailscaleExecCount()).toBe(0);

    vi.stubEnv("PAPERCLIP_TAILNET_BIND_HOST", undefined);
    expect(loadConfig().host).toBe(DETECTED_TAILNET_ADDRESS);
    expect(loadConfig().host).toBe(DETECTED_TAILNET_ADDRESS);
    expect(tailscaleExecCount()).toBe(1);
  });

  it("sees a later change of the bind mode in the environment and in the config file", async () => {
    writeServerConfig({ bind: "lan" });
    const { loadConfig } = await importFreshConfigModules();
    expect(loadConfig()).toMatchObject({ bind: "lan", host: "0.0.0.0" });
    expect(tailscaleExecCount()).toBe(0);

    vi.stubEnv("PAPERCLIP_BIND", "tailnet");
    expect(loadConfig()).toMatchObject({ bind: "tailnet", host: DETECTED_TAILNET_ADDRESS });

    vi.stubEnv("PAPERCLIP_BIND", undefined);
    expect(loadConfig()).toMatchObject({ bind: "lan", host: "0.0.0.0" });
    writeServerConfig({ bind: "tailnet" });
    expect(loadConfig()).toMatchObject({ bind: "tailnet", host: DETECTED_TAILNET_ADDRESS });

    expect(tailscaleExecCount()).toBe(1);
  });

  it("refuses server.bind=tailnet when no tailnet address exists, and does not try tailscale again", async () => {
    tailscale.installed = false;
    writeServerConfig({ bind: "tailnet" });
    const { loadConfig } = await importFreshConfigModules();

    for (let call = 0; call < 3; call += 1) {
      expect(() => loadConfig()).toThrow(
        "server.bind=tailnet requires a detected Tailscale address or PAPERCLIP_TAILNET_BIND_HOST",
      );
    }
    expect(tailscaleExecCount()).toBe(1);

    vi.stubEnv("PAPERCLIP_TAILNET_BIND_HOST", "100.64.0.9");
    expect(loadConfig()).toMatchObject({ bind: "tailnet", host: "100.64.0.9" });
  });
});
