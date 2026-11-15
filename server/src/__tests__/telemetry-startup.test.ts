import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stateFactory = vi.hoisted(() => vi.fn(() => ({
  installId: "test-install",
  salt: "test-salt",
  createdAt: "2026-01-01T00:00:00Z",
  firstSeenVersion: "0.0.0",
})));

vi.mock("@paperclipai/shared/telemetry", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/shared/telemetry")>(),
  loadOrCreateState: stateFactory,
}));
vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => "/unused-test-instance" }));
vi.mock("../version.js", () => ({ serverVersion: "0.0.0-test" }));

describe("server telemetry startup", () => {
  const fixtureDirs: string[] = [];
  beforeEach(() => {
    vi.resetModules();
    stateFactory.mockClear();
    for (const key of ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI", "PAPERCLIP_TELEMETRY_DISABLED", "DO_NOT_TRACK"]) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv("PAPERCLIP_TELEMETRY_ENDPOINT", "http://localhost:9999/ingest");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(async () => {
    const { getTelemetryClient } = await import("../telemetry.js");
    getTelemetryClient()?.stop();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("emits the OS family exactly once even when initialization is repeated", async () => {
    const { initTelemetry, getTelemetryClient } = await import("../telemetry.js");
    const client = initTelemetry({ enabled: true });
    expect(client).not.toBeNull();
    expect(initTelemetry({ enabled: true })).toBe(client);
    expect(getTelemetryClient()).toBe(client);
    await client!.flush();

    expect(stateFactory).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.events).toEqual([
      { name: "server.started", occurredAt: expect.any(String), dimensions: { os_platform: process.platform } },
    ]);
  });

  describe("Cloud organization link", () => {
    const organizationRef = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    async function startAndCollect() {
      const { TelemetryClient } = await import("@paperclipai/shared/telemetry");
      const track = vi.spyOn(TelemetryClient.prototype, "track");
      const { initTelemetry } = await import("../telemetry.js");
      const client = initTelemetry({ enabled: true });
      await client!.flush();
      const sent = vi.mocked(fetch).mock.calls.map((call) => String(call[1]?.body)).join(" ");
      return { names: track.mock.calls.map((call) => call[0] as string), track, sent };
    }

    it("attempts the link once on a managed Cloud instance, and sends nothing for it before approval", async () => {
      vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "tenant-token");
      vi.stubEnv("PAPERCLIP_CLOUD_ACCOUNT_GROUP_ID", "account-acme-rockets");
      vi.stubEnv("PAPERCLIP_CLOUD_TELEMETRY_ORGANIZATION_REF", organizationRef);

      const { names, track, sent } = await startAndCollect();

      expect(names).toEqual(["server.started", "cloud.organization_identified"]);
      expect(track).toHaveBeenLastCalledWith("cloud.organization_identified", { organization_ref: organizationRef });
      expect(sent).toContain("server.started");
      expect(sent).not.toContain("cloud.organization_identified");
      expect(sent).not.toContain(organizationRef);
      expect(sent).not.toContain("acme");
    });

    it.each([
      ["no reference", undefined],
      ["an account group ID in place of the reference", "account-acme-rockets"],
    ])("does not attempt the link with %s", async (_label, value) => {
      vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "tenant-token");
      vi.stubEnv("PAPERCLIP_CLOUD_ACCOUNT_GROUP_ID", "account-acme-rockets");
      if (value !== undefined) vi.stubEnv("PAPERCLIP_CLOUD_TELEMETRY_ORGANIZATION_REF", value);

      const { names, sent } = await startAndCollect();

      expect(names).toEqual(["server.started"]);
      expect(sent).not.toContain("acme");
    });

    it("does not attempt the link outside a managed Cloud instance", async () => {
      vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "");
      vi.stubEnv("PAPERCLIP_CLOUD_TELEMETRY_ORGANIZATION_REF", organizationRef);

      expect((await startAndCollect()).names).toEqual(["server.started"]);
    });
  });

  it("disables telemetry after a state failure without aborting startup or retrying", async () => {
    stateFactory.mockImplementationOnce(() => {
      throw Object.assign(new Error("private telemetry path cannot be written"), { code: "EACCES" });
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { TelemetryClient } = await import("@paperclipai/shared/telemetry");
    const periodicFlush = vi.spyOn(TelemetryClient.prototype, "startPeriodicFlush");
    const { initTelemetry, getTelemetryClient } = await import("../telemetry.js");

    expect(initTelemetry({ enabled: true })).toBeNull();
    expect(getTelemetryClient()).toBeNull();
    expect(initTelemetry({ enabled: true })).toBeNull();
    expect(stateFactory).toHaveBeenCalledTimes(1);
    expect(periodicFlush).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(warning.mock.calls).toEqual([
      ["[telemetry] Initialization failed; telemetry is disabled for this process."],
    ]);
  });

  it("continues startup when the real state store cannot create its directory", async () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "paperclip-telemetry-startup-"));
    fixtureDirs.push(fixtureDir);
    const blockedStateDir = path.join(fixtureDir, "telemetry");
    writeFileSync(blockedStateDir, "this file prevents directory creation");
    const { loadOrCreateState } = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
      "@paperclipai/shared/telemetry",
    );
    stateFactory.mockImplementationOnce(() => loadOrCreateState(blockedStateDir, "0.0.0-test"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { initTelemetry, getTelemetryClient } = await import("../telemetry.js");

    expect(initTelemetry({ enabled: true })).toBeNull();
    expect(getTelemetryClient()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not initialize state or send when disabled in file configuration", async () => {
    const { initTelemetry, getTelemetryClient } = await import("../telemetry.js");
    expect(initTelemetry({ enabled: false })).toBeNull();
    expect(getTelemetryClient()).toBeNull();
    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["PAPERCLIP_TELEMETRY_DISABLED", "DO_NOT_TRACK", "CI", "GITHUB_ACTIONS"])(
    "respects %s before creating the client or state",
    async (key) => {
      vi.stubEnv(key, "1");
      const { initTelemetry, getTelemetryClient } = await import("../telemetry.js");
      expect(initTelemetry({ enabled: true })).toBeNull();
      expect(getTelemetryClient()).toBeNull();
      expect(stateFactory).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
