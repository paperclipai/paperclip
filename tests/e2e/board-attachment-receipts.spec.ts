import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";

// Real local Board UI, upload storage, comment HTTP routes, and disposable DB.
// Only the interface flag and explicit transport/upload rejection faults are mocked.
// Tasks have no recipient: no agent, runner, or provider is contacted.
type Attachment = {
  id: string;
  issueCommentId: string | null;
  contentPath: string;
};
type Comment = { id: string; body: string; clientRequestId?: string | null };

async function body<T>(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
): Promise<T> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(
    true,
  );
  return response.json() as Promise<T>;
}

async function dismissAnnouncement(page: Page, dismiss: Locator) {
  const menuOpen = await page.getByRole("menu", { name: "Add to composer", exact: true }).isVisible();
  if (menuOpen) await page.keyboard.press("Escape");
  const [button] = await dismiss.elementHandles();
  if (button) {
    try { await button.click(); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Element is not attached") || await dismiss.count()) throw error;
    }
  }
  if (menuOpen) await page.getByRole("button", { name: "Add to composer", exact: true }).click();
}

async function setup(page: Page, request: APIRequestContext, classic: boolean) {
  // Announcements can appear after navigation or reload and cover the classic
  // composer's attachment button. Dismiss through the same UI as a Board user.
  await page.addLocatorHandler(
    page.getByRole("complementary", { name: "Paperclip announcements", exact: true })
      .getByRole("button", { name: "Dismiss announcement", exact: true }),
    async (dismiss) => dismissAnnouncement(page, dismiss),
  );
  const company = await body<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", {
      data: { name: `Board receipt browser ${randomUUID()}` },
    }),
  );
  const issue = await body<{ id: string; identifier: string }>(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: {
        title: "Inspect the newly uploaded Board files",
        status: "todo",
        // Keep attachment sends on the comment route. A task assigned to the
        // current human now suggests an empty recipient and sends a reassignment.
        assigneeUserId: null,
      },
    }),
  );
  await page.route("**/api/instance/settings/experimental", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ enableClassicTaskInterface: classic }),
    }),
  );
  await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
  await expect(
    page.getByRole("heading", {
      name: "Inspect the newly uploaded Board files",
      exact: true,
    }),
  ).toBeVisible();
  const composer = classic
    ? page.getByTestId("issue-chat-composer")
    : page.locator(".paperclip-task-chat-composer");
  const editor = composer.getByRole("textbox", {
    name: "editable markdown",
    exact: true,
  });
  const send = classic
    ? composer.getByRole("button", { name: /Send|Reply/ }).last()
    : page.getByTestId("task-chat-composer-send");
  await expect(editor).toBeVisible();
  return {
    company,
    issue,
    composer,
    editor,
    send,
    sendComment: async () => {
      await send.click();
      if (classic) {
        const confirm = page.getByTestId("issue-chat-no-assignee-send-anyway");
        await expect(confirm).toBeVisible();
        await confirm.click();
      }
    },
    attachments: () =>
      request
        .get(`/api/issues/${issue.id}/attachments`)
        .then(body<Attachment[]>),
    comments: () =>
      request.get(`/api/issues/${issue.id}/comments`).then(body<Comment[]>),
  };
}

const files = [
  {
    name: "board-fresh.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Object: cat\nAccent: teal\nCount: 3\n"),
  },
  {
    name: "board-fresh.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfFoAAAAASUVORK5CYII=",
      "base64",
    ),
  },
];

