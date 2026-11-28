import { beforeEach, expect, it, vi } from "vitest";
import { qualifyCloudConfigurationForCurrentImage } from "../services/cloud-configuration-qualification.js";

const { qualify } = vi.hoisted(() => ({ qualify: vi.fn() }));
vi.mock("../services/cloud-configuration-migration.js", () => ({ cloudConfigurationMigrationService: () => ({ qualify }) }));
vi.mock("../services/plugin-loader.js", () => ({ pluginLoader: () => ({ loadManifest: async () => null }) }));

beforeEach(() => { qualify.mockReset(); });

it("waits for a delayed bundled manifest update before qualifying a volume-free image", async () => {
  let release!: () => void;
  let manifestUpdated = false;
  const manifestsReady = new Promise<void>(resolve => { release = () => { manifestUpdated = true; resolve(); }; });
  qualify.mockImplementation(async () => {
    expect(manifestUpdated).toBe(true);
    return { configurationPackagesEligible: true };
  });
  const result = qualifyCloudConfigurationForCurrentImage({} as Parameters<typeof qualifyCloudConfigurationForCurrentImage>[0], {
    runtimeEnv: { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-fixture" }, bundledManifestsReady: manifestsReady,
  });
  await Promise.resolve();
  expect(qualify).not.toHaveBeenCalled();
  release();
  await expect(result).resolves.toMatchObject({ configurationPackagesEligible: true });
  expect(qualify).toHaveBeenCalledTimes(1);
});

it("does not qualify when bundled manifest reconciliation rejects", async () => {
  await expect(qualifyCloudConfigurationForCurrentImage({} as Parameters<typeof qualifyCloudConfigurationForCurrentImage>[0], {
    runtimeEnv: { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-fixture" }, bundledManifestsReady: Promise.reject(new Error("refresh failed")),
  })).rejects.toThrow("refresh failed");
  expect(qualify).not.toHaveBeenCalled();
});
