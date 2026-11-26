import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import {
  captureTelegramGenerationStopped,
  telegramGenerationStoppedReceipt,
  telegramPrivateDraftDestination,
  parseTelegramDraftBinding,
  isTelegramDraftStopped,
} from "./chat-telegram-draft-stop.js";

// Local qualification uses a physical candidate package, not a transport mock.
// Default/CI execution resolves the normally installed pinned dependency.
vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const candidate = process.env.PAPERCLIP_TELEGRAM_STOP_ADAPTER_MODULE;
  return candidate ? import(/* @vite-ignore */ candidate) : importOriginal();
});

describe("Telegram exact private draft Stop transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["before_draft", "during_draft", "before_final"] as const)(
    "does not send a permanent message after an owned stop (%s)",
    async (when) => {
      let stopped = when === "before_draft";
      const requests: Array<{ method: string; body: Record<string, unknown> }> =
        [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const method = new URL(String(url)).pathname.split("/").at(-1)!;
          const body = JSON.parse(String(init.body));
          requests.push({ method, body });
          if (method.endsWith("Draft") && when === "during_draft")
            stopped = true;
          return Response.json({
            ok: true,
            result: method.endsWith("Draft")
              ? true
              : {
                  message_id: 71,
                  date: 1,
                  chat: { id: 456, type: "private" },
                  from: { id: 123, is_bot: true, first_name: "Fixture" },
                  text: "Approved output",
                },
          });
        }),
      );
      const adapter = createTelegramAdapter({
        botToken: "123:synthetic",
        nativeStreaming: true,
        userName: "fixture_bot",
        secretToken: "synthetic",
      });
      const beforeDraft = vi.fn(async () => !stopped);
      const beforeFinal = vi.fn(
        async () => when !== "before_final" && !stopped,
      );
      async function* chunks() {
        yield "Approved output ";
        yield "complete tail";
      }
      const result = await adapter.stream("telegram:456:42", chunks(), {
        updateIntervalMs: 0,
        paperclipDraftControl: {
          version: 1,
          draftId: 1337,
          beforeDraft,
          beforeFinal,
        },
      } as never);
      expect(result).toEqual({ paperclipDraftStopped: true });
      expect(requests.every(({ method }) => method.endsWith("Draft"))).toBe(
        true,
      );
      expect(requests.length).toBe(
        when === "before_draft" ? 0 : when === "during_draft" ? 1 : 2,
      );
      for (const { body } of requests)
        expect(body).toMatchObject({
          draft_id: 1337,
          chat_id: "456",
          message_thread_id: 42,
          can_stop: true,
          keep_on_stop: false,
        });
      expect(beforeDraft).toHaveBeenCalled();
    },
  );

  it.each(["beforeDraft", "beforeFinal"] as const)(
    "propagates a failed durable %s decision without a final send",
    async (stage) => {
      const methods: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url) => {
          methods.push(new URL(String(url)).pathname.split("/").at(-1)!);
          return Response.json({ ok: true, result: true });
        }),
      );
      const adapter = createTelegramAdapter({
        botToken: "123:synthetic",
        nativeStreaming: true,
        userName: "fixture_bot",
      });
      async function* chunks() {
        yield "Approved output";
      }
      await expect(
        adapter.stream("telegram:456", chunks(), {
          paperclipDraftControl: {
            version: 1,
            draftId: 44,
            beforeDraft: async () => {
              if (stage === "beforeDraft")
                throw new Error("durable decision failed");
              return true;
            },
            beforeFinal: async () => {
              throw new Error("durable decision failed");
            },
          },
        } as never),
      ).rejects.toThrow("durable decision failed");
      expect(methods.every((method) => method.endsWith("Draft"))).toBe(true);
      expect(methods.length).toBe(stage === "beforeDraft" ? 0 : 1);
    },
  );

  it.each([0, -1, 2_147_483_648, NaN, "11"])(
    "rejects invalid draft identity %s before I/O",
    async (draftId) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const adapter = createTelegramAdapter({
        botToken: "123:synthetic",
        nativeStreaming: true,
        userName: "fixture_bot",
      });
      async function* chunks() {
        yield "Approved output";
      }
      await expect(
        adapter.stream("telegram:456", chunks(), {
          paperclipDraftControl: {
            version: 1,
            draftId,
            beforeDraft: async () => true,
            beforeFinal: async () => true,
          },
        } as never),
      ).rejects.toThrow("Invalid durable draft control");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("never interprets ordinary non-private streaming as a stoppable draft", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const adapter = createTelegramAdapter({
      botToken: "123:synthetic",
      nativeStreaming: true,
      userName: "fixture_bot",
    });
    async function* chunks() {
      yield "Approved output";
    }
    await expect(
      adapter.stream("telegram:-100456:42", chunks(), {
        paperclipDraftControl: {
          version: 1,
          draftId: 4,
          beforeDraft: async () => true,
          beforeFinal: async () => true,
        },
      } as never),
    ).rejects.toThrow("requires native private streaming");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Telegram private draft Stop binding", () => {
  const update = {
    update_id: 123,
    stopped_message_generation: {
      chat: { id: 456, type: "private" },
      draft_id: 789,
      message_thread_id: 42,
    },
  };
  it("retains only exact provider routing scalars, without actor or raw content authority", () => {
    const proof = captureTelegramGenerationStopped("123", {
      ...update,
      text: "PRIVATE",
    })!;
    expect(telegramGenerationStoppedReceipt(proof)).toEqual({
      botUserId: "123",
      updateId: 123,
      chatId: "456",
      draftId: 789,
      messageThreadId: 42,
    });
    expect(telegramGenerationStoppedReceipt({} as never)).toBeNull();
    expect(JSON.stringify(proof)).toBe("{}");
    expect(telegramPrivateDraftDestination("telegram:456:42")).toEqual({
      chatId: "456",
      messageThreadId: 42,
    });
    expect(
      isTelegramDraftStopped({ paperclipDraftStopped: true, id: "fake" }),
    ).toBe(false);
    expect(parseTelegramDraftBinding({})).toBeNull();
  });
  it.each([
    { chat: { id: -456, type: "supergroup" } },
    { chat: { id: 0, type: "private" } },
    { chat: { id: "456", type: "private" } },
    { draft_id: 0 },
    { draft_id: 2_147_483_648 },
    { message_thread_id: 0 },
    { message_thread_id: "42" },
  ])("refuses malformed/nonprivate provider Stop %j", (patch) => {
    expect(
      captureTelegramGenerationStopped("123", {
        ...update,
        stopped_message_generation: {
          ...update.stopped_message_generation,
          ...patch,
        },
      }),
    ).toBeNull();
  });
});
