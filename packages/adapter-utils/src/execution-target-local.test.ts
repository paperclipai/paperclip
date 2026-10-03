import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  formatAdapterExecutionTimeoutSummary,
  resolveAdapterExecutionTargetTimeout,
  resolveAdapterExecutionTargetTimeoutSec,
  type AdapterExecutionTargetTimeoutPolicy,
  type AdapterSshExecutionTarget,
} from "./execution-target.js";
import {
  ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY,
  parseAdapterRunTimeoutPolicySec,
  readAdapterRunTimeoutPolicyFromEnv,
  resolveAdapterRunTimeoutPolicy,
} from "./adapter-timeout-policy.js";

/**
 * Local/SSH run-timeout policy precedence. Before CON-307 these targets had
 * exactly two outcomes: an explicit per-agent `adapterConfig.timeoutSec` or
 * `{ timeoutSec: 0, source: "unlimited" }`, so every unconfigured agent ran
 * unbounded. The deployment policy (instance setting, else
 * `PAPERCLIP_ADAPTER_RUN_TIMEOUT_SEC`) now fills that gap as one value instead
 * of N per-agent rows.
 */
describe("resolveAdapterExecutionTargetTimeout for local and SSH targets", () => {
  const sshTarget: AdapterSshExecutionTarget = {
    kind: "remote",
    transport: "ssh",
    remoteCwd: "/workspace",
    spec: {
      host: "127.0.0.1",
      port: 22,
      username: "fixture",
      remoteWorkspacePath: "/workspace",
      remoteCwd: "/workspace",
      privateKey: "KEY",
      knownHosts: "host key",
      strictHostKeyChecking: true,
    },
  };
  const targets = [
    ["local", { kind: "local" } as const],
    ["ssh", sshTarget],
  ] as const;

  it("resolves an unset timeoutSec to the instance policy default, not 0", () => {
    for (const [label, target] of targets) {
      expect(
        resolveAdapterExecutionTargetTimeout(target, undefined, {
          timeoutSec: 7_200,
          source: "instance_default",
        }),
        label,
      ).toEqual({ timeoutSec: 7_200, source: "instance_default" });
      // The stored 0 that the adapter config UI persists for untouched fields
      // means the same as unset, so it also picks up the policy.
      expect(
        resolveAdapterExecutionTargetTimeout(target, 0, {
          timeoutSec: 7_200,
          source: "instance_default",
        }),
        label,
      ).toEqual({ timeoutSec: 7_200, source: "instance_default" });
    }
  });

  it("keeps the historical unlimited outcome when no policy is configured", () => {
    for (const [label, target] of targets) {
      expect(resolveAdapterExecutionTargetTimeout(target, undefined), label).toEqual({
        timeoutSec: 0,
        source: "unlimited",
      });
      expect(resolveAdapterExecutionTargetTimeout(target, 0, null), label).toEqual({
        timeoutSec: 0,
        source: "unlimited",
      });
      // A zero-valued policy carries no intent either, so it cannot be a
      // backdoor to unlimited-with-a-misleading-source.
      expect(
        resolveAdapterExecutionTargetTimeout(target, 0, {
          timeoutSec: 0,
          source: "instance_default",
        }),
        label,
      ).toEqual({ timeoutSec: 0, source: "unlimited" });
    }
  });

  it("keeps a positive per-agent timeoutSec ahead of the policy", () => {
    for (const [label, target] of targets) {
      expect(
        resolveAdapterExecutionTargetTimeout(target, 900, {
          timeoutSec: 7_200,
          source: "instance_default",
        }),
        label,
      ).toEqual({ timeoutSec: 900, source: "configured" });
    }
  });

  it("keeps a negative per-agent timeoutSec as the opt-out over the policy", () => {
    for (const [label, target] of targets) {
      expect(
        resolveAdapterExecutionTargetTimeout(target, -1, {
          timeoutSec: 7_200,
          source: "instance_default",
        }),
        label,
      ).toEqual({ timeoutSec: 0, source: "configured" });
    }
  });

  it("honors a negative policy value as the deployment-level opt-out", () => {
    for (const [label, target] of targets) {
      expect(
        resolveAdapterExecutionTargetTimeout(target, 0, {
          timeoutSec: -1,
          source: "env_default",
        }),
        label,
      ).toEqual({ timeoutSec: 0, source: "env_default" });
    }
  });

  it("applies the env-var policy identically to the instance policy", () => {
    expect(
      resolveAdapterExecutionTargetTimeout({ kind: "local" }, 0, {
        timeoutSec: 1_800,
        source: "env_default",
      }),
    ).toEqual({ timeoutSec: 1_800, source: "env_default" });
    expect(
      resolveAdapterExecutionTargetTimeoutSec({ kind: "local" }, 0, {
        timeoutSec: 1_800,
        source: "env_default",
      }),
    ).toBe(1_800);
  });

  it("preserves fractional configured values ahead of the policy", () => {
    expect(
      resolveAdapterExecutionTargetTimeout({ kind: "local" }, 0.5, {
        timeoutSec: 7_200,
        source: "instance_default",
      }),
    ).toEqual({ timeoutSec: 0.5, source: "configured" });
  });

  it("leaves sandbox targets on their transport default", () => {
    // The sandbox backstop is tied to the recovery watchdog's critical
    // threshold, so the policy does not rescale it.
    const sandboxTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
    } as unknown as Parameters<typeof resolveAdapterExecutionTargetTimeout>[0];
    expect(
      resolveAdapterExecutionTargetTimeout(sandboxTarget, 0, {
        timeoutSec: 7_200,
        source: "instance_default",
      }),
    ).toEqual({
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      source: "sandbox_default",
    });
    // A per-agent value still wins on sandbox targets, as before.
    expect(
      resolveAdapterExecutionTargetTimeout(sandboxTarget, 90, {
        timeoutSec: 7_200,
        source: "instance_default",
      }),
    ).toEqual({ timeoutSec: 90, source: "configured" });
  });

  it("turns a resolved timeout into the native run turn timeout", () => {
    // Native runs do not reach adapter.execute, so the server applies the
    // same chain to the turn wall clock instead. The clamp preserves today's
    // native behavior for an opted-out (negative) per-agent value, where 0
    // means "no turn timeout". This is the exact expression at the call site.
    const turnTimeoutMs = (
      configured: number | null | undefined,
      policy: AdapterExecutionTargetTimeoutPolicy | null,
    ) =>
      Math.max(
        0,
        resolveAdapterExecutionTargetTimeoutSec({ kind: "local" }, configured, policy),
      ) * 1_000;

    const policy: AdapterExecutionTargetTimeoutPolicy = {
      timeoutSec: 7_200,
      source: "instance_default",
    };
    // The policy is the floor for an unconfigured agent, and the per-agent
    // value still outranks it in both directions.
    expect(turnTimeoutMs(undefined, policy)).toBe(7_200_000);
    expect(turnTimeoutMs(0, policy)).toBe(7_200_000);
    expect(turnTimeoutMs(900, policy)).toBe(900_000);
    expect(turnTimeoutMs(-1, policy)).toBe(0);
    // An opted-out policy and no policy at all both leave the native run
    // without a turn timeout, exactly as before.
    expect(turnTimeoutMs(0, { timeoutSec: -1, source: "env_default" })).toBe(0);
    expect(turnTimeoutMs(0, null)).toBe(0);
  });
});

