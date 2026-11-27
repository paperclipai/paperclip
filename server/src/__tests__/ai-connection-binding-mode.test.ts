import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { readAiConnectionConfigurationFailure } from "../services/ai-connection-configuration-failure.js";
import { aiConnectionService } from "../services/ai-connections.js";

describe("AI connection binding mode guard", () => {
  it("rejects an unknown binding mode before it reads any connection", async () => {
    // Any database read fails the test: the guard must run first.
    const select = vi.fn(() => {
      throw new Error("unexpected database read");
    });
    const service = aiConnectionService({ select } as unknown as Db);
    const binding = {
      provider: "openai",
      method: "api_key",
      mode: "connection",
      connectionId: "11111111-1111-4111-8111-111111111111",
      grantId: "22222222-2222-4222-8222-222222222222",
    } as unknown as AiConnectionBinding;

    const error = await service.select({
      companyId: "33333333-3333-4333-8333-333333333333",
      userId: "user-1",
      agentId: "44444444-4444-4444-8444-444444444444",
      adapterType: "codex_local",
      binding,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 422 });
    expect(readAiConnectionConfigurationFailure(error)).toBe("ai_connection_incompatible");
    expect(select).not.toHaveBeenCalled();
  });
});
