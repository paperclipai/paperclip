import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { assertNoPendingLegacyMigration } from "./legacy-migration-gate.js";
import { readDurableControlPlaneState } from "./authority-locator.js";

it("holds absent/legacy/indexed admission while migration is partial and refuses unsafe markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-gate-"));
  const controller = join(root, "control-plane"), marker = join(root, "indexed-migration.json");
  try {
    await mkdir(controller, { mode: 0o700 });
    expect(() => assertNoPendingLegacyMigration(controller)).not.toThrow();
    for (const phase of ["copying", "activating", "unknown"]) {
      await writeFile(marker, JSON.stringify({ schema: "paperclip.runner.legacy-activation.v1", phase }), { mode: 0o600 });
      expect(() => assertNoPendingLegacyMigration(controller)).toThrow("migration_pending");
      await expect(readDurableControlPlaneState(controller)).rejects.toThrow("migration_pending");
    }
    await writeFile(marker, JSON.stringify({ schema: "paperclip.runner.legacy-activation.v1", phase: "active" }), { mode: 0o600 });
    expect(() => assertNoPendingLegacyMigration(controller)).not.toThrow();
    await rm(marker); await symlink(join(root, "missing"), marker);
    expect(() => assertNoPendingLegacyMigration(controller)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
