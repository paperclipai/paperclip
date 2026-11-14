import { describe, expect, it, vi } from "vitest";
import { acpxElicitationHandler, createAcpxPermissionReplyConfirmations, withReturnedResponseDelivery } from "./interaction-delivery.js";

const raw = (toolCallId: string) => ({ sessionId: "s", toolCall: { toolCallId } });
const options = [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }];
const request = (id: number, toolCallId = "tool-1") => ({ jsonrpc: "2.0", id, method: "session/request_permission", params: { ...raw(toolCallId), options } });
const selected = { outcome: { outcome: "selected", optionId: "allow" } };

async function settled(promise: Promise<void>): Promise<"resolved" | Error | "pending"> {
  return await Promise.race([
    promise.then(() => "resolved" as const, (error: Error) => error),
    new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 5)),
  ]);
}

describe("ACP permission reply confirmation", () => {
  it("resolves only when ACPX writes the selected decision as the exact request's reply", async () => {
    const replies = createAcpxPermissionReplyConfirmations();
    replies.observe("inbound", request(4));
    const binding = replies.bind({ sessionId: "s", raw: raw("tool-1") }, new AbortController().signal);
    binding.select({ outcome: "allow_once" });
    replies.observe("outbound", { jsonrpc: "2.0", id: 9, result: selected });
    expect(await settled(binding.delivery)).toBe("pending");
    replies.observe("outbound", { jsonrpc: "2.0", id: 4, result: selected });
    expect(await settled(binding.delivery)).toBe("resolved");
  });

  it.each([
    ["an error reply", { jsonrpc: "2.0", id: 4, error: { code: -32603, message: "failed" } }, /error instead/],
    ["a cancellation in place of the decision", { jsonrpc: "2.0", id: 4, result: { outcome: { outcome: "cancelled" } } }, /changed the selected/],
    ["another offered option", { jsonrpc: "2.0", id: 4, result: { outcome: { outcome: "selected", optionId: "deny" } } }, /changed the selected/],
    ["an option that was not offered", { jsonrpc: "2.0", id: 4, result: { outcome: { outcome: "selected", optionId: "elsewhere" } } }, /changed the selected/],
    ["an empty result", { jsonrpc: "2.0", id: 4, result: {} }, /changed the selected/],
  ])("rejects %s", async (_label, reply, error) => {
    const replies = createAcpxPermissionReplyConfirmations();
    replies.observe("inbound", request(4));
    const binding = replies.bind({ sessionId: "s", raw: raw("tool-1") }, new AbortController().signal);
    binding.select({ outcome: "allow_once" });
    replies.observe("outbound", reply);
    await expect(binding.delivery).rejects.toThrow(error);
  });

  it("rejects an allow written for a deny decision, and accepts the exact option id", async () => {
    const replies = createAcpxPermissionReplyConfirmations();
    replies.observe("inbound", request(4));
    const deny = replies.bind({ sessionId: "s", raw: raw("tool-1") }, new AbortController().signal);
    deny.select({ outcome: "reject_once" });
    replies.observe("outbound", { jsonrpc: "2.0", id: 4, result: selected });
    await expect(deny.delivery).rejects.toThrow(/changed the selected/);
    replies.observe("inbound", request(5, "tool-2"));
    const exact = replies.bind({ sessionId: "s", raw: raw("tool-2") }, new AbortController().signal);
    exact.select({ outcome: "selected", optionId: "deny" });
    replies.observe("outbound", { jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "selected", optionId: "deny" } } });
    await expect(exact.delivery).resolves.toBeUndefined();
  });

  it("accepts a cancelled reply when the host cancelled", async () => {
    const replies = createAcpxPermissionReplyConfirmations();
    replies.observe("inbound", request(4));
    const binding = replies.bind({ sessionId: "s", raw: raw("tool-1") }, new AbortController().signal);
    binding.select({ outcome: "cancel" });
    replies.observe("outbound", { jsonrpc: "2.0", id: 4, result: { outcome: { outcome: "cancelled" } } });
    await expect(binding.delivery).resolves.toBeUndefined();
  });

  it("fails closed for an unknown or ambiguous provider request", async () => {
    const replies = createAcpxPermissionReplyConfirmations();
    const unknown = replies.bind({ sessionId: "s", raw: raw("tool-1") }, new AbortController().signal);
    await expect(unknown.delivery).rejects.toThrow(/no unique provider request id/);
    replies.observe("inbound", request(1, "tool-2"));
    replies.observe("inbound", request(2, "tool-2"));
    const ambiguous = replies.bind({ sessionId: "s", raw: raw("tool-2") }, new AbortController().signal);
    await expect(ambiguous.delivery).rejects.toThrow(/no unique provider request id/);
  });

  it("rejects when the turn aborts, the callback fails, or no reply is written", async () => {
    vi.useFakeTimers();
    try {
      const replies = createAcpxPermissionReplyConfirmations({ replyTimeoutMs: 50 });
      replies.observe("inbound", request(1, "a"));
      replies.observe("inbound", request(2, "b"));
      replies.observe("inbound", request(3, "c"));
      const controller = new AbortController();
      const aborted = replies.bind({ sessionId: "s", raw: raw("a") }, controller.signal);
      controller.abort();
      await expect(aborted.delivery).rejects.toThrow(/cancelled or disconnected/);
      const failed = replies.bind({ sessionId: "s", raw: raw("b") }, new AbortController().signal);
      failed.fail(new Error("callback failed"));
      await expect(failed.delivery).rejects.toThrow("callback failed");
      const unwritten = replies.bind({ sessionId: "s", raw: raw("c") }, new AbortController().signal);
      unwritten.select({ outcome: "allow_once" });
      const rejection = expect(unwritten.delivery).rejects.toThrow(/not written/);
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets requests ACPX answers from its own policy", async () => {
    const replies = createAcpxPermissionReplyConfirmations();
    replies.observe("inbound", request(1));
    replies.observe("outbound", { jsonrpc: "2.0", id: 1, result: selected });
    replies.observe("inbound", request(2));
    const binding = replies.bind({ sessionId: "s", raw: raw("tool-1") }, new AbortController().signal);
    binding.select({ outcome: "allow_once" });
    replies.observe("outbound", { jsonrpc: "2.0", id: 2, result: selected });
    await expect(binding.delivery).resolves.toBeUndefined();
  });
});

