import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { teamBindingCandidate, teamConfigureExternalCases, type TeamBindingApproval } from "./external-team-configure.js";
function valid() {
  return { scenarioId: "teams.configure-team", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", connections: [], profiles: [], secrets: [], endpoints: [], interactions: [], tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], links: [],
    reply: "QA has been configured and each team member is ready.", phaseReplies: [{ runId: "initial", body: "QA needs the eligible account; open QA configuration." }, { runId: "verified", body: "QA and the senior coder are now configured and ready." }], runs: [{ id: "initial", status: "succeeded" }, { id: "verified", status: "succeeded" }],
    activity: [{ id: "repair", action: "agent.updated", actorType: "user", entityId: "qa", agentId: null as string | null }], state: {
      installedFromCatalog: true, missingId: "qa", workingId: "coder", expectedMembers: 2, memberIdsBefore: ["coder", "qa"], workingRevisionIdsBefore: ["revision"], workingRevisionIdsAfter: ["revision"],
      initialProbes: [{ agentId: "qa", status: "fail", testedAt: "2026-10-26T10:00:00Z", checks: [{ code: "codex_auth", level: "error" }] }, { agentId: "coder", status: "pass", testedAt: "2026-10-26T10:00:00Z", checks: [] }],
      afterProbes: [{ agentId: "qa", status: "pass", testedAt: "2026-10-26T10:05:01Z", checks: [] }, { agentId: "coder", status: "pass", testedAt: "2026-10-26T10:05:02Z", checks: [] }],
      repairVerifiedAfter: Date.parse("2026-10-26T10:05:00Z"), initialHandoffSupported: true, repairConfirmed: true, repairChannel: "human-board-configuration", workingHashBefore: "same-config", workingHashAfter: "same-config", memberIdsPreserved: true, initialRunId: "initial", preVerificationRunIds: ["initial"],
    } };
}
describe("installed team per-member readiness oracle", () => {
  const definition = teamConfigureExternalCases[0]!;
  it("accepts real missing-account diagnosis, human repair and fresh separate readiness checks", () => { expect(definition.grade(valid()).passed).toBe(true); });
  it("accepts the exact OpenCode missing-auth warning without treating the member as ready", () => {
    const o = valid(); o.state.initialProbes[0]!.status = "warn"; o.state.initialProbes[0]!.checks = [{ code: "opencode_hello_probe_auth_required", level: "warn" }];
    expect(definition.grade(o).passed).toBe(true);
    o.state.afterProbes[0]!.status = "warn";
    expect(definition.grade(o).passed).toBe(false);
  });
  it("also accepts an actually attributed eligible agent configuration repair", () => { const o = valid(); o.state.repairChannel = "agent-configuration"; o.activity[0]!.actorType = "agent"; o.activity[0]!.agentId = "ceo"; expect(definition.grade(o).passed).toBe(true); });
  it("rejects stale/member-substituted readiness, unrelated config edits and premature success", () => {
    for (const change of [
      (o: ReturnType<typeof valid>) => { o.state.afterProbes[0]!.testedAt = "2026-10-26T09:00:00Z"; },
      (o: ReturnType<typeof valid>) => { o.state.afterProbes[0]!.status = "fail"; },
      (o: ReturnType<typeof valid>) => { o.state.afterProbes[0]!.agentId = "coder"; },
      (o: ReturnType<typeof valid>) => { o.state.initialProbes[0]!.agentId = "other-member"; },
      (o: ReturnType<typeof valid>) => { o.state.workingHashAfter = "changed-working-account"; },
      (o: ReturnType<typeof valid>) => { o.state.workingRevisionIdsAfter = ["masked-env-change"]; },
      (o: ReturnType<typeof valid>) => { o.state.initialHandoffSupported = false; },
      (o: ReturnType<typeof valid>) => { o.phaseReplies[1]!.body = "  "; },
      (o: ReturnType<typeof valid>) => { o.runs[1]!.status = "failed"; },
      (o: ReturnType<typeof valid>) => { o.phaseReplies[1]!.runId = "initial"; },
    ]) { const o = valid(); change(o); expect(definition.grade(o).passed).toBe(false); }
  });
  it("grades the followup structurally, not by its wording", () => {
    for (const body of ["Both QA and the senior coder pass their own checks now.", "Fertig: alle Mitglieder bestehen ihre Prüfung."]) {
      const o = valid(); o.phaseReplies[1]!.body = body; o.reply = body; expect(definition.grade(o).passed).toBe(true);
    }
  });
  it("missing observations cannot pass", () => { expect(definition.grade(undefined).passed).toBe(false); expect(definition.grade({ reply: "Everyone is ready." }).passed).toBe(false); });
});

