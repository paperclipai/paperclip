import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY } from "@paperclipai/adapter-utils";

const getGeneral = vi.fn();

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral }),
}));

const { readAdapterRunTimeoutPolicy, resetAdapterRunTimeoutPolicyCache } = await import(
  "../services/adapter-run-timeout.js"
);
const { readAdapterRunTimeoutPolicyFromEnv } = await import("@paperclipai/adapter-utils");

describe("readAdapterRunTimeoutPolicy", () => {
  beforeEach(() => {
    getGeneral.mockReset();
    getGeneral.mockResolvedValue({ adapterRunTimeoutSec: null });
    resetAdapterRunTimeoutPolicyCache();
  });

  it("has no policy when neither the instance setting nor the env var is set", async () => {
    expect(await readAdapterRunTimeoutPolicy({} as never, {})).toBeNull();
  });

  it("uses the instance setting ahead of the env var", async () => {
    getGeneral.mockResolvedValue({ adapterRunTimeoutSec: 7_200 });
    expect(
      await readAdapterRunTimeoutPolicy({} as never, { [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "900" }),
    ).toEqual({ timeoutSec: 7_200, source: "instance_default" });
  });

  it("falls back to the env var when the instance setting is null", async () => {
    expect(
      await readAdapterRunTimeoutPolicy({} as never, { [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "900" }),
    ).toEqual({ timeoutSec: 900, source: "env_default" });
  });

  it("keeps a negative instance setting as the deployment-level opt-out", async () => {
    getGeneral.mockResolvedValue({ adapterRunTimeoutSec: -1 });
    expect(
      await readAdapterRunTimeoutPolicy({} as never, { [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "900" }),
    ).toEqual({ timeoutSec: -1, source: "instance_default" });
  });

  it("treats a stored 0 as no policy rather than a wall clock or an opt-out", async () => {
    getGeneral.mockResolvedValue({ adapterRunTimeoutSec: 0 });
    expect(
      await readAdapterRunTimeoutPolicy({} as never, { [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "900" }),
    ).toEqual({ timeoutSec: 900, source: "env_default" });
  });

  it("fails open to the env var when the settings read throws", async () => {
    getGeneral.mockRejectedValue(new Error("db down"));
    expect(
      await readAdapterRunTimeoutPolicy({} as never, { [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "900" }),
    ).toEqual({ timeoutSec: 900, source: "env_default" });
  });

  it("reuses the last successfully read value instead of dropping the wall clock", async () => {
    getGeneral.mockResolvedValueOnce({ adapterRunTimeoutSec: 7_200 });
    expect(await readAdapterRunTimeoutPolicy({} as never, {})).toEqual({
      timeoutSec: 7_200,
      source: "instance_default",
    });

    getGeneral.mockRejectedValue(new Error("db down"));
    expect(await readAdapterRunTimeoutPolicy({} as never, {})).toEqual({
      timeoutSec: 7_200,
      source: "instance_default",
    });
  });

  it("does not resurrect a removed policy during a later read failure", async () => {
    getGeneral.mockResolvedValueOnce({ adapterRunTimeoutSec: 7_200 });
    await readAdapterRunTimeoutPolicy({} as never, {});
    getGeneral.mockResolvedValueOnce({ adapterRunTimeoutSec: null });
    expect(await readAdapterRunTimeoutPolicy({} as never, {})).toBeNull();

    getGeneral.mockRejectedValue(new Error("db down"));
    expect(
      await readAdapterRunTimeoutPolicy({} as never, { [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "900" }),
    ).toEqual({ timeoutSec: 900, source: "env_default" });
  });

  it("keeps the last known negative opt-out through a read failure", async () => {
    getGeneral.mockResolvedValueOnce({ adapterRunTimeoutSec: -1 });
    await readAdapterRunTimeoutPolicy({} as never, {});
    getGeneral.mockRejectedValue(new Error("db down"));
    expect(
      await readAdapterRunTimeoutPolicy({} as never, { [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "900" }),
    ).toEqual({ timeoutSec: -1, source: "instance_default" });
  });

  it("throws on a non-numeric env value so the host can refuse startup", async () => {
    await expect(
      readAdapterRunTimeoutPolicy({} as never, { [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "2h" }),
    ).rejects.toThrow(ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY);
  });
});

describe("readAdapterRunTimeoutPolicyFromEnv", () => {
  it("returns the env layer, and throws on an unparseable value", () => {
    expect(readAdapterRunTimeoutPolicyFromEnv({})).toBeNull();
    expect(
      readAdapterRunTimeoutPolicyFromEnv({ [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "-1" }),
    ).toEqual({ timeoutSec: -1, source: "env_default" });
    expect(() => readAdapterRunTimeoutPolicyFromEnv({ [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "soon" })).toThrow(
      ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY,
    );
  });
});
