import { describe, expect, it } from "vitest";
import {
  assertEnvironmentEventOrder,
  createEnvironmentTestHarness,
} from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import plugin from "./plugin.js";

describe("fake sandbox provider plugin", () => {
  it("runs a deterministic provider lifecycle through environment hooks", async () => {
    const definition = plugin.definition;
    const harness = createEnvironmentTestHarness({
      manifest,
      environmentDriver: {
        driverKey: "fake-plugin",
        onValidateConfig: definition.onEnvironmentValidateConfig,
        onProbe: definition.onEnvironmentProbe,
        onAcquireLease: definition.onEnvironmentAcquireLease,
        onResumeLease: definition.onEnvironmentResumeLease,
        onReleaseLease: definition.onEnvironmentReleaseLease,
        onDestroyLease: definition.onEnvironmentDestroyLease,
        onRealizeWorkspace: definition.onEnvironmentRealizeWorkspace,
        onExecute: definition.onEnvironmentExecute,
      },
    });
    const base = {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "env-1",
      config: { image: "fake:test", reuseLease: false },
    };

    const validation = await harness.validateConfig({
      driverKey: "fake-plugin",
      config: base.config,
    });
    expect(validation).toMatchObject({
      ok: true,
      normalizedConfig: { image: "fake:test", reuseLease: false },
    });

    const probe = await harness.probe(base);
    expect(probe).toMatchObject({
      ok: true,
      metadata: { provider: "fake-plugin", image: "fake:test" },
    });

    const lease = await harness.acquireLease({ ...base, runId: "run-1" });
    expect(lease.providerLeaseId).toContain("fake-plugin://run-1/");

    const realized = await harness.realizeWorkspace({
      ...base,
      lease,
      workspace: { mode: "isolated_workspace" },
    });
    expect(realized.cwd).toContain("paperclip-fake-sandbox-");

    const executed = await harness.execute({
      ...base,
      lease,
      command: "sh",
      args: ["-lc", "printf fake-plugin-ok"],
      cwd: realized.cwd,
      timeoutMs: 10_000,
    });
    expect(executed).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: "fake-plugin-ok",
    });

    await harness.destroyLease({
      ...base,
      providerLeaseId: lease.providerLeaseId,
    });

    assertEnvironmentEventOrder(harness.environmentEvents, [
      "validateConfig",
      "probe",
      "acquireLease",
      "realizeWorkspace",
      "execute",
      "destroyLease",
    ]);
  });

  it("does not expose host-only environment variables to executed commands", async () => {
    const previousSecret = process.env.PAPERCLIP_FAKE_PLUGIN_HOST_SECRET;
    process.env.PAPERCLIP_FAKE_PLUGIN_HOST_SECRET = "should-not-leak";
    try {
      const definition = plugin.definition;
      const harness = createEnvironmentTestHarness({
        manifest,
        environmentDriver: {
          driverKey: "fake-plugin",
          onAcquireLease: definition.onEnvironmentAcquireLease,
          onDestroyLease: definition.onEnvironmentDestroyLease,
          onRealizeWorkspace: definition.onEnvironmentRealizeWorkspace,
          onExecute: definition.onEnvironmentExecute,
        },
      });
      const base = {
        driverKey: "fake-plugin",
        companyId: "company-1",
        environmentId: "env-1",
        config: { image: "fake:test", reuseLease: false },
      };
      const lease = await harness.acquireLease({ ...base, runId: "run-1" });
      const realized = await harness.realizeWorkspace({
        ...base,
        lease,
        workspace: { mode: "isolated_workspace" },
      });

      const executed = await harness.execute({
        ...base,
        lease,
        command: "sh",
        args: ["-lc", "test -z \"${PAPERCLIP_FAKE_PLUGIN_HOST_SECRET+x}\" && printf \"$EXPLICIT_ONLY\""],
        cwd: realized.cwd,
        env: { EXPLICIT_ONLY: "visible" },
        timeoutMs: 10_000,
      });

      expect(executed).toMatchObject({
        exitCode: 0,
        timedOut: false,
        stdout: "visible",
      });

      await harness.destroyLease({
        ...base,
        providerLeaseId: lease.providerLeaseId,
      });
    } finally {
      if (previousSecret === undefined) {
        delete process.env.PAPERCLIP_FAKE_PLUGIN_HOST_SECRET;
      } else {
        process.env.PAPERCLIP_FAKE_PLUGIN_HOST_SECRET = previousSecret;
      }
    }
  });

  it("includes /usr/local/bin in the default PATH when no PATH override is provided", async () => {
    const definition = plugin.definition;
    const harness = createEnvironmentTestHarness({
      manifest,
      environmentDriver: {
        driverKey: "fake-plugin",
        onAcquireLease: definition.onEnvironmentAcquireLease,
        onDestroyLease: definition.onEnvironmentDestroyLease,
        onRealizeWorkspace: definition.onEnvironmentRealizeWorkspace,
        onExecute: definition.onEnvironmentExecute,
      },
    });
    const base = {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "env-1",
      config: { image: "fake:test", reuseLease: false },
    };
    const lease = await harness.acquireLease({ ...base, runId: "run-1" });
    const realized = await harness.realizeWorkspace({
      ...base,
      lease,
      workspace: { mode: "isolated_workspace" },
    });

    const executed = await harness.execute({
      ...base,
      lease,
      command: "sh",
      args: ["-lc", "printf %s \"$PATH\""],
      cwd: realized.cwd,
      timeoutMs: 10_000,
    });

    expect(executed.stdout).toContain("/usr/local/bin");

    await harness.destroyLease({
      ...base,
      providerLeaseId: lease.providerLeaseId,
    });
  });

  it("escalates to SIGKILL after timeout if the child ignores SIGTERM", async () => {
    const definition = plugin.definition;
    const harness = createEnvironmentTestHarness({
      manifest,
      environmentDriver: {
        driverKey: "fake-plugin",
        onAcquireLease: definition.onEnvironmentAcquireLease,
        onDestroyLease: definition.onEnvironmentDestroyLease,
        onRealizeWorkspace: definition.onEnvironmentRealizeWorkspace,
        onExecute: definition.onEnvironmentExecute,
      },
    });
    const base = {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "env-1",
      config: { image: "fake:test", reuseLease: false },
    };
    const lease = await harness.acquireLease({ ...base, runId: "run-1" });
    const realized = await harness.realizeWorkspace({
      ...base,
      lease,
      workspace: { mode: "isolated_workspace" },
    });

    const executed = await harness.execute({
      ...base,
      lease,
      command: "sh",
      args: ["-lc", "trap '' TERM; while :; do sleep 1; done"],
      cwd: realized.cwd,
      timeoutMs: 100,
    });

    expect(executed.timedOut).toBe(true);
    expect(executed.exitCode).toBeNull();

    await harness.destroyLease({
      ...base,
      providerLeaseId: lease.providerLeaseId,
    });
  });
});
