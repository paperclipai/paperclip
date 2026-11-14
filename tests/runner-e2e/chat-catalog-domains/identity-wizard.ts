import { expect, test, type Page, type Response } from "@playwright/test";
import { privateIdentityBrowser } from "./identity-private-browser.js";
import { pollUntil } from "../api.js";
import type { AiConnectionBinding, AiConnectionList } from "../../../packages/shared/src/ai-connections.js";

export type WizardHarness = "codex_local" | "claude_local";
interface Company { id: string; name: string; issuePrefix: string; defaultResponsibleUserId?: string | null }
interface Agent { id: string; companyId: string; name: string; adapterType: string; adapterConfig: { provider?: string; acpxAgent?: string }; runtimeConfig: { aiConnection?: AiConnectionBinding }; lifecycleState: string; status: string; pauseReason?: string | null }
export interface WizardReceipt {
  companyId: string; firstAgentId: string; companyName: string; agentName: string; requestedHarness: WizardHarness;
  actualHarness: WizardHarness; environmentId: string; environmentDriver: string; actualProbeEnvironmentId: string;
  beforeCompanyIds: string[]; afterCompanyIds: string[]; beforeReadyAgents: number; afterAgentIds: string[];
  hello: { httpStatus: number; routeHarness: string; adapterType: string; status: string; checks: Array<{ code: string; level: string }> };
  hiredThroughWizard: boolean; firstAgentReady: boolean; chatComposerVisible: boolean; heartbeatRunIds: string[];
  readyConversationPath: string;
  account: { id: string; grantId: string; provider: string; method: string; status: string; ownership: string; ownerUserId?: string; currentUserId: string; responsibleUserId?: string | null; bindingMode: string };
  draftCompanyId?: string; draftAgentId?: string; restoredCompanyId?: string; restoredAgentId?: string; secureFieldRequestedAgain?: boolean;
  draftRetainedHarness?: boolean; draftContainsCredential: boolean; publicAgentContainsCredential: boolean;
  verificationKind: "public-native-hello-probe"; firstWorkExecuted: false; probeUsage: "unavailable-outside-heartbeat-accounting";
}
/** The actual public wizard owns all company/account/first-agent mutations.
 * APIs only read its resulting identities; secrets enter the normal masked
 * human field and are never included in receipts or browser draft snapshots. */
