import { describe, expect, it, vi, afterEach, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import postgres from "postgres";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

import { assertPgNotReachableOnInterfaces } from "./embedded-pg-lockdown.js";

describe("assertPgNotReachableOnInterfaces", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves when connection is refused (ECONNREFUSED = pg not reachable)", async () => {
    vi.spyOn(net, "createConnection").mockImplementation((_port: unknown, _host: unknown, callback?: () => void) => {
      const socket = {
        on: vi.fn().mockImplementation((event: string, handler: (err?: Error) => void) => {
          if (event === "error") {
            const err = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
            setTimeout(() => handler(err), 0);
          }
          return socket;
        }),
        destroy: vi.fn(),
      };
      callback?.();
      return socket as unknown as net.Socket;
    });

    await expect(assertPgNotReachableOnInterfaces(["192.168.1.10"], 5432)).resolves.toBeUndefined();
  });

  it("throws when pg connection succeeds (pg is reachable = lockdown failed)", async () => {
    vi.spyOn(net, "createConnection").mockImplementation((_port: unknown, _host: unknown, callback?: () => void) => {
      const socket = {
        on: vi.fn().mockImplementation((event: string, handler: () => void) => {
          if (event === "connect") {
            setTimeout(() => handler(), 0);
          }
          return socket;
        }),
        destroy: vi.fn(),
      };
      callback?.();
      return socket as unknown as net.Socket;
    });

    await expect(
      assertPgNotReachableOnInterfaces(["192.168.1.10"], 5432),
    ).rejects.toThrow(/reachable on 192\.168\.1\.10:5432/);
  });

  it("throws when connection errors with ETIMEDOUT (fail closed on ambiguous)", async () => {
    vi.spyOn(net, "createConnection").mockImplementation((_port: unknown, _host: unknown, callback?: () => void) => {
      const socket = {
        on: vi.fn().mockImplementation((event: string, handler: (err?: Error) => void) => {
          if (event === "error") {
            const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
            setTimeout(() => handler(err), 0);
          }
          return socket;
        }),
        destroy: vi.fn(),
      };
      callback?.();
      return socket as unknown as net.Socket;
    });

    await expect(
      assertPgNotReachableOnInterfaces(["192.168.1.10"], 5432),
    ).rejects.toThrow(/ETIMEDOUT/);
  });

  it("throws when connection errors with ENETUNREACH (fail closed on ambiguous)", async () => {
    vi.spyOn(net, "createConnection").mockImplementation((_port: unknown, _host: unknown, callback?: () => void) => {
      const socket = {
        on: vi.fn().mockImplementation((event: string, handler: (err?: Error) => void) => {
          if (event === "error") {
            const err = Object.assign(new Error("net unreachable"), { code: "ENETUNREACH" });
            setTimeout(() => handler(err), 0);
          }
          return socket;
        }),
        destroy: vi.fn(),
      };
      callback?.();
      return socket as unknown as net.Socket;
    });

    await expect(
      assertPgNotReachableOnInterfaces(["192.168.1.10"], 5432),
    ).rejects.toThrow(/ENETUNREACH/);
  });

  it("throws with error message when socket error has no code (fail closed on ambiguous)", async () => {
    vi.spyOn(net, "createConnection").mockImplementation((_port: unknown, _host: unknown, callback?: () => void) => {
      const socket = {
        on: vi.fn().mockImplementation((event: string, handler: (err?: Error) => void) => {
          if (event === "error") {
            setTimeout(() => handler(new Error("some unknown error")), 0);
          }
          return socket;
        }),
        destroy: vi.fn(),
      };
      callback?.();
      return socket as unknown as net.Socket;
    });

    await expect(
      assertPgNotReachableOnInterfaces(["192.168.1.10"], 5432),
    ).rejects.toThrow(/some unknown error/);
  });

  it("throws when internal 500ms timeout fires (socket hangs, neither connects nor errors)", async () => {
    vi.useFakeTimers();
    vi.spyOn(net, "createConnection").mockImplementation(() => {
      const socket = {
        on: vi.fn().mockReturnThis(),
        destroy: vi.fn(),
      };
      return socket as unknown as net.Socket;
    });

    const probe = assertPgNotReachableOnInterfaces(["192.168.1.10"], 5432);
    vi.advanceTimersByTime(501);
    await expect(probe).rejects.toThrow(/timed out/);
    vi.useRealTimers();
  });

  it("resolves immediately for empty address list (no probe needed)", async () => {
    const spy = vi.spyOn(net, "createConnection");
    await expect(assertPgNotReachableOnInterfaces([], 5432)).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("stops at first reachable address (fails fast)", async () => {
    let callCount = 0;
    vi.spyOn(net, "createConnection").mockImplementation((_port: unknown, _host: unknown, callback?: () => void) => {
      callCount++;
      const socket = {
        on: vi.fn().mockImplementation((event: string, handler: () => void) => {
          if (event === "connect") setTimeout(() => handler(), 0);
          return socket;
        }),
        destroy: vi.fn(),
      };
      callback?.();
      return socket as unknown as net.Socket;
    });

    await expect(
      assertPgNotReachableOnInterfaces(["192.168.1.10", "192.168.1.11"], 5432),
    ).rejects.toThrow(/reachable/);
    // Only the first address is probed before the rejection
    expect(callCount).toBe(1);
  });
});

// packages/db/src/ → repo root is 3 levels up
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readSrc(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

describe("postgresFlags static regression guard", () => {
  const constructorSites = [
    { file: "server/src/index.ts", label: "main server startup" },
    { file: "packages/db/src/migration-runtime.ts", label: "migration runtime" },
    { file: "packages/db/src/test-embedded-postgres.ts", label: "integration test helper" },
  ];

  for (const { file, label } of constructorSites) {
    it(`${label} (${file}) passes postgresFlags to EmbeddedPostgres constructor`, () => {
      const src = readSrc(file);
      expect(src).toMatch(/postgresFlags/);
    });
  }

  it("buildEmbeddedPostgresFlags snapshot — value must be the listen_addresses lockdown flag", async () => {
    const { buildEmbeddedPostgresFlags } = await import("./embedded-postgres-flags.js");
    const flags = buildEmbeddedPostgresFlags();
    expect(flags).toEqual(["-c", "listen_addresses=127.0.0.1"]);
  });
});

// Integration test: verify the real embedded-postgres process starts with listen_addresses=127.0.0.1
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => {});
});

describeEmbeddedPostgres("embedded-postgres listen_addresses lockdown (integration)", () => {
  it("SHOW listen_addresses returns 127.0.0.1 proving postgresFlags is honored", async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-pg-lockdown-integration-");
    cleanups.push(db.cleanup);

    const sql = postgres(db.connectionString, { max: 1 });
    try {
      const result = await sql`SHOW listen_addresses`;
      expect(result[0]?.listen_addresses).toBe("127.0.0.1");
    } finally {
      await sql.end();
    }
  });
});
