import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  environmentRuntimeService,
  resolveSandboxDuplexBridgeInput,
} from "../services/environment-runtime.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres duplex bridge input tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("resolveSandboxDuplexBridgeInput", () => {
  it("carries an enabled kill switch into the bridge input", () => {
    expect(resolveSandboxDuplexBridgeInput({ enableSandboxDuplexBridge: true })).toEqual({
      enableDuplexBridge: true,
    });
  });

  it("keeps the file bridge when the kill switch is off", () => {
    expect(resolveSandboxDuplexBridgeInput({ enableSandboxDuplexBridge: false })).toEqual({
      enableDuplexBridge: false,
    });
  });
});

describeEmbeddedPostgres("environmentRuntimeService.readSandboxDuplexBridgeInput", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let runtime!: ReturnType<typeof environmentRuntimeService>;
  let settings!: ReturnType<typeof instanceSettingsService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-runtime-duplex-bridge");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    runtime = environmentRuntimeService(db);
    settings = instanceSettingsService(db);
    return async () => {
      await stopDb?.();
    };
  });

  it("defaults the per-run bridge input to the file bridge", async () => {
    expect(await runtime.readSandboxDuplexBridgeInput()).toEqual({ enableDuplexBridge: false });
  });

  it("reads the enabled kill switch from instance settings for a run", async () => {
    await settings.updateExperimental({ enableSandboxDuplexBridge: true });

    expect(await runtime.readSandboxDuplexBridgeInput()).toEqual({ enableDuplexBridge: true });
  });

  it("returns to the file bridge when the kill switch is turned back off", async () => {
    await settings.updateExperimental({ enableSandboxDuplexBridge: true });
    await settings.updateExperimental({ enableSandboxDuplexBridge: false });

    expect(await runtime.readSandboxDuplexBridgeInput()).toEqual({ enableDuplexBridge: false });
  });
});
