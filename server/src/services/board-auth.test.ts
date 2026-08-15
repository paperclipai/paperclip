import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { boardAuthService } from "./board-auth.js";

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
