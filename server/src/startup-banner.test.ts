import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use env-var injection so resolvePaperclipConfigPath returns a known path
// without relying on vi.mock of a local module (which can be unreliable in ESM).
// paths.ts checks PAPERCLIP_CONFIG first, so we inject it in beforeEach.
const TEST_CONFIG_PATH = "/home/user/.paperclip/config.json";

// Mock the fs module so existsSync never accidentally reads the real filesystem
// (e.g. for the JWT secret env-file check inside printStartupBanner).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(""),
  };
});

import { existsSync } from "node:fs";
import { printStartupBanner } from "./startup-banner.js";

type BannerOpts = Parameters<typeof printStartupBanner>[0];

function makeOpts(overrides: Partial<BannerOpts> = {}): BannerOpts {
  return {
    bind: "loopback",
    host: "127.0.0.1",
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    requestedPort: 3100,
    listenPort: 3100,
    uiMode: "static",
    db: { mode: "embedded-postgres", dataDir: "/data/pg", port: 5432 },
    migrationSummary: "up to date",
    heartbeatSchedulerEnabled: true,
    heartbeatSchedulerIntervalMs: 60000,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 7,
    databaseBackupDir: "/data/backups",
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(existsSync).mockReturnValue(false);
  vi.stubEnv("PAPERCLIP_CONFIG", TEST_CONFIG_PATH);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ============================================================================
// printStartupBanner — basic output
// ============================================================================

describe("printStartupBanner — output", () => {
  it("calls console.log once", () => {
    printStartupBanner(makeOpts());
    expect(console.log).toHaveBeenCalledOnce();
  });

  it("output contains API URL", () => {
    printStartupBanner(makeOpts({ host: "127.0.0.1", listenPort: 3100 }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("127.0.0.1:3100");
  });

  it("output contains deployment mode", () => {
    printStartupBanner(makeOpts({ deploymentMode: "authenticated" }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("authenticated");
  });

  it("output contains config path", () => {
    printStartupBanner(makeOpts());
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain(".paperclip/config.json");
  });
});

// ============================================================================
// printStartupBanner — database details
// ============================================================================

describe("printStartupBanner — database details", () => {
  it("shows embedded-postgres data dir and port", () => {
    printStartupBanner(makeOpts({
      db: { mode: "embedded-postgres", dataDir: "/var/data/pg", port: 5433 },
    }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("/var/data/pg");
    expect(output).toContain("5433");
  });

  it("redacts password from external postgres connection string", () => {
    printStartupBanner(makeOpts({
      db: { mode: "external-postgres", connectionString: "postgres://admin:s3cret@db.internal:5432/paperclip" },
    }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).not.toContain("s3cret");
    expect(output).toContain("admin:***@");
    expect(output).toContain("db.internal:5432");
  });

  it("shows fallback for invalid connection string", () => {
    printStartupBanner(makeOpts({
      db: { mode: "external-postgres", connectionString: "not-a-url" },
    }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("<invalid DATABASE_URL>");
  });
});

// ============================================================================
// printStartupBanner — heartbeat and backup
// ============================================================================

describe("printStartupBanner — heartbeat and backup", () => {
  it("shows heartbeat interval when enabled", () => {
    printStartupBanner(makeOpts({ heartbeatSchedulerEnabled: true, heartbeatSchedulerIntervalMs: 30000 }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("30000");
  });

  it("shows backup info when enabled", () => {
    printStartupBanner(makeOpts({
      databaseBackupEnabled: true,
      databaseBackupIntervalMinutes: 30,
      databaseBackupRetentionDays: 14,
    }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("30");
    expect(output).toContain("14");
  });
});

// ============================================================================
// printStartupBanner — port display
// ============================================================================

describe("printStartupBanner — port display", () => {
  it("shows listen port", () => {
    printStartupBanner(makeOpts({ listenPort: 4200, requestedPort: 4200 }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("4200");
  });

  it("shows both requested and listen port when they differ", () => {
    printStartupBanner(makeOpts({ listenPort: 3101, requestedPort: 3100 }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("3101");
    expect(output).toContain("3100");
  });
});

// ============================================================================
// printStartupBanner — host normalization
// ============================================================================

describe("printStartupBanner — host normalization", () => {
  it("uses 'localhost' in URL when host is 0.0.0.0", () => {
    printStartupBanner(makeOpts({ host: "0.0.0.0", listenPort: 3100 }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("localhost:3100");
    expect(output).not.toContain("0.0.0.0:3100");
  });

  it("uses actual host in URL when host is not 0.0.0.0", () => {
    printStartupBanner(makeOpts({ host: "192.168.1.5", listenPort: 3100 }));
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("192.168.1.5:3100");
  });
});

// ============================================================================
// printStartupBanner — agent JWT secret status
// ============================================================================

describe("printStartupBanner — agent JWT secret", () => {
  it("shows 'set' when PAPERCLIP_AGENT_JWT_SECRET is in env", () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "my-secret-key");
    printStartupBanner(makeOpts());
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("set");
  });

  it("shows warning text when secret is missing", () => {
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    vi.mocked(existsSync).mockReturnValue(false);
    printStartupBanner(makeOpts());
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(output).toContain("missing");
  });
});
