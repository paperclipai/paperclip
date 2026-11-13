import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertEphemeralServerData } from "../services/ephemeral-server-contract.js";
import { hasLocalNativeHarnessObligations } from "../services/native-runtime/native-harness-backup-migration.js";
import { volumeFreeControllerStateOwned } from "../services/native-runtime/volume-free-controller-state.js";

vi.mock("../storage/index.js", () => ({ getStorageService: () => ({ provider: "s3" }) }));
vi.mock("../services/native-runtime/native-harness-backup-migration.js", () => ({ hasLocalNativeHarnessObligations: vi.fn() }));
vi.mock("../services/native-runtime/volume-free-controller-state.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/native-runtime/volume-free-controller-state.js")>(),
  volumeFreeControllerStateOwned: vi.fn(),
}));

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("ephemeral-startup-run-state-"); db = createDb(database.connectionString); }, 90_000);
afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(hasLocalNativeHarnessObligations).mockReset(); vi.mocked(volumeFreeControllerStateOwned).mockReset(); });

// Staging, 2026-11-11: a volume-free server died mid-run, leaving leases whose
// harness backup never reached durable storage. Every later start refused with
// this blocker, so the workspace stayed down until someone repaired it by hand.
it("starts a volume-free server over harness backups a volume-free server left unsaved", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true"); vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  vi.mocked(hasLocalNativeHarnessObligations).mockResolvedValue(true);
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(true);
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
});

it("still refuses configuration that would write new data to the local disk, with the owner marker present", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true"); vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  vi.mocked(hasLocalNativeHarnessObligations).mockResolvedValue(true);
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(true);
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Startup gate", issuePrefix: "SGAT" });
  await db.insert(agents).values({ companyId, name: "Legacy files" });
  try {
    const refusal = assertEphemeralServerData(db);
    await expect(refusal).rejects.toThrow("agent_files_require_migration");
    await expect(refusal).rejects.not.toThrow("native_harness_backups_require_migration");
  } finally {
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  }
});

it("still refuses unsaved harness backups on a filesystem with no volume-free owner marker", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true"); vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  vi.mocked(hasLocalNativeHarnessObligations).mockResolvedValue(true);
  vi.mocked(volumeFreeControllerStateOwned).mockResolvedValue(false);
  await expect(assertEphemeralServerData(db)).rejects.toThrow("native_harness_backups_require_migration");
});

it("does not consult the owner marker when harness backups are settled", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true"); vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  vi.mocked(hasLocalNativeHarnessObligations).mockResolvedValue(false);
  await expect(assertEphemeralServerData(db)).resolves.toBeUndefined();
  expect(volumeFreeControllerStateOwned).not.toHaveBeenCalled();
});
