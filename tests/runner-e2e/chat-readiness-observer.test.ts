import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerAdapterModule } from "../../server/src/adapters/types.js";
import { installChatReadinessObserver, readChatReadinessReceipts, readinessErrorCategory } from "./chat-readiness-observer.js";
const roots: string[] = [];
const companyId = "11111111-1111-4111-8111-111111111111";
const ids = ["chat-features.runner-opencode.local.create-backlog"];
const context = { companyId, adapterType: "paperclip_runner", config: { provider: "opencode", env: { PRIVATE_KEY: "private-config-canary" } } };
const result = () => ({ adapterType: "paperclip_runner", status: "fail" as const, testedAt: "2026-10-27T14:00:00Z",
  checks: [{ code: "opencode_hello_probe_failed", level: "error" as const, message: "OpenCode hello probe failed.",
    detail: "HTTP 429 private-provider-canary", hint: "private-hint-canary" }] });
async function fixture() {
  const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "readiness-observer-"))); roots.push(temporaryRoot);
  const testEnvironment = vi.fn(async () => result());
  const adapter = { testEnvironment } as Pick<ServerAdapterModule, "testEnvironment">;
  await installChatReadinessObserver({ executionIds: ids, temporaryRoot, adapter });
  return { temporaryRoot, adapter, testEnvironment, receipts: () => readChatReadinessReceipts(temporaryRoot, companyId) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe("transparent same-call readiness retention", () => {
  it("calls exactly once with the original args/this and returns the identical result", async () => {
    const f = await fixture(), original = result(); f.testEnvironment.mockResolvedValue(original);
    expect(await f.adapter.testEnvironment(context)).toBe(original);
    expect(f.testEnvironment).toHaveBeenCalledExactlyOnceWith(context);
    expect(f.testEnvironment.mock.contexts[0]).toBe(f.adapter);
    const receipts = await f.receipts();
    expect(receipts).toMatchObject([{ companyId, sequence: 1, status: "fail", thrown: false,
      checks: [{ code: "opencode_hello_probe_failed", level: "error", category: "rate-limit" }] }]);
    const bytes = await readFile(path.join(f.temporaryRoot, "artifacts-private", "chat-readiness-probes.jsonl"), "utf8");
    expect(bytes + JSON.stringify(receipts)).not.toMatch(/private-|detail|message|hint|env|config/);
    expect(receipts[0]).not.toHaveProperty("agentId");
  });
  it("accepts the existing launcher directory beneath its private root", async () => {
    const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "readiness-observer-"))); roots.push(temporaryRoot);
    await mkdir(path.join(temporaryRoot, "artifacts-private"), { mode: 0o755 });
    const adapter: Pick<ServerAdapterModule, "testEnvironment"> = { testEnvironment: vi.fn(async () => result()) };
    await installChatReadinessObserver({ executionIds: ids, temporaryRoot, adapter });
    await adapter.testEnvironment(context);
    expect(await readChatReadinessReceipts(temporaryRoot, companyId)).toHaveLength(1);
    await chmod(temporaryRoot, 0o755);
    await expect(installChatReadinessObserver({ executionIds: ids, temporaryRoot, adapter })).rejects.toThrow("owned private attempt root");
  });
  it("rethrows the identical error without another call or raw error output", async () => {
    const f = await fixture(), error = new Error("Cannot find package private-package-canary");
    f.testEnvironment.mockRejectedValue(error);
    await expect(f.adapter.testEnvironment(context)).rejects.toBe(error);
    expect(f.testEnvironment).toHaveBeenCalledTimes(1);
    expect(await f.receipts()).toMatchObject([{ status: "unknown", thrown: true, errorCategory: "module-missing" }]);
    expect(JSON.stringify(await f.receipts())).not.toContain("private-package-canary");
  });
  it("never replaces the original result when diagnostic storage fails", async () => {
    const f = await fixture(), original = result(); f.testEnvironment.mockResolvedValue(original);
    await writeFile(path.join(f.temporaryRoot, "artifacts-private", "chat-readiness-probes.jsonl"), "", { mode: 0o644 });
    expect(await f.adapter.testEnvironment(context)).toBe(original);
    expect(f.testEnvironment).toHaveBeenCalledTimes(1);
  });
  it("keeps sequence only within the attempt and filters foreign companies", async () => {
    const f = await fixture(); await f.adapter.testEnvironment(context); await f.adapter.testEnvironment(context);
    expect((await f.receipts()).map(row => row.sequence)).toEqual([1, 2]);
    expect(await readChatReadinessReceipts(f.temporaryRoot, "22222222-2222-4222-8222-222222222222")).toEqual([]);
  });
  it("reprojects arbitrary keys, status, codes and categories as unknown", async () => {
    const f = await fixture();
    await writeFile(path.join(f.temporaryRoot, "artifacts-private", "chat-readiness-probes.jsonl"), JSON.stringify({ schema: "paperclip.chat-readiness-probe/v1", companyId, sequence: 1,
      status: "private-status", secret: "private-extra", checks: [{ code: "private-code", level: "private-level", category: "private-category", detail: "private-detail" }] }));
    const receipts = await f.receipts();
    expect(receipts).toMatchObject([{ status: "unknown", checks: [{ code: "unknown", level: "unknown", category: "unknown" }] }]);
    expect(JSON.stringify(receipts)).not.toContain("private-");
  });
  it("does not observe an unrelated provider or execution", async () => {
    const f = await fixture(); await f.adapter.testEnvironment({ ...context, config: { provider: "codex" } });
    expect(await f.receipts()).toEqual([]);
    const original = vi.fn(async () => result()), adapter = { testEnvironment: original };
    await installChatReadinessObserver({ executionIds: ["other.runner-opencode.local.case"], temporaryRoot: "", adapter });
    expect(adapter.testEnvironment).toBe(original);
  });
  it.each([
    ["agent_runner_config_incompatible", "unknown"], ["paperclip_runner_mode_invalid", "unknown"], ["paperclip_runner_opencode_model_invalid", "unknown"],
  ])("preserves source profile-validation code %s without its message", async (code, category) => {
    const f = await fixture(); f.testEnvironment.mockResolvedValue({ ...result(), checks: [{ code, level: "error", message: "private-profile-canary", detail: "private-canary", hint: "private-canary" }] });
    await f.adapter.testEnvironment(context);
    expect((await f.receipts())[0]!.checks).toEqual([{ code, level: "error", category }]);
    expect(JSON.stringify(await f.receipts())).not.toContain("private-");
  });
  // Actual check.message/detail layouts emitted by opencode-local/server/test.ts:
  // summarizeProbeDetail selects parsed error, first stderr or first stdout line.
  it.each([
    ["opencode_command_unresolvable", "Command is not executable: ENOENT", "opencode", "command-missing"],
    ["opencode_openai_api_key_missing", "OPENAI_API_KEY override is empty.", "", "unknown"],
    ["opencode_hello_probe_auth_required", "OpenCode is installed, but provider authentication is not ready.", "HTTP 401 Unauthorized private-canary", "authentication"],
    ["opencode_hello_probe_model_unavailable", "The configured model was not found by the provider.", "ProviderModelNotFoundError private-canary", "model-unavailable"],
    ["opencode_hello_probe_failed", "OpenCode hello probe failed.", '{"name":"APIError","data":{"statusCode":429,"message":"private-canary"}}', "rate-limit"],
    ["opencode_hello_probe_failed", "OpenCode hello probe failed.", "fetch failed ECONNREFUSED private-canary", "network"],
    ["opencode_hello_probe_timed_out", "OpenCode hello probe timed out.", "", "timeout"],
    ["opencode_hello_probe_failed", "OpenCode hello probe failed.", "private-unknown-canary", "unknown"],
  ])("retains closed actual-source diagnostic shape %s/%s", async (code, message, detail, category) => {
    const f = await fixture(); f.testEnvironment.mockResolvedValue({ ...result(), checks: [{ code, level: "error", message, detail, hint: "private-hint-canary" }] });
    await f.adapter.testEnvironment(context);
    expect((await f.receipts())[0]!.checks).toEqual([{ code, level: "error", category }]);
    expect(JSON.stringify(await f.receipts())).not.toMatch(/private-|APIError|statusCode|detail|message|hint/);
  });
  it.each([
    ["HTTP 401 private", "authentication"], ["ECONNREFUSED private", "network"], ["EPERM private", "permission"],
    ["ENOENT private", "command-missing"], ["timed out private", "timeout"], ["unrecognized private", "unknown"],
  ])("classifies only a closed category for %s", (value, category) => expect(readinessErrorCategory(value)).toBe(category));
});
