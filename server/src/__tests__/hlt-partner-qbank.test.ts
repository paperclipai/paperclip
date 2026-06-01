import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPartnerQBankQuestion } from "../services/hlt-partner-qbank.js";

describe("HLT Partner QBank client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a question by app and question id without exposing the token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ item: { id: 50067, question: "<p>Ovarian cancer spread?</p>" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const item = await fetchPartnerQBankQuestion({
      appId: 3,
      questionId: "50067",
      apiKey: "test-token",
    });

    expect(item).toMatchObject({ id: 50067, question: "<p>Ovarian cancer spread?</p>" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.hltcorp.com/api/partner/v1/mcp",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-mcp-token": "test-token",
        }),
        body: JSON.stringify({ action: "get_question", app_id: 3, id: "50067" }),
      }),
    );
  });

  it("fails closed when no Partner API token is configured", async () => {
    await expect(fetchPartnerQBankQuestion({ appId: 3, questionId: "50067", apiKey: undefined }))
      .rejects.toThrow("HLT Partner API token is not configured");
  });
});
