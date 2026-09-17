import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ ssh: vi.fn() }));
vi.mock("../../packages/plugins/sandbox-providers/exe-dev/src/transport.js", () => ({ ssh: mocks.ssh, quote: (value: string) => `'${value}'` }));
import { cleanupExeFixture } from "./exe-cleanup.js";
const fixture = { vmName: "paperclip-e2e-0123456789abcdef0123", companyId: "company", environmentId: "environment", sshPrivateKey: "test-key" };
beforeEach(() => mocks.ssh.mockReset());
it("refuses an unrelated name before connecting", async () => {
  await expect(cleanupExeFixture({ ...fixture, vmName: "personal-server" })).rejects.toThrow("non-campaign");
  expect(mocks.ssh).not.toHaveBeenCalled();
});
it("refuses a matching name owned by another fixture", async () => {
  mocks.ssh.mockResolvedValue(JSON.stringify({ vms: [{ vm_name: fixture.vmName, tags: ["other"] }] }));
  await expect(cleanupExeFixture(fixture)).rejects.toThrow("ownership tag");
  expect(mocks.ssh).toHaveBeenCalledTimes(1);
});
it("deletes only an owned VM and verifies its absence", async () => {
  const tag = "paperclip-" + createHash("sha256").update("company\0environment").digest("hex").slice(0, 32);
  mocks.ssh.mockResolvedValueOnce(JSON.stringify({ vms: [{ vm_name: fixture.vmName, tags: [tag] }] })).mockResolvedValueOnce("{}").mockResolvedValueOnce('{"vms":[]}');
  await cleanupExeFixture(fixture);
  expect(mocks.ssh.mock.calls[1][2]).toBe(`rm --json '${fixture.vmName}'`);
  expect(mocks.ssh).toHaveBeenCalledTimes(3);
});
it("is idempotent when normal teardown already removed the VM", async () => {
  mocks.ssh.mockResolvedValue('{"vms":[]}');
  await cleanupExeFixture(fixture);
  expect(mocks.ssh).toHaveBeenCalledTimes(1);
});
