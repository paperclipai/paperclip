import { describe, expect, it } from "vitest";
import { teamConfigureExternalCases } from "./external-team-configure.js";
function valid() {
  return { scenarioId: "teams.configure-team", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", connections: [], profiles: [], secrets: [], endpoints: [], interactions: [], tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], links: [],
    reply: "QA has been configured and each team member is ready.", phaseReplies: [{ runId: "initial", body: "QA needs the eligible account; open QA configuration." }, { runId: "verified", body: "QA and the senior coder are now configured and ready." }], runs: [{ id: "initial", status: "succeeded" }, { id: "verified", status: "succeeded" }],
    activity: [{ id: "repair", action: "agent.updated", actorType: "user", entityId: "qa", agentId: null as string | null }], state: {
      installedFromCatalog: true, missingId: "qa", workingId: "coder", expectedMembers: 2, memberIdsBefore: ["coder", "qa"], workingRevisionIdsBefore: ["revision"], workingRevisionIdsAfter: ["revision"],
      initialProbes: [{ agentId: "qa", status: "fail", testedAt: "2026-10-26T10:00:00Z", checks: [{ code: "codex_auth", level: "error" }] }, { agentId: "coder", status: "pass", testedAt: "2026-10-26T10:00:00Z", checks: [] }],
      afterProbes: [{ agentId: "qa", status: "pass", testedAt: "2026-10-26T10:05:01Z", checks: [] }, { agentId: "coder", status: "pass", testedAt: "2026-10-26T10:05:02Z", checks: [] }],
      repairVerifiedAfter: Date.parse("2026-10-26T10:05:00Z"), initialHandoffSupported: true, repairConfirmed: true, repairChannel: "human-board-configuration", workingHashBefore: "same-config", workingHashAfter: "same-config", memberIdsPreserved: true, initialRunId: "initial",
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
