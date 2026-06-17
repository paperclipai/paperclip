import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatUptime, probeEmbeddedPg, readDevConfig } from "../dev-status-utils.ts";
import * as supervisor from "../services/local-service-supervisor.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
  vi.restoreAllMocks();
});

function makeTempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

describe("formatUptime", () => {
  it("formats seconds", () => {
    const since = new Date(Date.now() - 45_000).toISOString();
    expect(formatUptime(since)).toBe("45s");
  });

  it("formats minutes", () => {
    const since = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(formatUptime(since)).toBe("3m");
  });

  it("formats hours and minutes", () => {
    const since = new Date(Date.now() - (2 * 3600 + 15 * 60) * 1000).toISOString();
    expect(formatUptime(since)).toBe("2h 15m");
  });

  it("formats days and hours", () => {
    const since = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    expect(formatUptime(since)).toBe("1d 2h");
  });

  it("clamps negative durations to zero", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(formatUptime(future)).toBe("0s");
  });
});

describe("readDevConfig", () => {
  it("returns defaults when config path is null", () => {
    const config = readDevConfig(null);
    expect(config.deploymentMode).toBe("local_trusted");
    expect(config.port).toBe(3100);
    expect(config.pgPort).toBe(54329);
  });

  it("reads bind mode and deployment mode from config file", () => {
    const dir = makeTempDir("paperclip-dev-status-config-");
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        server: {
          deploymentMode: "authenticated",
          exposure: "private",
          bind: "tailnet",
          host: "100.10.0.1",
          port: 3200,
        },
        database: {
          embeddedPostgresDataDir: "/custom/db",
          embeddedPostgresPort: 55000,
        },
      }),
      "utf8",
    );

    const config = readDevConfig(configPath);
    expect(config.deploymentMode).toBe("authenticated");
    expect(config.exposure).toBe("private");
    expect(config.bind).toBe("tailnet");
    expect(config.host).toBe("100.10.0.1");
    expect(config.port).toBe(3200);
    expect(config.pgDataDir).toBe("/custom/db");
    expect(config.pgPort).toBe(55000);
  });

  it("returns defaults for fields missing from config file", () => {
    const dir = makeTempDir("paperclip-dev-status-partial-");
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ server: { port: 3500 } }), "utf8");

    const config = readDevConfig(configPath);
    expect(config.port).toBe(3500);
    expect(config.deploymentMode).toBe("local_trusted");
    expect(config.pgPort).toBe(54329);
  });

  it("returns defaults when config file contains invalid JSON", () => {
    const dir = makeTempDir("paperclip-dev-status-invalid-");
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, "{ not valid json", "utf8");

    const config = readDevConfig(configPath);
    expect(config.deploymentMode).toBe("local_trusted");
  });
});

describe("probeEmbeddedPg", () => {
  it("reads PID and port from postmaster.pid when the PID is alive", async () => {
    const dir = makeTempDir("paperclip-dev-status-pg-");
    fs.writeFileSync(
      path.join(dir, "postmaster.pid"),
      [
        "12345",      // line 0: pid
        dir,          // line 1: data dir
        "1234567890", // line 2: start time
        "54329",      // line 3: port
        "/tmp",       // line 4: socket dir
        "localhost",  // line 5: listen address
        "",           // line 6: shm key
        "ready",      // line 7: status
      ].join("\n"),
      "utf8",
    );

    vi.spyOn(supervisor, "isPidAlive").mockReturnValue(true);

    const result = await probeEmbeddedPg(dir, 54329);
    expect(result.source).toBe("postmaster.pid");
    expect(result.pid).toBe(12345);
    expect(result.port).toBe(54329);
    expect(result.alive).toBe(true);
  });

  it("marks PG as not alive when PID from postmaster.pid is dead", async () => {
    const dir = makeTempDir("paperclip-dev-status-pg-dead-");
    fs.writeFileSync(
      path.join(dir, "postmaster.pid"),
      ["99999", dir, "1234567890", "54329", "/tmp", "localhost", "", "ready"].join("\n"),
      "utf8",
    );

    vi.spyOn(supervisor, "isPidAlive").mockReturnValue(false);

    const result = await probeEmbeddedPg(dir, 54329);
    expect(result.source).toBe("postmaster.pid");
    expect(result.pid).toBe(99999);
    expect(result.alive).toBe(false);
  });

  it("falls back to lsof when postmaster.pid is absent", async () => {
    const dir = makeTempDir("paperclip-dev-status-pg-nopid-");
    vi.spyOn(supervisor, "readLocalServicePortOwner").mockResolvedValue(11111);

    const result = await probeEmbeddedPg(dir, 54329);
    expect(result.source).toBe("lsof");
    expect(result.pid).toBe(11111);
    expect(result.alive).toBe(true);
    expect(result.port).toBe(54329);
  });

  it("reports not running via lsof when nothing listens on the PG port", async () => {
    const dir = makeTempDir("paperclip-dev-status-pg-none-");
    vi.spyOn(supervisor, "readLocalServicePortOwner").mockResolvedValue(null);

    const result = await probeEmbeddedPg(dir, 54329);
    expect(result.source).toBe("lsof");
    expect(result.pid).toBeNull();
    expect(result.alive).toBe(false);
  });
});