const cardPayload = { version: 1, prompt: "Bind?", secretProposal: { version: 1, proposalId: "proposal", sourceSecretLabel: "OpenRouter", configPath: "env.OPENROUTER_API_KEY", targetAgentId: "qa", targetAgentName: "QA", justification: "x", expiresAt: "2026-12-01T00:00:00Z" } };
function card(overrides: Record<string, unknown> = {}) {
  return { id: "card", companyId: "company", issueId: "source", kind: "request_confirmation", status: "pending", sourceRunId: "initial", createdByAgentId: "ceo", createdByUserId: null, addresseeAgentId: null,
    resolvedByUserId: null as string | null, resolvedByAgentId: null as string | null, requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", idempotencyKey: "secret-proposal:proposal", payload: structuredClone(cardPayload), ...overrides };
}
function proposal(overrides: Record<string, unknown> = {}) {
  return { id: "proposal", companyId: "company", kind: "binding", status: "pending", secretId: "openrouter-secret", secretProposalId: null, targetType: "agent", target: { id: "qa" },
    configPath: "env.OPENROUTER_API_KEY", originRunId: "initial", proposedBy: { id: "ceo" }, ...overrides };
}
function candidate(cards: unknown[], proposals: unknown[]) {
  return teamBindingCandidate({ interactions: cards as never, proposals: proposals as never, companyId: "company", issueId: "source", leadId: "ceo", initialRunId: "initial", missingId: "qa",
    eligible: [{ configPath: "env.OPENROUTER_API_KEY", secretId: "openrouter-secret" }] });
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function bindingValid() {
  const o = valid(), marker: TeamBindingApproval = { interactionId: "card", proposalId: "proposal", configPath: "env.OPENROUTER_API_KEY", secretId: "openrouter-secret", targetAgentId: "qa", payloadHash: hash(cardPayload) };
  return { ...o, activity: [] as typeof o.activity, interactions: [card({ status: "accepted", resolvedByUserId: "person" })],
    runs: [...o.runs, { id: "wake", status: "succeeded" }], phaseReplies: [o.phaseReplies[0]!, { runId: "wake", body: "QA is now bound to the company account." }, o.phaseReplies[1]!],
    state: { ...o.state, preVerificationRunIds: ["initial", "wake"], repairChannel: "human-approved-binding", bindingApproval: marker, currentUserId: "person",
      bindingsBefore: ["agent:coder:env.OPENROUTER_API_KEY", "agent:ceo:env.OPENROUTER_API_KEY"], bindingsAfter: ["agent:ceo:env.OPENROUTER_API_KEY", "agent:coder:env.OPENROUTER_API_KEY", "agent:qa:env.OPENROUTER_API_KEY"],
      missingBindingRef: { type: "secret_ref", secretId: "openrouter-secret" } } };
}
describe("governed binding approval path", () => {
  const definition = teamConfigureExternalCases[0]!;
  it("selects only the lead's pending human-only card binding the eligible account to the missing member", () => {
    expect(candidate([card()], [proposal()])).toMatchObject({ interactionId: "card", configPath: "env.OPENROUTER_API_KEY", secretId: "openrouter-secret", targetAgentId: "qa" });
    for (const [cards, proposals] of [
      [[card({ payload: { ...cardPayload, secretProposal: { ...cardPayload.secretProposal, targetAgentId: "coder" } } })], [proposal({ target: { id: "coder" } })]],
      [[card()], [proposal({ secretId: "other-secret" })]],
      [[card()], [proposal({ configPath: "env.OTHER_KEY" })]],
      [[card({ resolvedByAgentId: "ceo", status: "accepted" })], [proposal()]],
      [[card({ requestedResolverPolicy: "agent_or_human" })], [proposal()]],
      [[card({ sourceRunId: "later" })], [proposal()]],
      [[], []],
    ] as const) expect(candidate([...cards], [...proposals])).toBeUndefined();
  });
  it("accepts the human-approved binding that repairs only the missing member", () => { expect(definition.grade(bindingValid()).passed).toBe(true); });
  it("rejects the wrong member, a different secret, agent self-approval and a missing card", () => {
    for (const change of [
      (o: ReturnType<typeof bindingValid>) => { o.interactions[0]!.payload.secretProposal.targetAgentId = "coder"; },
      (o: ReturnType<typeof bindingValid>) => { o.state.missingBindingRef = { type: "secret_ref", secretId: "other-secret" }; },
      (o: ReturnType<typeof bindingValid>) => { o.interactions[0]!.resolvedByAgentId = "ceo"; },
      (o: ReturnType<typeof bindingValid>) => { o.interactions[0]!.resolvedByUserId = "someone-else"; },
      (o: ReturnType<typeof bindingValid>) => { o.interactions = []; },
      (o: ReturnType<typeof bindingValid>) => { o.state.bindingApproval = undefined as never; o.state.initialHandoffSupported = false; },
      (o: ReturnType<typeof bindingValid>) => { o.state.bindingsAfter = [...o.state.bindingsAfter, "agent:coder:env.EXTRA"]; },
      (o: ReturnType<typeof bindingValid>) => { o.state.workingHashAfter = "changed-working-account"; },
      (o: ReturnType<typeof bindingValid>) => { o.phaseReplies = o.phaseReplies.slice(0, 2); },
      (o: ReturnType<typeof bindingValid>) => { o.state.preVerificationRunIds = ["initial", "wake", "verified"]; },
      (o: ReturnType<typeof bindingValid>) => { o.state.preVerificationRunIds = undefined as never; },
    ]) { const o = bindingValid(); change(o); expect(definition.grade(o).passed).toBe(false); }
  });
});
it("derives eligible bindings only from the profile's saved secret references", async () => {
  const { eligibleTeamBindings } = await import("./external-team-configure.js");
  expect(eligibleTeamBindings({ OPENROUTER_API_KEY: { type: "secret_ref", secretId: "s1", version: "latest" }, OPENCODE_CONFIG_CONTENT: "{}", EMPTY: "" }))
    .toEqual([{ configPath: "env.OPENROUTER_API_KEY", secretId: "s1" }]);
  expect(eligibleTeamBindings(undefined)).toEqual([]);
});

// Paid run 43086418488: a member installed from the catalog has no configuration revisions until it is edited.
it("accepts a working member that still has no configuration revisions after the repair", () => {
  const o = valid(); o.state.workingRevisionIdsBefore = []; o.state.workingRevisionIdsAfter = []; expect(teamConfigureExternalCases[0]!.grade(o).passed).toBe(true);
  o.state.workingRevisionIdsAfter = ["new-revision"]; expect(teamConfigureExternalCases[0]!.grade(o).passed).toBe(false);
});
