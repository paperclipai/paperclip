import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const mocks = vi.hoisted(() => ({ close: vi.fn(async () => {}), prestage: vi.fn(), key: vi.fn(async () => {}), obligations: vi.fn(async () => false) }));
vi.mock("@paperclipai/db", () => ({ createDb: () => ({}), closeRegisteredClients: mocks.close }));
vi.mock("../config.js", () => ({ loadConfig: () => ({ secretsMasterKeyFilePath: "/fixture/key" }) }));
vi.mock("../services/cloud-runtime-config.js", () => ({ cloudRuntimeConfigService: () => ({}) }));
vi.mock("../services/cloud-runtime-config-snapshot.js", () => ({ setCloudRuntimeConfigSnapshot: () => {} }));
vi.mock("../services/cloud-instance.js", () => ({ isCloudManagedInstance: () => false }));
vi.mock("../storage/index.js", () => ({ getStorageService: () => ({ provider: "s3" }) }));
vi.mock("../services/native-runtime/native-harness-backup-migration.js", () => ({
  prestageNativeHarnessBackups: mocks.prestage, hasLocalNativeHarnessObligations: mocks.obligations,
}));
vi.mock("./native-harness-prestage-runtime.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-harness-prestage-runtime.js")>(), initializeNativeHarnessPrestageKey: mocks.key,
}));

const initialExitCode = process.exitCode;
afterEach(() => { process.exitCode = initialExitCode; vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); mocks.close.mockClear(); mocks.obligations.mockReset().mockResolvedValue(false); });

it.each([true, false])("checks unfulfilled database obligations for an empty source scan (pending: %s)", async pending => {
  vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_PRESTAGE", "true");
  vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@localhost/fixture");
  const counts = { inspected: 0, published: 0, current: 0, deferred: {} };
  mocks.prestage.mockResolvedValue(counts);
  mocks.obligations.mockResolvedValue(pending);
  const success = vi.spyOn(console, "log").mockImplementation(() => {});
  const failure = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("./native-harness-prestage.js");
  expect(mocks.close).toHaveBeenCalled();
  if (pending) {
    expect(process.exitCode).toBe(1);
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledOnce();
    expect(JSON.parse(failure.mock.calls[0][0])).toEqual({ schema: "paperclip.native-harness-prestage.v1",
      state: "blocked", failure: "native_harness_prestage_source_missing", enrollmentReady: false });
  } else {
    expect(process.exitCode ?? 0).toBe(0);
    expect(failure).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith(JSON.stringify({ schema: "paperclip.native-harness-prestage.v1", counts, enrollmentReady: false }));
  }
});

it("keeps a nonempty deferred scan advisory without requiring all obligations to be copied", async () => {
  vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_PRESTAGE", "true");
  vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@localhost/fixture");
  const counts = { inspected: 1, published: 0, current: 0, deferred: { source_active: 1 } };
  mocks.prestage.mockResolvedValue(counts); mocks.obligations.mockResolvedValue(true);
  const success = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./native-harness-prestage.js");
  expect(mocks.obligations).not.toHaveBeenCalled();
  expect(process.exitCode ?? 0).toBe(0);
  expect(success).toHaveBeenCalledWith(JSON.stringify({ schema: "paperclip.native-harness-prestage.v1", counts, enrollmentReady: false }));
});

it("reports a failed deadline with real timers when the dependency holds no event-loop handle", async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./native-harness-prestage.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
    banner: { js: "const realTimeout = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 5400000 ? 10 : ms === 10000 ? 50 : ms, ...args);" },
    plugins: [{ name: "prestage-dependencies", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => args.importer ? { path: "dependencies", namespace: "fixture" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const createDb = () => ({}), closeRegisteredClients = async () => {};
        export const loadConfig = () => ({ secretsMasterKeyFilePath: '/fixture/key' });
        export const cloudRuntimeConfigService = () => ({}), setCloudRuntimeConfigSnapshot = () => {};
        export const isCloudManagedInstance = () => false, getStorageService = () => ({ provider: 's3' });
        export const initializeNativeHarnessPrestageKey = async () => {}, nativeHarnessPrestageDatabaseUrl = url => url;
        export const prestageNativeHarnessBackups = () => new Promise(() => {});
        export const hasLocalNativeHarnessObligations = async () => false;
      ` }));
    } }],
  });
  const child = spawnSync(process.execPath, ["--input-type=module"], {
    input: bundled.outputFiles[0].text, encoding: "utf8", timeout: 5000,
    env: { ...process.env, PAPERCLIP_NATIVE_HARNESS_PRESTAGE: "true", DATABASE_URL: "postgres://fixture:fixture@localhost/fixture" },
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(JSON.parse(child.stderr.trim())).toEqual({ schema: "paperclip.native-harness-prestage.v1",
    state: "blocked", failure: "native_harness_prestage_deadline", enrollmentReady: false });
});

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