async function openAttachmentChooser(page: Page, composer: Locator) {
  await composer.getByRole("button", { name: "Add to composer" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Files and images", exact: true }).click();
  return chooser;
}

test("new-task images survive reload, retain bytes, and clear after creation", async ({ page, request }) => {
  const fixture = await setup(page, request, false);
  await page.getByRole("button", { name: "New Task", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "New task", exact: true });
  const editor = dialog.getByRole("textbox", { name: "editable markdown", exact: true });
  await editor.fill("Keep the caption and image after reload.");
  const chooser = await openAttachmentChooser(page, dialog);
  await chooser.setFiles(files[1]!);
  await expect(dialog.getByRole("img", { name: "board-fresh.png", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("paperclip:issue-draft-files", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction("files", "readonly");
        const request = tx.objectStore("files").getAll();
        tx.oncomplete = () => resolve(request.result.flat().length);
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  })).toBe(1);
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage)
    .some(([key, value]) => key.startsWith("paperclip:issue-draft:") && value.includes("Keep the caption")))).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "New Task", exact: true }).first().click();
  await expect(editor).toContainText("Keep the caption and image after reload.");
  await expect(dialog.getByRole("img", { name: "board-fresh.png", exact: true })).toBeVisible();
  const upload = page.waitForResponse((response) => response.request().method() === "POST"
    && /\/issues\/[^/]+\/attachments$/.test(new URL(response.url()).pathname));
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  const attachment = await body<Attachment>(await upload);
  const content = await request.get(attachment.contentPath);
  expect(content.ok()).toBe(true);
  expect(await content.body()).toEqual(files[1]!.buffer);
  await expect(dialog).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "New Task", exact: true }).first().click();
  await expect(dialog.getByRole("img")).toHaveCount(0);
});

test("an older image draft retains the rich editor", async ({ page, request }) => {
  const fixture = await setup(page, request, false);
  const attachment = await body<Attachment>(await request.post(`/api/companies/${fixture.company.id}/issues/${fixture.issue.id}/attachments`, {
    multipart: { file: { name: files[1]!.name, mimeType: files[1]!.mimeType, buffer: files[1]!.buffer } },
  }));
  await page.addInitScript(({ issueId, imagePath }) => {
    localStorage.setItem(`paperclip:issue-comment-draft:${issueId}`, `Keep this older caption.\n\n![Older image](${imagePath})`);
  }, { issueId: fixture.issue.id, imagePath: attachment.contentPath });
  await page.reload();
  await expect(fixture.editor).toBeVisible();
  await expect(fixture.editor).toContainText("Keep this older caption.");
  await expect(fixture.composer.getByRole("img", { name: "Older image", exact: true })).toBeVisible();
  await expect(fixture.composer.locator("textarea")).toHaveCount(0);
});

