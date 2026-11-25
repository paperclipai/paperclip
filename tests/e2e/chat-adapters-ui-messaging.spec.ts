import { expect, test, type Page, type Route } from "@playwright/test";

import {
  fulfill,
  installChatControlPlaneMock,
  json,
  seedCompanyAndAgent,
  PROVIDERS,
  bodyOf,
  type Seed,
} from "./chat-adapters-ui.shared";

/**
 * Native chat-connector messaging coverage: destination partial updates,
 * board send delivery refresh, and exact failed-run retry. Shared fixtures
 * and the chat-control-plane mock live in ./chat-adapters-ui.shared.ts; the
 * provider-setup describes run in chat-adapters-ui-providers.spec.ts.
 */
test.describe("chat destination partial updates", () => {
  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await seedCompanyAndAgent(request);
  });

  for (const initiallyEnabled of [false, true]) {
    test(`a stale Settings view preserves another view's ${initiallyEnabled ? "revocation" : "grant"}`, async ({
      context,
      page,
    }) => {
      const provider = PROVIDERS.find((item) => item.provider === "discord")!;
      // Both real pages share one server fixture, but have separate query caches.
      const mock = await installChatControlPlaneMock(context, provider, seed, {
        enableChatConnectors: true,
      });
      mock.setStatus("active");
      const settingsUrl = `/${seed.prefix}/apps/chat/endpoint-discord/settings`;
      const primarySwitch = (view: Page) =>
        view.getByRole("switch", { name: `Enable ${provider.resourceLabel}` });
      const secondarySwitch = (view: Page) =>
        view.getByRole("switch", {
          name: `Enable ${provider.secondaryResourceLabel}`,
        });

      await page.goto(settingsUrl);
      await expect(primarySwitch(page)).not.toBeChecked();
      if (initiallyEnabled) {
        await primarySwitch(page).click();
        await expect(primarySwitch(page)).toBeChecked();
      }
      const staleView = await context.newPage();
      const resourcesPath = "/api/chat-endpoints/endpoint-discord/resources";
      const initialResources = staleView.waitForResponse(response =>
        new URL(response.url()).pathname === resourcesPath && response.request().method() === "GET",
      );
      await staleView.goto(settingsUrl);
      const snapshot = await (await initialResources).json();
      let retainSnapshot = true;
      await staleView.route(`**${resourcesPath}`, async route => {
        const method = route.request().method();
        if (method === "GET" && retainSnapshot) {
          await fulfill(route, snapshot);
          return;
        }
        if (method === "PUT") retainSnapshot = false;
        await route.fallback();
      });
      await expect(primarySwitch(staleView)).toBeChecked({
        checked: initiallyEnabled,
      });
      await expect(secondarySwitch(staleView)).not.toBeChecked();

      await primarySwitch(page).click();
      await expect(primarySwitch(page)).toBeChecked({
        checked: !initiallyEnabled,
      });
      await expect(primarySwitch(staleView)).toBeChecked({
        checked: initiallyEnabled,
      });
      await secondarySwitch(staleView).click();
      await expect(secondarySwitch(staleView)).toBeChecked();
      await expect(primarySwitch(staleView)).toBeChecked({
        checked: !initiallyEnabled,
      });
      expect(mock.resourceUpdates.at(-1)).toEqual([
        { id: "resource-discord-secondary", enabled: true },
      ]);

      // The full response refreshes this page, and persisted state survives reload.
      await page.reload();
      await expect(primarySwitch(page)).toBeChecked({
        checked: !initiallyEnabled,
      });
      await expect(secondarySwitch(page)).toBeChecked();
      await staleView.close();
    });
  }

  test("a pending destination change stays truthful on rejection and explicit retry", async ({
    page,
  }, testInfo) => {
    const provider = PROVIDERS.find((item) => item.provider === "discord")!;
    const mock = await installChatControlPlaneMock(page, provider, seed, {
      enableChatConnectors: true,
    });
    mock.setStatus("active");
    const attempts: unknown[] = [];
    let holdFirstPut!: (route: Route) => void;
    const firstPut = new Promise<Route>((resolve) => {
      holdFirstPut = resolve;
    });
    await page.route(
      "**/api/chat-endpoints/endpoint-discord/resources",
      async (route) => {
        if (route.request().method() === "PUT") {
          attempts.push(bodyOf(route));
          if (attempts.length === 1) {
            holdFirstPut(route);
            return;
          }
        }
        await route.fallback();
      },
    );
    await page.goto(`/${seed.prefix}/apps/chat/endpoint-discord/settings`);
    const primary = page.getByRole("switch", { name: "Enable #general" });
    const secondary = page.getByRole("switch", { name: "Enable #support" });
    await expect(primary).not.toBeChecked();
    await primary.click();
    const held = await firstPut;
    try {
      await expect(primary).toBeDisabled();
      await expect(secondary).toBeDisabled();
      await expect(primary).not.toBeChecked();
      await expect(secondary).not.toBeChecked();
      expect(mock.resourceUpdates).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath("destination-pending.png"),
      });
    } finally {
      await fulfill(
        held,
        { error: "Destination is no longer available. Refresh and try again." },
        409,
      );
    }
    await expect(
      page.getByText("Couldn't update destination", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Destination is no longer available. Refresh and try again.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(primary).toBeEnabled();
    await expect(secondary).toBeEnabled();
    await expect(primary).not.toBeChecked();
    await expect(secondary).not.toBeChecked();
    expect(mock.resourceUpdates).toEqual([]);
    expect(attempts).toEqual([
      { resources: [{ id: "resource-discord", enabled: true }] },
    ]);
    // Visibility alone also matches the toast's initial transparent animation frame.
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: "Couldn't update destination" }),
    ).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: testInfo.outputPath("destination-rejected.png"),
    });
    await primary.click();
    await expect(primary).toBeChecked();
    await expect(secondary).not.toBeChecked();
    expect(attempts).toEqual([
      { resources: [{ id: "resource-discord", enabled: true }] },
      { resources: [{ id: "resource-discord", enabled: true }] },
    ]);
    expect(mock.resourceUpdates).toEqual([
      [{ id: "resource-discord", enabled: true }],
    ]);
    await page.reload();
    await expect(primary).toBeChecked();
    await expect(secondary).not.toBeChecked();
    await page.screenshot({
      path: testInfo.outputPath("destination-retry-saved.png"),
    });
  });

  test("one toggle succeeds with more than 500 discovered destinations", async ({
    page,
  }) => {
    const provider = PROVIDERS.find((item) => item.provider === "discord")!;
    const mock = await installChatControlPlaneMock(page, provider, seed, {
      enableChatConnectors: true,
      resourceCount: 501,
    });
    mock.setStatus("active");
    await page.goto(`/${seed.prefix}/apps/chat/endpoint-discord/settings`);
    await expect(page.getByRole("switch", { name: /^Enable / })).toHaveCount(
      501,
    );
    const target = page.getByRole("switch", {
      name: "Enable Extra destination 499",
    });
    await expect(target).not.toBeChecked();
    await target.click();
    await expect(target).toBeChecked();
    expect(mock.resourceUpdates).toEqual([
      [{ id: "resource-discord-extra-498", enabled: true }],
    ]);
    await expect(
      page.getByRole("switch", { name: "Enable #general" }),
    ).not.toBeChecked();
    await page.reload();
    await expect(target).toBeChecked();
    await expect(page.getByRole("switch", { name: /^Enable / })).toHaveCount(
      501,
    );
  });
});

