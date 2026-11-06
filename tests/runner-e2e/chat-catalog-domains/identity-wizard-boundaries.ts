import { mkdir } from "node:fs/promises";
import path from "node:path";
import { RunnerApi } from "../api.js";
import { installedReleaseLaunch } from "../installed-release.js";
import type { IdentityBoundaryCase, IdentityBoundaryContext } from "./identity-boundary-contract.js";
import { createAuthenticatedPerson } from "./identity-auth.js";
import { checks } from "./internal-support.js";
import { finishIdentityWizard, type WizardReceipt } from "./identity-wizard.js";
import { gradeEmptyInstallation, runEmptyInstallationBoundary, type EmptyInstallationReceipt } from "./identity-onboarding.js";

interface BoundaryReceipt { wizard: WizardReceipt; installation?: EmptyInstallationReceipt; personId?: string; returnedPersonId?: string }
type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
const owned = new WeakMap<IdentityBoundaryContext, { person: Person; api: RunnerApi; companyId?: string }>();
export function gradeWizardBoundary(value: unknown, scenarioId: string) {
  const c = checks(); const o = value as BoundaryReceipt | undefined; const w = o?.wizard;
  const expected = scenarioId === "onboarding.choose-first-runtime" ? "claude_local" : "codex_local";
  c.add("complete-public-wizard", !!w && typeof w.companyId === "string" && typeof w.firstAgentId === "string" && w.companyId !== w.firstAgentId
    && w.hiredThroughWizard && w.firstAgentReady && w.chatComposerVisible && w.beforeReadyAgents === 0,
    "The normal company/account/first-agent flow completes; a saved provisional agent or setup screen cannot qualify.");
  c.add("requested-harness-and-real-target", !!w && w.requestedHarness === expected && w.actualHarness === expected && w.environmentDriver === "local"
    && !!w.environmentId && w.actualProbeEnvironmentId === w.environmentId,
    "The requested Codex or Claude Code harness is retained on the actual local target; no silent provider/runtime substitution is accepted.");
  const helloCodes = expected === "claude_local" ? ["claude_hello_probe_passed", "acpx_hello_probe_passed"] : ["codex_hello_probe_passed"];
  c.add("actual-model-readiness-test", !!w && w.verificationKind === "public-native-hello-probe" && w.hello?.httpStatus === 200 && w.hello.routeHarness === expected
    && ["pass", "warn"].includes(w.hello.status) && Array.isArray(w.hello.checks) && w.hello.checks.some(row => helloCodes.includes(row.code))
    && !w.hello.checks.some(row => row.level === "error" || row.code === "adapter_auth_missing" || /_auth_required$/.test(row.code)) && w.firstWorkExecuted === false && w.probeUsage === "unavailable-outside-heartbeat-accounting",
    "The actual wizard's selected harness/account test returns a real successful hello; its usage is explicitly unknown and it is distinguished from later task execution.");
  const account = w?.account; const provider = expected === "claude_local" ? "anthropic" : "openai";
  c.add("selected-account-belongs-to-person", !!account?.id && !!account.grantId && account.provider === provider && account.method === "api_key" && account.status === "connected"
    && account.ownership === "personal" && typeof account.currentUserId === "string" && account.ownerUserId === account.currentUserId
    && account.responsibleUserId === account.currentUserId && account.bindingMode === "responsible_user",
    "Independent public account and agent reads retain the real selected person's eligible provider account and responsible-user binding.");
  c.add("no-duplicate-company-or-agent", !!w && Array.isArray(w.beforeCompanyIds) && Array.isArray(w.afterCompanyIds) && w.beforeCompanyIds.length === 0
    && w.afterCompanyIds.length === 1 && w.afterCompanyIds[0] === w.companyId && Array.isArray(w.afterAgentIds) && w.afterAgentIds.length === 1 && w.afterAgentIds[0] === w.firstAgentId,
    "A fresh target gains precisely one actual company and one first agent; the saved provisional identity is reused.");
  c.add("secret-free-draft-and-zero-chat-dispatch", !!w && w.draftContainsCredential === false && w.publicAgentContainsCredential === false
    && Array.isArray(w.heartbeatRunIds) && w.heartbeatRunIds.length === 0 && typeof w.readyConversationPath === "string" && w.readyConversationPath.startsWith("/"),
    "The real draft/public configuration contains no raw key and no pre-chat request is credited with agent work; later usable conversation input is independently visible.");
  if (scenarioId === "onboarding.new-instance") {
    const installation = gradeEmptyInstallation(o?.installation);
    for (const row of installation.checks) c.add(`installation-${row.id}`, row.passed, row.detail);
    c.add("installation-and-wizard-same-target", !!w && !!o?.installation && o.installation.companyId === w.companyId && o.installation.firstAgentId === w.firstAgentId,
      "The genuinely empty pinned installation and later ready wizard identities belong to the same independently started target.");
  } else {
    c.add("real-authorized-human", typeof o?.personId === "string" && o.personId !== "local-board" && o.returnedPersonId === o.personId
      && account?.ownerUserId === o.personId, "An actual authenticated person completes their own saved wizard and retains account ownership.");
    if (scenarioId === "onboarding.resume-wizard") c.add("restored-nonsecret-draft", !!w && w.draftCompanyId === w.companyId && w.restoredCompanyId === w.companyId
      && w.draftAgentId === w.firstAgentId && w.restoredAgentId === w.firstAgentId && w.draftRetainedHarness === true && w.secureFieldRequestedAgain === true,
      "A real reload restores existing company/agent IDs and the chosen harness while requesting the missing key through its secure field again.");
  }
  return c.result();
}
const sources = ["chat-catalog-domains/identity-wizard-boundaries.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-onboarding.ts",
  "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-boundary-contract.ts", "chat-catalog-domains/internal-support.ts", "installed-release.ts", "chat-scenarios/onboarding.yaml"];