test("two open tabs retain their staged images when either tab saves or creates a task", async ({ page, request, context }) => {
  await setup(page, request, false);
  const second = await context.newPage();
  await second.goto(page.url());
  const dialogs = [page, second].map((tab) => tab.getByRole("dialog", { name: "New task", exact: true }));
  for (const [index, tab] of [page, second].entries()) {
    await tab.getByRole("button", { name: "New Task", exact: true }).first().click();
    await dialogs[index]!.getByRole("textbox", { name: "editable markdown", exact: true }).fill(`Keep tab ${index + 1}'s image.`);
    await expect(dialogs[index]!.getByRole("button", { name: "Create task", exact: true })).toBeEnabled();
  }
  const savedNames = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("paperclip:issue-draft-files", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction("files", "readonly");
        const request = tx.objectStore("files").getAll();
        tx.oncomplete = () => resolve(request.result.flat().map((item: { file: File }) => item.file.name).sort());
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
  for (const [index, tab] of [page, second].entries()) {
    const chooser = await openAttachmentChooser(tab, dialogs[index]!);
    await chooser.setFiles({ ...files[1]!, name: `tab-${index + 1}.png` });
    await expect(dialogs[index]!.getByRole("img", { name: `tab-${index + 1}.png`, exact: true })).toBeVisible();
    await expect.poll(savedNames).toEqual(index === 0 ? ["tab-1.png"] : ["tab-1.png", "tab-2.png"]);
  }
  await dialogs[0]!.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(dialogs[0]!).toBeHidden();
  await expect.poll(savedNames).toEqual(["tab-2.png"]);
  await second.reload();
  await second.getByRole("button", { name: "New Task", exact: true }).first().click();
  await expect(dialogs[1]!.getByRole("img", { name: "tab-2.png", exact: true })).toBeVisible();
  await dialogs[1]!.getByRole("textbox", { name: "editable markdown", exact: true }).fill("Create the remaining tab's image.");
  await dialogs[1]!.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(dialogs[1]!).toBeHidden();
  await expect.poll(savedNames).toEqual([]);
  await second.close();
});

async function upload(
  page: Page,
  fixture: Awaited<ReturnType<typeof setup>>,
  file: (typeof files)[number],
) {
  const chooser = await openAttachmentChooser(page, fixture.composer);
  const response = page.waitForResponse(
    (res) =>
      res.request().method() === "POST" &&
      new URL(res.url()).pathname.endsWith(
        `/issues/${fixture.issue.id}/attachments`,
      ),
  );
  await chooser.setFiles(file);
  const receipt = await body<Attachment>(await response);
  await expect
    .poll(async () =>
      (await fixture.attachments()).some((item) => item.id === receipt.id),
    )
    .toBe(true);
  return receipt;
}

for (const classic of [false, true]) {
  test(`uploaded file and image receipts survive reload and bind exactly once (classic=${classic})`, async ({
    page,
    request,
  }, testInfo) => {
    const fixture = await setup(page, request, classic);
    await fixture.editor.fill(
      "Inspect only these fresh Board attachments. Keep this internal.",
    );
    const receipts = [];
    for (const file of files) receipts.push(await upload(page, fixture, file));
    const draftKey = `paperclip:issue-comment-draft:${fixture.issue.id}`;
    await expect
      .poll(() =>
        page.evaluate(
          (key) =>
            JSON.parse(localStorage.getItem(`${key}:attachments:v1`) ?? "null")
              ?.attachments?.length,
          draftKey,
        ),
      )
      .toBe(2);
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey))
      .toContain("Inspect only these fresh Board attachments.");
    await testInfo.attach("before-reload-draft", {
      body: JSON.stringify(
        await page.evaluate(
          (key) => ({
            text: localStorage.getItem(key),
            receipts: localStorage.getItem(`${key}:attachments:v1`),
          }),
          draftKey,
        ),
      ),
      contentType: "application/json",
    });
    await page.reload();
    await expect(fixture.editor).toContainText(
      "Inspect only these fresh Board attachments.",
    );
    await expect(
      fixture.composer.getByText("board-fresh.txt", { exact: true }),
    ).toBeVisible();
    await expect(fixture.composer.locator("img")).toHaveCount(1);
    const outbound = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname.endsWith("/comments"),
    );
    await fixture.sendComment();
    expect((await outbound).postDataJSON().attachmentIds.sort()).toEqual(
      receipts.map((row) => row.id).sort(),
    );
    await expect.poll(async () => (await fixture.comments()).length).toBe(1);
    const [comment] = await fixture.comments();
    const savedBubble = classic
      ? page.locator(`[id="comment-${comment!.id}"]`)
      : page.getByTestId("task-chat-human-bubble").filter({
          hasText:
            "Inspect only these fresh Board attachments. Keep this internal.",
        });
    await expect(savedBubble).toHaveCount(1);
    expect(comment.body).toContain(receipts[0]!.contentPath);
    expect(comment.body).toContain(receipts[1]!.contentPath);
    expect(
      (await fixture.attachments()).map((item) => item.issueCommentId),
    ).toEqual([comment.id, comment.id]);
    for (let index = 0; index < receipts.length; index++) {
      const downloaded = await request.get(receipts[index]!.contentPath);
      expect(downloaded.ok()).toBe(true);
      expect(await downloaded.body()).toEqual(files[index]!.buffer);
    }
    await expect
      .poll(() =>
        page.evaluate(
          (key) => localStorage.getItem(`${key}:attachments:v1`),
          draftKey,
        ),
      )
      .toBeNull();
    await page.reload();
    await expect(fixture.editor).toBeEmpty();
    expect(await fixture.comments()).toHaveLength(1);
    await expect(savedBubble).toHaveCount(1);
    await page.screenshot({
      path: testInfo.outputPath("bound-board-attachments.png"),
      fullPage: true,
    });
  });

  test(`lost accepted response settles from its exact receipt without replay (classic=${classic})`, async ({
    page,
    request,
  }, testInfo) => {
    const fixture = await setup(page, request, classic);
    await fixture.editor.fill("Accepted once: inspect this exact file.");
    const receipt = await upload(page, fixture, files[0]!);
    let accepted = false;
    let attempts = 0;
    let acceptedRequestId: string | undefined;
    await page.route("**/api/issues/*/comments", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts++;
      if (accepted) return route.continue();
      acceptedRequestId = route.request().postDataJSON().clientRequestId;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      accepted = true;
      await route.abort("connectionreset");
    });
    await fixture.sendComment();
    await expect.poll(() => accepted).toBe(true);
    expect(await fixture.comments()).toHaveLength(1);
    expect(acceptedRequestId).toEqual(expect.any(String));
    expect((await fixture.comments())[0]!.clientRequestId).toBe(acceptedRequestId);
    expect(
      (await fixture.attachments()).find((row) => row.id === receipt.id)
        ?.issueCommentId,
    ).toBeTruthy();
    await page.reload();
    // The durable request receipt proves delivery even though the POST reply
    // was lost. No manual Review/Discard bookkeeping or blind replay remains.
    await expect(fixture.editor).toBeEmpty();
    await expect(fixture.composer.getByRole("alert")).toHaveCount(0);
    await expect(fixture.composer.getByText("board-fresh.txt", { exact: true })).toHaveCount(0);
    await expect(fixture.send).toBeDisabled();
    await fixture.editor.press("Control+Enter");
    expect(attempts).toBe(1);
    expect(await fixture.comments()).toHaveLength(1);
    await page.screenshot({
      path: testInfo.outputPath("accepted-response-lost.png"),
      fullPage: true,
    });
    expect(
      (await fixture.attachments()).find((row) => row.id === receipt.id)
        ?.issueCommentId,
    ).toBeTruthy();
    await page.reload();
    await expect(fixture.composer.getByRole("alert")).toHaveCount(0);
    await fixture.editor.fill(
      "A deliberately new comment after the original receipt settled.",
    );
    await fixture.sendComment();
    await expect.poll(async () => (await fixture.comments()).length).toBe(2);
  });

  test(`known rejection retains the same uploaded receipt for explicit retry (classic=${classic})`, async ({
    page,
    request,
  }) => {
    const fixture = await setup(page, request, classic);
    await fixture.editor.fill("Known rejection, then retry the same file.");
    const receipt = await upload(page, fixture, files[0]!);
    let rejected = false;
    await page.route("**/api/issues/*/comments", async (route) => {
      if (route.request().method() !== "POST" || rejected)
        return route.continue();
      rejected = true;
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture policy rejected this attempt" }),
      });
    });
    await fixture.sendComment();
    await expect(fixture.editor).toContainText("Known rejection,");
    await expect(fixture.send).toBeEnabled();
    expect(await fixture.comments()).toHaveLength(0);
    await page.reload();
    await expect(fixture.editor).toContainText("Known rejection,");
    await expect(fixture.composer.getByRole("alert")).toHaveCount(0);
    await fixture.sendComment();
    await expect.poll(async () => (await fixture.comments()).length).toBe(1);
    expect(
      (await fixture.attachments()).find((row) => row.id === receipt.id)
        ?.issueCommentId,
    ).toBeTruthy();
  });

  test(`reload during a pending save settles its receipt and preserves a newer draft (classic=${classic})`, async ({
    page,
    request,
  }) => {
    const fixture = await setup(page, request, classic);
    await fixture.editor.fill("One text-only save interrupted by reload.");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accepted = false;
    let attempts = 0;
    let acceptedRequestId: string | undefined;
    await page.route("**/api/issues/*/comments", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts++;
      acceptedRequestId ??= route.request().postDataJSON().clientRequestId;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      accepted = true;
      await held;
      // Reload cancels the original browser request; the owned server response
      // has already been observed and must never be replayed by the fixture.
      await route.fulfill({ response }).catch(() => {});
    });
    try {
      await fixture.sendComment();
      await expect.poll(() => accepted).toBe(true);
      expect(await fixture.comments()).toHaveLength(1);
      await fixture.editor.fill("A newer draft written while delivery was pending.");
      await page.reload();
      release();
      await expect(fixture.editor).toHaveText(
        "A newer draft written while delivery was pending.",
      );
      await expect(fixture.composer.getByRole("alert")).toHaveCount(0);
      await expect(fixture.send).toBeEnabled();
      expect(attempts).toBe(1);
      expect(await fixture.comments()).toHaveLength(1);
      expect(acceptedRequestId).toEqual(expect.any(String));
      expect((await fixture.comments())[0]!.clientRequestId).toBe(acceptedRequestId);
      await fixture.sendComment();
      await expect.poll(async () => (await fixture.comments()).length).toBe(2);
      expect(attempts).toBe(2);
      expect((await fixture.comments()).map((comment) => comment.body).sort()).toEqual([
        "A newer draft written while delivery was pending.",
        "One text-only save interrupted by reload.",
      ]);
    } finally {
      release();
    }
  });
}

