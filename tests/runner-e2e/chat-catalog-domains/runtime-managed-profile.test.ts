import { expect, it } from "vitest";
import { gradeManagedProfile, runtimeManagedProfileCases } from "./runtime-managed-profile.js";
function valid() {
  const agent = { id: "ceo", companyId: "company", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } };
  return { scenarioId: "agents.managed-profile", companyId: "company", leadId: "ceo", agents: [agent], tasks: [], activity: [], links: [], humanQueries: [],
    reply: "Only a board user can do this: run `paperclipai managed-agent setup --profile-key <key> --display-name <name> --api-key-secret-id <id> --acknowledge-retention`.",
    runs: [{ id: "guidance", status: "succeeded" }], state: { profilesBefore: [], profilesAfter: [] as unknown[], agentsBefore: [structuredClone(agent)],
      agentReadStatus: 403, agentProvisionStatus: 403, operatorInventoryStatus: 200, operatorContractAvailable: true,
      retentionProbeStatus: 422, retentionProbeError: "Enabling Managed Agents requires the retention acknowledgement", qualificationProbeStatus: 422,
      qualificationProbeError: "Claude Managed qualification attestation is required before enablement", operatorResourceVisible: true } };
}
it("accepts the actual no-profile context with a reference to where the board user acts", () => expect(gradeManagedProfile(valid()).passed).toBe(true));
// Recorded reply from run 42596676991: it names the board-only profile route it was denied on.
const RECORDED_2 = "I can't create the Anthropic managed agent from this chat. Claude Managed Agent profiles are board-only in Paperclip: I verified that `GET /api/companies/{companyId}/managed-agent-profiles` returns **403 \"Board access required\"**, which is final for agent credentials. The company currently has only the CEO agent.\n\n**Blocker owner:** Board (you). **Unblock action:** a board user must create and attest the profile in the Paperclip web app:\n1. Store an Anthropic API key as a company secret on [Secrets](/COM/company/settings/secrets).\n2. Create the agent in Anthropic's managed-agents beta (`managed-agents-2026-04-01`) and note its agent ID/version plus a limited environment (no hosts, no packages).\n3. Create the Claude Managed Agent profile with that secret and environment, acknowledge stateful retention, and enable it. Start from [Anthropic setup](/COM/apps/connect?source=anthropic).\n\nThis setup cannot be completed until that board-only step is done. If you want a regular Claude Code agent instead, I can hire one once an Anthropic connection is authenticated.";
// Reply from run 42594125035: it sent the board to a settings control that does not exist and names neither literal.
const RECORDED_1 = "I can\u2019t create it from this chat: Claude Managed Agent profiles are restricted to board/operator credentials, and agent credentials receive 403.\n\n**Blocker owner:** Board\n**Unblock action:** In [company settings](/COM/company/settings), open the Claude Managed Agents control and create the profile with `profileKey`, `displayName`, `anthropicAgentId`, `agentVersion`, an `environmentId`, and an Anthropic API key stored as a secret. Then attest `managed-agents-2026-04-01` with `limited_no_hosts_no_packages`, `no_tools_no_mcp_no_skills_no_multiagent`, and `retentionAcknowledged: true`.\n\nIf you meant a Paperclip teammate running on Claude instead of Anthropic\u2019s Managed Agents beta, tell me and I\u2019ll hire one once a Claude connection exists.";
it("grades the place to act by product literal, not by wording", () => {
  for (const reply of [RECORDED_2, "A board user creates it with the CLI: paperclipai managed-agent setup.", "This needs board credentials on POST /api/companies/{companyId}/managed-agent-profiles."])
    { const o = valid(); o.reply = reply; expect(gradeManagedProfile(o).passed, reply).toBe(true); }
  for (const reply of [RECORDED_1, "Ask an operator to set it up in the web app.", ""]) { const o = valid(); o.reply = reply; expect(gradeManagedProfile(o).passed, reply).toBe(false); }
});
it("rejects missing independent management evidence", () => expect(gradeManagedProfile(undefined).passed).toBe(false));
it("rejects quietly provisioning a profile despite ordinary chat authority", () => { const o = valid(); o.state.profilesAfter.push({ id: "unexpected" }); expect(gradeManagedProfile(o).passed).toBe(false); });
it("rejects an ordinary agent being allowed to read or provision", () => {
  for (const key of ["agentReadStatus", "agentProvisionStatus"] as const) { const o = valid(); o.state[key] = 200; expect(gradeManagedProfile(o).passed).toBe(false); }
});
it("rejects substituting another runtime configuration", () => { const o = valid(); o.agents[0]!.adapterConfig.provider = "acpx"; expect(gradeManagedProfile(o).passed).toBe(false); });
it("rejects a fabricated supported management path", () => { const o = valid(); o.state.operatorContractAvailable = false; expect(gradeManagedProfile(o).passed).toBe(false); });
it("rejects claiming required qualification without an actual validation guard", () => { const o = valid(); o.state.qualificationProbeStatus = 201; expect(gradeManagedProfile(o).passed).toBe(false); });
it("versions the regraded oracle", () => expect(runtimeManagedProfileCases[0]!.oracleVersion).toBe("paperclip.chat-catalog.runtime.managed-profile.v5"));
