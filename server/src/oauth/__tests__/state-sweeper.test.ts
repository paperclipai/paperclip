import { describe, it, expect, vi } from "vitest";
import { runStateSweep } from "../state-sweeper.js";

describe("runStateSweep", () => {
  it("issues a delete with an expiresAt < now() - 1 day predicate", async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn(() => ({ where: whereMock }));
    const db = { delete: deleteFn };
    await runStateSweep({ db } as never);
    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it("swallows and logs an error thrown by db.delete", async () => {
    const db = {
      delete: () => {
        throw new Error("postgres unavailable");
      },
    };
    // The sweep must not propagate the error — the caller (tick loop) relies
    // on this to keep ticking.
    await expect(runStateSweep({ db } as never)).resolves.toBeUndefined();
  });

  it("swallows and logs an error thrown by the where chain", async () => {
    const db = {
      delete: () => ({
        where: () => Promise.reject(new Error("pg timeout")),
      }),
    };
    await expect(runStateSweep({ db } as never)).resolves.toBeUndefined();
  });
});