for (const classic of [false, true])
  test(`removed pending inline upload cannot reappear or submit after its HTTP response (classic=${classic})`, async ({
    page,
    request,
  }) => {
    const fixture = await setup(page, request, classic);
    await fixture.editor.fill("Send without the removed image.");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = false;
    await page.route(
      `**/api/companies/${fixture.company.id}/issues/${fixture.issue.id}/attachments`,
      async (route) => {
        const response = await route.fetch();
        arrived = true;
        await held;
        await route.fulfill({ response });
      },
    );
    const chooser = await openAttachmentChooser(page, fixture.composer);
    await chooser.setFiles(files[1]!);
    await expect.poll(() => arrived).toBe(true);
    await expect(fixture.send).toBeDisabled();
    try {
      await expect(
        fixture.composer.getByText(
          classic ? "Uploading to task" : "Uploading board-fresh.png…",
          { exact: true },
        ),
      ).toBeVisible();
      const remove = fixture.composer.getByRole("button", {
        name: "Remove board-fresh.png",
      });
      await expect(remove).toBeVisible();
      await remove.click();
      release();
      await expect(fixture.send).toBeEnabled();
      await expect(fixture.composer.locator("img")).toHaveCount(0);
      const outbound = page.waitForRequest(
        (req) =>
          req.method() === "POST" &&
          new URL(req.url()).pathname.endsWith("/comments"),
      );
      await fixture.sendComment();
      expect((await outbound).postDataJSON().attachmentIds).toBeUndefined();
      await expect.poll(async () => (await fixture.comments()).length).toBe(1);
      expect((await fixture.comments())[0]!.body).not.toContain(
        "/api/attachments/",
      );
      expect((await fixture.attachments())[0]!.issueCommentId).toBeNull();
    } finally {
      release();
    }
  });

