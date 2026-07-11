import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import {
  createDevShadowEnv,
  parseDevShadowArgs,
  probeDevShadowDatabase,
  resolveDevShadowDatabaseUrl,
} from "../../../scripts/dev-shadow-core.mjs";
import { createDevServiceProfile } from "../../../scripts/dev-service-profile-core.mjs";

describe("dev shadow resolver", () => {
  it("uses the documented defaults", () => {
    expect(parseDevShadowArgs([])).toEqual({
      sourceApi: "http://127.0.0.1:3100",
      port: 3101,
      databaseUrl: undefined,
    });
  });

  it("accepts an explicit PostgreSQL URL and rejects data-directory sharing", async () => {
    const options = parseDevShadowArgs([
      "--source-api",
      "http://localhost:3200/",
      "--port",
      "3201",
      "--database-url",
      "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
    ]);
    const fetchImpl = vi.fn();

    await expect(resolveDevShadowDatabaseUrl(options, fetchImpl)).resolves.toBe(
      "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => parseDevShadowArgs(["--database-url", "./data/postgres"])).toThrow(
      /embedded data directory/,
    );
    expect(() => parseDevShadowArgs(["--embedded-postgres-data-dir", "data/postgres"])).toThrow(
      /unsafe/,
    );
  });

  it("resolves the active database from the source API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ databaseUrl: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(resolveDevShadowDatabaseUrl(parseDevShadowArgs([]), fetchImpl)).resolves.toContain(
      "127.0.0.1:54329/paperclip",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/health/dev-database-source",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("fails clearly when the source API is unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(resolveDevShadowDatabaseUrl(parseDevShadowArgs([]), fetchImpl)).rejects.toThrow(
      /Could not reach source Paperclip API.*ECONNREFUSED/,
    );
  });

  it("fails clearly when the resolved database is unavailable", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP probe address");
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

    await expect(
      probeDevShadowDatabase(`postgres://paperclip:paperclip@127.0.0.1:${address.port}/paperclip`, 500),
    ).rejects.toThrow(/Could not connect to PostgreSQL/);
  });

  it("constructs a guarded shadow environment", () => {
    const env = createDevShadowEnv(
      parseDevShadowArgs([]),
      "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
      { KEEP_ME: "yes" },
    );

    expect(env).toMatchObject({
      KEEP_ME: "yes",
      PORT: "3101",
      DATABASE_URL: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
      PAPERCLIP_API_URL: "http://127.0.0.1:3101",
      PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
      PAPERCLIP_SHADOW_DEV_SOURCE_API: "http://127.0.0.1:3100",
      HEARTBEAT_SCHEDULER_ENABLED: "false",
      PAPERCLIP_DB_BACKUP_ENABLED: "false",
      PAPERCLIP_MIGRATION_AUTO_APPLY: "false",
    });
  });
});

describe("dev service identity", () => {
  it("distinguishes stable watch, once, and shadow services", () => {
    const common = { forwardedArgs: [], networkProfile: "default", port: 3100 };
    const watch = createDevServiceProfile({ ...common, mode: "watch" });
    const once = createDevServiceProfile({ ...common, mode: "dev" });
    const shadow = createDevServiceProfile({
      ...common,
      mode: "watch",
      port: 3101,
      shadowSourceApi: "http://127.0.0.1:3100",
    });

    expect([watch.serviceName, once.serviceName, shadow.serviceName]).toEqual([
      "paperclip-dev-watch",
      "paperclip-dev-once",
      "paperclip-dev-shadow",
    ]);
    expect(new Set([watch.envFingerprint, once.envFingerprint, shadow.envFingerprint]).size).toBe(3);
  });
});
