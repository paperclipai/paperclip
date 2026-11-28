import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { assetService } from "./assets.js";

describe("assetService.getById", () => {
  it("returns null for non-UUID ids without querying the database", async () => {
    const select = vi.fn();
    const svc = assetService({ select } as unknown as Db);
    await expect(svc.getById("x")).resolves.toBeNull();
    await expect(svc.getById("asset-1")).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("queries the database for UUID-shaped ids", async () => {
    const row = { id: "0190f6c4-1234-7abc-8def-0123456789ab" };
    const then = vi.fn((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([row])));
    const where = vi.fn(() => ({ then }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const svc = assetService({ select } as unknown as Db);
    await expect(svc.getById(row.id)).resolves.toBe(row);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
