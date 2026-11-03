import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  token: "ops_synthetic-worker-token",
  execute: vi.fn(),
  postMessage: vi.fn(),
}));

vi.mock("node:worker_threads", () => ({
  parentPort: { postMessage: fixture.postMessage },
  workerData: { token: fixture.token, tool: "onepassword_get_item", parameters: { vaultId: "a".repeat(26), itemId: "b".repeat(26) } },
}));
vi.mock("./sdk.js", () => ({ executeOnePasswordSdk: fixture.execute }));

describe("1Password worker results", () => {
  beforeEach(() => {
    vi.resetModules();
    fixture.execute.mockReset();
    fixture.postMessage.mockReset();
  });

  it("redacts every exact connection token in nested successful results before posting", async () => {
    fixture.execute.mockResolvedValue({
      title: "Synthetic item",
      fields: [{ value: `before ${fixture.token} after ${fixture.token}`, nested: { value: fixture.token } }],
      unchanged: "another item value",
    });

    await import("./worker.js");

    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ result: {
      title: "Synthetic item",
      fields: [{ value: "before [REDACTED] after [REDACTED]", nested: { value: "[REDACTED]" } }],
      unchanged: "another item value",
    } });
    expect(JSON.stringify(fixture.postMessage.mock.calls)).not.toContain(fixture.token);
  });

  it("rejects an oversized SDK result without posting its contents", async () => {
    fixture.execute.mockResolvedValue({ value: "x".repeat(1024 * 1024) });

    await import("./worker.js");

    expect(fixture.postMessage).toHaveBeenCalledTimes(1);
    const reply = fixture.postMessage.mock.calls[0]![0];
    expect("result" in reply).toBe(false);
    expect(reply).toEqual({ code: "onepassword_output_limit" });
  });
});
