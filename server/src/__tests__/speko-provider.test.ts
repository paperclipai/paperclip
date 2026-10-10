import { describe, expect, it, vi } from "vitest";
import { createSpekoProvider, SpekoProviderError } from "../services/voice/speko-provider.js";
import { logger } from "../middleware/logger.js";
const input = { agentId: "agent_fixture", maxDurationSeconds: 600, bindingId: "binding_fixture", toolToken: "scoped-tool-token", systemPrompt: "Speak approved replies" };
const session = { sessionId: "session_fixture", transportToken: "short-lived-media-token", transportUrl: "wss://room.example.test" };
describe("Speko hosted provider transport", () => {
  it("returns only media credentials and scopes the tool secret outside model context", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ ...session, providerKey: "must-not-leak" }));
    expect(await createSpekoProvider("private-key", transport).createBrowserSession(input)).toEqual(session);
    const [url, options] = transport.mock.calls[0]!; expect(url).toBe("https://api.speko.dev/v1/sessions"); expect(options?.redirect).toBe("error");
    const body = JSON.parse(String(options?.body)); expect(body).toMatchObject({ mode: "cascade", firstMessage: "Hi, what would you like me to work on?", ttlSeconds: 120, maxDurationSeconds: 600, toolSecrets: { paperclip_session_token: "scoped-tool-token" } });
    expect(body.systemPrompt).not.toContain("scoped-tool-token");
    // The real browser-session endpoint rejects this agent-only field.
    expect(body).not.toHaveProperty("idleRePrompts");
  });
  it("classifies a credit rejection as definitive without replaying creation or exposing vendor text", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("private-key vendor credit detail", {status: 402}));
    await expect(createSpekoProvider("private-key", transport).createBrowserSession(input)).rejects.toMatchObject({code: "insufficient_credits", outcomeUnknown: false, httpStatus: 402, message: "Speko insufficient_credits"});
    expect(transport).toHaveBeenCalledOnce();
  });
  it("never retries an uncertain creation or includes raw provider errors", async () => {
    const transport = vi.fn<typeof fetch>(async () => { throw new Error("private-key vendor response"); });
    const error = await createSpekoProvider("private-key", transport).createBrowserSession(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpekoProviderError); expect(error).toMatchObject({ outcomeUnknown: true, code: "provider_unavailable" });
    expect(String(error)).not.toContain("private-key"); expect(transport).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 429])("classifies a rejected request without treating it as accepted (%s)", async (status) => {
    const transport = vi.fn<typeof fetch>(async () => new Response("private response", { status }));
    await expect(createSpekoProvider("key", transport).createBrowserSession(input)).rejects.toMatchObject({ outcomeUnknown: false, httpStatus: status });
  });
  it("marks a 5xx or malformed successful creation as uncertain", async () => {
    for (const response of [new Response("failure", { status: 500 }), Response.json({ sessionId: "s1" })]) {
      await expect(createSpekoProvider("key", async () => response).createBrowserSession(input)).rejects.toMatchObject({ outcomeUnknown: true });
    }
  });
  it("pushes a response with a receipt distinct from spoken playback", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({message_id: "msg_test"}, {status: 202}));
    expect(await createSpekoProvider("private-key", transport).sendCallMessage("call_test", "Approved answer")).toEqual({messageId: "msg_test"});
    expect(transport.mock.calls[0]![0]).toBe("https://api.speko.dev/v1/calls/call_test/messages");
    expect(JSON.parse(String(transport.mock.calls[0]![1]?.body))).toEqual({text: "Approved answer", mode: "respond"});
  });
  it("logs HTTP receipt/status/timing without logging headers, reply text or raw errors", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await createSpekoProvider("private-key", async () => Response.json({message_id: "msg_test"}, {status: 202})).sendCallMessage("call_test", "private answer");
      await expect(createSpekoProvider("private-key", async () => new Response("private-key raw error private answer", {status: 502})).sendCallMessage("call_test", "private answer")).rejects.toMatchObject({outcomeUnknown: true});
      expect(info).toHaveBeenCalledWith(expect.objectContaining({event: "voice.reply.push.http_accepted", providerSessionId: "call_test", messageId: "msg_test", httpStatus: 202, durationMs: expect.any(Number), playback: "unknown"}), expect.any(String));
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({event: "voice.reply.push.http_failed", httpStatus: 502, outcomeUnknown: true}), expect.any(String));
      expect(JSON.stringify([info.mock.calls, warn.mock.calls])).not.toContain("private");
    } finally { info.mockRestore(); warn.mockRestore(); }
  });
  it("reads only the bound call's diagnostic endpoints and treats malformed events as a safe read failure", async () => {
    const transport = vi.fn<typeof fetch>(async url => String(url).endsWith("/events") ? Response.json({events: [{session_id: "other_call", event_type: "call.message_sent"}]}) : Response.json({id: "call_test"}));
    await expect(createSpekoProvider("private-key", transport).callDeliveryDiagnostics("call_test", [{messageId: "msg_test", acceptedAt: "2026-10-09T13:39:14.340Z"}])).rejects.toMatchObject({code: "invalid_response", outcomeUnknown: false});
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.map(call => call[0])).toEqual(["https://api.speko.dev/v1/calls/call_test", "https://api.speko.dev/v1/calls/call_test/events"]);
  });
  it("classifies ended calls and uncertain message outcomes without retrying", async () => {
    for (const [response, expected] of [[new Response(null, {status: 409}), {httpStatus: 409, outcomeUnknown: false}], [Response.json({}), {outcomeUnknown: true}]] as const) {
      const transport = vi.fn<typeof fetch>(async () => response);
      await expect(createSpekoProvider("key", transport).sendCallMessage("call_test", "answer")).rejects.toMatchObject(expected);
      expect(transport).toHaveBeenCalledOnce();
    }
  });
  it("does not equate an end request with confirmed hangup", async () => {
    expect(await createSpekoProvider("key", async () => Response.json({ status: "ending" })).endSession("s1")).toEqual({ confirmed: false });
    expect(await createSpekoProvider("key", async () => Response.json({ status: "already_ended" })).endSession("s1")).toEqual({ confirmed: true });
  });
  it.each(["endedAt", "ended_at"])("reconciles the provider's %s call response", async (field) => {
    const ended = "2026-09-12T21:00:00.000Z";
    expect(await createSpekoProvider("key", async () => Response.json({ status: "ended", [field]: ended, transcript: "private" })).inspectSession("s1")).toEqual({ status: "ended", endedAt: ended });
  });
  it("rejects invalid duration and path substitution before network access", async () => {
    const transport = vi.fn<typeof fetch>(); const provider = createSpekoProvider("key", transport);
    await expect(provider.createBrowserSession({ ...input, maxDurationSeconds: 3600 })).rejects.toThrow();
    await expect(provider.endSession("../agents")).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
  });
  it("reads the actual wrapped webhook inventory and strips unrelated provider fields", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({data: [{id: "hook", url: "https://voice.example.test/events", events: ["call.pre_call"], allAgents: false, agentIds: ["agent"], filterTags: {}, authHeaders: [{name: "Authorization", configured: true}]}]}));
    expect(await createSpekoProvider("key", transport).listWebhooks()).toEqual([{id: "hook", url: "https://voice.example.test/events", events: ["call.pre_call"], allAgents: false, agentIds: ["agent"], filterTags: {}}]);
  });
  it("keeps browser defaults quiet and incoming calls realtime during owned setup", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({id: input.agentId}));
    await createSpekoProvider("key", transport).configureVoiceDefaults(input.agentId);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]![1]?.method).toBe("PATCH");
    const body = JSON.parse(String(transport.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({runMode: "s2s", idleRePrompts: {enabled: false}});
    expect(body.systemPrompt).toContain("Paperclip pushes approved task answers");
    expect(body.systemPrompt).toContain("do not call submit_request for it");
    expect(body.systemPrompt).toContain("submit_request exactly once");
    expect(body.systemPrompt).toContain("answer_question with its exact interaction and question IDs");
    expect(body.systemPrompt).toContain("Do not repeatedly poll while pending.");
  });
  it("uses the hosted phone endpoint with scoped secrets and returns no media or phone number", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ sessionId: "phone_test", status: "dialing", to: "+12015551234", callControlId: "private-control" }));
    expect(await createSpekoProvider("private-key", transport).createPhoneSession({ ...input, to: "+12015551234" })).toEqual({ sessionId: "phone_test", status: "dialing" });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]![0]).toBe("https://api.speko.dev/v1/sessions/phone");
    expect(JSON.parse(String(transport.mock.calls[0]![1]?.body))).toMatchObject({ runMode: "s2s", maxDurationSeconds: 600, toolSecrets: { paperclip_session_token: input.toolToken } });
  });
  it("validates phone parameters before changing the persona or placing a call", async () => {
    const transport = vi.fn<typeof fetch>(); const provider = createSpekoProvider("key", transport);
    for (const change of [{ to: "555" }, { maxDurationSeconds: 3600 }, { agentId: "../agents" }]) {
      await expect(provider.createPhoneSession({ ...input, to: "+12015551234", ...change })).rejects.toThrow();
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("refuses stub telephony and does not retry malformed or uncertain phone creation", async () => {
    for (const response of [Response.json({ sessionId: "phone_test", status: "dialing-stub" }), Response.json({ status: "dialing" }), new Response("private upstream", { status: 502 })]) {
      const transport = vi.fn<typeof fetch>(async () => response);
      await expect(createSpekoProvider("key", transport).createPhoneSession({ ...input, to: "+12015551234" })).rejects.toBeInstanceOf(SpekoProviderError);
      expect(transport).toHaveBeenCalledOnce();
    }
  });

});
