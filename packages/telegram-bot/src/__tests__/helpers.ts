import { CodeStore } from "../state/code-store.js";
import { ReplyStore } from "../state/reply-store.js";
import { PaperclipClient, type FetchLike } from "../api/paperclip-client.js";
import type { CommandDeps, IncomingMessageContext } from "../commands/types.js";

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

export type MockFetch = FetchLike & {
  calls: RecordedRequest[];
};

export function mockFetch(
  responder: (req: RecordedRequest) => { status?: number; body?: unknown },
): MockFetch {
  const calls: RecordedRequest[] = [];
  const fn: FetchLike = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init.method ?? "GET").toString().toUpperCase();
    const rawHeaders = init.headers ?? {};
    const headers: Record<string, string> = {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    let body: unknown = undefined;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const recorded: RecordedRequest = { url, method, headers, body };
    calls.push(recorded);
    const out = responder(recorded);
    const status = out.status ?? 200;
    const text = out.body === undefined ? "" : JSON.stringify(out.body);
    return new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  (fn as MockFetch).calls = calls;
  return fn as MockFetch;
}

export function makeDeps(opts: {
  fetchImpl: FetchLike;
  companyId?: string;
}): CommandDeps {
  return {
    codeStore: new CodeStore(),
    replyStore: new ReplyStore(),
    client: new PaperclipClient({
      baseUrl: "http://test.local",
      apiKey: "bot-key",
      companyId: opts.companyId ?? "company-1",
      fetchImpl: opts.fetchImpl,
    }),
  };
}

export function makeCtx(
  text: string,
  overrides: Partial<IncomingMessageContext> = {},
): { ctx: IncomingMessageContext; replies: string[] } {
  const replies: string[] = [];
  const ctx: IncomingMessageContext = {
    chatId: "55555",
    tgUserId: "100",
    tgUsername: "dinar",
    text,
    replyToMessageId: null,
    reply: async (t) => {
      replies.push(t);
    },
    ...overrides,
  };
  return { ctx, replies };
}
