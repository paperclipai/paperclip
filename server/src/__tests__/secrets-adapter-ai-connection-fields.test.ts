import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findActiveServerAdapter: vi.fn(), select: vi.fn() }));

vi.mock("../adapters/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/index.js")>()),
  findActiveServerAdapter: mocks.findActiveServerAdapter,
}));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ select: mocks.select }) }));

import { secretService } from "../services/secrets.js";

const companyId = "c0000000-0000-4000-8000-000000000001";
const binding = {
  mode: "shared", provider: "anthropic", method: "api_key",
  connectionId: "11111111-1111-4111-8111-111111111111", grantId: "21111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  mocks.select.mockReset();
  mocks.findActiveServerAdapter.mockReset();
  mocks.findActiveServerAdapter.mockReturnValue({
    getConfigSchema: async () => ({ fields: [
      { key: "judge", label: "Judge", type: "text", meta: { aiConnection: { harness: "claude_local", providers: ["anthropic"] } } },
    ] }),
  });
});

describe("normalizeAdapterConfigForPersistence with AI connection fields", () => {
  it("validates the bound connection for the acting user before saving", async () => {
    mocks.select.mockResolvedValue({ connection: { config: { ai: { provider: "anthropic", method: "api_key" } } } });
    const normalized = await secretService({} as never).normalizeAdapterConfigForPersistence(
      companyId, { judge: binding, other: 1 }, { adapterType: "ext", actor: { userId: "user-1" } });
    expect(normalized).toEqual({ judge: binding, other: 1 });
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", adapterType: "claude_local" }));
  });

  it("rejects an unusable connection with 422", async () => {
    mocks.select.mockResolvedValue({ connection: { config: { ai: { provider: "openai", method: "api_key" } } } });
    await expect(secretService({} as never).normalizeAdapterConfigForPersistence(
      companyId, { judge: binding }, { adapterType: "ext", actor: { userId: "user-1" } })).rejects.toMatchObject({ status: 422 });
  });
});