test.describe("Board send delivery refresh", () => {
  for (const { classic, entry } of [
    { classic: false, entry: "uuid" as const },
    { classic: false, entry: "uppercase-uuid" as const },
    { classic: false, entry: "wrong-prefix-identifier" as const },
    { classic: true, entry: "wrong-prefix-identifier" as const },
  ]) {
      test(`opens external task links in their own organization and uploads safely (${entry}, classic=${classic})`, async ({
        page,
        request,
      }) => {
        await page.addLocatorHandler(
          page.getByRole("complementary", { name: "Paperclip announcements", exact: true })
            .getByRole("button", { name: "Dismiss announcement", exact: true }),
          async (dismiss) => {
            const menuOpen = await page.getByRole("menu", { name: "Add to composer", exact: true }).isVisible();
            if (menuOpen) await page.keyboard.press("Escape");
            await dismiss.click();
            if (menuOpen) await page.getByRole("button", { name: "Add to composer", exact: true }).click();
          },
        );
        const selected = await seedCompanyAndAgent(request);
        const target = await seedCompanyAndAgent(request);
        const issue = await json<{ id: string; identifier: string }>(
          await request.post(`/api/companies/${target.companyId}/issues`, {
            data: { title: "Organization-bound task link", status: "backlog" },
          }),
          "create linked task in another organization",
        );
        await page.route("**/api/workspace-preferences/me", route => fulfill(route, {
          userId: "local-board", coordinatorWorkspaceEnabled: !classic, updatedAt: null,
        }));
        await page.route("**/api/instance/settings/experimental", (route) =>
          fulfill(route, {
            enableChatConnectors: true,
            enableClassicTaskInterface: classic,
          }),
        );
        await page.goto(`/${selected.prefix}/issues`);
        await expect
          .poll(() =>
            page.evaluate(() =>
              localStorage.getItem("paperclip.selectedCompanyId"),
            ),
          )
          .toBe(selected.companyId);
        await page.goto(
          entry === "uuid"
            ? `/issues/${issue.id}`
            : entry === "uppercase-uuid"
              ? `/issues/${issue.id.toUpperCase()}`
              : `/${selected.prefix}/issues/${issue.identifier}?external=chat#files`,
        );
        if (!classic) {
          await expect(page.getByTestId("task-chat-history-content")).toBeVisible({ timeout: 30_000 });
        }
        await expect(
          page.getByRole("heading", {
            name: "Organization-bound task link",
            exact: true,
          }),
        ).toBeVisible();
        await expect
          .soft(page)
          .toHaveURL(
            new RegExp(
              `/${target.prefix}/issues/${issue.identifier}${
                entry === "wrong-prefix-identifier"
                  ? "\\?external=chat#files"
                  : ""
              }$`,
            ),
            { timeout: 4_000 },
          );
        const file = {
          name: classic ? "task-link-report.txt" : "task-link-image.png",
          mimeType: classic ? "text/plain" : "image/png",
          buffer: classic
            ? Buffer.from("Synthetic cross-organization upload proof.\n")
            : Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfFoAAAAASUVORK5CYII=",
                "base64",
              ),
        };
        if (!classic) {
          await page.getByRole("button", { name: "Add to composer" }).click();
        }
        const chooserPromise = page.waitForEvent("filechooser");
        await (classic
          ? page.getByRole("button", { name: "Upload attachment", exact: true })
          : page.getByRole("menuitem", { name: "Files and images", exact: true })
        ).click();
        const responsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            /\/api\/companies\/[^/]+\/issues\/[^/]+\/attachments$/.test(
              new URL(response.url()).pathname,
            ),
        );
        await (await chooserPromise).setFiles(file);
        const response = await responsePromise;
        expect.soft(response.status(), await response.text()).toBe(201);
        expect
          .soft(new URL(response.url()).pathname)
          .toBe(
            `/api/companies/${target.companyId}/issues/${issue.id}/attachments`,
          );
        const attachments = await json<
          {
            originalFilename: string;
            contentPath: string;
            issueCommentId: string | null;
          }[]
        >(
          await request.get(`/api/issues/${issue.id}/attachments`),
          "read linked task attachments",
        );
        expect(attachments).toHaveLength(1);
        expect(attachments[0]).toMatchObject({
          originalFilename: file.name,
          issueCommentId: null,
        });
        expect(
          await (await request.get(attachments[0].contentPath)).body(),
        ).toEqual(file.buffer);
        expect(
          await json<unknown[]>(
            await request.get(`/api/issues/${issue.id}/comments`),
            "read linked task comments",
          ),
        ).toHaveLength(0);
        await expect
          .poll(() =>
            page.evaluate(() =>
              localStorage.getItem("paperclip.selectedCompanyId"),
            ),
          )
          .toBe(target.companyId);
      });
  }

  test("keeps the connected-task banner readable in narrow task panes", async ({
    page,
    request,
  }) => {
    const seed = await seedCompanyAndAgent(request);
    const issue = await json<{ id: string; identifier: string }>(
      await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: { title: "Connected banner layout", status: "backlog" },
      }),
      "create connected banner task",
    );
    await page.route("**/api/instance/settings/experimental", (route) =>
      fulfill(route, { enableChatConnectors: true }),
    );
    await page.route(`**/api/issues/${issue.id}/chat-binding`, (route) =>
      fulfill(route, {
        endpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        provider: "discord",
        externalLabel: "#a-long-but-readable-qualification-channel-name",
        externalUrl: "https://discord.com/channels/test-server/test-thread",
        assignedAgentLocked: true,
      }),
    );
    await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
    const banner = page.getByRole("region", {
      name: "External conversation",
      exact: true,
    });
    const heading = banner.getByText("Connected to Discord", { exact: true });
    await expect(heading).toBeVisible();
    // Exercise container widths independently of the operator's sidebar and
    // Properties preferences. These are test constraints, not product styles.
    for (const width of [340, 500, 760]) {
      await banner.evaluate((element, value) => {
        element.style.width = `${value}px`;
      }, width);
      await expect
        .poll(() =>
          heading
            .evaluate((element) => ({
              height: element.getBoundingClientRect().height,
              lineHeight: Number.parseFloat(
                getComputedStyle(element).lineHeight,
              ),
            }))
            .then(({ height, lineHeight }) => height <= lineHeight * 1.5),
        )
        .toBe(true);
      const bounds = await banner.boundingBox();
      expect(bounds).not.toBeNull();
      for (const action of [
        banner.getByRole("link", { name: "Open Discord", exact: true }),
        banner.getByRole("button", { name: "Send to channel", exact: true }),
        banner.getByRole("link", { name: "Connection", exact: true }),
      ]) {
        await expect(action).toBeVisible();
        const box = await action.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          bounds!.x + bounds!.width,
        );
        expect(box!.y + box!.height).toBeLessThanOrEqual(
          bounds!.y + bounds!.height,
        );
      }
    }
  });

  test("uploads images and files directly from an empty channel composer without publishing early", async ({
    page,
    request,
  }) => {
    const seed = await seedCompanyAndAgent(request);
    const issue = await json<{ id: string; identifier: string }>(
      await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: { title: "Upload channel files", status: "backlog" },
      }),
      "create upload task",
    );
    const endpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const publicationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const sends: Record<string, unknown>[] = [];
    let releaseSend!: () => void;
    const sendResponse = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    await page.route("**/api/instance/settings/experimental", (route) =>
      fulfill(route, { enableChatConnectors: true }),
    );
    await page.route(`**/api/issues/${issue.id}/chat-binding`, (route) =>
      fulfill(route, {
        endpointId,
        conversationId,
        provider: "discord",
        externalLabel: "#upload-test",
        assignedAgentLocked: true,
      }),
    );
    await page.route(
      `**/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications`,
      async (route) => {
        sends.push(bodyOf(route));
        await sendResponse;
        return fulfill(
          route,
          { id: publicationId, state: "streaming", attempts: 1 },
          201,
        );
      },
    );
    await page.route(
      `**/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications/${publicationId}/status`,
      (route) =>
        fulfill(route, {
          publication: { id: publicationId, state: "pending", attempts: 0 },
          total: 3,
          published: 0,
        }),
    );
    await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
    await page
      .getByRole("button", { name: "Send to channel", exact: true })
      .click();
    const input = page.getByLabel("Attach file to channel update", {
      exact: true,
    });
    const files = [
      {
        name: "channel-image.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfFoAAAAASUVORK5CYII=",
          "base64",
        ),
      },
      {
        name: "channel-report.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic channel upload proof.\n"),
      },
    ];
    for (const file of files) {
      await input.setInputFiles(file);
      await expect(
        page
          .getByRole("group", { name: "Include task files", exact: true })
          .getByRole("checkbox", { name: file.name, exact: true }),
      ).toBeChecked();
      await expect(input).toBeEnabled();
    }
    expect(sends).toHaveLength(0);
    const stored = await json<
      {
        id: string;
        originalFilename: string;
        contentPath: string;
        issueCommentId: string | null;
      }[]
    >(
      await request.get(`/api/issues/${issue.id}/attachments`),
      "read uploaded files",
    );
    expect(stored).toHaveLength(2);
    for (const file of files) {
      const attachment = stored.find(
        (item) => item.originalFilename === file.name,
      )!;
      expect(attachment.issueCommentId).toBeNull();
      const content = await request.get(attachment.contentPath);
      expect(content.ok()).toBe(true);
      expect(await content.body()).toEqual(file.buffer);
    }
    expect(
      await json<unknown[]>(
        await request.get(`/api/issues/${issue.id}/comments`),
        "read internal comments",
      ),
    ).toHaveLength(0);
    await page
      .getByRole("textbox", { name: "Board update", exact: true })
      .fill("Publish these two synthetic files.");
    await page
      .getByRole("button", { name: "Send to channel", exact: true })
      .last()
      .click();
    await expect.poll(() => sends.length).toBe(1);
    await expect(
      page.getByRole("button", { name: "Sending…", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("Delivery result not confirmed", { exact: true }),
    ).toHaveCount(0);
    releaseSend();
    expect(sends[0].attachmentIds).toEqual(
      files.map(
        (file) =>
          stored.find((item) => item.originalFilename === file.name)!.id,
      ),
    );
    await expect(input).toBeDisabled();
    await page.reload();
    const retained = page.getByRole("group", {
      name: "Files in this send",
      exact: true,
    });
    for (const file of files) {
      await expect(
        retained.getByRole("checkbox", { name: file.name, exact: true }),
      ).toBeChecked();
      await expect(
        retained.getByRole("checkbox", { name: file.name, exact: true }),
      ).toBeDisabled();
    }
    expect(sends).toHaveLength(1);
  });

  test("recovers an uncertain channel send into a durable rejection before an explicit correction", async ({
    page,
    request,
  }, testInfo) => {
    const seed = await seedCompanyAndAgent(request);
    const issue = await json<{ id: string; identifier: string }>(
      await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: { title: "Rejected channel selection", status: "backlog" },
      }),
      "create rejected-send task",
    );
    const endpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await page.route("**/api/instance/settings/experimental", (route) =>
      fulfill(route, { enableChatConnectors: false, enableGitHubReviewBots: true }),
    );
    await page.route(`**/api/issues/${issue.id}/chat-binding`, (route) =>
      fulfill(route, {
        endpointId,
        conversationId,
        provider: "github",
        externalLabel: "test/rejected-send",
        assignedAgentLocked: true,
      }),
    );
    const sends: Record<string, unknown>[] = [];
    let attachmentId = "";
    let privateComment: { id: string } | undefined;
    // The lost send resends on its own; hold that resend until the waiting
    // state has been checked.
    let releaseResend!: () => void;
    const resendReleased = new Promise<void>((resolve) => {
      releaseResend = resolve;
    });
    await page.route(
      `**/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications`,
      async (route) => {
        const input = bodyOf(route);
        sends.push(input);
        if (sends.length === 1) {
          expect(input.attachmentIds).toEqual([attachmentId]);
          // Consume the file only after the browser has captured its send.
          // Binding it before Send lets live refresh remove it from the draft,
          // making the mocked rejection inconsistent with the actual request.
          privateComment = await json<{ id: string }>(
            await request.post(`/api/issues/${issue.id}/comments`, {
              data: { body: "Private Board file", attachmentIds: [attachmentId] },
            }),
            "bind selected file to private comment",
          );
          return route.abort("connectionreset");
        }
        if (sends.length === 2) {
          await resendReleased;
          return fulfill(
            route,
            {
              error: "A selected file already belongs to another comment",
              details: {
                code: "chat_board_send_attachments_already_bound",
                endpointId,
                conversationId,
                idempotencyKey: input.idempotencyKey,
                attachmentIds: [attachmentId],
              },
            },
            409,
          );
        }
        return fulfill(
          route,
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            state: "published",
            attempts: 1,
          },
          201,
        );
      },
    );
    await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
    const banner = page.getByRole("region", { name: "External conversation" });
    await banner
      .getByRole("button", { name: "Send to channel", exact: true })
      .click();
    await banner
      .getByLabel("Attach file to channel update", { exact: true })
      .setInputFiles({
        name: "rejected-send.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic rejected send proof.\n"),
      });
    await expect(
      banner.getByRole("checkbox", { name: "rejected-send.txt" }),
    ).toBeChecked();
    const [file] = await json<{ id: string }[]>(
      await request.get(`/api/issues/${issue.id}/attachments`),
      "read selected file",
    );
    attachmentId = file!.id;
    // The first intercepted send binds the file to a concurrent Board comment.
    // The real TX/idempotency and delete/retry behavior are covered in PostgreSQL.
    const draft =
      "Share the verified result, without the private Board comment.";
    await banner.getByRole("textbox", { name: "Board update" }).fill(draft);
    await banner
      .getByRole("button", { name: "Send to channel", exact: true })
      .last()
      .click();
    // A lost response waits and resends on its own with the same identity.
    await expect(
      banner.getByText("Sending when reconnected…", { exact: true }),
    ).toBeVisible();
    await expect(
      banner.getByRole("textbox", { name: "Board update" }),
    ).toBeDisabled();
    await expect.poll(() => sends.length).toBe(2);
    releaseResend();
    await expect(
      banner.getByText("Update was not sent", { exact: true }),
    ).toBeVisible();
    expect(sends[1]).toEqual(sends[0]);
    await page.reload();
    await expect(
      banner.getByText("Update was not sent", { exact: true }),
    ).toBeVisible();
    await expect(
      banner.getByRole("textbox", { name: "Board update" }),
    ).toHaveValue(draft);
    expect(sends).toHaveLength(2);
    await banner.screenshot({
      path: testInfo.outputPath("durable-rejected-channel-send.png"),
    });
    await banner
      .getByRole("button", { name: "Edit rejected send", exact: true })
      .click();
    await expect(
      banner.getByRole("textbox", { name: "Board update" }),
    ).toBeEnabled();
    await expect(
      banner.getByText(/Attach a new copy or share the task link/),
    ).toBeVisible();
    await expect(banner.getByRole("checkbox")).toHaveCount(0);
    await banner
      .getByRole("button", { name: "Send to channel", exact: true })
      .last()
      .click();
    await expect(
      banner.getByRole("textbox", { name: "Board update" }),
    ).toHaveCount(0);
    expect(sends).toHaveLength(3);
    expect(sends[2]!.body).toBe(draft);
    expect(sends[2]!.attachmentIds ?? []).toEqual([]);
    expect(sends[2]!.idempotencyKey).not.toBe(sends[0]!.idempotencyKey);
    const attachments = await json<{ id: string; issueCommentId: string }[]>(
      await request.get(`/api/issues/${issue.id}/attachments`),
      "verify immutable original binding",
    );
    expect(attachments).toEqual([
      expect.objectContaining({
        id: attachmentId,
        issueCommentId: privateComment!.id,
      }),
    ]);
  });
});
