import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localRunnerConfinementPolicy, setLocalRunnerConfinementDatabasePort } from "./local-runner-confinement.js";

describe("localRunnerConfinementPolicy", () => {
  afterEach(() => {
    setLocalRunnerConfinementDatabasePort(null);
    vi.unstubAllEnvs();
  });

  it("confines local sessions by default to the instance, the company and away from the embedded database", () => {
    vi.stubEnv("PAPERCLIP_HOME", "/srv/paperclip-home");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("PAPERCLIP_LOCAL_AGENT_CONFINEMENT", "");
    setLocalRunnerConfinementDatabasePort(54331);
    expect(localRunnerConfinementPolicy("company-1")).toEqual({
      mode: "auto",
      instanceRoot: resolve("/srv/paperclip-home", "instances", "default"),
      companyId: "company-1",
      deniedLoopbackPorts: [54331],
    });
  });

  it("follows the operator's confinement mode and an external database", () => {
    vi.stubEnv("PAPERCLIP_LOCAL_AGENT_CONFINEMENT", "required");
    expect(localRunnerConfinementPolicy("company-1")).toMatchObject({ mode: "required", deniedLoopbackPorts: [] });
  });
});
