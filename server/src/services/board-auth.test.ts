import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { boardAuthService, hashBearerToken } from "./board-auth.js";

describe("boardAuthService touchBoardApiKey", () => {
  it("retries the audit write after a transient failure", async () => {
    const writes = [Promise.reject(new Error("transient")), Promise.resolve([])];
    const update = vi.fn(() => ({
      set: () => ({
        where: () => writes.shift(),
      }),
    }));
    const service = boardAuthService({ update } as unknown as Db);

    await expect(service.touchBoardApiKey("key-1")).rejects.toThrow("transient");
    await expect(service.touchBoardApiKey("key-1")).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight audit write across concurrent touches", async () => {
    let releaseWrite: (() => void) | undefined;
    const write = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const update = vi.fn(() => ({
      set: () => ({
        where: () => write,
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

describe("boardAuthService findLapsedBoardApiKeyByToken (#16600)", () => {
  const token = "pcp_board_x";
  function serviceWithRows(rows: Array<{ keyHash?: string; expiresAt: Date | null; revokedAt: Date | null }>) {
    const stored = rows.map((row) => ({ keyHash: hashBearerToken(token), ...row }));
    const select = vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve(stored),
      }),
    }));
    return boardAuthService({ select } as unknown as Db);
  }
  const day = 24 * 60 * 60 * 1000;

  it("reports an expired board key with its expiry date", async () => {
    const expiresAt = new Date(Date.now() - day);
    const service = serviceWithRows([{ expiresAt, revokedAt: null }]);
    await expect(service.findLapsedBoardApiKeyByToken(token)).resolves.toEqual({
      status: "expired",
      at: expiresAt,
    });
  });

  it("reports a revoked board key", async () => {
    const revokedAt = new Date(Date.now() - day);
    const service = serviceWithRows([{ expiresAt: new Date(Date.now() + day), revokedAt }]);
    await expect(service.findLapsedBoardApiKeyByToken(token)).resolves.toEqual({
      status: "revoked",
      at: revokedAt,
    });
  });

  it("does not match a lapsed key stored under a different token", async () => {
    const service = serviceWithRows([
      { keyHash: hashBearerToken("pcp_board_other"), expiresAt: new Date(Date.now() - day), revokedAt: null },
    ]);
    await expect(service.findLapsedBoardApiKeyByToken(token)).resolves.toBeNull();
  });

  it("returns null for unknown tokens and for keys that are still usable", async () => {
    await expect(serviceWithRows([]).findLapsedBoardApiKeyByToken("nope")).resolves.toBeNull();
    await expect(
      serviceWithRows([{ expiresAt: new Date(Date.now() + day), revokedAt: null }])
        .findLapsedBoardApiKeyByToken(token),
    ).resolves.toBeNull();
  });
});
