import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";

describe("company deletion configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { mode: "local_trusted", exposure: "private", setting: undefined, enabled: true },
    { mode: "local_trusted", exposure: "private", setting: "true", enabled: true },
    { mode: "local_trusted", exposure: "private", setting: "false", enabled: false },
    ...["private", "public"].flatMap((exposure) => [
      { mode: "authenticated", exposure, setting: undefined, enabled: false },
      { mode: "authenticated", exposure, setting: "true", enabled: true },
      { mode: "authenticated", exposure, setting: "false", enabled: false },
    ]),
  ])("$mode/$exposure with setting=$setting resolves to $enabled", ({ mode, exposure, setting, enabled }) => {
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", mode);
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_EXPOSURE", exposure);
    vi.stubEnv("PAPERCLIP_ENABLE_COMPANY_DELETION", setting);
    const config = loadConfig();
    expect(config.deploymentMode).toBe(mode);
    expect(config.deploymentExposure).toBe(exposure);
    expect(config.companyDeletionEnabled).toBe(enabled);
  });
});
