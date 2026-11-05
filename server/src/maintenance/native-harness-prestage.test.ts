import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ close: vi.fn(async () => {}), prestage: vi.fn(), key: vi.fn(async () => {}) }));
vi.mock("@paperclipai/db", () => ({ createDb: () => ({}), closeRegisteredClients: mocks.close }));
vi.mock("../config.js", () => ({ loadConfig: () => ({ secretsMasterKeyFilePath: "/fixture/key" }) }));
vi.mock("../services/cloud-runtime-config.js", () => ({ cloudRuntimeConfigService: () => ({}) }));
vi.mock("../services/cloud-runtime-config-snapshot.js", () => ({ setCloudRuntimeConfigSnapshot: () => {} }));
vi.mock("../services/cloud-instance.js", () => ({ isCloudManagedInstance: () => false }));
vi.mock("../storage/index.js", () => ({ getStorageService: () => ({ provider: "s3" }) }));
vi.mock("../services/native-runtime/native-harness-backup-migration.js", () => ({ prestageNativeHarnessBackups: mocks.prestage }));
vi.mock("./native-harness-prestage-runtime.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-harness-prestage-runtime.js")>(), initializeNativeHarnessPrestageKey: mocks.key,
}));

const initialExitCode = process.exitCode;
afterEach(() => { process.exitCode = initialExitCode; vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); mocks.close.mockClear(); });

it.each(["SIGTERM", "deadline"])("bounds shutdown if a dependency does not settle after %s", async mode => {
  vi.useFakeTimers();
  vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_PRESTAGE", "true");
  vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@localhost/fixture");
  const once = vi.spyOn(process, "once"), exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const success = vi.spyOn(console, "log").mockImplementation(() => {});
  let settle!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  mocks.prestage.mockImplementation(async () => { started(); await new Promise<void>(resolve => { settle = resolve; }); return { copied: 1 }; });
  const command = import("./native-harness-prestage.js");
  await ready;
  try {
    if (mode === "SIGTERM") {
      const handler = once.mock.calls.find(([signal]) => signal === "SIGTERM")?.[1];
      expect(handler).toBeTypeOf("function"); handler!();
    } else await vi.advanceTimersByTimeAsync(90 * 60_000);
    expect(mocks.key).toHaveBeenCalledWith("/fixture/key");
    expect(mocks.prestage.mock.calls.at(-1)?.[1].signal.aborted).toBe(true);
    expect(mocks.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).toHaveBeenCalledWith(1);
  } finally { settle(); await command; }
  expect(success).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});