test("legacy failed upload can be removed before sending the retained text", async ({
  page,
  request,
}) => {
  const fixture = await setup(page, request, true);
  await fixture.editor.fill("Keep this text after removing the failed file.");
  await page.route(
    `**/api/companies/${fixture.company.id}/issues/${fixture.issue.id}/attachments`,
    (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture upload rejected" }),
      }),
  );
  const chooser = await openAttachmentChooser(page, fixture.composer);
  await chooser.setFiles(files[0]!);
  await expect(
    fixture.composer.getByText("Fixture upload rejected", { exact: true }),
  ).toBeVisible();
  await expect(fixture.send).toBeDisabled();
  const remove = fixture.composer.getByRole("button", {
    name: "Remove board-fresh.txt",
  });
  await expect(remove).toBeVisible();
  await remove.click();
  await fixture.sendComment();
  await expect.poll(async () => (await fixture.comments()).length).toBe(1);
  expect((await fixture.comments())[0]!.body).toBe(
    "Keep this text after removing the failed file.",
  );
  expect(await fixture.attachments()).toHaveLength(0);
});

test("announcement dismissal handler tolerates an already-removed announcement", async ({ page }) => {
  await page.setContent(`<aside aria-label="Paperclip announcements"><button aria-label="Dismiss announcement">Dismiss</button></aside><button id="continue" onclick="this.dataset.clicked='yes'">Continue</button>`);
  const dismiss = page.getByRole("complementary", { name: "Paperclip announcements" }).getByRole("button", { name: "Dismiss announcement" });
  await page.addLocatorHandler(dismiss, async locator => {
    await page.locator("aside").evaluate(element => element.remove());
    await dismissAnnouncement(page, locator);
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 1000 });
  await expect(page.locator("#continue")).toHaveAttribute("data-clicked", "yes");
});

test("announcement dismissal handler preserves errors while the target remains", async ({ page }) => {
  await page.setContent('<aside aria-label="Paperclip announcements"><button disabled aria-label="Dismiss announcement">Dismiss</button></aside><button>Continue</button>');
  const dismiss = page.getByRole("complementary", { name: "Paperclip announcements" }).getByRole("button", { name: "Dismiss announcement" });
  page.setDefaultTimeout(1000);
  await expect(dismissAnnouncement(page, dismiss)).rejects.toThrow(/Timeout|timeout/);
  await expect(dismiss).toBeVisible();
  await expect(dismiss).toBeDisabled();
});