describe("returned response delivery", () => {
  it("resolves after the callback returns and rejects when it fails", async () => {
    let receipt!: Promise<void>;
    let delivered = false;
    const value = withReturnedResponseDelivery(async (responseDelivery) => {
      receipt = responseDelivery;
      void responseDelivery.then(() => { delivered = true; });
      await Promise.resolve();
      expect(delivered).toBe(false);
      return "answer";
    });
    await expect(value).resolves.toBe("answer");
    await expect(receipt).resolves.toBeUndefined();

    let failedReceipt!: Promise<void>;
    await expect(withReturnedResponseDelivery(async (responseDelivery) => {
      failedReceipt = responseDelivery;
      throw new Error("declined");
    })).rejects.toThrow("declined");
    await expect(failedReceipt).rejects.toThrow(/before its response was handed to ACPX/);
  });

  it("rejects delivery when the accepted response is refused", async () => {
    let receipt!: Promise<void>;
    await expect(withReturnedResponseDelivery(async (responseDelivery) => { receipt = responseDelivery; return 1; }, () => {
      throw new Error("turn expired");
    })).rejects.toThrow("turn expired");
    await expect(receipt).rejects.toThrow();
  });

  it("adapts a Runner elicitation callback to the stock ACPX callback", async () => {
    const handler = vi.fn(async (_request: unknown, context: { responseDelivery: Promise<void> }) => {
      expect(context.responseDelivery).toBeInstanceOf(Promise);
      return { action: "cancel" as const };
    });
    const stock = acpxElicitationHandler(handler as never);
    await expect(stock({} as never, { requestId: 1, signal: new AbortController().signal })).resolves.toEqual({ action: "cancel" });
    expect(handler).toHaveBeenCalledOnce();
  });
});
