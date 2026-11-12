import { describe, expect, it } from "vitest";
import { parseSpekoDeliveryDiagnostics } from "../services/voice/speko-delivery-diagnostics.js";
const acceptedAt = "2026-10-09T13:39:14.340Z";
const deliveries = [{messageId: "msg_test", acceptedAt}];
function fixture() {
  const prompt = "Paperclip pushes approved task answers. private prompt credential";
  return {
    call: {id: "call_test", status: "ended", ended_at: "2026-10-09T13:39:36.000Z",
      recording_url: "https://private.example/recording", phone: "+12015551234", metadata: {token: "private-token"},
      pipeline_config: {kind: "s2s", systemPrompt: prompt, s2s: {systemPrompt: prompt, tools: [{name: "submit_request"}]},
        tools: [{name: "submit_request", source: {secret: "private-secret"}}, {name: "private-custom-tool"}],
        idleRePrompts: {enabled: true, delayMs: 5000, maxPrompts: 10, messages: ["private idle text"]}},
      report: {session_id: "call_test", updated_at: "2026-10-09T13:39:40.000Z", transcript: {entries: [
        {id: "before", index: 0, source: "agent", text: "private spoken answer", startedAt: "2026-10-09T13:39:09.000Z"},
        {id: "after1", index: 1, source: "agent", text: "I'm still working on it.", startedAt: "2026-10-09T13:39:16.637Z"},
        {id: "after2", index: 2, source: "agent", text: "I’m still working on it.", startedAt: "2026-10-09T13:39:24.420Z"},
      ]}}},
    events: {events: [
      {session_id: "call_test", event_type: "worker.duplex.started", occurred_at: "2026-10-09T13:38:13.882Z", payload: {data: {provider: "openai", model: "gpt-live-1", backendModel: "gpt-5.6-luna", sipInbound: true, toolCount: 3, token: "private-worker-token"}}},
      {session_id: "call_test", event_type: "call.message_sent", status: "pending", occurred_at: acceptedAt, payload: {messageId: "msg_test", text: "private result text", mode: "respond"}},
      {session_id: "call_test", event_type: "call.message_sent", status: "pending", payload: {messageId: "other_message", text: "another private result"}},
    ]},
  };
}
describe("Speko delivery diagnostics", () => {
  it("correlates message acceptance, worker configuration and idle speech without claiming playback", () => {
    const f = fixture(), result = parseSpekoDeliveryDiagnostics(f.call, f.events, "call_test", deliveries);
    expect(result).toMatchObject({transcriptComplete: true, agentTurnCount: 3,
      runtime: {model: "gpt-live-1", backendModel: "gpt-5.6-luna", sipInbound: true, fallbackObserved: false},
      configuration: {promptsMatch: true, automaticPushInstruction: true, topLevelTools: ["submit_request"], idleRepromptsEnabled: true, idleRepromptDelayMs: 5000},
      messages: [{messageId: "msg_test", providerMessageEventCount: 1, providerMessageEventStatus: "pending", agentTurnsAfterAcceptance: 2, workingRepromptsAfterAcceptance: 2, playback: "unknown"}]});
    const serialized = JSON.stringify(result);
    for (const forbidden of ["private", "+12015551234", "other_message", "still working"]) expect(serialized).not.toContain(forbidden);
  });
  it("rejects cross-call substitution in call detail or events", () => {
    const f = fixture();
    expect(() => parseSpekoDeliveryDiagnostics({...f.call, id: "other_call"}, f.events, "call_test", deliveries)).toThrow();
    expect(() => parseSpekoDeliveryDiagnostics(f.call, {events: [{session_id: "other_call", event_type: "call.message_sent"}]}, "call_test", deliveries)).toThrow();
  });
  it("does not infer playback or expose arbitrary status/model text from incomplete reports", () => {
    const result = parseSpekoDeliveryDiagnostics({id: "call_test", status: "private status", pipeline_config: {systemPrompt: "private prompt"}},
      {events: [{event_type: "worker.duplex.started", payload: {data: {model: "private model"}}}]}, "call_test", deliveries);
    expect(result).toMatchObject({callStatus: null, transcriptComplete: false, runtime: {model: null},
      messages: [{providerMessageEventCount: 0, agentTurnsAfterAcceptance: 0, playback: "unknown"}]});
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
