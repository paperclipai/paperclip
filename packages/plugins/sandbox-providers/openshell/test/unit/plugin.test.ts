import { describe, it, expect } from "vitest";
import plugin from "../../src/plugin.js";

describe("plugin", () => {
  it("exports all required environment driver hooks", () => {
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentValidateConfig).toBeTypeOf(
      "function"
    );
    expect(plugin.definition.onEnvironmentProbe).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentResumeLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentRealizeWorkspace).toBeTypeOf(
      "function"
    );
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentReleaseLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentDestroyLease).toBeTypeOf("function");
  });

  it("onHealth returns ok", async () => {
    const result = await plugin.definition.onHealth!();
    expect(result.status).toBe("ok");
  });

  describe("onEnvironmentValidateConfig", () => {
    const validate = plugin.definition.onEnvironmentValidateConfig!;

    it("accepts valid config with gatewayEndpoint", async () => {
      const result = await validate({
        driverKey: "openshell",
        config: { gatewayEndpoint: "openshell.openshell.svc:8080" },
      });
      expect(result.ok).toBe(true);
      expect(result.normalizedConfig).toEqual(
        expect.objectContaining({
          gatewayEndpoint: "openshell.openshell.svc:8080",
          useTls: true,
          gpu: false,
          timeoutSeconds: 3600,
          workspacePath: "/workspace",
        })
      );
    });

    it("rejects config without gatewayEndpoint", async () => {
      const result = await validate({
        driverKey: "openshell",
        config: {},
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it("rejects empty gatewayEndpoint", async () => {
      const result = await validate({
        driverKey: "openshell",
        config: { gatewayEndpoint: "" },
      });
      expect(result.ok).toBe(false);
    });

    it("normalizes defaults", async () => {
      const result = await validate({
        driverKey: "openshell",
        config: { gatewayEndpoint: "gw:8080" },
      });
      expect(result.ok).toBe(true);
      expect(result.normalizedConfig).toEqual(
        expect.objectContaining({
          sandboxImage:
            "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
          gpu: false,
          gpuCount: 1,
          timeoutSeconds: 3600,
          labels: {},
        })
      );
    });

    it("accepts full config with all optional fields", async () => {
      const result = await validate({
        driverKey: "openshell",
        config: {
          gatewayEndpoint: "gw:8080",
          useTls: true,
          caCert: "pem-data",
          sandboxImage: "custom:v1",
          workspacePath: "/work",
          gpu: true,
          gpuCount: 2,
          timeoutSeconds: 1800,
          labels: { team: "ai" },
        },
      });
      expect(result.ok).toBe(true);
      expect(result.normalizedConfig).toEqual(
        expect.objectContaining({
          gatewayEndpoint: "gw:8080",
          useTls: true,
          caCert: "pem-data",
          sandboxImage: "custom:v1",
          workspacePath: "/work",
          gpu: true,
          gpuCount: 2,
          timeoutSeconds: 1800,
          labels: { team: "ai" },
        })
      );
    });

    it("does not warn when TLS is enabled (default)", async () => {
      const result = await validate({
        driverKey: "openshell",
        config: { gatewayEndpoint: "gw:8080" },
      });
      expect(result.ok).toBe(true);
      expect(result.warnings).toBeUndefined();
    });

    it("rejects useTls=false without allowInsecure", async () => {
      const result = await validate({
        driverKey: "openshell",
        config: { gatewayEndpoint: "gw:8080", useTls: false },
      });
      expect(result.ok).toBe(false);
      expect(result.errors![0]).toContain("allowInsecure");
    });

    it("warns but allows useTls=false with allowInsecure=true", async () => {
      const result = await validate({
        driverKey: "openshell",
        config: {
          gatewayEndpoint: "gw:8080",
          useTls: false,
          allowInsecure: true,
        },
      });
      expect(result.ok).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some((w) => w.includes("plaintext"))).toBe(true);
    });

    it("rejects invalid timeoutSeconds", async () => {
      const result = await validate({
        driverKey: "openshell",
        config: { gatewayEndpoint: "gw:8080", timeoutSeconds: 0 },
      });
      expect(result.ok).toBe(false);
    });

    it("rejects invalid gpuCount", async () => {
      const result = await validate({
        driverKey: "openshell",
        config: { gatewayEndpoint: "gw:8080", gpuCount: 0 },
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("onEnvironmentRealizeWorkspace", () => {
    const realize = plugin.definition.onEnvironmentRealizeWorkspace!;

    it("returns configured workspace path", async () => {
      const result = await realize({
        driverKey: "openshell",
        companyId: "c1",
        environmentId: "e1",
        config: { gatewayEndpoint: "gw:8080", workspacePath: "/custom" },
        lease: { providerLeaseId: "pc-test", metadata: {} },
        workspace: {},
      } as any);
      expect(result.cwd).toBe("/custom");
    });

    it("returns default /workspace when no config", async () => {
      const result = await realize({
        driverKey: "openshell",
        companyId: "c1",
        environmentId: "e1",
        config: {},
        lease: { providerLeaseId: "pc-test", metadata: {} },
        workspace: {},
      } as any);
      expect(result.cwd).toBe("/workspace");
    });

    it("prefers remotePath from workspace params", async () => {
      const result = await realize({
        driverKey: "openshell",
        companyId: "c1",
        environmentId: "e1",
        config: { gatewayEndpoint: "gw:8080", workspacePath: "/config" },
        lease: { providerLeaseId: "pc-test", metadata: {} },
        workspace: { remotePath: "/from-params" },
      } as any);
      expect(result.cwd).toBe("/from-params");
    });
  });

  describe("onEnvironmentExecute with missing sandbox ID", () => {
    const execute = plugin.definition.onEnvironmentExecute!;

    it("returns error when lease has no sandboxId", async () => {
      const result = await execute({
        driverKey: "openshell",
        companyId: "c1",
        environmentId: "e1",
        config: { gatewayEndpoint: "gw:8080" },
        lease: { providerLeaseId: "pc-test", metadata: {} },
        command: "echo hello",
      } as any);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No sandbox ID");
    });
  });

  describe("onEnvironmentReleaseLease with no lease ID", () => {
    const release = plugin.definition.onEnvironmentReleaseLease!;

    it("returns immediately when providerLeaseId is null", async () => {
      await expect(
        release({
          driverKey: "openshell",
          companyId: "c1",
          environmentId: "e1",
          config: { gatewayEndpoint: "gw:8080" },
          providerLeaseId: null as any,
        } as any)
      ).resolves.toBeUndefined();
    });
  });

  describe("onEnvironmentDestroyLease with no lease ID", () => {
    const destroy = plugin.definition.onEnvironmentDestroyLease!;

    it("returns immediately when providerLeaseId is null", async () => {
      await expect(
        destroy({
          driverKey: "openshell",
          companyId: "c1",
          environmentId: "e1",
          config: { gatewayEndpoint: "gw:8080" },
          providerLeaseId: null as any,
        } as any)
      ).resolves.toBeUndefined();
    });
  });
});
