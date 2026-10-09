import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareGrokRunnerCredentials } from "./grok-runner-credentials.js";

const { companyHome } = vi.hoisted(() => ({ companyHome: vi.fn() }));
vi.mock("@paperclipai/adapter-grok-local/server", () => ({
  resolveManagedGrokHomeDir: companyHome,
  grokHomeHasUsableAuth: async () => false,
}));
const roots: string[] = [];
async function home() { const root = await realpath(await mkdtemp(join(tmpdir(), "grok-controller-test-"))); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.clearAllMocks(); });

describe("Grok runner company credentials", () => {
  it("requires the company login for remote runs and never borrows a configured host home", async () => {
    const root = await home();
    companyHome.mockReturnValue(join(root, "company-without-login"));
    const host = join(root, "host"); await mkdir(host, { mode: 0o700 });
    await writeFile(join(host, "auth.json"), "host-secret", { mode: 0o600 });
    await expect(prepareGrokRunnerCredentials({ companyId: "test-company", remote: true, environment: { GROK_HOME: host, PAPERCLIP_HOME: host, PAPERCLIP_INSTANCE_ID: "other" } })).rejects.toThrow("subscription login is unavailable");
    expect(companyHome).toHaveBeenCalledWith(process.env, "test-company");
  });
  it("uses only an explicitly selected API key and strips subscription payloads and homes", async () => {
    expect(await prepareGrokRunnerCredentials({ companyId: "test-company", remote: true, environment: { XAI_API_KEY: "selected", GROK_HOME: "/host", PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: "stale" } })).toEqual({ environment: { XAI_API_KEY: "selected" }, home: null });
  });
  it("reads the controller-selected managed connection privately", async () => {
    const root = await home(); companyHome.mockReturnValue(join(root, "unused"));
    await writeFile(join(root, "auth.json"), '{"private":"fixture"}', { mode: 0o600 });
    const value = await prepareGrokRunnerCredentials({ companyId: "test-company", remote: true, managedHome: root, environment: { GROK_HOME: "/untrusted", XAI_API_KEY: "" } });
    expect(value).toEqual({ home: root, environment: { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: '{"private":"fixture"}' } });
  });
});
