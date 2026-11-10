import { waitForCompanySettingsTurn } from "./identity-company-observer.js";
import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import type { AiConnectionList, AiManagedConnectionSummary } from "../../../packages/shared/src/ai-connections.js";
import { DECISION_MODELS, type DecisionHistoryEntry, type DecisionModelSettings, type DecisionResult } from "../../../packages/shared/src/decision-models.js";
import type { PromptInjectionPreventionSettings, PromptInjectionTestResult } from "../../../packages/shared/src/prompt-injection-prevention.js";
import type { FastResponseSettings, FastResponseTestResult } from "../../../packages/shared/src/fast-response.js";
import type { CostSummary } from "../../../packages/shared/src/types/cost.js";
import { checks } from "./internal-support.js";
import { followRenderedLink, identityDefinition, identityObservation, observeIdentity, probeAgentPermission } from "./identity-support.js";
import type { Locator } from "@playwright/test";

export const requestedAuxiliaryServiceModel = "deepseek/deepseek-v4.1-flash-1017";

function remainingCompanyServiceObservationBudget(ctx: ChatCatalogContext): number {
  const now = Date.now(), deadline = ctx.observationDeadlineAt;
  if (!Number.isFinite(deadline) || deadline! <= now) throw new Error("Original company service observation budget exhausted or missing");
  return deadline! - now;
}

/** The settings click starts an async PUT; observe its completion before independent readback. */
export async function saveFastResponseModelBeforeTest(ctx: ChatCatalogContext, connection: AiManagedConnectionSummary,
  clickSave: (options: { timeout: number }) => Promise<unknown>): Promise<FastResponseSettings> {
  const remaining = () => remainingCompanyServiceObservationBudget(ctx);
  const path = `/api/companies/${ctx.input.fixtures.company.id}/fast-response`;
  const origin = new URL(ctx.input.page.url()).origin;
  const response = ctx.input.page.waitForResponse(row => row.request().method() === "PUT"
    && new URL(row.url()).origin === origin && new URL(row.url()).pathname === path, { timeout: remaining() });
  const [, receipt] = await Promise.all([clickSave({ timeout: remaining() }), response]);
  remaining();
  expect(receipt.status(), "Actual fast response save completed successfully before service test").toBe(200);
  const saved = await receipt.json() as FastResponseSettings;
  const expected = { companyId: ctx.input.fixtures.company.id, enabled: true, connectionId: connection.id,
    grantId: connection.grantId, model: requestedAuxiliaryServiceModel };
  expect(saved, "Requested auxiliary model saved before any service test").toMatchObject(expected);
  const persisted = (await ctx.input.api.get<{ settings: FastResponseSettings }>(path, { timeout: remaining() })).settings;
  remaining();
  expect(persisted, "Requested auxiliary model saved before any service test").toMatchObject(expected);
  return persisted;
}

/**
 * The person follows the reply's own rendered links, in order, and stops at the first page that shows the service control.
 * There is no typed-URL fallback: a reply that links a page without the control leaves the person without it.
 */
export async function openServiceControlFromReply(ctx: ChatCatalogContext, links: readonly string[], origin: string, control: () => Locator): Promise<string | undefined> {
  const source = ctx.input.page.url();
  for (const href of links) {
    let url: URL; try { url = new URL(href, origin); } catch { continue; }
    if (url.origin !== new URL(origin).origin) continue;
    await followRenderedLink(ctx, href);
    const shown = await control().waitFor({ state: "visible", timeout: Math.min(15_000, remainingCompanyServiceObservationBudget(ctx)) }).then(() => true, () => false);
    if (shown) return href;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  }
  return undefined;
}