interface WizardInput {
  page: Page; origin: string; companyName: string; agentName: string; harness: WizardHarness; credential: string;
  deadlineAt: number; resume?: boolean; entry?: "empty" | "new-company";
  onCompany(company: Company): void; evidence(name: string, value: unknown): Promise<void>;
}
export async function finishIdentityWizard(input: WizardInput): Promise<WizardReceipt> {
  const receipt = await privateIdentityBrowser({ kind: "wizard", origin: input.origin, startPath: input.page.url() === "about:blank" ? "/" : input.page.url(), cookies: await input.page.context().cookies(input.origin),
    credential: input.credential, companyName: input.companyName, agentName: input.agentName, harness: input.harness, deadlineAt: input.deadlineAt, resume: input.resume, entry: input.entry },
    { company(id) { input.onCompany({ id, name: input.companyName, issuePrefix: "" }); } });
  if (!receipt.wizard) throw new Error("Private wizard returned no bounded result");
  await input.page.goto(new URL(receipt.wizard.readyConversationPath, input.origin).href, { waitUntil: "domcontentloaded" });
  await input.evidence("identity-public-wizard-result.json", receipt.wizard); return receipt.wizard;
}
/** Called only by the standalone worker, never in the Playwright Test process. */
export async function runIdentityWizardInPrivateBrowser(input: WizardInput & { registerCompany(company: Company): Promise<void> }): Promise<WizardReceipt> {
  let attached = false; try { test.info(); attached = true; } catch { /* outside Test */ }
  if (attached) throw new Error("Credential-bearing wizard must run only in the private child");
  const { page, origin } = input; const remaining = () => Math.max(1, Math.min(180_000, input.deadlineAt - Date.now()));
  const get = async <T>(endpoint: string): Promise<T> => {
    const response = await page.context().request.get(origin + endpoint, { timeout: Math.min(30_000, remaining()) });
    if (!response.ok()) throw new Error(`Public wizard read returned HTTP ${response.status()}`); return response.json() as Promise<T>;
  };
  const before = await get<Company[]>("/api/companies");
  if (input.entry === "new-company") {
    await page.getByRole("button", { name: /^Open .+ (?:organization|workspace|company) switcher$/i }).click();
    await page.getByRole("menuitem", { name: "Create organization", exact: true }).click();
  } else await page.goto(`${origin}/onboarding`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "What is the name of your organization?", exact: true })).toBeVisible();
  await page.locator("#onboarding-company-name").fill(input.companyName);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#onboarding-agent-name")).toBeVisible();
  const company = await pollUntil({ label: "wizard-created exact company", deadlineAt: input.deadlineAt,
    load: () => get<Company[]>("/api/companies"), accept: rows => rows.filter(row => !before.some(old => old.id === row.id) && row.name === input.companyName).length === 1 }).then(rows => rows.find(row => !before.some(old => old.id === row.id) && row.name === input.companyName)!);
  await input.registerCompany(company);
  input.onCompany(company);
  await page.locator("#onboarding-agent-name").fill(input.agentName); await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect a model", exact: true })).toBeVisible();
  const setupAgents = await pollUntil({ label: "public first-agent setup record", deadlineAt: input.deadlineAt,
    load: () => get<Agent[]>(`/api/companies/${company.id}/agents`), accept: rows => rows.length === 1 && rows[0]?.name === input.agentName });
  const provisional = setupAgents[0]!;
  const beforeReadyAgents = setupAgents.filter(row => row.lifecycleState === "ready" && ["idle", "active"].includes(row.status)).length;
  if (beforeReadyAgents) throw new Error("Wizard prerequisite already had a usable first agent before account setup");
  const environments = await get<Array<{ id: string; driver: string }>>(`/api/companies/${company.id}/environments?driver=local`);
  if (environments.length !== 1 || environments[0]?.driver !== "local") throw new Error("Wizard requires one real available local target; no silent target substitution is allowed");
  const environment = environments[0]!;
  const choose = async () => {
    await page.getByRole("radio", { name: input.harness === "claude_local" ? /^Claude/ : /^OpenAI/ }).click();
    const apiMode = page.getByRole("button", { name: "Use API key instead", exact: true });
    const key = page.getByPlaceholder("Enter API key here", { exact: true });
    await expect(apiMode.or(key).first()).toBeVisible();
    if (await apiMode.isVisible()) await apiMode.click();
    await expect(key).toBeVisible(); return key;
  };
  let key = await choose();
  let draftCompanyId: string | undefined, draftAgentId: string | undefined, restoredCompanyId: string | undefined, restoredAgentId: string | undefined;
  let secureFieldRequestedAgain: boolean | undefined, draftRetainedHarness: boolean | undefined;
  await key.fill(input.credential);
  // Retain only booleans/identity fields from browser-local storage. Never emit
  // its raw JSON, which is exactly the privacy surface under test.
  const draft = async () => page.evaluate(secret => {
    const raw = localStorage.getItem("paperclip-onboarding-state") ?? ""; let state: Record<string, unknown> = {};
    try { state = JSON.parse(raw) as Record<string, unknown>; } catch { /* Readiness below stays false. */ }
    return { companyId: typeof state.createdCompanyId === "string" ? state.createdCompanyId : null,
      agentId: typeof state.setupAgentId === "string" ? state.setupAgentId : null, harness: typeof state.adapterType === "string" ? state.adapterType : null,
      containsCredential: Object.values(localStorage).some(value => String(value).includes(secret)) };
  }, input.credential);
  const saved = await pollUntil({ label: "nonsecret wizard draft persisted", deadlineAt: input.deadlineAt, load: draft,
    accept: value => value.companyId === company.id && value.agentId === provisional.id && value.harness === input.harness });
  if (saved.containsCredential) throw new Error("The actual wizard draft leaked its secure input; contents withheld");
  if (input.resume) {
    draftCompanyId = saved.companyId!; draftAgentId = saved.agentId!;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Connect a model", exact: true })).toBeVisible();
    const restored = await draft(); restoredCompanyId = restored.companyId!; restoredAgentId = restored.agentId!; draftRetainedHarness = restored.harness === input.harness;
    key = page.getByPlaceholder("Enter API key here", { exact: true }); await expect(key).toBeVisible();
    secureFieldRequestedAgain = await key.inputValue() === "";
    if (!secureFieldRequestedAgain || restored.containsCredential) throw new Error("Reload did not request the secure input again; values withheld");
    const existing = await get<Agent[]>(`/api/companies/${company.id}/agents`);
    if (existing.length !== 1 || existing[0]?.id !== provisional.id || existing[0]?.lifecycleState === "ready") throw new Error("Wizard reload duplicated or prematurely completed the first agent");
    await key.fill(input.credential);
  }
  let hello: WizardReceipt["hello"] | undefined; let actualProbeEnvironmentId = ""; let hiredThroughWizard = false;
  const reads = new Set<Promise<void>>();
  const onResponse = (response: Response) => {
    const url = new URL(response.url()); if (url.origin !== origin || response.request().method() !== "POST") return;
    const test = url.pathname === `/api/companies/${company.id}/adapters/${input.harness}/test-environment`;
    const hire = url.pathname === `/api/companies/${company.id}/agent-hires`;
    if (!test && !hire) return;
    const pending = (async () => {
      if (hire) { hiredThroughWizard = response.ok(); return; }
      const request = response.request().postDataJSON() as { environmentId?: unknown };
      actualProbeEnvironmentId = typeof request.environmentId === "string" ? request.environmentId : "";
      const body = await response.json() as { adapterType?: string; status?: string; checks?: Array<{ code?: string; level?: string }> };
      hello = { httpStatus: response.status(), routeHarness: input.harness, adapterType: body.adapterType ?? "", status: body.status ?? "",
        checks: (body.checks ?? []).map(row => ({ code: row.code ?? "", level: row.level ?? "" })) };
    })(); reads.add(pending); void pending.finally(() => reads.delete(pending)).catch(() => {});
  };
  page.on("response", onResponse);
  try {
    await page.getByRole("button", { name: /^(?:Connect|Next)$/, exact: true }).last().click();
    await expect(page.getByRole("button", { name: "Get started", exact: true })).toBeVisible({ timeout: remaining() });
    await Promise.all([...reads]);
  } finally { page.off("response", onResponse); }
  const expectedHello = input.harness === "claude_local" ? ["claude_hello_probe_passed", "acpx_hello_probe_passed"] : ["codex_hello_probe_passed"];
  if (!hello || hello.httpStatus !== 200 || !["pass", "warn"].includes(hello.status) || hello.checks.some(row => row.level === "error" || row.code === "adapter_auth_missing" || /_auth_required$/.test(row.code)) || !hello.checks.some(row => expectedHello.includes(row.code))
    || actualProbeEnvironmentId !== environment.id || !hiredThroughWizard) throw new Error("Actual wizard account/harness/target verification is incomplete; a saved profile alone is not readiness");
  const agents = await get<Agent[]>(`/api/companies/${company.id}/agents`);
  if (agents.length !== 1 || agents[0]?.id !== provisional.id) throw new Error("Wizard completion duplicated or replaced the saved first agent");
  const agent = await pollUntil({ label: "wizard first agent independently ready", deadlineAt: input.deadlineAt,
    load: () => get<Agent>(`/api/agents/${provisional.id}`), accept: row => row.lifecycleState === "ready" && ["idle", "active"].includes(row.status) });
  const actualHarness = agent.adapterType === "claude_local" || agent.adapterType === "codex_local" ? agent.adapterType
    : agent.adapterType === "paperclip_runner" && agent.adapterConfig.provider === "acpx" && agent.adapterConfig.acpxAgent === "claude" ? "claude_local"
      : agent.adapterType === "paperclip_runner" && agent.adapterConfig.provider === "codex" ? "codex_local" : undefined;
  if (actualHarness !== input.harness || agent.companyId !== company.id || JSON.stringify(agent).includes(input.credential)) throw new Error("Public ready agent differs from the requested harness/company or exposes its credential; contents withheld");
  const accounts = await get<AiConnectionList>(`/api/companies/${company.id}/ai-connections`);
  const responsibleCompany = await get<Company>(`/api/companies/${company.id}`);
  const provider = input.harness === "claude_local" ? "anthropic" : "openai";
  const account = accounts.connections.find(row => row.companyId === company.id && row.provider === provider && row.method === "api_key" && row.ownership === "personal"
    && row.ownerUserId === accounts.currentUserId && row.isDefault && row.status === "connected");
  if (!account || responsibleCompany.defaultResponsibleUserId !== accounts.currentUserId || agent.runtimeConfig.aiConnection?.provider !== provider
    || agent.runtimeConfig.aiConnection.method !== "api_key" || agent.runtimeConfig.aiConnection.mode !== "responsible_user") throw new Error("Ready wizard agent does not retain the actual responsible person's selected provider account");
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await expect(page.getByTestId("task-chat-composer-input").or(page.getByTestId("task-chat-composer-takeover")).first()).toBeVisible();
  const settings = await get<{ enableAgentChat: boolean }>("/api/instance/settings/experimental");
  if (settings.enableAgentChat) {
    await page.goto(`${origin}/${company.issuePrefix}/chats/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
  }
  const runIds = (await get<Array<{ id: string }>>(`/api/companies/${company.id}/heartbeat-runs?limit=100`)).map(row => row.id);
  const afterCompanies = await get<Company[]>("/api/companies");
  const finalDraft = await draft();
  const receipt: WizardReceipt = { companyId: company.id, firstAgentId: agent.id, companyName: company.name, agentName: agent.name, requestedHarness: input.harness, actualHarness,
    environmentId: environment.id, environmentDriver: environment.driver, actualProbeEnvironmentId, beforeCompanyIds: before.map(row => row.id), afterCompanyIds: afterCompanies.map(row => row.id),
    beforeReadyAgents, afterAgentIds: agents.map(row => row.id), hello, hiredThroughWizard, firstAgentReady: true, chatComposerVisible: true, heartbeatRunIds: runIds, readyConversationPath: new URL(page.url()).pathname,
    account: { id: account.id, grantId: account.grantId, provider: account.provider, method: account.method, status: account.status, ownership: account.ownership,
      ownerUserId: account.ownerUserId, currentUserId: accounts.currentUserId, responsibleUserId: responsibleCompany.defaultResponsibleUserId, bindingMode: agent.runtimeConfig.aiConnection.mode },
    ...(input.resume ? { draftCompanyId, draftAgentId, restoredCompanyId, restoredAgentId, secureFieldRequestedAgain, draftRetainedHarness } : {}),
    draftContainsCredential: saved.containsCredential || finalDraft.containsCredential, publicAgentContainsCredential: false,
    verificationKind: "public-native-hello-probe", firstWorkExecuted: false, probeUsage: "unavailable-outside-heartbeat-accounting" };
  await input.evidence("identity-public-wizard-result.json", receipt); return receipt;
}
