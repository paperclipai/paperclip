import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, test } from "@playwright/test";
import type {
  ToolConnection,
  ToolCatalogEntry,
  ToolConnectionTestCallResult,
  ConnectionGrantsResponse,
} from "../../../packages/shared/src/types/tool-access.js";
import {
  validNotionOAuthInput,
  notionSelfWorkspaceMatches,
  type NotionOAuthInput,
  type NotionOAuthReceipt,
} from "./external-notion-oauth-contract.js";
/** Finite real Notion OAuth operation. Never imported into Playwright Test;
 * private redirects/session/API bodies cannot enter its step/report hooks. */
async function main(): Promise<NotionOAuthReceipt> {
  let attached = false;
  try {
    test.info();
    attached = true;
  } catch {
    /* standalone */
  }
  if (attached) throw new Error("Private Notion OAuth must run outside Test");
  const input = JSON.parse(
    await readFile(process.argv[2]!, "utf8"),
  ) as NotionOAuthInput & { executablePath?: string; channel?: string };
  if (!validNotionOAuthInput(input))
    throw new Error("Invalid private Notion request");
  const browser = await chromium.launch({
    headless: true,
    ...(input.executablePath ? { executablePath: input.executablePath } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
  });
  try {
    const storage = path.join(path.dirname(process.argv[2]!), "storage.json");
    await writeFile(
      storage,
      JSON.stringify({
        cookies: [
          ...input.publicSession.cookies,
          ...input.notionSession.cookies,
        ],
        origins: [
          ...input.publicSession.origins,
          ...input.notionSession.origins,
        ],
      }),
      { mode: 0o600 },
    );
    const context = await browser.newContext({ storageState: storage });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const api = async <T>(pathname: string): Promise<T> => {
      const response = await context.request.get(input.publicOrigin + pathname);
      if (!response.ok()) throw new Error("Private public-state read failed");
      return (await response.json()) as T;
    };
    const session = await api<{ user: { id: string } }>(
      "/api/auth/get-session",
    );
    if (session.user?.id !== input.humanId)
      throw new Error(
        "Public Notion setup person differs from addressed human",
      );
    const root = `/api/companies/${input.companyId}/tools`;
    if (input.intentId) {
      const cards = await api<
        Array<{
          id: string;
          status: string;
          addresseeUserId?: string;
          payload?: { serviceSlug: string; requestingAgentId: string };
        }>
      >(`/api/issues/${input.issueId}/interactions`);
      const card = cards.find((c) => c.id === input.intentId);
      if (
        !card ||
        card.status !== "pending" ||
        card.addresseeUserId !== input.humanId ||
        card.payload?.serviceSlug !== "notion" ||
        card.payload.requestingAgentId !== input.agentId
      )
        throw new Error(
          "Notion full-page handoff lost its actual addressed source intent",
        );
    }
    const before = (
      await api<{ connections: ToolConnection[] }>(root + "/connections")
    ).connections;
    const params = new URLSearchParams({ source: "notion", stage: "setup" });
    if (input.intentId) params.set("intent", input.intentId);
    if (input.draftId) params.set("resume", input.draftId);
    if (input.reconnectId) params.set("reconnect", input.reconnectId);
    if (input.newPersonal) params.set("new", "1");
    const setupURL = `${input.publicOrigin}/${input.prefix}/apps/connect?${params}`;
    await page.goto(setupURL, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", {
        name: input.draftId
          ? "Finish connecting Notion"
          : "Connect Notion to Paperclip",
        exact: true,
      })
      .waitFor();
    if (!input.draftId && !input.reconnectId) {
      await page.getByRole("button", { name: "Change", exact: true }).click();
      await page.getByRole("radio", { name: "Just me", exact: true }).click();
    }
    const started = page.waitForResponse(
      (r) =>
        r.url().startsWith(input.publicOrigin + root + "/apps/connect") &&
        r.request().method() === "POST",
    );
    const navigated = page.waitForURL((u) => u.origin !== input.publicOrigin, {
      timeout: 90000,
    });
    // Source UI starts OAuth directly from a durable resume without connectApp.
    if (input.draftId || input.reconnectId) void started.catch(() => undefined);
    await page
      .getByRole("button", {
        name: input.draftId ? "Finish with Notion" : "Continue to Notion",
        exact: true,
      })
      .click();
    let connectionId = input.draftId ?? input.reconnectId;
    if (!connectionId) {
      const response = await started;
      if (!response.ok())
        throw new Error("Actual Notion draft creation failed");
      connectionId = ((await response.json()) as { connectionId: string })
        .connectionId;
    }
    if (!connectionId) throw new Error("Actual Notion draft ID missing");
    await navigated;
    const provider = new URL(page.url());
    if (
      provider.protocol !== "https:" ||
      !/^(?:[a-z0-9-]+\.)*notion\.(?:so|com)$/.test(provider.hostname)
    )
      throw new Error("Notion handoff escaped official provider");
    const draft = await api<ToolConnection>(
      `/api/tool-connections/${connectionId}`,
    );
    const grantState = await api<ConnectionGrantsResponse>(
      `/api/tool-connections/${connectionId}/grants`,
    );
    const personal = grantState.grants.filter(
      (g) => g.kind === "user" && g.subjectUserId === input.humanId,
    );
    if (input.reconnectId) {
      if (
        draft.id !== input.reconnectId ||
        draft.companyId !== input.companyId ||
        draft.authKind !== "oauth" ||
        draft.credentialPolicy !== "shared" ||
        !before.some((c) => c.id === draft.id) ||
        !grantState.grants.some((g) => g.kind === "organization")
      )
        throw new Error(
          "Actual Notion reconnect changed the existing shared OAuth identity",
        );
    } else if (
      draft.companyId !== input.companyId ||
      draft.credentialPolicy !== "per_user" ||
      draft.authKind !== "oauth" ||
      draft.status !== "draft" ||
      draft.credentialSecretRefs.length ||
      draft.credentialRefs?.length ||
      personal.length !== 1 ||
      before.some((c) => c.id === connectionId) !== !!input.draftId
    )
      throw new Error(
        "Notion handoff did not preserve one actual credential-free personal draft",
      );
    const receipt: NotionOAuthReceipt = {
      connectionId,
      humanId: input.humanId,
      intentId: input.intentId ?? null,
      personalDraft: !input.reconnectId,
      providerHandoff: true,
      credentialAbsentAtHandoff: !input.reconnectId,
      resumedSameDraft: !!input.draftId,
      draftSurvivedReload: false,
      consentCompleted: false,
      callbackReturned: false,
      workspaceMatched: false,
      providerHumanMatched: false,
      processIsolation: true,
      testRunnerAttached: false,
      tracingEnabled: false,
      videoEnabled: false,
    };
    if (input.operation === "save-draft") {
      // Leave before any provider consent; supported setup navigation and actual
      // reload must hydrate the original durable choices, without a fake draft.
      const resume = new URL(setupURL);
      resume.searchParams.set("resume", connectionId);
      await page.goto(`${input.publicOrigin}/${input.prefix}/apps`, {
        waitUntil: "domcontentloaded",
      });
      await page.goto(resume.href, { waitUntil: "domcontentloaded" });
      await page.reload();
      await page
        .getByRole("button", { name: "Finish with Notion", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Change", exact: true }).click();
      if (
        !(await page
          .getByRole("radio", { name: "Just me", exact: true })
          .isChecked())
      )
        throw new Error("Reloaded Notion draft lost personal identity choice");
      const current = await api<ToolConnection>(
        `/api/tool-connections/${connectionId}`,
      );
      const rows = (
        await api<{ connections: ToolConnection[] }>(root + "/connections")
      ).connections;
      if (
        current.status !== "draft" ||
        current.credentialPolicy !== "per_user" ||
        current.credentialSecretRefs.length ||
        current.credentialRefs?.length ||
        rows.length !== before.length + (input.draftId ? 0 : 1)
      )
        throw new Error(
          "Saved Notion draft became usable or duplicated before credentials",
        );
      receipt.draftSurvivedReload = true;
      return receipt;
    }
    // Provider UI identity is checked before consent; a session/display name
    // alone never proves the workspace that was actually granted. The private
    // get-self call below supplies independent exact workspace authority.
    await page.getByText(input.providerEmail, { exact: true }).waitFor();
    const workspace = page.getByRole("combobox");
    if ((await workspace.count()) === 1) {
      if (await workspace.evaluate((e) => e.tagName === "SELECT"))
        await workspace.selectOption({ label: input.workspaceName });
      else {
        await workspace.click();
        await page
          .getByRole("option", { name: input.workspaceName, exact: true })
          .click();
      }
    }
    await page
      .getByText(input.workspaceName, { exact: true })
      .first()
      .waitFor();
    receipt.providerHumanMatched = true;
    let originalConversationReturned = false;
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() || !input.issueId) return;
      const u = new URL(frame.url());
      if (
        u.origin === input.publicOrigin &&
        [
          `/issues/${input.issueId}`,
          `/${input.prefix}/issues/${input.issueId}`,
        ].includes(u.pathname)
      )
        originalConversationReturned = true;
    });
    await page
      .getByRole("button", { name: /^(Allow access|Authorize|Allow)$/i })
      .click();
    await page.waitForURL((u) => u.origin === input.publicOrigin, {
      timeout: 90000,
    });
    if (input.issueId) {
      for (let n = 0; n < 40 && !originalConversationReturned; n++)
        await new Promise((r) => setTimeout(r, 250));
      if (!originalConversationReturned)
        throw new Error(
          "Notion callback did not actually return to its original source conversation",
        );
      const cards = await api<
        Array<{
          id: string;
          status: string;
          resolvedByUserId?: string;
          result?: { outcome: string; connectionId: string };
        }>
      >(`/api/issues/${input.issueId}/interactions`);
      const card = cards.find((c) => c.id === input.intentId);
      if (
        !card ||
        card.status === "pending" ||
        card.resolvedByUserId !== input.humanId ||
        card.result?.outcome !== "connected" ||
        card.result.connectionId !== connectionId
      )
        throw new Error(
          "Notion callback did not resolve the exact original addressed conversation request",
        );
    }
    receipt.callbackReturned = true;
    let connected: ToolConnection | undefined;
    for (let n = 0; n < 40; n++) {
      connected = await api<ToolConnection>(
        `/api/tool-connections/${connectionId}`,
      );
      if (connected.status === "active" && connected.healthStatus === "ok")
        break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (
      !connected ||
      connected.companyId !== input.companyId ||
      connected.status !== "active" ||
      connected.healthStatus !== "ok" ||
      connected.credentialPolicy !== (input.reconnectId ? "shared" : "per_user")
    )
      throw new Error(
        "Real Notion callback did not activate the same personal draft",
      );
    const catalog = (
      await api<{ catalog: ToolCatalogEntry[] }>(
        `/api/tool-connections/${connectionId}/catalog`,
      )
    ).catalog;
    const self = catalog.filter(
      (e) =>
        e.toolName === "notion-get-self" &&
        e.isReadOnly &&
        e.status === "active",
    );
    if (self.length !== 1)
      throw new Error("Official Notion workspace identity tool is unavailable");
    const testCall = await context.request.post(
      `${input.publicOrigin}/api/tool-connections/${connectionId}/test-calls`,
      {
        data: {
          agentId: input.agentId,
          toolName: self[0]!.toolName,
          parameters: {},
        },
      },
    );
    if (!testCall.ok())
      throw new Error("Independent Notion get-self could not execute");
    const result = (await testCall.json()) as ToolConnectionTestCallResult;
    if (
      result.decision !== "allowed" ||
      result.error ||
      !notionSelfWorkspaceMatches(result.result, input.workspaceId)
    )
      throw new Error(
        "Actual granted Notion workspace differs from selected personal fixture",
      );
    if (
      (await api<{ user: { id: string } }>("/api/auth/get-session")).user.id !==
      input.humanId
    )
      throw new Error("Notion callback changed the signed-in person");
    receipt.workspaceMatched = true;
    receipt.consentCompleted = true;
    return receipt;
  } finally {
    await browser.close();
  }
}
main()
  .then((value) => process.stdout.write(JSON.stringify(value)))
  .catch(() => {
    process.stderr.write(
      "Private Notion OAuth operation failed; provider/session/redirect details withheld\n",
    );
    process.exitCode = 1;
  });
