import { afterEach, expect, it, vi } from "vitest";
import { createLocalEncryptedCipher } from "../../server/src/secrets/local-encrypted-provider.js";

const mocks = vi.hoisted(() => ({
  start: vi.fn(), observer: vi.fn(), stop: vi.fn(), close: vi.fn(), writeFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ mkdir: async () => {}, writeFile: mocks.writeFile,
  readFile: async () => JSON.stringify({ database: { mode: "postgres", connectionString: "postgres://fixture" },
    secrets: { localEncrypted: { keyFilePath: "/fixture/secrets/master.key" } } }) }));
vi.mock("../../packages/shared/src/config-schema.js", () => ({ paperclipConfigSchema: { parse: (value: unknown) => value } }));
vi.mock("./rolling-deployment-process.js", () => ({ startRollingDeploymentProcess: mocks.start }));
vi.mock("./rolling-deployment-proxy.js", () => ({ startRollingDeploymentProxy: async () => ({ origin: "http://127.0.0.1:1", routeTo() {}, close: mocks.close }) }));
vi.mock("./controller-recovery-observer.js", () => ({ createControllerRecoveryObserver: mocks.observer }));
vi.mock("./server-restart-request.js", () => ({ readRestartRequest: async () => ({ requestId: "key-check", rollingDeployment: true, recoveryBinding: {} }) }));
import { superviseRollingDeployment } from "./rolling-deployment-supervisor.js";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each([undefined, "prior-disposable-key"])("shares the server key with checkpoint observation and restores %s on failure", async prior => {
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", prior);
  let material: ReturnType<ReturnType<typeof createLocalEncryptedCipher>["encrypt"]>;
  mocks.start.mockImplementation(async ({ sharedEnvironment }) => {
    expect(process.env.PAPERCLIP_SECRETS_MASTER_KEY).toBe(sharedEnvironment.PAPERCLIP_SECRETS_MASTER_KEY);
    expect(mocks.writeFile).toHaveBeenCalledWith("/fixture/secrets/master.key", sharedEnvironment.PAPERCLIP_SECRETS_MASTER_KEY,
      { mode: 0o600, flag: "wx" });
    material = createLocalEncryptedCipher("write").encrypt("synthetic checkpoint");
    return { child: { exitCode: null, signalCode: null }, configPath: "/fixture/config.json",
      origin: "http://127.0.0.1:2", waitForReady: async () => {}, stop: mocks.stop };
  });
  mocks.observer.mockImplementation(async () => {
    expect(createLocalEncryptedCipher("read").decrypt(material)).toBe("synthetic checkpoint");
    throw new Error("synthetic observer failure");
  });
  await expect(superviseRollingDeployment({ temporaryRoot: "/fixture", repositoryRoot: "/fixture",
    configPath: "/fixture/config.json", port: 1, executionIds: ["rolling"], cancelled: () => false,
    environment: { PAPERCLIP_STORAGE_PROVIDER: "s3" },
  })).rejects.toThrow("synthetic observer failure");
  expect(mocks.observer).toHaveBeenCalledOnce();
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(process.env.PAPERCLIP_SECRETS_MASTER_KEY).toBe(prior);
});