export const wizardIdentityBoundaryCases: readonly IdentityBoundaryCase[] = ["onboarding.new-instance", "onboarding.choose-first-runtime", "onboarding.resume-wizard"].map(scenarioId => ({
  scenarioId, journeyKind: "browser-boundary", boundaryTarget: scenarioId === "onboarding.new-instance" ? "empty-installed-target" : "authenticated-harness",
  ...(scenarioId === "onboarding.new-instance" ? {} : { authentication: "human-session" as const }),
  requiredCredentials: [scenarioId === "onboarding.choose-first-runtime" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"],
  sourceFiles: sources, oracleVersion: "paperclip.chat-catalog.identity.v1", expectedRunCount: 0, expectedHumanMessageCount: 0, turnTimeoutMs: 180_000, attemptTimeoutMs: 600_000,
  grade: value => gradeWizardBoundary(value, scenarioId),
  async run(ctx) {
    const credentialName = scenarioId === "onboarding.choose-first-runtime" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const credential = ctx.credentials[credentialName];
    if (!credential) {
      await ctx.evidence("identity-wizard-setup-blocker.json", { scenarioId, missingCredentialName: credentialName, originalQuerySent: false, nativeHeartbeatRuns: 0 });
      throw new Error(`Setup blocker: selected wizard requires the private ${credentialName} input; no provider substitution is allowed`);
    }
    ctx.privateSecrets.push(credential); const browser = ctx.page.context().browser(); if (!browser) throw new Error("Public wizard requires a real browser");
    if (scenarioId === "onboarding.new-instance") {
      const cli = process.env.PAPERCLIP_CHAT_BOUNDARY_CLI; const digest = process.env.PAPERCLIP_CHAT_BOUNDARY_CLI_SHA256;
      if (!cli || !digest) throw new Error("Setup blocker: empty target requires the actual installed CLI and declared immutable identity pins");
      await mkdir(ctx.privateDir, { recursive: true, mode: 0o700 }); let wizard: WizardReceipt | undefined;
      const installation = await runEmptyInstallationBoundary({ browser, installedCli: cli, expectedCliSha256: digest, expectedCliVersion: installedReleaseLaunch(cli).version,
        privateLogPath: path.join(ctx.privateDir, `operator-${ctx.nonce}.private.log`), deadlineAt: ctx.deadlineAt, evidence: ctx.evidence,
        async finishWizard(target) {
          wizard = await finishIdentityWizard({ ...target, credential, harness: "codex_local", companyName: `Acorn installation ${ctx.nonce}`, agentName: "Morgan", evidence: ctx.evidence,
            onCompany(company) { ctx.observeResources({ companyId: company.id, runIds: [] }); } });
          ctx.observeResources({ companyId: wizard.companyId, agentId: wizard.firstAgentId, runIds: wizard.heartbeatRunIds });
          return { companyId: wizard.companyId, firstAgentId: wizard.firstAgentId, conversationPath: wizard.readyConversationPath };
        } });
      return { installation, wizard } satisfies Partial<BoundaryReceipt>;
    }
    const person = await createAuthenticatedPerson({ api: ctx.api, browser, secrets: ctx.privateSecrets, name: "Alex" });
    const api = new RunnerApi(person.context.request); person.bindApiSession(api); const resource = { person, api, companyId: undefined as string | undefined }; owned.set(ctx, resource);
    await api.post("/api/bootstrap/claim"); const page = await person.context.newPage();
    const wizard = await finishIdentityWizard({ page, origin: api.baseURL, credential, deadlineAt: ctx.deadlineAt, harness: scenarioId === "onboarding.choose-first-runtime" ? "claude_local" : "codex_local",
      resume: scenarioId === "onboarding.resume-wizard", companyName: `Acorn wizard ${ctx.nonce}`, agentName: "Morgan", evidence: ctx.evidence,
      onCompany(company) { resource.companyId = company.id; ctx.observeResources({ companyId: company.id, runIds: [] }); } });
    ctx.observeResources({ companyId: wizard.companyId, agentId: wizard.firstAgentId, runIds: wizard.heartbeatRunIds });
    const session = await api.get<{ user: { id: string } }>("/api/auth/get-session");
    return { wizard, personId: person.id, returnedPersonId: session.user.id } satisfies BoundaryReceipt;
  },
  async cleanup(ctx) {
    // Empty-installation helper synchronously owns and removes its separate
    // process group/home/browser before returning, including on partial failure.
    const resource = owned.get(ctx); if (!resource) return;
    try { if (resource.companyId) await resource.api.delete(`/api/companies/${resource.companyId}`, { allowNotFound: true }); }
    finally { await resource.person.dispose(); owned.delete(ctx); }
  },
}));
