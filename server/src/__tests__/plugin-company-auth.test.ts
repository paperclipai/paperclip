/**
 * Tests for assertPluginAuthorizedForCompany (plugin-company-auth.ts).
 *
 * Authorization model:
 * - no row          → authorized (default company behavior)
 * - row enabled=true  → authorized
 * - row enabled=false → DENIED
 */

import { describe, expect, it, vi } from "vitest";
import { assertPluginAuthorizedForCompany } from "../services/plugin-company-auth.js";
import type { Db } from "@paperclipai/db";

function makeDb(rows: Array<{ enabled: boolean }>): Db {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi
      .fn()
      .mockImplementation((cb: (rows: Array<{ enabled: boolean }>) => unknown) =>
        Promise.resolve(cb(rows)),
      ),
  } as unknown as Db;
}

describe("assertPluginAuthorizedForCompany", () => {
  it("resolves when no plugin_company_settings row exists (no-row=enabled)", async () => {
    const db = makeDb([]);
    await expect(
      assertPluginAuthorizedForCompany(db, "plugin-1", "company-1"),
    ).resolves.toBeUndefined();
  });

  it("resolves when row exists with enabled=true", async () => {
    const db = makeDb([{ enabled: true }]);
    await expect(
      assertPluginAuthorizedForCompany(db, "plugin-1", "company-1"),
    ).resolves.toBeUndefined();
  });

  it("throws when row exists with enabled=false", async () => {
    const db = makeDb([{ enabled: false }]);
    await expect(
      assertPluginAuthorizedForCompany(db, "plugin-1", "company-1"),
    ).rejects.toThrow(/not authorized/i);
  });
});
