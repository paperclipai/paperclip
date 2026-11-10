import { expect, test, type Page, type Response } from "@playwright/test";
import { privateIdentityBrowser } from "./identity-private-browser.js";
import { pollUntil } from "../api.js";
import type { AiConnectionList } from "../../../packages/shared/src/ai-connections.js";
import type { ConnectionGrantsResponse, ToolConnectionInstall } from "../../../packages/shared/src/types/tool-access.js";
import { NEW_COMPANY_NATIVE_MODEL, NEW_COMPANY_PROVIDER_MODEL, nativeSetupRequest, requireNativeFirstAgentProof,
  type NativeCompany, type NativeFirstAgent, type NativeSetupProbe, type NativeSetupRequest, type NewCompanyNativeReceipt } from "./identity-new-company-native-proof.js";
export type { NewCompanyNativeReceipt } from "./identity-new-company-native-proof.js";
interface Input {
  page: Page; origin: string; companyName: string; agentName: string; credential: string; deadlineAt: number;
  onCompany(id: string): void; onConnection(companyId: string, connectionId: string, grantId: string): void;
  evidence(name: string, value: unknown): Promise<void>;
}
export async function finishNativeNewCompany(input: Input): Promise<NewCompanyNativeReceipt> {
  const receipt = await privateIdentityBrowser({ kind: "new-company-native", origin: input.origin, startPath: input.page.url(),
    cookies: await input.page.context().cookies(input.origin), companyName: input.companyName, agentName: input.agentName,
    credential: input.credential, deadlineAt: input.deadlineAt }, { company: input.onCompany, connection: input.onConnection });
  if (!receipt.newCompany) throw new Error("Private new-company setup returned no closed result");
  await input.page.goto(new URL(receipt.newCompany.readyConversationPath, input.origin).href, { waitUntil: "domcontentloaded" });
  await input.evidence("identity-public-new-company-native-result.json", receipt.newCompany); return receipt.newCompany;
}
/** Only the existing standalone private credential worker may call this. */
export async function runNativeNewCompanyInPrivateBrowser(input: Input & {
  registerCompany(company: NativeCompany): Promise<void>;
  registerConnection(companyId: string, connectionId: string, grantId: string): Promise<void>;
}): Promise<NewCompanyNativeReceipt> {
  let attached = false; try { test.info(); attached = true; } catch { /* standalone only */ }
  if (attached) throw new Error("Credential-bearing company setup requires the private child");
  const { page, origin } = input;
  const remaining = () => Math.max(1, Math.min(180_000, input.deadlineAt - Date.now()));
  const get = async <T>(endpoint: string): Promise<T> => {
    const response = await page.context().request.get(origin + endpoint, { timeout: Math.min(30_000, remaining()) });
    if (!response.ok()) throw new Error(`Public company setup read returned HTTP ${response.status()}`); return response.json() as Promise<T>;
  };
  const session = await get<{ user: { id: string } }>("/api/auth/get-session");
  const before = await get<NativeCompany[]>("/api/companies");
  await page.getByRole("button", { name: /^Open .+ (?:organization|workspace|company) switcher$/i }).click();
  await page.getByRole("menuitem", { name: "Create organization", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What is the name of your organization?", exact: true })).toBeVisible();
  await page.locator("#onboarding-company-name").fill(input.companyName);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#onboarding-agent-name")).toBeVisible();
  const company = await pollUntil({ label: "actual saved new company", deadlineAt: input.deadlineAt,
    load: () => get<NativeCompany[]>("/api/companies"), accept: rows => rows.filter(row => !before.some(old => old.id === row.id) && row.name === input.companyName).length === 1 })
    .then(rows => rows.find(row => !before.some(old => old.id === row.id) && row.name === input.companyName)!);
  await input.registerCompany(company); input.onCompany(company.id);
  if ((await get<NativeFirstAgent[]>(`/api/companies/${company.id}/agents`)).length) throw new Error("The wizard created an agent before the public route departure");
  // Ordinary address-bar navigation to a supported public route. No hidden
  // dialog action, draft edit or forced localStorage state is used.
  const publicSetupRoute = `/${company.issuePrefix}/agents/new`;
  await page.goto(new URL(publicSetupRoute, origin).href, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("onboarding-wizard")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Meet your next agent", exact: true })).toBeVisible();
  await page.getByLabel("Agent name", { exact: true }).fill(input.agentName);
  await page.getByRole("button", { name: "Choose adapter", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose an adapter", exact: true })).toBeVisible();
  const setupAgents = await get<NativeFirstAgent[]>(`/api/companies/${company.id}/agents`);
  if (setupAgents.length !== 1 || setupAgents[0]?.name !== input.agentName || setupAgents[0]?.role !== "ceo" || setupAgents[0]?.lifecycleState === "ready")
    throw new Error("Public first-agent dialog did not save one setup-held CEO");
  const provisional = setupAgents[0]!;
  await page.getByRole("dialog").locator("summary").filter({ hasText: /^Advanced$/ }).click();
  await page.getByRole("button", { name: "Experimental harness", exact: true }).click();
  await page.getByRole("option", { name: "OpenCode (Paperclip Runner)", exact: true }).click();
  await page.getByRole("button", { name: "Configure agent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Configure your agent", exact: true })).toBeVisible();
  if (new URL(page.url()).searchParams.get("setupAgentId") !== provisional.id) throw new Error("Public setup route replaced the saved first-agent identity");
  const environments = await get<Array<{ id: string; driver: string }>>(`/api/companies/${company.id}/environments?driver=local`);
  if (environments.length !== 1 || environments[0]?.driver !== "local") throw new Error("Company setup requires the actual available local target");
  const environment = environments[0]!;
  await page.getByRole("combobox", { name: "Environment", exact: true }).selectOption(environment.id);
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption({ label: "Enter custom model…" });
  await page.getByRole("textbox", { name: "Model ID", exact: true }).fill(NEW_COMPANY_NATIVE_MODEL);
  let connection: { connectionId: string; grantId: string } | undefined; let responseSequence = 0;
  const probes: NativeSetupProbe[] = [], hires: Array<NativeSetupRequest & { httpStatus: number; resultAgentId: string }> = [];
  const reads = new Set<Promise<void>>(), errors: unknown[] = [];
  const onResponse = (response: Response) => {
    const url = new URL(response.url()); if (url.origin !== origin || response.request().method() !== "POST") return;
    const account = url.pathname === `/api/companies/${company.id}/ai-connections`;
    const probe = url.pathname.match(new RegExp(`^/api/companies/${company.id}/adapters/([^/]+)/test-environment$`));
    const hire = url.pathname === `/api/companies/${company.id}/agent-hires`;
    if (!account && !probe && !hire) return;
    const sequence = ++responseSequence;
    const pending = (async () => {
      const body = response.request().postDataJSON() as Record<string, unknown>;
      const result = await response.json() as Record<string, unknown>;
      if (account) {
        if (response.status() !== 201 || typeof result.connectionId !== "string" || typeof result.grantId !== "string") throw new Error("Public account creation receipt missing");
        await input.registerConnection(company.id, result.connectionId, result.grantId);
        if (connection || body.provider !== "openrouter" || body.method !== "api_key" || body.ownership !== "personal"
          || body.allAgents !== false || !Array.isArray(body.agentIds) || body.agentIds.length !== 1 || body.agentIds[0] !== provisional.id)
          throw new Error("Public account creation did not preserve exact personal first-agent access");
        connection = { connectionId: result.connectionId, grantId: result.grantId };
        return;
      }
      const request = nativeSetupRequest({ companyId: company.id, adapterType: probe ? decodeURIComponent(probe[1]!) : String(body.adapterType ?? ""), body, sequence }, input.credential);
      if (probe) probes.push({ ...request, httpStatus: response.status(), resultAdapterType: String(result.adapterType ?? ""), status: String(result.status ?? ""),
        checks: Array.isArray(result.checks) ? result.checks.map(row => ({ code: String(row.code ?? ""), level: String(row.level ?? "") })) : [] });
      else hires.push({ ...request, httpStatus: response.status(), resultAgentId: String((result.agent as { id?: string } | undefined)?.id ?? "") });
    })(); reads.add(pending); void pending.catch(error => errors.push(error)).finally(() => reads.delete(pending));
  };
  page.on("response", onResponse);
  const settleReads = async () => { await Promise.all([...reads].map(read => read.catch(() => {}))); if (errors.length) throw new Error("Public company setup response identity check failed"); };
  try {
    await page.getByRole("combobox", { name: "Connection", exact: true }).click();
    await page.getByRole("option", { name: "Connect an account…", exact: true }).click();
    const accountDialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Connect account", exact: true }) });
    await accountDialog.locator("summary").filter({ hasText: /^Advanced providers$/ }).click();
    await accountDialog.getByRole("button", { name: "OpenRouter", exact: true }).click();
    await accountDialog.getByRole("button", { name: "Change", exact: true }).click();
    await accountDialog.getByRole("radio", { name: "Just me", exact: true }).click();
    await accountDialog.getByRole("radio", { name: "Just agents I pick", exact: true }).click();
    await accountDialog.getByRole("button", { name: "Select agents", exact: true }).click();
    await page.getByRole("checkbox", { name: `Allow ${input.agentName}`, exact: true }).setChecked(true);
    await page.getByPlaceholder("Filter agents", { exact: true }).press("Escape");
    await accountDialog.getByRole("textbox", { name: "Model IDs", exact: true }).fill(NEW_COMPANY_PROVIDER_MODEL);
    await accountDialog.getByLabel("API key", { exact: true }).fill(input.credential);
    await accountDialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(accountDialog).not.toBeVisible({ timeout: remaining() }); await settleReads();
    if (!connection) throw new Error("Public new-company account creation receipt missing");
    await page.getByRole("button", { name: "Run test", exact: true }).click();
    await expect(page.getByRole("button", { name: "Test again", exact: true })).toBeVisible({ timeout: remaining() }); await settleReads();
    if (probes.length !== 1 || probes[0]?.status !== "pass") throw new Error("The selected native account/model test did not pass");
    await page.getByRole("button", { name: "Finish setup", exact: true }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^Assign ${input.agentName} a Task$`) })).toBeVisible({ timeout: remaining() }); await settleReads();
  } finally { page.off("response", onResponse); }
  const agents = await get<NativeFirstAgent[]>(`/api/companies/${company.id}/agents`);
  if (agents.length !== 1 || agents[0]?.id !== provisional.id) throw new Error("Public setup duplicated or replaced the first agent");
  const agent = await get<NativeFirstAgent>(`/api/agents/${provisional.id}`);
  const responsibleCompany = await get<NativeCompany>(`/api/companies/${company.id}`);
  const accounts = await get<AiConnectionList>(`/api/companies/${company.id}/ai-connections?agentId=${agent.id}`);
  const grants = await get<ConnectionGrantsResponse>(`/api/tool-connections/${connection!.connectionId}/grants`);
  const installs = await get<{ installs: ToolConnectionInstall[] }>(`/api/tool-connections/${connection!.connectionId}/installs`);
  requireNativeFirstAgentProof({ company: responsibleCompany, agent, humanId: session.user.id, environment, savedSetupAgentId: provisional.id, probes, hires, connection: connection!, accounts, grants, installs: installs.installs });
  if (JSON.stringify(agent).includes(input.credential)) throw new Error("The public first-agent record exposes a credential; values withheld");
  const draftContainsCredential = await page.evaluate(secret => Object.values(localStorage).some(value => String(value).includes(secret)), input.credential);
  if (draftContainsCredential) throw new Error("The public setup draft exposes a credential; values withheld");
  const settings = await get<{ enableAgentChat: boolean }>("/api/instance/settings/experimental");
  if (!settings.enableAgentChat) throw new Error("The actual new-company chat entry is unavailable");
  await page.goto(`${origin}/${company.issuePrefix}/chats/${agent.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
  const heartbeatRunIds = (await get<Array<{ id: string }>>(`/api/companies/${company.id}/heartbeat-runs?limit=100`)).map(row => row.id);
  const after = await get<NativeCompany[]>("/api/companies"), account = accounts.connections.find(row => row.id === connection!.connectionId && row.grantId === connection!.grantId)!;
  return { companyId: company.id, companyPrefix: company.issuePrefix, firstAgentId: agent.id, companyName: company.name, agentName: agent.name,
    requestedHarness: "opencode_local", actualHarness: "opencode_local", model: NEW_COMPANY_NATIVE_MODEL, environmentId: environment.id, environmentDriver: "local", actualProbeEnvironmentId: probes[0]!.environmentId,
    beforeCompanyIds: before.map(row => row.id), afterCompanyIds: after.map(row => row.id), beforeReadyAgents: 0, afterAgentIds: agents.map(row => row.id),
    noAgentBeforeRouteDeparture: true, publicSetupRoute, savedSetupAgentId: provisional.id, hello: probes[0]!, helloCount: probes.length, hiredThroughPublicSetup: true, hireCount: hires.length,
    firstAgentReady: true, chatComposerVisible: true, heartbeatRunIds, readyConversationPath: new URL(page.url()).pathname,
    account: { id: account.id, grantId: account.grantId, provider: "openrouter", method: "api_key", status: "connected", ownership: "personal", ownerUserId: account.ownerUserId!, currentUserId: session.user.id, responsibleUserId: responsibleCompany.defaultResponsibleUserId!, bindingMode: "delegated" },
    exactPublicGrantAndAgentInstall: true, draftContainsCredential: false, publicAgentContainsCredential: false, verificationKind: "public-native-hello-probe", firstWorkExecuted: false, probeUsage: "unavailable-outside-heartbeat-accounting" };
}
