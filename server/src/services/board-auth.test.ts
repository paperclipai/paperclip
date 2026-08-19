import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  BOARD_API_KEY_SCOPE_PRESETS,
  type BoardApiKeyScopeConfig,
} from "@paperclipai/shared";
import { boardAuthService } from "./board-auth.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SCOPE_CONFIG: BoardApiKeyScopeConfig = {
  version: 1,
  kind: "scoped",
  companyIds: [COMPANY_ID],
  permissions: [...BOARD_API_KEY_SCOPE_PRESETS.company_automation.permissions],
  instanceCapabilities: [],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("boardAuthService touchBoardApiKey", () => {
  it("retries the audit write after a transient failure", async () => {
    const writes = [
      Promise.reject(new Error("transient")),
      Promise.resolve([{ id: "key-1" }]),
    ];
    const update = vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: () => writes.shift(),
        }),
      }),
    }));
    const service = boardAuthService({ update } as unknown as Db);

    await expect(service.touchBoardApiKey("key-1")).rejects.toThrow("transient");
    await expect(service.touchBoardApiKey("key-1")).resolves.toEqual({ id: "key-1" });

    expect(update).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight audit write across concurrent touches", async () => {
    let releaseWrite: (() => void) | undefined;
    const write = new Promise<Array<{ id: string }>>((resolve) => {
      releaseWrite = () => resolve([{ id: "key-1" }]);
    });
    const update = vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: () => write,
        }),
      }),
    }));
    const service = boardAuthService({ update } as unknown as Db);

    const first = service.touchBoardApiKey("key-1");
    const second = service.touchBoardApiKey("key-1");
    releaseWrite?.();
    await Promise.all([first, second]);

    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("boardAuthService board API key lifecycle", () => {
  it("stores only a hash, captures a safe prefix, and defaults expiry to 30 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    let inserted: Record<string, unknown> | undefined;
    const insert = vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted = values;
        return {
          returning: () => Promise.resolve([{
            id: "22222222-2222-4222-8222-222222222222",
            ...values,
            legacyUnrestricted: false,
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
            lastUsedAt: null,
            revokedAt: null,
          }]),
        };
      },
    }));
    const service = boardAuthService({ insert } as unknown as Db);

    const created = await service.createNamedBoardApiKey({
      userId: "user-1",
      name: "automation",
      scopeConfig: SCOPE_CONFIG,
    });

    expect(created.token).toMatch(/^pcp_board_/);
    expect(inserted).toMatchObject({
      userId: "user-1",
      name: "automation",
      tokenPrefix: created.token.slice(0, "pcp_board_".length + 12),
      scopeConfig: SCOPE_CONFIG,
      expiresAt: new Date("2026-09-14T12:00:00.000Z"),
    });
    expect(inserted?.keyHash).not.toBe(created.token);
    expect(created.expiresAt).toEqual(new Date("2026-09-14T12:00:00.000Z"));
  });

  it("selects only safe metadata and derives status for list responses", async () => {
    const projectionKeys: string[][] = [];
    const select = vi.fn((projection: Record<string, unknown>) => {
      projectionKeys.push(Object.keys(projection));
      return {
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([{
              id: "22222222-2222-4222-8222-222222222222",
              name: "automation",
              tokenPrefix: "pcp_board_123456789abc",
              scopeConfig: SCOPE_CONFIG,
              legacyUnrestricted: false,
              createdAt: new Date("2026-08-15T12:00:00.000Z"),
              lastUsedAt: null,
              expiresAt: null,
              revokedAt: null,
            }]),
          }),
        }),
      };
    });
    const service = boardAuthService({ select } as unknown as Db);

    const rows = await service.listBoardApiKeys("user-1", { includeInactive: true });

    expect(projectionKeys[0]).toEqual([
      "id",
      "name",
      "tokenPrefix",
      "scopeConfig",
      "legacyUnrestricted",
      "createdAt",
      "lastUsedAt",
      "revokedAt",
      "expiresAt",
    ]);
    expect(rows[0]).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      status: "never_expires",
    });
    expect(rows[0]).not.toHaveProperty("userId");
    expect(rows[0]).not.toHaveProperty("keyHash");
    expect(rows[0]).not.toHaveProperty("token");
  });
});