describe("adapter run-timeout policy sources", () => {
  it("prefers the instance setting over the env var", () => {
    expect(
      resolveAdapterRunTimeoutPolicy({ instanceSec: 7_200, envSec: 900 }),
    ).toEqual({ timeoutSec: 7_200, source: "instance_default" });
  });

  it("falls back to the env var when the instance setting is absent, null, or 0", () => {
    for (const instanceSec of [null, 0, undefined]) {
      expect(resolveAdapterRunTimeoutPolicy({ instanceSec, envSec: "900" })).toEqual({
        timeoutSec: 900,
        source: "env_default",
      });
    }
  });

  it("keeps a negative value from either layer as the opt-out", () => {
    expect(resolveAdapterRunTimeoutPolicy({ instanceSec: -1, envSec: 900 })).toEqual({
      timeoutSec: -1,
      source: "instance_default",
    });
    expect(resolveAdapterRunTimeoutPolicy({ envSec: "-1" })).toEqual({
      timeoutSec: -1,
      source: "env_default",
    });
  });

  it("returns no policy when neither layer is set", () => {
    expect(resolveAdapterRunTimeoutPolicy()).toBeNull();
    expect(resolveAdapterRunTimeoutPolicy({ instanceSec: null, envSec: null })).toBeNull();
  });

  it("reads the env layer by key and treats blank values as unset", () => {
    expect(readAdapterRunTimeoutPolicyFromEnv({ [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "7200" })).toEqual({
      timeoutSec: 7_200,
      source: "env_default",
    });
    expect(readAdapterRunTimeoutPolicyFromEnv({ [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "  " })).toBeNull();
    expect(readAdapterRunTimeoutPolicyFromEnv({})).toBeNull();
  });

  it("parses policy values, treating 0 and garbage-free blanks as unset", () => {
    expect(parseAdapterRunTimeoutPolicySec("7200")).toBe(7_200);
    expect(parseAdapterRunTimeoutPolicySec(" 900 ")).toBe(900);
    expect(parseAdapterRunTimeoutPolicySec("-1")).toBe(-1);
    expect(parseAdapterRunTimeoutPolicySec(0)).toBeNull();
    expect(parseAdapterRunTimeoutPolicySec("0")).toBeNull();
    expect(parseAdapterRunTimeoutPolicySec(undefined)).toBeNull();
    expect(parseAdapterRunTimeoutPolicySec(null)).toBeNull();
  });

  it("fails loudly on a non-numeric policy value instead of silently reverting to unlimited", () => {
    expect(() => parseAdapterRunTimeoutPolicySec("soon")).toThrow(ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY);
    expect(() => readAdapterRunTimeoutPolicyFromEnv({ [ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY]: "2h" })).toThrow(
      ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY,
    );
  });
});

describe("adapter timeout formatting names the policy source", () => {
  it("distinguishes a policy default from an explicit per-agent value", () => {
    const policyDefault = formatAdapterExecutionTimeoutSummary({
      timeoutSec: 7_200,
      source: "instance_default",
    });
    expect(policyDefault).toBe(
      "Adapter execution timeout: timeoutSec=7200 " +
        "(company/instance default adapterRunTimeoutSec; set adapterConfig.timeoutSec to override).",
    );
    const envDefault = formatAdapterExecutionTimeoutSummary({
      timeoutSec: 7_200,
      source: "env_default",
    });
    expect(envDefault).toBe(
      `Adapter execution timeout: timeoutSec=7200 ` +
        `(${ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY} override; set adapterConfig.timeoutSec to override).`,
    );
    // A run-start log can tell the policy apart from the same number an
    // operator typed on one agent.
    expect(
      formatAdapterExecutionTimeoutStartLogLine({ timeoutSec: 7_200, source: "configured" }),
    ).not.toBe(policyDefault);
  });

  it("names the policy layer when a run is killed by the policy wall clock", () => {
    expect(
      formatAdapterExecutionTimeoutErrorMessage({ timeoutSec: 7_200, source: "instance_default" }),
    ).toBe(
      "Run exceeded the adapter execution timeout (timeoutSec=7200, " +
        "company/instance default adapterRunTimeoutSec). Set adapterConfig.timeoutSec to raise it.",
    );
  });

  it("explains a negative policy value instead of reporting a bare timeout", () => {
    expect(
      formatAdapterExecutionTimeoutSummary({ timeoutSec: 0, source: "env_default" }),
    ).toBe(
      "Adapter execution timeout: none " +
        `(${ADAPTER_RUN_TIMEOUT_SEC_ENV_KEY} override is negative; set a positive value to add a wall clock).`,
    );
  });
});
