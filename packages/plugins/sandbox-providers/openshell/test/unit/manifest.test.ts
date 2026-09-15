import { describe, it, expect } from "vitest";
import manifest from "../../src/manifest.js";

describe("manifest", () => {
  it("has correct plugin identity", () => {
    expect(manifest.id).toBe("paperclip.openshell-sandbox-provider");
    expect(manifest.displayName).toBe("NVIDIA OpenShell Sandbox Provider");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("declares environment.drivers.register capability", () => {
    expect(manifest.capabilities).toContain("environment.drivers.register");
  });

  it("declares exactly one environment driver", () => {
    expect(manifest.environmentDrivers).toHaveLength(1);
  });

  it("declares openshell driver with correct shape", () => {
    const driver = manifest.environmentDrivers![0];
    expect(driver.driverKey).toBe("openshell");
    expect(driver.kind).toBe("sandbox_provider");
    expect(driver.displayName).toBe("NVIDIA OpenShell");
    expect(driver.configSchema).toBeDefined();
  });

  it("config schema requires gatewayEndpoint", () => {
    const schema = manifest.environmentDrivers![0].configSchema as any;
    expect(schema.required).toContain("gatewayEndpoint");
    expect(schema.properties.gatewayEndpoint.type).toBe("string");
  });

  it("config schema has caCert with secret-ref format", () => {
    const schema = manifest.environmentDrivers![0].configSchema as any;
    expect(schema.properties.caCert.format).toBe("secret-ref");
  });

  it("declares worker entrypoint", () => {
    expect(manifest.entrypoints?.worker).toBe("./dist/worker.js");
  });
});
