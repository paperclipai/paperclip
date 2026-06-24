import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Re-import the module fresh in each test so its in-process cache does not leak.
async function loadService() {
  vi.resetModules();
  const mod = await import("../services/mail-diagnostics.ts");
  return mod.mailDiagnosticsService();
}

describe("mailDiagnosticsService.getReverseDnsStatus", () => {
  const prevHost = process.env.MAIL_HOSTNAME;
  const prevIp = process.env.MAIL_PUBLIC_IP;

  beforeEach(() => {
    delete process.env.MAIL_HOSTNAME;
    delete process.env.MAIL_PUBLIC_IP;
  });

  afterEach(() => {
    if (prevHost === undefined) delete process.env.MAIL_HOSTNAME;
    else process.env.MAIL_HOSTNAME = prevHost;
    if (prevIp === undefined) delete process.env.MAIL_PUBLIC_IP;
    else process.env.MAIL_PUBLIC_IP = prevIp;
  });

  it("reports `unconfigured` when MAIL_HOSTNAME is not set", async () => {
    const svc = await loadService();
    const status = await svc.getReverseDnsStatus();
    expect(status.status).toBe("unconfigured");
    expect(status.hostname).toBeNull();
    expect(status.ip).toBeNull();
    expect(status.fcrdns).toBe(false);
    expect(status.checkedAt).toEqual(expect.any(String));
  });
});
