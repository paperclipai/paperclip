/** Finite required-human named ChatGPT setup. No generic client registration,
 * token exchange, REST comment surrogate, tracing, screenshots or provider state
 * export. The browser stays private until its exact cleanup gate is released. */
import { readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  test,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { readValidatedPublicOriginReceipt } from "../chat-public-origin.js";
import type {
  McpConnection,
  McpConnectionRequest,
  McpConnectionSetup,
} from "../../../packages/shared/src/public-mcp.js";
import {
  namedChatgptRequest,
  validChatgptInput,
  setupCheckComment,
  createdChatgptAppId,
  exactAcceptedChatgptScopes,
  chatgptConsentDisclosure,
  type ChatgptInput,
  type ChatgptReceipt,
} from "./external-chatgpt-contract.js";
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
async function pane(
  page: Page,
  title: string,
  body: string,
  checks: string[],
  button: string,
) {
  await page.setContent(
    `<html><head><title>Private ChatGPT setup</title></head><body><h1>${esc(title)}</h1>${body}<form>${checks.map((text) => `<p><label><input type="checkbox" required>${esc(text)}</label></p>`).join("")}<button>${esc(button)}</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.confirmed='yes'}</script></body></html>`,
  );
  await page.bringToFront();
}
async function confirm(page: Page, timeout: number) {
  await page.waitForFunction(
    () => document.body.dataset.confirmed === "yes",
    undefined,
    { timeout },
  );
}
async function json<T>(
  c: BrowserContext,
  origin: string,
  pathname: string,
): Promise<T> {
  const r = await c.request.get(origin + pathname);
  if (!r.ok()) throw new Error("Private named-client public read failed");
  return r.json() as Promise<T>;
}
async function main() {
  let attached = false;
  try {
    test.info();
    attached = true;
  } catch {
    /* standalone */
  }
  if (attached)
    throw new Error("Private named ChatGPT operation cannot run in Test");
  const filename = process.argv[2]!,
    directory = path.dirname(filename),
    stat = await lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    stat.size > 2 * 1024 * 1024
  )
    throw new Error("Invalid private named-client file");
  const i = JSON.parse(await readFile(filename, "utf8")) as ChatgptInput;
  if (!validChatgptInput(i))
    throw new Error("Invalid finite named-client input");
  const origin = await readValidatedPublicOriginReceipt({
    receiptPath: i.receiptPath,
    executionId: i.executionId,
    attemptId: i.attemptId,
    backendOrigin: i.backendOrigin,
  });
  if (origin.publicOrigin !== i.publicOrigin)
    throw new Error("Actual owned public origin changed");
  const browser = await chromium.launch({
    headless: false,
    ...(i.executablePath ? { executablePath: i.executablePath } : {}),
    ...(i.channel ? { channel: i.channel } : {}),
  });
  const hardStop = setTimeout(() => {
    void browser.close();
  }, 1050000);
  hardStop.unref();
  let context: BrowserContext | undefined,
    appId: string | undefined,
    cleaned = false,
    cleanupGrantId: string | undefined,
    removeOwnedApp: (() => Promise<void>) | undefined,
    providerAppRemoved = false;
  const stage = async (value: string) =>
    writeFile(
      path.join(directory, "stage.json"),
      JSON.stringify({ stage: value }),
      { mode: 0o600 },
    );
  try {
    const stateFile = path.join(directory, "public-storage.json");
    await writeFile(stateFile, JSON.stringify(i.publicSession), {
      mode: 0o600,
    });
    context = await browser.newContext({ storageState: stateFile });
    context.setDefaultTimeout(20000);
    const person = await json<{ user: { id: string } }>(
      context,
      i.publicOrigin,
      "/api/auth/get-session",
    );
    if (person.user.id !== i.humanId)
      throw new Error(
        "Public human session does not match actual fixture person",
      );
    const operator = await context.newPage();
    const identity = `<p>Operator ${esc(i.operatorRef)}. Authorized synthetic ChatGPT account reference ${esc(i.authorizationRef)}. Company ${esc(i.companyName)} (${esc(i.companyId)}).</p>`;
    const common = {
      operation: i.operation,
      executionId: i.executionId,
      attemptId: i.attemptId,
      companyId: i.companyId,
      humanId: i.humanId,
      processIsolation: true,
      testRunnerAttached: false,
      tracingEnabled: false,
      videoEnabled: false,
      operatorAvailable: true,
    } as const;
    if (i.operation === "availability") {
      await stage("availability");
      await pane(
        operator,
        "Required ChatGPT operator availability",
        identity +
          "<p>No provider setup or consent has occurred. Confirm availability within 15 seconds.</p>",
        [
          "I am the explicitly selected authorized operator of this synthetic ChatGPT test account/workspace.",
          "I am available for this attempt, can create a private custom MCP app, and can remove that exact test app afterward.",
        ],
        "Confirm availability",
      );
      await confirm(operator, 15000);
      await writeFile(
        path.join(directory, "qualified.json"),
        JSON.stringify(common),
        { mode: 0o600 },
      );
      cleaned = true;
      return;
    }
    await stage("product-setup");
    const c = context,
      product = await c.newPage(),
      chatgpt = await c.newPage();
    await product.goto(
      `${i.publicOrigin}/${i.prefix}/apps/assistant-connection`,
    );
    await product.getByText("Set up manually", { exact: true }).click();
    await product
      .getByRole("tab", { name: "ChatGPT / Claude web", exact: true })
      .click();
    const setup = await json<McpConnectionSetup>(
        c,
        i.publicOrigin,
        "/api/mcp/setup",
      ),
      url = new URL(setup.serverUrl);
    if (
      !setup.enabled ||
      url.origin !== i.publicOrigin ||
      url.pathname !== "/mcp/paperclip" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Actual named-client setup metadata differs from owned resource",
      );
    await product.getByText(setup.serverUrl, { exact: true }).first().waitFor();
    const beforeGrants = await json<McpConnection[]>(
        c,
        i.publicOrigin,
        "/api/mcp/connections",
      ),
      beforeRuns = await json<Array<{ id: string }>>(
        c,
        i.publicOrigin,
        `/api/companies/${i.companyId}/heartbeat-runs?limit=100`,
      );
    if (beforeRuns.length >= 100)
      throw new Error("Cannot prove complete bounded company native inventory");
    const appName = `Paperclip ${i.prefix} setup ${i.attemptId.slice(0, 8)}`;
    removeOwnedApp = async () => {
      if (!appId || providerAppRemoved) return;
      let deleted = false;
      const observer = (r: import("@playwright/test").Response) => {
        const request = r.request(),
          u = new URL(r.url()),
          text = request.postData() ?? "";
        if (
          u.origin === "https://chatgpt.com" &&
          r.ok() &&
          (request.method() === "DELETE" ||
            (request.method() === "POST" &&
              /delete|remove/i.test(u.pathname))) &&
          (u.pathname.split("/").includes(appId!) || text.includes(appId!))
        )
          deleted = true;
      };
      c.on("response", observer);
      try {
        await stage("cleanup");
        await pane(
          operator,
          "Remove only this newly created ChatGPT test app",
          identity +
            `<p>In the actual ChatGPT Apps/Plugins settings, open <strong>${esc(appName)}</strong> and complete its Delete/Remove confirmation. Do not remove another app or conversation. Only a successful provider deletion response bound to this actual new app ID qualifies. Paperclip separately revokes only this test grant.</p>`,
          [],
          "I opened the exact new app's delete confirmation",
        );
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline && !deleted)
          await new Promise((r) => setTimeout(r, 250));
        if (!deleted)
          throw new Error(
            "Exact created ChatGPT app deletion was not observed",
          );
        providerAppRemoved = true;
      } finally {
        c.off("response", observer);
      }
    };
    // Observe only the real provider browser creation response; do not call any
    // ChatGPT API. The actual newly created ID scopes eventual UI cleanup.
    c.on("response", (response) => {
      void (async () => {
        const request = response.request(),
          u = new URL(response.url());
        if (
          u.origin !== "https://chatgpt.com" ||
          request.method() !== "POST" ||
          !response.ok()
        )
          return;
        const text = request.postData() ?? "";
        if (!text.includes(appName) || !text.includes(setup.serverUrl)) return;
        const actual = createdChatgptAppId(
          await response.json().catch(() => null),
          appName,
          text,
          setup.serverUrl,
        );
        if (actual) {
          if (appId && appId !== actual)
            throw new Error("More than one app created");
          appId = actual;
        }
      })().catch(() => {
        void browser.close();
      });
    });
    await chatgpt.goto("https://chatgpt.com/");
    await stage("provider-app");
    await pane(
      operator,
      "Create only the real private ChatGPT test app",
      identity +
        `<p>Use the other official ChatGPT tab. Sign in to the designated account, then open its current Apps/Create custom MCP settings (or its supported private custom-server flow). Do not publish anything to a workspace or adopt an existing app.</p><p>New app name: <strong>${esc(appName)}</strong></p><p>Use this exact URL copied from the real Paperclip browser setup instructions:</p><textarea readonly>${esc(setup.serverUrl)}</textarea><p>Choose OAuth. Stop at the actual Paperclip consent page and review the next private instruction panel. Do not paste any token, cookie, OAuth code or state into chat.</p>`,
      [],
      "I opened the actual provider flow",
    );
    let consent: Page | undefined,
      requestId = "";
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline && !consent) {
      for (const p of c.pages()) {
        try {
          const u = new URL(p.url());
          if (
            u.origin === i.publicOrigin &&
            /^\/mcp-connect\/[A-Za-z0-9_-]+$/.test(u.pathname)
          ) {
            consent = p;
            requestId = u.pathname.split("/").at(-1)!;
            break;
          }
        } catch {
          /* private pane */
        }
      }
      if (!consent) await new Promise((r) => setTimeout(r, 250));
    }
    if (!consent || new URL(chatgpt.url()).origin !== "https://chatgpt.com")
      throw new Error(
        "Actual named ChatGPT UI did not produce its real Paperclip OAuth request",
      );
    await stage("consent");
    const request = await json<McpConnectionRequest>(
      c,
      i.publicOrigin,
      `/api/mcp/requests/${requestId}`,
    );
    if (!namedChatgptRequest(request, i.companyId))
      throw new Error(
        "Actual ChatGPT client/company/write request does not match qualification",
      );
    const consentLabel = consent.getByText("Write all of your Paperclip data", {
      exact: true,
    });
    await consentLabel.waitFor({ state: "visible" });
    const consentWording = await consentLabel.innerText();
    await pane(
      operator,
      "Review and approve the actual Paperclip consent",
      identity +
        `<p>On the real Paperclip consent tab, select this exact company and explicitly approve read and write access for the single controlled qualification below. ${request.requestedConfigure ? "Configuration authority is also requested. The actual broad Write all of your Paperclip data choice includes configuring agents, projects and skills in this isolated company; explicitly acknowledge that authority here, then knowingly accept the real broad write choice on the actual consent tab." : "No configuration authority is requested or accepted."} Never approve agent/impersonation scope. Click Connect organization THERE, then finish creating the private ChatGPT app. This panel never approves consent.</p>`,
      request.requestedConfigure
        ? [
            "I explicitly accept the requested configuration authority for this isolated company under the real broad write consent choice.",
          ]
        : [],
      "I reviewed the real consent tab",
    );
    await confirm(operator, 120000);
    const configureDisclosed = chatgptConsentDisclosure(
      request.requestedConfigure === true,
      consentWording,
      true,
    );
    if (!configureDisclosed)
      throw new Error(
        "Actual broad write consent and explicit requested configuration acceptance were not established",
      );
    const submitted = consent.waitForResponse(
      (r) =>
        new URL(r.url()).origin === i.publicOrigin &&
        new URL(r.url()).pathname ===
          `/api/mcp/requests/${requestId}/consent` &&
        r.request().method() === "POST",
      { timeout: 120000 },
    );
    await consent.bringToFront();
    const response = await submitted,
      payload = response.request().postDataJSON() as {
        decision?: string;
        companyId?: string;
        allowWrites?: boolean;
        allowConfiguration?: boolean;
      };
    if (
      !response.ok() ||
      payload.decision !== "approve" ||
      payload.companyId !== i.companyId ||
      payload.allowWrites !== true ||
      Boolean(payload.allowConfiguration) !==
        Boolean(request.requestedConfigure)
    )
      throw new Error(
        "Actual human consent did not explicitly approve the exact company/read-write scope",
      );
    const redirect = (await response.json()) as { redirectUrl?: string };
    if (
      !redirect.redirectUrl ||
      new URL(redirect.redirectUrl).origin !== "https://chatgpt.com"
    )
      throw new Error(
        "Actual provider callback target differs from named client",
      );
    await consent.waitForURL((u) => u.origin === "https://chatgpt.com", {
      timeout: 60000,
    });
    const grantDeadline = Date.now() + 60000;
    let grant: McpConnection | undefined;
    while (Date.now() < grantDeadline && !grant) {
      const rows = (
        await json<McpConnection[]>(c, i.publicOrigin, "/api/mcp/connections")
      ).filter(
        (g) =>
          !beforeGrants.some((old) => old.id === g.id) &&
          g.companyId === i.companyId &&
          !g.revokedAt,
      );
      if (rows.length > 1) throw new Error("Duplicate new assistant grants");
      grant = rows[0];
      if (!grant) await new Promise((r) => setTimeout(r, 500));
    }
    if (grant) cleanupGrantId = grant.id;
    if (
      !grant ||
      !/^(?:ChatGPT|OpenAI|OpenAI ChatGPT)$/i.test(grant.clientName) ||
      !grant.scopes.includes("paperclip:read") ||
      !grant.scopes.includes("paperclip:write") ||
      !exactAcceptedChatgptScopes(
        [
          "paperclip:read",
          "paperclip:write",
          ...(request.requestedConfigure ? ["paperclip:configure"] : []),
          ...(request.offlineAccess ? ["offline_access"] : []),
        ],
        grant.scopes,
        configureDisclosed,
      )
    )
      throw new Error(
        "Actual named ChatGPT grant does not preserve explicitly accepted access",
      );
    cleanupGrantId = grant.id;
    const qualify = `Using only the newly connected Paperclip app, read task ${i.control!.identifier} in ${i.companyName}. Then add exactly one neutral comment to that same task: “Setup check: the launch owner is [the actual launch owner from the task description].” Replace the bracketed phrase with the observed owner. Do not assign, start, modify, mention anyone, or comment on any other task. Do not repeat the write with a different requestId. Return the real comment link.`;
    await stage("qualification");
    await pane(
      operator,
      "Use only the newly connected ChatGPT app",
      identity +
        `<p>Finish the app's actual Create step if still pending. Select this exact app in a real ChatGPT conversation and send this one bounded instruction. Approve only its one comment when ChatGPT asks. No separate REST client or manual Paperclip comment is permitted.</p><textarea readonly rows="8">${esc(qualify)}</textarea>`,
      [],
      "I sent the limited instruction to the real ChatGPT app",
    );
    let comment:
      | {
          id: string;
          authorUserId: string;
          authorAgentId?: string | null;
          createdByRunId?: string | null;
          clientRequestId?: string;
          body: string;
        }
      | undefined;
    const qualifyDeadline = Date.now() + 180000;
    while (Date.now() < qualifyDeadline && !comment) {
      const comments = await json<NonNullable<typeof comment>[]>(
        c,
        i.publicOrigin,
        `/api/issues/${i.control!.id}/comments?order=asc`,
      );
      if (comments.length > 1)
        throw new Error("ChatGPT qualification duplicated the control comment");
      if (comments.length === 1) comment = comments[0];
      if (!comment) await new Promise((r) => setTimeout(r, 500));
    }
    if (
      !comment ||
      comment.authorUserId !== i.humanId ||
      comment.authorAgentId ||
      comment.createdByRunId ||
      !comment.clientRequestId ||
      !setupCheckComment(comment.body, i.control!.ownerFact)
    )
      throw new Error(
        "Actual real-client control comment is missing, incorrectly attributed or not grounded in the task read",
      );
    const events = await json<
      Array<{
        action: string;
        actorId: string;
        actorType: string;
        entityId: string;
        details?: Record<string, unknown>;
      }>
    >(c, i.publicOrigin, `/api/companies/${i.companyId}/activity?limit=1000`);
    const tool = events.filter(
      (e) => e.action === "mcp.tool_called" && e.entityId === grant!.id,
    );
    if (
      tool.length !== 1 ||
      tool[0]!.actorType !== "user" ||
      tool[0]!.actorId !== i.humanId ||
      tool[0]!.details?.operation !== "paperclip_add_comment" ||
      tool[0]!.details?.requestId !== comment.clientRequestId
    )
      throw new Error(
        "Actual named-client grant audit does not bind the exact human control comment",
      );
    const afterRuns = await json<Array<{ id: string }>>(
      c,
      i.publicOrigin,
      `/api/companies/${i.companyId}/heartbeat-runs?limit=100`,
    );
    if (
      afterRuns.length >= 100 ||
      JSON.stringify(afterRuns.map((r) => r.id).sort()) !==
        JSON.stringify(beforeRuns.map((r) => r.id).sort())
    )
      throw new Error(
        "ChatGPT setup qualification admitted undeclared native work",
      );
    if (
      (
        await json<{ user: { id: string } }>(
          c,
          i.publicOrigin,
          "/api/auth/get-session",
        )
      ).user.id !== i.humanId
    )
      throw new Error("Actual consenting person changed");
    if (!appId)
      throw new Error(
        "Actual provider app creation ID was not inspectable for scoped cleanup",
      );
    cleanupGrantId = grant.id;
    const receipt: ChatgptReceipt = {
      ...common,
      grantId: grant.id,
      requestId,
      commentId: comment.id,
      clientRequestId: comment.clientRequestId,
      actualChatgptUi: true,
      realHumanConsent: true,
      actualProviderCallback: true,
      boundMcpComment: true,
      zeroNativeAdmissions: true,
      requestedScopes: [
        "paperclip:read",
        "paperclip:write",
        ...(request.requestedConfigure ? ["paperclip:configure"] : []),
        ...(request.offlineAccess ? ["offline_access"] : []),
      ],
      acceptedScopes: [...grant.scopes],
      configureDisclosed,
      consentWording,
    };
    await writeFile(
      path.join(directory, "qualified.json"),
      JSON.stringify(receipt),
      { mode: 0o600 },
    );
    await stage("awaiting-cleanup");
    let cleanup = false;
    const cleanupDeadline = Date.now() + 90000;
    while (Date.now() < cleanupDeadline && !cleanup) {
      try {
        const gate = JSON.parse(
          await readFile(path.join(directory, "cleanup.json"), "utf8"),
        );
        cleanup =
          gate.operation === "cleanup" &&
          gate.attemptId === i.attemptId &&
          gate.grantId === grant.id;
      } catch {
        /* exact private gate not present */
      }
      if (!cleanup) await new Promise((r) => setTimeout(r, 100));
    }
    if (!cleanup)
      throw new Error("Exact private cleanup gate was not released");
    await removeOwnedApp();
    cleaned = true;
  } finally {
    // A failed qualification can still have created a real provider app. Keep
    // its exact UI cleanup available, without claiming qualification succeeded.
    if (appId && !providerAppRemoved)
      await removeOwnedApp?.().catch(() => undefined);
    if (!cleaned && cleanupGrantId && context) {
      const revoked = await context.request
        .delete(`${i.publicOrigin}/api/mcp/connections/${cleanupGrantId}`)
        .catch(() => undefined);
      if (!revoked?.ok())
        await writeFile(
          path.join(directory, "grant-cleanup-incomplete.json"),
          JSON.stringify({ grantCleanupComplete: false }),
          { mode: 0o600 },
        );
    }
    clearTimeout(hardStop);
    try {
      await context?.clearCookies();
    } finally {
      try {
        await context?.close();
      } finally {
        await browser.close();
      }
    }
    if (cleaned && cleanupGrantId && providerAppRemoved)
      await writeFile(
        path.join(directory, "cleanup-complete.json"),
        JSON.stringify({
          attemptId: i.attemptId,
          grantId: cleanupGrantId,
          providerAppRemoved: true,
          privateBrowserClosed: true,
        }),
        { mode: 0o600 },
      );
    if (!cleaned)
      await writeFile(
        path.join(directory, "incomplete.json"),
        JSON.stringify({ cleanupComplete: false }),
        { mode: 0o600 },
      ).catch(() => undefined);
  }
}
main().catch(() => {
  process.exitCode = 1;
});
