import { randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

// Real local Board UI, upload storage, comment HTTP routes, and disposable DB.
// Only the interface flag and explicit transport/upload rejection faults are mocked.
// Tasks belong to the Board user: no agent, runner, or provider is contacted.
type Attachment = {
  id: string;
  issueCommentId: string | null;
  contentPath: string;
};
type Comment = { id: string; body: string };

async function body<T>(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
): Promise<T> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(
    true,
  );
  return response.json() as Promise<T>;
}

async function setup(page: Page, request: APIRequestContext, classic: boolean) {
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
        assigneeUserId: "local-board",
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

async function upload(
  page: Page,
  fixture: Awaited<ReturnType<typeof setup>>,
  file: (typeof files)[number],
) {
  const chooser = page.waitForEvent("filechooser");
  await fixture.composer
    .getByRole("button", { name: "Attach file", exact: true })
    .click();
  const response = page.waitForResponse(
    (res) =>
      res.request().method() === "POST" &&
      new URL(res.url()).pathname.endsWith(
        `/issues/${fixture.issue.id}/attachments`,
      ),
  );
  await (await chooser).setFiles(file);
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
    await fixture.send.click();
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

  test(`lost accepted response does not leave an apparently retryable bound receipt (classic=${classic})`, async ({
    page,
    request,
  }, testInfo) => {
    const fixture = await setup(page, request, classic);
    await fixture.editor.fill("Accepted once: inspect this exact file.");
    const receipt = await upload(page, fixture, files[0]!);
    let accepted = false;
    await page.route("**/api/issues/*/comments", async (route) => {
      if (route.request().method() !== "POST" || accepted)
        return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      accepted = true;
      await route.abort("connectionreset");
    });
    await fixture.send.click();
    await expect.poll(() => accepted).toBe(true);
    await expect(fixture.editor).toContainText("Accepted once:");
    expect(await fixture.comments()).toHaveLength(1);
    expect(
      (await fixture.attachments()).find((row) => row.id === receipt.id)
        ?.issueCommentId,
    ).toBeTruthy();
    await page.reload();
    await expect(fixture.editor).toContainText("Accepted once:");
    await expect(fixture.composer.getByRole("alert")).toContainText(
      "couldn’t confirm whether this comment was saved",
    );
    await expect(fixture.send).toBeDisabled();
    // Neither click nor the editor keyboard shortcut may blindly replay it.
    await fixture.editor.press("Control+Enter");
    expect(await fixture.comments()).toHaveLength(1);
    const refresh = page.waitForResponse(
      (res) =>
        res.request().method() === "GET" &&
        new URL(res.url()).pathname.endsWith("/comments"),
    );
    await fixture.composer
      .getByRole("button", { name: "Review conversation", exact: true })
      .click();
    expect((await refresh).ok()).toBe(true);
    await expect(
      fixture.composer.getByText(
        "Discarding this draft does not remove any saved comment or uploaded file.",
      ),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("accepted-response-lost.png"),
      fullPage: true,
    });
    await fixture.composer
      .getByRole("button", { name: "Discard draft and start new", exact: true })
      .click();
    await expect(fixture.editor).toBeEmpty();
    expect(await fixture.comments()).toHaveLength(1);
    expect(
      (await fixture.attachments()).find((row) => row.id === receipt.id)
        ?.issueCommentId,
    ).toBeTruthy();
    await page.reload();
    await expect(fixture.composer.getByRole("alert")).toHaveCount(0);
    await fixture.editor.fill(
      "A deliberately new comment after reviewing the saved original.",
    );
    await fixture.send.click();
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
    await fixture.send.click();
    await expect(fixture.editor).toContainText("Known rejection,");
    await expect(fixture.send).toBeEnabled();
    expect(await fixture.comments()).toHaveLength(0);
    await page.reload();
    await expect(fixture.editor).toContainText("Known rejection,");
    await expect(fixture.composer.getByRole("alert")).toHaveCount(0);
    await fixture.send.click();
    await expect.poll(async () => (await fixture.comments()).length).toBe(1);
    expect(
      (await fixture.attachments()).find((row) => row.id === receipt.id)
        ?.issueCommentId,
    ).toBeTruthy();
  });

  test(`reload during a pending text-only save preserves uncertainty without replay (classic=${classic})`, async ({
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
    await page.route("**/api/issues/*/comments", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts++;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      accepted = true;
      await held;
      // Reload cancels the original browser request; the owned server response
      // has already been observed and must never be replayed by the fixture.
      await route.fulfill({ response }).catch(() => {});
    });
    try {
      await fixture.send.click();
      await expect.poll(() => accepted).toBe(true);
      expect(await fixture.comments()).toHaveLength(1);
      await page.reload();
      release();
      await expect(fixture.editor).toContainText(
        "One text-only save interrupted by reload.",
      );
      await expect(fixture.composer.getByRole("alert")).toContainText(
        "couldn’t confirm whether this comment was saved",
      );
      await expect(fixture.send).toBeDisabled();
      expect(attempts).toBe(1);
      expect(await fixture.comments()).toHaveLength(1);
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
    const chooser = page.waitForEvent("filechooser");
    await fixture.composer
      .getByRole("button", { name: "Attach file", exact: true })
      .click();
    await (await chooser).setFiles(files[1]!);
    await expect.poll(() => arrived).toBe(true);
    await expect(fixture.send).toBeDisabled();
    try {
      await expect(
        fixture.composer.getByText(
          classic ? "Uploading to task" : "Uploading…",
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
      await fixture.send.click();
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
  const chooser = page.waitForEvent("filechooser");
  await fixture.composer
    .getByRole("button", { name: "Attach file", exact: true })
    .click();
  await (await chooser).setFiles(files[0]!);
  await expect(
    fixture.composer.getByText("Fixture upload rejected", { exact: true }),
  ).toBeVisible();
  await expect(fixture.send).toBeDisabled();
  const remove = fixture.composer.getByRole("button", {
    name: "Remove board-fresh.txt",
  });
  await expect(remove).toBeVisible();
  await remove.click();
  await fixture.send.click();
  await expect.poll(async () => (await fixture.comments()).length).toBe(1);
  expect((await fixture.comments())[0]!.body).toBe(
    "Keep this text after removing the failed file.",
  );
  expect(await fixture.attachments()).toHaveLength(0);
});