type Settings = DecisionModelSettings | PromptInjectionPreventionSettings | FastResponseSettings;
const fastExperiments = new WeakMap<ChatCatalogContext, boolean>();
const specs = [
  { id: "companies.configure-decision-model", path: "decision-model", section: "Decision model", save: "Save decision model", test: "Run test", toggle: "Enable decisions" },
  { id: "companies.prompt-injection-guard", path: "prompt-injection-prevention", section: "Prompt Injection Prevention", save: "Save prompt injection settings", test: "Test model checks", toggle: "Use model for prompt injection checks" },
  { id: "companies.fast-responses", path: "fast-response", section: "Fast response", save: "Save fast response", test: "Test response", toggle: "Enable fast responses" },
] as const;
export function gradeCompanyModel(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-model-service-evidence", !!o, "Actual selected account, public saved service configuration and real test receipts are required."); if (!o) return c.result();
  const connection = o.state.connection as AiManagedConnectionSummary | undefined; const saved = o.state.saved as Settings | undefined;
  c.add("real-eligible-shared-account", !!connection?.id && !!connection.grantId && connection.companyId === o.companyId && connection.ownership === "shared"
    && connection.provider === "openrouter" && connection.method === "api_key" && connection.status === "connected", "The actual validated shared OpenRouter account belongs to this company; a selected chat subscription is not substituted.");
  c.add("human-configured-service", o.state.beforeEnabled === false && o.state.afterReplyEnabled === false && o.state.agentWriteStatus === 403 && o.state.agentTestStatus === 403 && saved?.enabled === true
    && saved.companyId === o.companyId && saved.connectionId === connection?.id && saved.grantId === connection?.grantId && o.state.persistedAfterReload === true
    && o.state.testHttpStatus === 200 && o.state.visibleTestReceipt === true,
    "The canonical chat leaves the disabled board-managed service unchanged; the actual human settings controls save the intended grant and the result survives reload.");
  if (o.scenarioId === "companies.fast-responses") {
    const href = o.state.replyLinkedControlHref;
    c.add("reply-link-opens-fast-response-control", typeof href === "string" && o.links.includes(href),
      "The person clicked a link rendered in the reply and that page showed the Fast response control; a settings page without it does not qualify.");
  } else c.add("honest-human-settings-guidance", /settings|connections/i.test(o.reply) && !/\bI(?:'ve| have)?\s+(?:enabled|configured|turned on|tested)\b/i.test(o.reply), "The chat names the human settings surface and does not claim a board-only change or test it could not perform.");
  if (["companies.prompt-injection-guard", "companies.fast-responses"].includes(o.scenarioId)) {
    c.add("requested-service-model-persisted-before-test", o.state.modelBeforeTest === requestedAuxiliaryServiceModel && saved?.model === requestedAuxiliaryServiceModel,
      "The actual public human configuration uses the requested OpenRouter API model before service testing and after readback; default auxiliary models are not substituted.");
  }
  if (o.scenarioId === "companies.configure-decision-model") {
    const result = o.state.testResult as DecisionResult | undefined; const history = o.state.history as DecisionHistoryEntry[] | undefined;
    c.add("actual-decision-test-and-ledger", (saved as DecisionModelSettings | undefined)?.model === DECISION_MODELS.openrouter.id
      && !!result && result.status !== "unavailable" && !!result.invocationId && !!history?.some(row => row.id === result.invocationId
      && row.connectionId === connection?.id && row.model === DECISION_MODELS.openrouter.id && row.actorType === "user" && row.responsibleUserId === o.state.humanId
      && !!row.finishedAt && row.feature === "settings.test" && (result.status === "succeeded" ? row.status === "succeeded" : ["failed", "unknown"].includes(row.status) && row.errorCode === result.errorCode)
      && row.inputTokens === result.usage.inputTokens && row.outputTokens === result.usage.outputTokens && row.costStatus === result.usage.costStatus),
      "A real decision-service invocation, its exact shared model and its independent persisted human/usage history agree; an ordinary agent run is insufficient.");
  } else if (o.scenarioId === "companies.prompt-injection-guard") {
    const result = o.state.testResult as PromptInjectionTestResult | undefined;
    c.add("actual-fixed-classifier-samples", !!result && result.samples.length === 2 && ["Benign source code", "Malicious instructions"].every(name => result.samples.some(sample => sample.name === name))
      && result.samples.every(sample => !!sample.invocationId && !!sample.usage && typeof sample.durationMs === "number" && sample.actualViolation === sample.expectedViolation && sample.passed)
      && result.passed && o.state.testCostEvents === 2,
      "Both actual fixed samples receive the expected model verdict with two independently recorded service charges; built-in fallback or saved configuration cannot masquerade as a working model classifier.");
    c.add("bounded-protection-guidance", /settings|connection|human|you can/i.test(o.reply) && !/guarantee(?:d|s)?|all (?:attacks|injections)|completely (?:safe|protected)/i.test(o.reply), "The response describes the optional actual control without claiming universal protection.");
  } else if (o.scenarioId === "companies.fast-responses") {
    const result = o.state.testResult as FastResponseTestResult | undefined; const history = o.state.history as Array<DecisionHistoryEntry & { publicationStatus: string }> | undefined;
    c.add("actual-fast-response-receipt", !!result && result.status === "succeeded" && !!result.text.trim() && result.durationMs >= 0 && !!history?.some(row => row.id === result.invocationId
      && row.connectionId === connection?.id && row.model === requestedAuxiliaryServiceModel && row.responsibleUserId === o.state.humanId && row.feature === "settings.test" && row.finishedAt != null
      && row.inputTokens === result.usage.inputTokens && row.outputTokens === result.usage.outputTokens && row.costStatus === result.usage.costStatus),
      "The real settings test generates an actual model acknowledgement and matching durable usage/failure history; elapsed worker time alone cannot qualify.");
  } else c.add("known-service", false, "No oracle exists for this service.");
  return c.result();
}
const sources = ["chat-catalog-domains/identity-company-models.ts", "chat-catalog-domains/identity-company-observer.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/companies.yaml"];
export const companyModelIdentityCases: readonly ChatCatalogCase[] = specs.map(spec => identityDefinition(spec.id, async ctx => {
  const key = ctx.input.privateInputs?.credentials.OPENROUTER_API_KEY;
  if (!key || !ctx.input.privateSecrets) throw new Error("Setup blocker: this selected company service requires private OPENROUTER_API_KEY; no chat-profile substitution is allowed");
  ctx.input.privateSecrets.push(key);
  const root = `/api/companies/${ctx.input.fixtures.company.id}`;
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  let previousFastExperiment: boolean | undefined;
  if (spec.path === "fast-response") { const settings = await ctx.input.api.get<{ enableFastResponses: boolean }>("/api/instance/settings/experimental"); previousFastExperiment = settings.enableFastResponses;
    fastExperiments.set(ctx, previousFastExperiment); await ctx.input.api.patch("/api/instance/settings/experimental", { enableFastResponses: true }); }
  try {
  const created = await ctx.input.api.postSensitive<{ connectionId: string; grantId: string }>(`${root}/ai-connections`, { name: `Acorn shared model ${ctx.input.nonce}`, provider: "openrouter", method: "api_key", ownership: "shared", apiKey: key, allAgents: false, agentIds: [] });
  const list = await ctx.input.api.get<AiConnectionList>(`${root}/ai-connections`); const connection = list.connections.find(row => row.id === created.connectionId && row.grantId === created.grantId);
  if (!connection || connection.status !== "connected" || connection.ownership !== "shared") throw new Error("Setup blocker: public validation did not create an eligible shared model account");
  const before = await ctx.input.api.get<{ canManage: boolean; settings: Settings | null }>(`${root}/${spec.path}`);
  if (!before.canManage || !before.settings || before.settings.enabled) throw new Error("Setup blocker: the actual human must manage an initially disabled company model service");
  return { connection, beforeEnabled: before.settings.enabled, humanId: session.user.id, previousFastExperiment };
  } catch (error) { const prior = fastExperiments.get(ctx); if (prior !== undefined) { await ctx.input.api.patch("/api/instance/settings/experimental", { enableFastResponses: prior }); fastExperiments.delete(ctx); } throw error; }
}, gradeCompanyModel, {
  sourceFiles: sources, authentication: "human-session", requiredCredentials: ["OPENROUTER_API_KEY"], attemptTimeoutMs: 420_000,
  ...(spec.id === "companies.fast-responses" ? { oracleVersion: "paperclip.chat-catalog.identity.fast-responses.v2" } : {}),
  async act(ctx, state) {
    await waitForCompanySettingsTurn(ctx); const root = `/api/companies/${ctx.input.fixtures.company.id}`; const source = ctx.input.page.url();
    state.afterReplyEnabled = (await ctx.input.api.get<{ settings: Settings }>(`${root}/${spec.path}`)).settings.enabled;
    state.agentWriteStatus = await probeAgentPermission(ctx, `${root}/${spec.path}`, "PUT", { enabled: true, connectionId: (state.connection as AiManagedConnectionSummary).id, grantId: (state.connection as AiManagedConnectionSummary).grantId,
      ...(spec.path === "decision-model" ? { allowBackground: false } : spec.path === "fast-response" ? { model: requestedAuxiliaryServiceModel, allowSponsored: false } : { model: requestedAuxiliaryServiceModel }) });
    state.agentTestStatus = await probeAgentPermission(ctx, `${root}/${spec.path}/test`, "POST", {});
    const section = spec.path === "decision-model" ? ctx.input.page.locator('section[aria-labelledby="decision-model-heading"]') : ctx.input.page.getByRole("region", { name: spec.section, exact: true });
    if (spec.path === "fast-response") {
      const o = await observeIdentity(ctx, state);
      const href = await openServiceControlFromReply(ctx, o.links, o.origin, () => section);
      state.replyLinkedControlHref = href ?? null;
      await ctx.input.evidence("identity-company-model-reply-link.json", { links: o.links, opened: href ?? null, url: ctx.input.page.url() });
      if (!href) { await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); return; }
    } else await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/company/settings/connections`, { waitUntil: "domcontentloaded" });
    await section.getByRole("button", { name: (state.connection as AiManagedConnectionSummary).name, exact: true }).click();
    if (spec.path !== "decision-model") await section.getByLabel("Model", { exact: true }).fill(requestedAuxiliaryServiceModel);
    await section.getByRole("switch", { name: spec.toggle, exact: true }).setChecked(true);
    if (spec.path === "fast-response") {
      const persisted = await saveFastResponseModelBeforeTest(ctx, state.connection as AiManagedConnectionSummary,
        options => section.getByRole("button", { name: spec.save, exact: true }).click(options));
      state.modelBeforeTest = persisted.model;
    } else await section.getByRole("button", { name: spec.save, exact: true }).click();
    if (spec.path === "prompt-injection-prevention") {
      const persisted = (await ctx.input.api.get<{ settings: Settings }>(`${root}/${spec.path}`)).settings;
      expect(persisted.model, "Requested auxiliary model saved before any service test").toBe(requestedAuxiliaryServiceModel);
      state.modelBeforeTest = persisted.model;
    }
    const testOptions = () => spec.path === "fast-response" ? { timeout: remainingCompanyServiceObservationBudget(ctx) } : {};
    await expect(section.getByRole("button", { name: spec.test, exact: true })).toBeEnabled(testOptions());
    const before = await ctx.input.api.get<CostSummary>(`${root}/costs/summary`, spec.path === "fast-response" ? { timeout: remainingCompanyServiceObservationBudget(ctx) } : undefined);
    const response = ctx.input.page.waitForResponse(row => row.request().method() === "POST" && new URL(row.url()).pathname === `${root}/${spec.path}/test`, testOptions());
    await section.getByRole("button", { name: spec.test, exact: true }).click(testOptions());
    const receipt = await response; if (spec.path === "fast-response") remainingCompanyServiceObservationBudget(ctx); state.testHttpStatus = receipt.status(); state.testResult = await receipt.json();
    await expect(section.locator('[role="status"],[role="alert"]').last()).toBeVisible(); state.visibleTestReceipt = true;
    state.testCostEvents = (await ctx.input.api.get<CostSummary>(`${root}/costs/summary`)).eventCount - before.eventCount;
    state.saved = (await ctx.input.api.get<{ settings: Settings }>(`${root}/${spec.path}`)).settings;
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(section.getByRole("switch", { name: spec.toggle, exact: true })).toBeChecked();
    if (spec.path !== "decision-model") await expect(section.getByLabel("Model", { exact: true })).toHaveValue(requestedAuxiliaryServiceModel);
    state.persistedAfterReload = true;
    if (spec.path !== "prompt-injection-prevention") state.history = await ctx.input.api.get<DecisionHistoryEntry[]>(`${root}/${spec.path}/history?limit=100`);
    await ctx.input.evidence("identity-company-model-test.json", { service: spec.path, connectionId: (state.connection as AiManagedConnectionSummary).id, saved: state.saved, result: state.testResult,
      history: state.history, independentlyAddedCostEvents: state.testCostEvents, nativeChatRunUsedAsServiceProof: false });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  observe: observeIdentity,
  async cleanup(ctx) { const prior = fastExperiments.get(ctx); if (prior !== undefined) { await ctx.input.api.patch("/api/instance/settings/experimental", { enableFastResponses: prior }); fastExperiments.delete(ctx); } },
}));
