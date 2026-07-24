import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { COMPANY_SETTINGS_SURFACES } from "@paperclipai/shared";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { closeDbClient } from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("instance settings visibility persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-instance-settings-visibility-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  it("defaults to all company surfaces, persists updates, and round-trips through get()", async () => {
    const svc = instanceSettingsService(db);

    await expect(svc.getVisibility()).resolves.toEqual({
      companySurfaces: [...COMPANY_SETTINGS_SURFACES],
    });

    const updated = await svc.updateVisibility({
      companySurfaces: ["company.members", "company.general"],
    });
    expect(updated.visibility).toEqual({
      companySurfaces: ["company.general", "company.members"],
    });

    await expect(svc.getVisibility()).resolves.toEqual({
      companySurfaces: ["company.general", "company.members"],
    });
    const full = await svc.get();
    expect(full.visibility).toEqual({
      companySurfaces: ["company.general", "company.members"],
    });

    const cleared = await svc.updateVisibility({ companySurfaces: [] });
    expect(cleared.visibility).toEqual({ companySurfaces: [] });
  });
});
