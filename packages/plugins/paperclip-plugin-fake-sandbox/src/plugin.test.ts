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
        onStartInteractiveSetup: definition.onEnvironmentStartInteractiveSetup,
        onGetInteractiveSetup: definition.onEnvironmentGetInteractiveSetup,
        onCaptureTemplate: definition.onEnvironmentCaptureTemplate,
        onCancelInteractiveSetup: definition.onEnvironmentCancelInteractiveSetup,
        onDeleteTemplate: definition.onEnvironmentDeleteTemplate,
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

    const setup = await harness.startInteractiveSetup({
      ...base,
      sessionId: "setup-1",
      sourceTemplateRef: "source-template-secret",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(setup).toMatchObject({
      providerLeaseId: "fake-plugin-setup://env-1/setup-1",
      status: "waiting_for_user",
      connectionSummary: {
        type: "ssh",
        hostRedacted: true,
        portRedacted: true,
        commandRedacted: true,
      },
      connectionPayload: {
        type: "ssh",
        command: "ssh sandbox@[fake-setup-host-redacted] -p [fake-port-redacted]",
      },
      metadata: {
        provider: "fake-plugin",
        sourceTemplateRefRedacted: true,
      },
    });
    expect(JSON.stringify(setup.metadata)).not.toContain("source-template-secret");

    const status = await harness.getInteractiveSetup({
      ...base,
      providerLeaseId: setup.providerLeaseId,
      includeConnectionPayload: false,
    });
    expect(status).toMatchObject({
      status: "waiting_for_user",
      connectionPayload: null,
    });

    const captured = await harness.captureTemplate({
      ...base,
      providerLeaseId: setup.providerLeaseId,
      sourceTemplateRef: "source-template-secret",
      previousTemplateRef: "previous-template-secret",
      templateLabel: "ignored-by-fake",
    });
    expect(captured).toMatchObject({
      templateKind: "snapshot",
      templateRef: "fake-template:env-1:setup-1",
      metadata: {
        provider: "fake-plugin",
        sourceTemplateRefRedacted: true,
        previousTemplateRefRedacted: true,
        promoted: true,
      },
    });
    expect(JSON.stringify(captured.metadata)).not.toContain("source-template-secret");
    expect(JSON.stringify(captured.metadata)).not.toContain("previous-template-secret");

    const deleted = await harness.deleteTemplate({
      ...base,
      templateRef: captured.templateRef,
      templateKind: captured.templateKind,
    });
    expect(deleted).toMatchObject({
      deleted: true,
      metadata: {
        provider: "fake-plugin",
        templateKind: "snapshot",
      },
    });

    const cancelled = await harness.cancelInteractiveSetup({
      ...base,
      providerLeaseId: "fake-plugin-setup://env-1/setup-cancel",
      reason: "timed_out",
    });
    expect(cancelled).toMatchObject({
      status: "timed_out",
      metadata: {
        provider: "fake-plugin",
        found: false,
      },
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
      "startInteractiveSetup",
      "getInteractiveSetup",
      "captureTemplate",
      "deleteTemplate",
      "cancelInteractiveSetup",
      "destroyLease",
    ]);
  });

  it("supports deterministic interactive setup, template capture, refresh, and rollback cleanup hooks", async () => {
    const definition = plugin.definition;
    const harness = createEnvironmentTestHarness({
      manifest,
      environmentDriver: {
        driverKey: "fake-plugin",
        onStartInteractiveSetup: definition.onEnvironmentStartInteractiveSetup,
        onGetInteractiveSetup: definition.onEnvironmentGetInteractiveSetup,
        onCaptureTemplate: definition.onEnvironmentCaptureTemplate,
        onCancelInteractiveSetup: definition.onEnvironmentCancelInteractiveSetup,
        onDeleteTemplate: definition.onEnvironmentDeleteTemplate,
      },
    });
    const base = {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "env-setup",
      config: { image: "fake:setup", reuseLease: false },
    };

    const setup = await harness.startInteractiveSetup({
      ...base,
      sessionId: "session-1",
      sourceTemplateRef: "fake-template:base",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    expect(setup).toMatchObject({
      providerLeaseId: "fake-plugin-setup://env-setup/session-1",
      status: "waiting_for_user",
      connectionSummary: {
        type: "ssh",
        username: "sandbox",
        hostRedacted: true,
        portRedacted: true,
        commandRedacted: true,
      },
      connectionPayload: {
        type: "ssh",
        command: "ssh sandbox@[fake-setup-host-redacted] -p [fake-port-redacted]",
      },
      metadata: {
        provider: "fake-plugin",
        image: "fake:setup",
        sourceTemplateRefRedacted: true,
        redactedConnectionOnly: true,
      },
    });

    const status = await harness.getInteractiveSetup({
      ...base,
      providerLeaseId: setup.providerLeaseId,
      includeConnectionPayload: false,
    });
    expect(status.connectionPayload).toBeNull();
    expect(status.status).toBe("waiting_for_user");

    const captured = await harness.captureTemplate({
      ...base,
      providerLeaseId: setup.providerLeaseId,
      sourceTemplateRef: "fake-template:base",
      previousTemplateRef: null,
    });
    expect(captured).toEqual({
      templateRef: "fake-template:env-setup:session-1",
      templateKind: "snapshot",
      metadata: {
        provider: "fake-plugin",
        image: "fake:setup",
        sourceTemplateRefRedacted: true,
        previousTemplateRefRedacted: false,
        setupSessionId: "session-1",
        promoted: true,
      },
    });

    const promotedStatus = await harness.getInteractiveSetup({
      ...base,
      providerLeaseId: setup.providerLeaseId,
      includeConnectionPayload: true,
    });
    expect(promotedStatus.status).toBe("promoted");
    expect(promotedStatus.connectionPayload).toBeNull();

    const refresh = await harness.startInteractiveSetup({
      ...base,
      sessionId: "session-2",
      sourceTemplateRef: captured.templateRef,
    });
    const replacement = await harness.captureTemplate({
      ...base,
      providerLeaseId: refresh.providerLeaseId,
      sourceTemplateRef: captured.templateRef,
      previousTemplateRef: captured.templateRef,
    });
    expect(replacement).toMatchObject({
      templateRef: "fake-template:env-setup:session-2",
      templateKind: "snapshot",
      metadata: {
        sourceTemplateRefRedacted: true,
        previousTemplateRefRedacted: true,
      },
    });

    await expect(harness.deleteTemplate({
      ...base,
      templateRef: replacement.templateRef,
      templateKind: replacement.templateKind,
      reason: "rollback",
    })).resolves.toMatchObject({
      deleted: true,
      metadata: {
        provider: "fake-plugin",
        templateRef: replacement.templateRef,
        templateKind: "snapshot",
      },
    });

    const cancelSetup = await harness.startInteractiveSetup({
      ...base,
      sessionId: "session-cancel",
      sourceTemplateRef: captured.templateRef,
    });
    await expect(harness.cancelInteractiveSetup({
      ...base,
      providerLeaseId: cancelSetup.providerLeaseId,
      reason: "cancelled",
    })).resolves.toMatchObject({
      status: "cancelled",
      metadata: {
        provider: "fake-plugin",
        found: true,
      },
    });

    assertEnvironmentEventOrder(harness.environmentEvents, [
      "startInteractiveSetup",
      "getInteractiveSetup",
      "captureTemplate",
      "getInteractiveSetup",
      "startInteractiveSetup",
      "captureTemplate",
      "deleteTemplate",
      "startInteractiveSetup",
      "cancelInteractiveSetup",
    ]);
  });

  it("keeps fake setup and capture payloads free of real-looking secrets, hosts, and IPs", async () => {
    const definition = plugin.definition;
    const harness = createEnvironmentTestHarness({
      manifest,
      environmentDriver: {
        driverKey: "fake-plugin",
        onStartInteractiveSetup: definition.onEnvironmentStartInteractiveSetup,
        onCaptureTemplate: definition.onEnvironmentCaptureTemplate,
      },
    });
    const base = {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "env-redaction",
      config: { image: "fake:redaction", reuseLease: false },
    };

    const setup = await harness.startInteractiveSetup({
      ...base,
      sessionId: "session-redaction",
    });
    const captured = await harness.captureTemplate({
      ...base,
      providerLeaseId: setup.providerLeaseId,
    });
    const serialized = JSON.stringify({ setup, captured, events: harness.environmentEvents });

    expect(serialized).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(serialized).not.toMatch(/\blocalhost\b/i);
    expect(serialized).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(serialized).not.toMatch(/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret)[":=]/i);
    expect(serialized).toContain("[fake-setup-host-redacted]");
    expect(serialized).toContain("[fake-port-redacted]");
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
