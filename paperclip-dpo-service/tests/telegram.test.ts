import { describe, it, expect, vi } from "vitest";
import { postTelegram } from "../src/telegram.js";

describe("postTelegram", () => {
  it("POSTs to sendMessage with chat_id and text", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await postTelegram({
      botToken: "T", chatId: "42", text: "hello",
    }, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/botT/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ chat_id: "42", text: "hello", parse_mode: "Markdown" });
  });

  it("swallows errors (never throws)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("net"));
    await expect(
      postTelegram({ botToken: "T", chatId: "42", text: "x" }, fetchFn)
    ).resolves.toBeUndefined();
  });
});
