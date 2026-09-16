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
      await staleView.goto(settingsUrl);
      await expect(primarySwitch(staleView)).toBeChecked({
        checked: initiallyEnabled,
      });
      await expect(secondarySwitch(staleView)).not.toBeChecked();

      await primarySwitch(page).click();
      await expect(primarySwitch(page)).toBeChecked({
        checked: !initiallyEnabled,
      });
      // Assert the stale prerequisite instead of assuming browser focus/refetch.
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
  for (const classic of [false, true]) {
    for (const entry of [
      "uuid",
      "uppercase-uuid",
      "wrong-prefix-identifier",
    ] as const) {
      test(`opens external task links in their own organization and uploads safely (${entry}, classic=${classic})`, async ({
        page,
        request,
      }) => {
        const selected = await seedCompanyAndAgent(request);
        const target = await seedCompanyAndAgent(request);
        const issue = await json<{ id: string; identifier: string }>(
          await request.post(`/api/companies/${target.companyId}/issues`, {
            data: { title: "Organization-bound task link", status: "backlog" },
          }),
          "create linked task in another organization",
        );
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
        const chooserPromise = page.waitForEvent("filechooser");
        await page
          .getByRole("button", {
            name: classic ? "Upload attachment" : "Attach file",
            exact: true,
          })
          .click();
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
      fulfill(route, { enableChatConnectors: true }),
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
        if (sends.length === 2)
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
    await expect(
      banner.getByText("Delivery result not confirmed", { exact: true }),
    ).toBeVisible();
    await expect(
      banner.getByRole("textbox", { name: "Board update" }),
    ).toBeDisabled();
    await banner
      .getByRole("button", { name: "Retry safely", exact: true })
      .click();
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

  for (const cancelledHead of [false, true]) {
    test(`keeps Teams file consent anchored across reload (${cancelledHead ? "cancelled head with waiting tail" : "mixed terminal receipt and explicit dismiss"})`, async ({
      page,
      request,
    }, testInfo) => {
      const seed = await seedCompanyAndAgent(request);
      const issue = await json<{ id: string; identifier: string }>(
        await request.post(`/api/companies/${seed.companyId}/issues`, {
          data: { title: "Teams consent receipt", status: "backlog" },
        }),
        "create consent receipt task",
      );
      const endpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const anchor = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const nextAnchor = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      const filePublications = [
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ];
      const filenames = ["consent-report.txt", "consent-notes.txt"];
      const posts: Record<string, unknown>[] = [];
      const statusReads: string[] = [];
      let terminal = false;
      const publicationsPath = `/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications`;
      const storageKey = `paperclip:board-send:v1:${JSON.stringify([seed.companyId, issue.id, endpointId, conversationId])}`;
      await page.route("**/api/instance/settings/experimental", (route) =>
        fulfill(route, { enableChatConnectors: true }),
      );
      await page.route(`**/api/issues/${issue.id}/chat-binding`, (route) =>
        fulfill(route, {
          endpointId,
          conversationId,
          provider: "microsoft-teams",
          externalLabel: "Personal file conversation",
          assignedAgentLocked: true,
        }),
      );
      // Only the publication API is simulated. Task creation and safe file
      // uploads use this test's isolated Paperclip instance, never Teams.
      await page.route(`**${publicationsPath}`, (route) => {
        expect(route.request().method()).toBe("POST");
        posts.push(bodyOf(route));
        return fulfill(
          route,
          {
            id: posts.length === 1 ? anchor : nextAnchor,
            state: "pending",
            attempts: 0,
          },
          201,
        );
      });
      await page.route(`**${publicationsPath}/*/status`, (route) => {
        expect(route.request().method()).toBe("GET");
        const path = new URL(route.request().url()).pathname;
        statusReads.push(path);
        if (path.endsWith(`/${nextAnchor}/status`)) {
          return fulfill(route, {
            publication: { id: nextAnchor, state: "pending", attempts: 0 },
            total: 1,
            published: 0,
            awaitingConsent: 0,
            declined: 0,
            expired: 0,
            cancelled: 0,
            settled: 0,
            canDismiss: false,
          });
        }
        expect(path).toBe(`${publicationsPath}/${anchor}/status`);
        const parts = [
          { id: anchor, state: "published", attempts: 1 },
          ...filePublications.map((id, index) => ({
            id,
            state:
              terminal || (cancelledHead && index === 0)
                ? "cancelled"
                : "awaiting_consent",
            attempts: 1,
            fileTransfer: {
              provider: "microsoft-teams",
              filename: filenames[index],
              phase: terminal
                ? index === 0
                  ? "declined"
                  : "expired"
                : cancelledHead && index === 0
                  ? "cancelled"
                  : "awaiting_consent",
              version: terminal ? 3 : 2,
            },
          })),
        ];
        return fulfill(route, {
          publication: parts[1],
          parts,
          total: 3,
          published: 1,
          awaitingConsent: terminal ? 0 : cancelledHead ? 1 : 2,
          declined: terminal ? 1 : 0,
          expired: terminal ? 1 : 0,
          cancelled: !terminal && cancelledHead ? 1 : 0,
          settled: terminal ? 3 : cancelledHead ? 2 : 1,
          canDismiss: terminal,
        });
      });
      await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
      const banner = page.getByRole("region", {
        name: "External conversation",
        exact: true,
      });
      await banner
        .getByRole("button", { name: "Send to channel", exact: true })
        .click();
      for (const name of filenames) {
        await banner
          .getByLabel("Attach file to channel update", { exact: true })
          .setInputFiles({
            name,
            mimeType: "text/plain",
            buffer: Buffer.from(`Synthetic consent fixture: ${name}.\n`),
          });
        await expect(
          banner.getByRole("checkbox", { name, exact: true }),
        ).toBeChecked();
        await expect(
          banner.getByLabel("Attach file to channel update", { exact: true }),
        ).toBeEnabled();
      }
      await expect(
        banner.getByRole("group", { name: "Include task files", exact: true }),
      ).toContainText(
        "In personal Teams chats, recipients accept each file before upload. Channels and group chats receive supported images directly; other files stay on the task, with a task link or private-task notice.",
      );
      await banner.screenshot({
        path: testInfo.outputPath("teams-file-guidance.png"),
      });
      expect(posts).toHaveLength(0);
      await banner
        .getByRole("textbox", { name: "Board update", exact: true })
        .fill("Please review these two files.");
      await banner
        .getByRole("button", { name: "Send to channel", exact: true })
        .last()
        .click();
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0].attachmentIds).toHaveLength(2);
      await expect(
        banner.getByText(
          cancelledHead
            ? "1 published · 1 awaiting consent · 1 cancelled"
            : "1 published · 2 awaiting consent",
          { exact: true },
        ),
      ).toBeVisible();
      const retainedBeforeReload = await page.evaluate(
        (key) => sessionStorage.getItem(key),
        storageKey,
      );
      expect(JSON.parse(retainedBeforeReload!).publication.id).toBe(anchor);
      const readsBeforeReload = statusReads.length;
      await page.reload();
      await expect
        .poll(() => statusReads.length)
        .toBeGreaterThan(readsBeforeReload);
      expect(
        await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
      ).toBe(retainedBeforeReload);
      expect(
        statusReads.every(
          (path) => path === `${publicationsPath}/${anchor}/status`,
        ),
      ).toBe(true);
      await expect(
        banner.getByRole("textbox", { name: "Board update", exact: true }),
      ).toBeDisabled();
      await expect(
        banner.getByLabel("Attach file to channel update", { exact: true }),
      ).toBeDisabled();
      await expect(
        banner
          .getByRole("button", { name: "Send to channel", exact: true })
          .last(),
      ).toBeDisabled();
      await expect(
        banner.getByRole("button", {
          name: "Dismiss delivery receipt",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        banner.getByText(
          cancelledHead
            ? "Waiting for remaining file consent"
            : "Waiting for file consent",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        banner.getByText("Channel delivery cancelled", { exact: true }),
      ).toHaveCount(0);
      await expect(
        banner.getByText("Sent to channel", { exact: true }),
      ).toHaveCount(0);
      for (const name of filenames) {
        await expect(
          banner.getByRole("checkbox", { name, exact: true }),
        ).toBeChecked();
        await expect(
          banner.getByRole("checkbox", { name, exact: true }),
        ).toBeDisabled();
      }
      expect(posts).toHaveLength(1);
      await banner.screenshot({
        path: testInfo.outputPath("consent-waiting.png"),
      });
      if (cancelledHead) return;

      terminal = true;
      await expect(
        banner.getByText("Delivery settled with mixed outcomes", {
          exact: true,
        }),
      ).toBeVisible({ timeout: 8_000 });
      await expect(
        banner.getByText("1 published · 1 declined · 1 expired", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        banner.getByText("consent-report.txt — Declined", { exact: true }),
      ).toBeVisible();
      await expect(
        banner.getByText("consent-notes.txt — Consent expired", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        banner
          .getByRole("button", { name: "Send to channel", exact: true })
          .last(),
      ).toBeDisabled();
      await banner.screenshot({
        path: testInfo.outputPath("consent-mixed.png"),
      });
      expect(posts).toHaveLength(1);
      await banner
        .getByRole("button", { name: "Dismiss delivery receipt", exact: true })
        .click();
      await expect(
        banner.getByRole("textbox", { name: "Board update", exact: true }),
      ).toHaveValue("");
      await expect(
        banner.getByRole("textbox", { name: "Board update", exact: true }),
      ).toBeEnabled();
      await expect(
        banner
          .getByRole("button", { name: "Send to channel", exact: true })
          .last(),
      ).toBeDisabled();
      expect(
        await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
      ).toBeNull();
      expect(posts).toHaveLength(1);
      await expect(
        page.getByText("Sent to channel", { exact: true }),
      ).toHaveCount(0);
      for (const name of filenames) {
        await expect(
          banner.getByRole("checkbox", { name, exact: true }),
        ).not.toBeChecked();
      }
      await banner
        .getByRole("textbox", { name: "Board update", exact: true })
        .fill("A separate text-only update.");
      expect(posts).toHaveLength(1);
      await banner
        .getByRole("button", { name: "Send to channel", exact: true })
        .last()
        .click();
      await expect.poll(() => posts.length).toBe(2);
      expect(posts[1]).toMatchObject({
        body: "A separate text-only update.",
      });
      expect(posts[1]).not.toHaveProperty("attachmentIds");
      expect(posts[1].idempotencyKey).not.toBe(posts[0].idempotencyKey);
    });
  }

  for (const outcome of [
    "published",
    "failed",
    "delivery_unknown",
    "response_lost",
  ] as const) {
    test(`tracks the whole file batch across reload and ${outcome} without a new send identity`, async ({
      page,
      request,
    }) => {
      const seed = await seedCompanyAndAgent(request);
      const issue = await json<{ id: string; identifier: string }>(
        await request.post(`/api/companies/${seed.companyId}/issues`, {
          data: { title: "Board delivery refresh", status: "backlog" },
        }),
        "create board-send task",
      );
      const endpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const publicationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const attachmentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const statusPath = `/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications/${publicationId}/status`;
      let sends = 0;
      const submittedPayloads: Record<string, unknown>[] = [];
      let reads = 0;
      let canonicalAttachmentReadsAfterSend = 0;
      let canonicalCommentReadsAfterSend = 0;
      let status = "streaming";
      await page.route("**/api/instance/settings/experimental", (route) =>
        fulfill(route, { enableChatConnectors: true }),
      );
      await page.route(`**/api/issues/${issue.id}/chat-binding`, (route) =>
        fulfill(route, {
          endpointId,
          conversationId,
          provider: "slack",
          externalLabel: "#board-send-test",
          assignedAgentLocked: true,
        }),
      );
      await page.route(
        new RegExp(
          `/api/issues/(${issue.id}|${issue.identifier})/comments(?:\\?|$)`,
        ),
        async (route) => {
          if (
            sends &&
            route.request().url().includes(`/issues/${issue.identifier}/`)
          )
            canonicalCommentReadsAfterSend += 1;
          await fulfill(
            route,
            sends
              ? [
                  {
                    id: publicationId,
                    companyId: seed.companyId,
                    issueId: issue.id,
                    authorAgentId: null,
                    authorUserId: "local-board",
                    authorType: "user",
                    body: "Board batch must finish all files.",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                ]
              : [],
          );
        },
      );
      await page.route(
        new RegExp(
          `/api/issues/(${issue.id}|${issue.identifier})/attachments$`,
        ),
        async (route) => {
          if (
            sends &&
            route.request().url().includes(`/issues/${issue.identifier}/`)
          )
            canonicalAttachmentReadsAfterSend += 1;
          await fulfill(route, [
            {
              id: attachmentId,
              companyId: seed.companyId,
              issueId: issue.id,
              issueCommentId: sends ? publicationId : null,
              assetId: attachmentId,
              provider: "local_disk",
              objectKey: "board-send-test.txt",
              contentType: "text/plain",
              byteSize: 12,
              sha256: "a".repeat(64),
              originalFilename: "board-send-test.txt",
              createdByAgentId: null,
              createdByUserId: "local-board",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              contentPath: `/api/attachments/${attachmentId}/content`,
            },
            {
              id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              companyId: seed.companyId,
              issueId: issue.id,
              issueCommentId: null,
              assetId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              provider: "local_disk",
              objectKey: "internal-only.txt",
              contentType: "text/plain",
              byteSize: 8,
              sha256: "b".repeat(64),
              originalFilename: "internal-only.txt",
              createdByAgentId: null,
              createdByUserId: "local-board",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              contentPath:
                "/api/attachments/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/content",
            },
          ]);
        },
      );
      await page.route(
        `**/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications`,
        async (route) => {
          expect(route.request().method()).toBe("POST");
          expect(bodyOf(route).attachmentIds).toEqual([attachmentId]);
          sends += 1;
          submittedPayloads.push(bodyOf(route));
          if (outcome === "response_lost" && sends === 1) {
            await route.abort("failed");
            return;
          }
          await fulfill(
            route,
            { id: publicationId, state: "streaming", attempts: 1 },
            201,
          );
        },
      );
      await page.route(`**${statusPath}`, async (route) => {
        expect(route.request().method()).toBe("GET");
        reads += 1;
        await fulfill(route, {
          publication: {
            id: status === "streaming" ? publicationId : attachmentId,
            state: status,
            attempts: 1,
          },
          total: 2,
          published: status === "published" ? 2 : 1,
        });
      });
      await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
      await page
        .getByRole("button", { name: "Send to channel", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Board update", exact: true })
        .fill("Board batch must finish all files.");
      await page.getByRole("checkbox", { name: "board-send-test.txt" }).check();
      await page
        .getByRole("button", { name: "Send to channel", exact: true })
        .last()
        .click();
      const expectRetainedFiles = async () => {
        const files = page.getByRole("group", {
          name: "Files in this send",
          exact: true,
        });
        await expect(files).toBeVisible();
        await expect(files.getByRole("checkbox")).toHaveCount(1);
        await expect(
          files.getByRole("checkbox", { name: "board-send-test.txt" }),
        ).toBeChecked();
        await expect(
          files.getByRole("checkbox", { name: "board-send-test.txt" }),
        ).toBeDisabled();
        await expect(
          files.getByText("internal-only.txt", { exact: true }),
        ).toHaveCount(0);
      };
      if (outcome === "response_lost") {
        await expect(
          page.getByText("Delivery result not confirmed", { exact: true }),
        ).toBeVisible();
        await page.reload();
        await expect(
          page.getByRole("textbox", { name: "Board update", exact: true }),
        ).toBeDisabled();
        await expectRetainedFiles();
        expect(sends).toBe(1);
        expect(reads).toBe(0);
        await page
          .getByRole("button", { name: "Retry safely", exact: true })
          .click();
        await expect.poll(() => submittedPayloads.length).toBe(2);
        expect(submittedPayloads[1]).toEqual(submittedPayloads[0]);
      } else {
        await expect(
          page.getByText("Publishing to channel", { exact: true }).first(),
        ).toBeVisible();
        // The canonical task view must refresh its comment/files before any reload.
        await expect
          .poll(() => canonicalCommentReadsAfterSend)
          .toBeGreaterThan(0);
        await expect
          .poll(() => canonicalAttachmentReadsAfterSend)
          .toBeGreaterThan(0);
        await expectRetainedFiles();
        const readsBeforeReload = reads;
        await page.reload();
        await expect
          .poll(() => reads, { timeout: 8_000 })
          .toBeGreaterThan(readsBeforeReload);
        expect(sends).toBe(1);
      }
      await expect.poll(() => reads, { timeout: 8_000 }).toBeGreaterThan(0);
      await expectRetainedFiles();
      await expect(
        page.getByRole("textbox", { name: "Board update", exact: true }),
      ).toHaveValue("Board batch must finish all files.");
      await expect(
        page.getByRole("textbox", { name: "Board update", exact: true }),
      ).toBeDisabled();
      status = outcome === "response_lost" ? "published" : outcome;
      if (status === "published") {
        await expect(
          page.getByRole("textbox", { name: "Board update", exact: true }),
        ).toHaveCount(0, { timeout: 8_000 });
        await expect(
          page.getByText("Sent to channel", { exact: true }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByText(
            outcome === "failed"
              ? "Channel delivery failed"
              : "Delivery not confirmed",
            { exact: true },
          ),
        ).toBeVisible({ timeout: 8_000 });
        await expect(
          page.getByRole("textbox", { name: "Board update", exact: true }),
        ).toHaveValue("Board batch must finish all files.");
        await expect(
          page
            .getByRole("button", { name: "Send to channel", exact: true })
            .last(),
        ).toBeDisabled();
        await expect(
          page.getByRole("link", { name: "Open Activity", exact: true }),
        ).toBeVisible();
        // An explicit resolution elsewhere may complete the batch; this surface only reads it.
        status = "published";
        await expect(
          page.getByRole("textbox", { name: "Board update", exact: true }),
        ).toHaveCount(0, { timeout: 8_000 });
      }
      expect(sends).toBe(outcome === "response_lost" ? 2 : 1);
      expect(canonicalCommentReadsAfterSend).toBeGreaterThan(0);
      expect(canonicalAttachmentReadsAfterSend).toBeGreaterThan(0);
      await expect(
        page.getByText("Board batch must finish all files.", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Send to channel", exact: true })
        .click();
      const newFiles = page.getByRole("group", {
        name: "Include task files",
        exact: true,
      });
      await expect(
        newFiles.getByRole("checkbox", { name: "board-send-test.txt" }),
      ).toHaveCount(0);
      await expect(
        newFiles.getByRole("checkbox", { name: "internal-only.txt" }),
      ).not.toBeChecked();
      await expect(
        newFiles.getByRole("checkbox", { name: "internal-only.txt" }),
      ).toBeEnabled();
      expect(sends).toBe(outcome === "response_lost" ? 2 : 1);
    });
  }
});

test.describe("Exact failed chat run retry", () => {
  let seed: Seed;
  let issue: { id: string; identifier: string; title: string };

  const failedRunId = "11111111-aaaa-4aaa-8aaa-111111111111";
  const actionId = "22222222-bbbb-4bbb-8bbb-222222222222";
  const denial =
    "This chat source is no longer authorized. Open the task to review its current channel access before retrying.";

  test.beforeAll(async ({ request }) => {
    seed = await seedCompanyAndAgent(request);
    issue = await json<typeof issue>(
      await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: { title: "Exact chat retry destination", status: "backlog" },
      }),
      "create exact-retry task",
    );
  });

  for (const surface of ["agent run", "Inbox", "Legacy Inbox"] as const) {
    for (const outcome of ["queued", "deferred", "denied"] as const) {
      test(`${surface}: selected run ${outcome} preserves exact retry authority and truthful feedback`, async ({
        page,
      }, testInfo) => {
        const now = Date.now();
        const run = {
          id: failedRunId,
          companyId: seed.companyId,
          agentId: seed.agentId,
          status: "failed",
          invocationSource: "assignment",
          triggerDetail: "system",
          startedAt: new Date(now - 60_000).toISOString(),
          finishedAt: new Date(now - 30_000).toISOString(),
          createdAt: new Date(now - 60_000).toISOString(),
          updatedAt: new Date(now - 30_000).toISOString(),
          error: "The fixture provider turn failed.",
          errorCode: "adapter_failed",
          exitCode: 1,
          signal: null,
          responsibleUserId: null,
          runtimeMode: "native",
          driverKind: "codex_app_server",
          nativeIssueId: issue.id,
          usageJson: null,
          resultJson: null,
          sessionIdBefore: null,
          sessionIdAfter: null,
          logStore: null,
          logRef: null,
          logBytes: 0,
          retryOfRunId: null,
          scheduledRetryAt: null,
          scheduledRetryAttempt: 0,
          scheduledRetryReason: null,
          contextSnapshot: {
            source: "chat:slack",
            issueId: issue.id,
            taskId: "33333333-cccc-4ccc-8ccc-333333333333",
            taskKey: "untrusted-copy-of-another-task",
            wakeCommentId: "44444444-dddd-4ddd-8ddd-444444444444",
            wakeCommentIds: ["44444444-dddd-4ddd-8ddd-444444444444"],
            chatFailedRunRetry: { actionId: "untrusted-client-action" },
          },
        };
        const requests: Array<{
          companyId: string | null;
          body: Record<string, unknown>;
        }> = [];
        const destinations: string[] = [];
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) destinations.push(frame.url());
        });
        await page.route("**/api/**", async (route) => {
          const url = new URL(route.request().url());
          const pathname = url.pathname;
          if (pathname === "/api/instance/settings/experimental") {
            await fulfill(route, {
              enableChatConnectors: true,
              enableStreamlinedUi: surface !== "Legacy Inbox",
            });
            return;
          }
          if (pathname === `/api/companies/${seed.companyId}/heartbeat-runs`) {
            await fulfill(route, [run]);
            return;
          }
          if (pathname === `/api/heartbeat-runs/${failedRunId}`) {
            await fulfill(route, run);
            return;
          }
          if (
            pathname === `/api/heartbeat-runs/${failedRunId}/events` ||
            pathname ===
              `/api/heartbeat-runs/${failedRunId}/workspace-operations` ||
            pathname === `/api/companies/${seed.companyId}/provider-traces`
          ) {
            await fulfill(route, []);
            return;
          }
          if (pathname === `/api/heartbeat-runs/${failedRunId}/issues`) {
            await fulfill(route, [
              {
                issueId: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                status: "backlog",
                priority: "medium",
              },
            ]);
            return;
          }
          if (pathname === `/api/heartbeat-runs/${failedRunId}/log`) {
            await fulfill(route, {
              runId: failedRunId,
              content: "",
              nextOffset: 0,
            });
            return;
          }
          if (pathname === `/api/agents/${seed.agentId}/wakeup`) {
            expect(route.request().method()).toBe("POST");
            requests.push({
              companyId: url.searchParams.get("companyId"),
              body: bodyOf(route),
            });
            if (outcome === "denied") {
              await fulfill(
                route,
                {
                  error: denial,
                  details: { code: "chat_failed_run_retry_source_denied" },
                },
                409,
              );
            } else {
              // The durable action exists, but no run has been admitted yet.
              await fulfill(
                route,
                { actionId, issueId: issue.id, runId: null, status: outcome },
                202,
              );
            }
            return;
          }
          await route.continue();
        });

        const startPath =
          surface === "agent run"
            ? `/${seed.prefix}/agents/${seed.agentId}/runs/${failedRunId}`
            : `/${seed.prefix}/inbox/all`;
        await page.goto(startPath);
        const retry = page
          .getByRole("button", { name: "Retry", exact: true })
          .filter({ visible: true });
        await expect(retry).toHaveCount(1);
        await retry.click();
        await expect.poll(() => requests.length).toBe(1);
        expect(requests[0]).toEqual({
          companyId: seed.companyId,
          body: {
            source: "on_demand",
            triggerDetail: "manual",
            reason: "retry_failed_run",
            failedRunId,
          },
        });
        if (outcome === "denied") {
          await expect(page.getByText(denial, { exact: true })).toBeVisible();
          if (surface !== "agent run") {
            await expect(
              page.getByText("Run retry failed", { exact: true }),
            ).toBeVisible();
            const toast = page.getByRole("listitem").filter({
              has: page.getByText("Run retry failed", { exact: true }),
            });
            // Visibility alone accepts opacity:0 during the toast entrance.
            // The operator must actually be able to read the denial.
            await expect(toast).toHaveCSS("opacity", "1");
            await expect(toast).toBeInViewport();
          }
          // Agent routes canonicalize the UUID to its human-readable URL key.
          // The selected failed run must remain unchanged across that redirect.
          await expect(page).toHaveURL(
            surface === "agent run"
              ? new RegExp(
                  `/${seed.prefix}/agents/(${seed.agentId}|maya)/runs/${failedRunId}$`,
                )
              : new RegExp(`${startPath}$`),
          );
          await expect(retry).toBeEnabled();
          await testInfo.attach(`${surface}-retry-denied`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
        } else {
          await expect(page).toHaveURL(
            new RegExp(
              `/${seed.prefix}/issues/(${issue.id}|${issue.identifier})$`,
            ),
          );
          await expect(
            page.getByText(issue.title, { exact: true }).first(),
          ).toBeVisible();
          await expect(
            page.getByText("Run retry failed", { exact: true }),
          ).toHaveCount(0);
        }
        expect(requests).toHaveLength(1);
        expect(
          destinations.some((url) =>
            /\/runs\/(null|undefined)(?:[/?#]|$)/.test(url),
          ),
        ).toBe(false);
      });
    }
  }
});
