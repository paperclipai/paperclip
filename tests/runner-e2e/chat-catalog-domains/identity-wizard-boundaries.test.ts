import { describe, expect, it } from "vitest";
import { gradeWizardBoundary, wizardIdentityBoundaryCases } from "./identity-wizard-boundaries.js";
import type { WizardReceipt } from "./identity-wizard.js";
function valid(id: string) {
  const claude = id === "onboarding.choose-first-runtime"; const owner = id === "onboarding.new-instance" ? "local-board" : "alex";
  const wizard: WizardReceipt = { companyId: "acorn", firstAgentId: "morgan", companyName: "Acorn", agentName: "Morgan", requestedHarness: claude ? "claude_local" : "codex_local",
    actualHarness: claude ? "claude_local" : "codex_local", environmentId: "local-target", environmentDriver: "local", actualProbeEnvironmentId: "local-target",
    beforeCompanyIds: [], afterCompanyIds: ["acorn"], beforeReadyAgents: 0, afterAgentIds: ["morgan"],
    hello: { httpStatus: 200, routeHarness: claude ? "claude_local" : "codex_local", adapterType: "paperclip_runner", status: "pass", checks: [{ code: claude ? "acpx_hello_probe_passed" : "codex_hello_probe_passed", level: "info" }] },
    hiredThroughWizard: true, firstAgentReady: true, chatComposerVisible: true, heartbeatRunIds: [], readyConversationPath: "/ACO/issues/ACO-1",
    draftCompanyId: "acorn", draftAgentId: "morgan", restoredCompanyId: "acorn", restoredAgentId: "morgan", secureFieldRequestedAgain: true, draftRetainedHarness: true,
    draftContainsCredential: false, publicAgentContainsCredential: false, verificationKind: "public-native-hello-probe", firstWorkExecuted: false, probeUsage: "unavailable-outside-heartbeat-accounting",
    account: { id: "account", grantId: "grant", provider: claude ? "anthropic" : "openai", method: "api_key", status: "connected", ownership: "personal", ownerUserId: owner,
      currentUserId: owner, responsibleUserId: owner, bindingMode: "responsible_user" } };
  return { wizard, personId: "alex", returnedPersonId: "alex", ...(id === "onboarding.new-instance" ? { installation: { journeyKind: "operator-before-chat", query: "Help me set up Paperclip on this machine.", querySent: false,
    cliVersion: "0.3.1", cliSha256: "a".repeat(64), initialHomeEntries: 0, companiesBeforeWizard: 0, deploymentMode: "local_trusted", configCreatedByOperatorCLI: true,
    selectedBind: "loopback", companyId: "acorn", firstAgentId: "morgan", firstAgentReady: true, chatComposerVisible: true, cleanup: "complete" } } : {}) };
}
describe("full real pre-chat wizard acceptance", () => {
  for (const definition of wizardIdentityBoundaryCases) it(`${definition.scenarioId}: complete, wrong provider and missing phases`, () => {
    const o = valid(definition.scenarioId); expect(definition.grade(o), JSON.stringify(definition.grade(o).checks)).toMatchObject({ passed: true });
    const wrong = structuredClone(o); wrong.wizard.actualHarness = wrong.wizard.actualHarness === "claude_local" ? "codex_local" : "claude_local";
    expect(definition.grade(wrong).passed).toBe(false); expect(definition.grade(undefined).passed).toBe(false);
    expect(definition.grade({ wizard: { firstAgentReady: true } }).passed).toBe(false);
  });
  it.each([{ hello: { httpStatus: 200, routeHarness: "claude_local", adapterType: "paperclip_runner", status: "pass", checks: [] } },
    { firstAgentReady: false }, { actualProbeEnvironmentId: "some-other-target" }, { draftContainsCredential: true }, { heartbeatRunIds: ["accidental-query"] }])("rejects unproven or wrong wizard result %j", change => {
    const o = valid("onboarding.choose-first-runtime"); Object.assign(o.wizard, change); expect(gradeWizardBoundary(o, "onboarding.choose-first-runtime").passed).toBe(false);
  });
  it("rejects an unavailable account despite a misleading successful hello", () => {
    const o = valid("onboarding.choose-first-runtime"); o.wizard.hello.checks.push({ code: "adapter_auth_missing", level: "warn" });
    expect(gradeWizardBoundary(o, "onboarding.choose-first-runtime").passed).toBe(false);
  });
  it("requires the same draft identities, proper secure reentry and account owner on reload", () => {
    for (const change of [{ restoredAgentId: "duplicate-agent" }, { restoredCompanyId: "new-company" }, { secureFieldRequestedAgain: false }]) {
      const o = valid("onboarding.resume-wizard"); Object.assign(o.wizard, change); expect(gradeWizardBoundary(o, "onboarding.resume-wizard").passed).toBe(false);
    }
    const wrong = valid("onboarding.resume-wizard"); wrong.wizard.account.ownerUserId = "riley"; expect(gradeWizardBoundary(wrong, "onboarding.resume-wizard").passed).toBe(false);
  });
  it("requires actual empty installation identity and synchronous owned cleanup", () => {
    const o = valid("onboarding.new-instance"); o.installation!.cleanup = "failed"; expect(gradeWizardBoundary(o, "onboarding.new-instance").passed).toBe(false);
    const missing = valid("onboarding.new-instance"); delete missing.installation; expect(gradeWizardBoundary(missing, "onboarding.new-instance").passed).toBe(false);
  });
});
