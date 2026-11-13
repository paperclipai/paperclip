import { describe, expect, it } from "vitest";
import { gradeGatewayCreate, requestedGateways } from "./external-gateways-profiles.js";

function observation(agentCreated = true) {
  const gateway = agentCreated
    ? { id: "gateway", companyId: "company", profileId: "profile", name: "Website", createdByAgentId: "ceo", tokens: [] as Array<{ pendingReveal?: boolean }> }
    : { id: "gateway", companyId: "company", profileId: "profile", name: "Website team tools", createdByAgentId: null, tokens: [] as Array<{ pendingReveal?: boolean }> };
  return { scenarioId: "gateways-profiles.create-gateway", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    reply: "Created the gateway. Open [Website](/COM/apps/gateways/gateway/overview).", phaseReplies: [], connections: [], profiles: [], secrets: [], endpoints: [], interactions: [],
    activity: [{ id: "event", entityId: "gateway", actorType: agentCreated ? "agent" : "user", action: "tool_gateway.created" }], links: [], runs: [], humanQueries: [],
    state: { profileId: "profile", gatewaysAfter: [gateway], gatewayCountBeforeHuman: agentCreated ? 1 : 0, ...(agentCreated ? { agentCreated: true } : { humanCreated: true }),
      linkedGateway: true, tokenScanComplete: true, tokensWithheld: true, tokenValueShapeSeen: false } as Record<string, unknown> };
}

describe("create-gateway oracle", () => {
  it("accepts an agent-created gateway under delegated authority and a person-created gateway", () => {
    expect(gradeGatewayCreate(observation(true)).passed).toBe(true);
    expect(gradeGatewayCreate(observation(false)).passed).toBe(true);
  });
  it("does not grade reply wording", () => {
    for (const reply of ["", "Done.", "I could not find the tools, but the gateway is ready."]) { const o = observation(); o.reply = reply; expect(gradeGatewayCreate(o).passed).toBe(true); }
  });
  it("accepts an agent-created token that still waits for the person's reveal", () => {
    const o = observation(); (o.state.gatewaysAfter as Array<{ tokens: Array<{ pendingReveal?: boolean }> }>)[0]!.tokens = [{ pendingReveal: true }];
    expect(gradeGatewayCreate(o).passed).toBe(true);
  });
  it("ignores Paperclip's own runtime gateway when counting requested gateways", () => {
    const native = { id: "native", metadata: { nativeRuntimeAssignmentDigest: "abc", agentId: "ceo" }, createdByAgentId: "ceo" };
    const requested = { id: "gateway", metadata: {}, createdByAgentId: "ceo" };
    expect(requestedGateways([native, requested]).map(row => row.id)).toEqual(["gateway"]);
    expect(requestedGateways([requested, { ...requested, id: "second", metadata: null }]).length).toBe(2);
  });
  it("rejects wrong scope, duplicates, unlinked results, wrong attribution and token values", () => {
    for (const mutate of [
      (o: ReturnType<typeof observation>) => { (o.state.gatewaysAfter as Array<{ companyId: string }>)[0]!.companyId = "other"; },
      (o: ReturnType<typeof observation>) => { (o.state.gatewaysAfter as Array<{ profileId: string }>)[0]!.profileId = "other"; },
      (o: ReturnType<typeof observation>) => { (o.state.gatewaysAfter as unknown[]).push({ ...(o.state.gatewaysAfter as object[])[0]!, id: "second" }); },
      (o: ReturnType<typeof observation>) => { (o.state.gatewaysAfter as Array<{ createdByAgentId: string | null }>)[0]!.createdByAgentId = "someone-else"; },
      (o: ReturnType<typeof observation>) => { o.state.linkedGateway = false; },
      (o: ReturnType<typeof observation>) => { o.activity = []; },
      (o: ReturnType<typeof observation>) => { o.activity[0]!.actorType = "user"; },
      (o: ReturnType<typeof observation>) => { o.state.tokensWithheld = false; },
      (o: ReturnType<typeof observation>) => { o.state.tokenValueShapeSeen = true; },
      (o: ReturnType<typeof observation>) => { o.state.tokenScanComplete = false; },
    ]) { const o = observation(); mutate(o); expect(gradeGatewayCreate(o).passed).toBe(false); }
    const human = observation(false); human.state.gatewayCountBeforeHuman = 1; expect(gradeGatewayCreate(human).passed).toBe(false);
  });
});
