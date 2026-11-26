import { readFile } from "node:fs/promises";
import { chromium, test, expect } from "@playwright/test";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import type { ConnectionIntentSetupOptions } from "../../../packages/shared/src/types/connection-intent.js";
import type { ConnectionGrant, ToolConnection, ToolConnectionInstall } from "../../../packages/shared/src/types/tool-access.js";
import { parseHumanGitHubAuth, qualifiesReadOnlyApp, qualifiesReadOnlyGrant, type GitHubHumanRequest, type GitHubAppQualification, type ReadOnlyGitHubGrant } from "./runtime-workspace-repositories-auth.js";
import { digest } from "./runtime-workspace-repositories-support.js";
let privateValues: string[] = [];
async function main(): Promise<ReadOnlyGitHubGrant> {
  try { test.info(); throw new Error("Attached Test worker refused"); } catch (error) { if (error instanceof Error && error.message === "Attached Test worker refused") throw error; }
  const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as GitHubHumanRequest & { executablePath?: string; channel?: string };
  const auth = parseHumanGitHubAuth(JSON.stringify(input.auth)), origin = new URL(input.origin);
  if (!(origin.protocol === "https:" || origin.protocol === "http:" && origin.hostname === "127.0.0.1") || origin.username || origin.password || origin.search || origin.hash
    || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input.repositoryFullName) || !/^[1-9]\d*$/.test(input.repositoryId)) throw new Error("Invalid owned human authorization target");
  for (const id of [input.companyId, input.taskId, input.workerId, input.interactionId, input.personId]) if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid product identity");
  privateValues = [auth.clientSecret, ...auth.storageState.cookies.map(cookie => cookie.value), ...input.cookies.map(cookie => cookie.value), ...auth.storageState.origins.flatMap(site => site.localStorage.map(row => row.value))];
  const browser = await chromium.launch({ headless: true, ...(input.executablePath ? { executablePath: input.executablePath } : {}), ...(input.channel ? { channel: input.channel } : {}) });
  let createdConnectionId: string | undefined;
  const pendingResponses = new Set<Promise<void>>();
  try {
    const context = await browser.newContext({ storageState: auth.storageState }); await context.addCookies(input.cookies);
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.origin !== origin.origin || response.request().method() !== "POST" || url.pathname !== `/api/companies/${input.companyId}/tools/connections` || !response.ok()) return;
      const tracked = response.json().then((body: ToolConnection | { connection: ToolConnection }) => {
        const connection = "connection" in body ? body.connection : body;
        if (connection.companyId === input.companyId && connection.config?.sourceTemplateKey === "github" && (connection.config.oauth as { clientId?: string } | undefined)?.clientId === auth.clientId) createdConnectionId = connection.id;
      }).catch(() => {}).finally(() => pendingResponses.delete(tracked));
      pendingResponses.add(tracked);
    });
    let productReads = 0, providerReads = 0;
    const get = async <T>(route: string): Promise<T> => {
      if (!route.startsWith("/api/") || new URL(route, origin).origin !== origin.origin || ++productReads > 90) throw new Error("Bounded public read escaped");
      const response = await context.request.get(new URL(route, origin).href, { maxRedirects: 0, timeout: 15000 });
      if (!response.ok()) { await response.dispose(); throw new Error("Required public authorization state is unavailable"); }
      try { return await response.json() as T; } finally { await response.dispose(); }
    };
    const appRead = async () => {
      if (++providerReads > 2) throw new Error("Provider qualification bound exceeded");
      const response = await fetch(`https://api.github.com/apps/${auth.appSlug}`, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Read-only GitHub App prerequisite unavailable"); }
      const app = await response.json() as GitHubAppQualification;
      if (!qualifiesReadOnlyApp(app, auth)) throw new Error("App is not the declared independently verified read-only client");
      return app;
    };
    const session = await get<{ user?: { id: string } }>("/api/auth/get-session");
    const before = await get<ConnectionIntentSetupOptions>(`/api/connection-intents/${input.interactionId}/setup-options`);
    if (session.user?.id !== input.personId || before.interaction.addresseeUserId !== input.personId || before.interaction.status !== "pending" || before.requestedAgentId !== input.workerId) throw new Error("Human/intent/worker prerequisite changed");
    const app = await appRead();
    // Actual human pause prevents any newly queued continuation from receiving
    // a credential until independent app/installation/repository checks pass.
    await page.goto(new URL(`/${input.issuePrefix}/agents/${input.workerId}`, origin).href);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const confirmation = page.getByRole("alertdialog"); if (await confirmation.isVisible()) await confirmation.getByRole("button", { name: "Pause", exact: true }).click();
    if ((await get<Agent>(`/api/agents/${input.workerId}`)).status !== "paused") throw new Error("Worker pause was not saved before consent");
    const provider = await context.newPage();
    // This case requires a genuine pre-existing disposable read-only App
    // installation. No new App or provider credential is manufactured.
    const owner = input.repositoryFullName.split("/")[0]!;
    await provider.goto(`https://github.com/settings/profile`);
    const login = await provider.locator('meta[name="user-login"]').getAttribute("content");
    if (!login || /\/login(?:\/|\?|$)/.test(provider.url())) throw new Error("Genuine human GitHub session is unavailable");
    const installationUrl = owner.toLowerCase() === login.toLowerCase()
      ? `https://github.com/settings/installations/${auth.installationId}`
      : `https://github.com/organizations/${owner}/settings/installations/${auth.installationId}`;
    await provider.goto(installationUrl);
    await expect(provider.getByText(app.name, { exact: true }).first()).toBeVisible();
    const selectedOnly = provider.getByRole("radio", { name: /Only select repositories/i });
    await expect(selectedOnly).toBeChecked();
    // A real existing selected installation is independently read back after
    // OAuth too. Never broaden to All repositories to make setup succeed.
    await expect(provider.getByText(input.repositoryFullName.split("/")[1]!, { exact: true }).first()).toBeVisible();
    const installationSelected = true;
    await provider.close();
    await page.goto(new URL(`/${input.issuePrefix}/issues/${input.taskId}`, origin).href);
    const card = page.locator(`[id=${JSON.stringify(`connection-intent-focus-target-${input.interactionId}`)}]`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: /^(?:Connect|Connect \/ Use existing)$/ }).click();
    const dialog = page.getByRole("dialog", { name: "Connect GitHub", exact: true }); await expect(dialog).toBeVisible();
    const connectNew = dialog.getByRole("button", { name: "Connect new", exact: true });
    if (await connectNew.isVisible()) await connectNew.click();
    const useOwn = dialog.getByRole("button", { name: "Use your own GitHub OAuth app", exact: true });
    if (await useOwn.isVisible()) await useOwn.click();
    if (!await dialog.getByLabel("Client ID", { exact: true }).isVisible()) {
      const change = dialog.getByRole("button", { name: "Change", exact: true });
      if (await change.count() !== 1) throw new Error("Customer-owned client disclosure is ambiguous");
      await change.click();
    }
    await dialog.getByLabel("Client ID", { exact: true }).fill(auth.clientId); await dialog.getByLabel("Client secret", { exact: true }).fill(auth.clientSecret);
    const mine = dialog.getByRole("radio", { name: /My GitHub account/ }); if (await mine.isVisible()) await mine.check();
    // The task dialog locks reach to the actual requesting agent. No API
    // create/finish/complete call substitutes for the tested visible controls.
    const signIn = dialog.getByRole("button", { name: /^(?:Continue to GitHub|Continue|Connect GitHub|Connect)$/ });
    const popupPromise = context.waitForEvent("page", { timeout: 30000 }); await signIn.last().click();
    const authorization = await popupPromise;
    await authorization.waitForURL(url => url.hostname === "github.com", { timeout: 30000 });
    const oauth = new URL(authorization.url());
    if (oauth.searchParams.get("client_id") !== auth.clientId || !oauth.pathname.startsWith("/login/oauth/authorize")) throw new Error("Provider consent selected a different OAuth client");
    const redirect = oauth.searchParams.get("redirect_uri"); if (redirect && new URL(redirect).origin !== origin.origin) throw new Error("OAuth callback escaped owned product origin");
    await expect(authorization.getByText(app.name, { exact: false }).first()).toBeVisible();
    const authorize = authorization.getByRole("button", { name: /^Authorize(?:\s|$)/ });
    if (await authorize.count() !== 1) throw new Error("Unambiguous actual provider consent is unavailable");
    await authorize.click();
    let options: ConnectionIntentSetupOptions | undefined;
    while (Date.now() < input.deadlineAt - 30000) {
      options = await get<ConnectionIntentSetupOptions>(`/api/connection-intents/${input.interactionId}/setup-options`);
      if (options.interaction.status === "accepted" && options.interaction.result?.outcome === "connected") break;
      if (await authorization.isClosed() === false && /\/login(?:\/|\?|$)|two-factor|saml/i.test(authorization.url())) throw new Error("Genuine provider human session needs operator authentication");
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    const result = options?.interaction.result;
    if (!options || result?.outcome !== "connected" || !result.connectionId) throw new Error("Actual provider/UI callback did not complete the pending intent");
    createdConnectionId = result.connectionId;
    const connection = await get<ToolConnection>(`/api/tool-connections/${result.connectionId}`);
    const grantList = await get<{ grants: ConnectionGrant[] }>(`/api/tool-connections/${result.connectionId}/grants`);
    const { installs } = await get<{ installs: ToolConnectionInstall[] }>(`/api/tool-connections/${result.connectionId}/installs`);
    const currentApp = await appRead();
    const grants = grantList.grants.filter(grant => qualifiesReadOnlyGrant({ ...input, app: currentApp, auth, connection, grant, installs, interaction: options!.interaction }));
    if (grants.length !== 1 || grants[0]!.providerTenant?.github?.login.toLowerCase() !== login.toLowerCase() || grants[0]!.providerTenant?.github?.installationIds[0] !== auth.installationId) throw new Error("Saved human grant is not exact-account/installation/repository read-only authority");
    if ((await get<Agent>(`/api/agents/${input.workerId}`)).status !== "paused") throw new Error("Worker admitted before qualification");
    await page.goto(new URL(`/${input.issuePrefix}/agents/${input.workerId}`, origin).href);
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    if ((await get<Agent>(`/api/agents/${input.workerId}`)).status === "paused") throw new Error("Actual UI worker resume did not persist");
    const github = grants[0]!.providerTenant!.github!;
    return { appId: app.id, appSlug: app.slug, appClientSha256: digest(auth.clientId), appMetadataSha256: digest(JSON.stringify(currentApp)), connectionId: connection.id, grantId: grants[0]!.id,
      personId: input.personId, workerId: input.workerId, installationId: auth.installationId, repositoryId: input.repositoryId, repositoryFullName: input.repositoryFullName,
      interactionId: input.interactionId, providerUserId: github.userId, providerLogin: github.login, readonlyAppVerified: true, selectedRepositoryVerified: true,
      actualProviderConsent: true, actualInstallationSelection: installationSelected, genuineHumanSession: true, uiCompletionObserved: true, workerPausedBeforeConsent: true,
      isolatedPrivateBrowser: true, tracingEnabled: false, videoEnabled: false, testRunnerAttached: false };
  } catch {
    // Cleanup only newly created Paperclip connection, never forge/retry the
    // human action or resume a worker after failed authority qualification.
    await Promise.allSettled([...pendingResponses]);
    if (createdConnectionId) {
      const cleanup = await browser.newContext(); await cleanup.addCookies(input.cookies);
      try { await cleanup.request.delete(new URL(`/api/tool-connections/${createdConnectionId}`, origin).href, { maxRedirects: 0 }); } finally { await cleanup.close(); }
    }
    throw new Error("Protected human GitHub consent prerequisite or completion failed");
  } finally { await browser.close(); }
}
main().then(receipt => { const output = JSON.stringify(receipt); if (privateValues.some(value => !!value && [value, encodeURIComponent(value), Buffer.from(value).toString("base64")].some(encoded => output.includes(encoded)))) throw new Error("Closed receipt contains private value"); process.stdout.write(output); }).catch(() => { process.stderr.write("Protected human GitHub consent failed; details withheld"); process.exitCode = 1; });
