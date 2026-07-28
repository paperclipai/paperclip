import { describe, expect, it } from "vitest";
import {
  isShadowRuntime,
  normalizeShadowSourceApi,
  resolveServerRuntimeInfo,
} from "../runtime-mode.js";

describe("runtime mode", () => {
  it("normalizes the shadow source API and detects shadow mode", () => {
    expect(normalizeShadowSourceApi(" http://127.0.0.1:3100/ ")).toBe("http://127.0.0.1:3100");
    expect(normalizeShadowSourceApi("   ")).toBeNull();
    expect(isShadowRuntime("http://127.0.0.1:3100")).toBe(true);
    expect(isShadowRuntime(undefined)).toBe(false);
  });

  it("forces scheduler and backup ownership to the source API in shadow mode", () => {
    expect(resolveServerRuntimeInfo({
      listenPort: 3101,
      shadowSourceApi: "http://127.0.0.1:3100",
      heartbeatSchedulerEnabled: true,
      databaseBackupEnabled: true,
    })).toEqual({
      role: "shadow",
      shadowSourceApi: "http://127.0.0.1:3100",
      shadowSourcePort: 3100,
      targetPort: 3101,
      scheduler: {
        enabled: false,
        owner: "source_api",
      },
      backups: {
        enabled: false,
        owner: "source_api",
      },
    });
  });

  it("keeps ownership local for primary runtimes", () => {
    expect(resolveServerRuntimeInfo({
      listenPort: 3100,
      heartbeatSchedulerEnabled: false,
      databaseBackupEnabled: true,
    })).toEqual({
      role: "primary",
      shadowSourceApi: null,
      shadowSourcePort: null,
      targetPort: 3100,
      scheduler: {
        enabled: false,
        owner: "local",
      },
      backups: {
        enabled: true,
        owner: "local",
      },
    });
  });
});
