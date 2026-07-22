import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("response", (response) => {
  if (response.status() >= 400) {
    failedResponses.push({ status: response.status(), url: response.url() });
  }
});

await page.goto("http://127.0.0.1:3100/CK/dashboard", {
  waitUntil: "networkidle",
});
await page.getByText("New Task", { exact: true }).first().click();
await page.getByPlaceholder("Task title").fill(
  "Prepare the next CRM-ranked uncontacted prospect for approval",
);

const placeholder = page.getByText("Add description...", { exact: true });
const box = await placeholder.boundingBox();
if (!box) throw new Error("Description placeholder was not visible");
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.type(
  "Select the next highest-value eligible prospect from the complete live Espo CRM universe. Use espo_rank_prospects as the authoritative candidate list and report its coverage, suppression evidence, account id, rank, score, and score reasons. Choose rank 1 unless REV-04 finds a concrete do-not-contact, identity, or email-evidence blocker; if blocked, record why and move to the next ranked account. Create the REV-04 research task first, then create the REV-06 draft task with blockedByIssueIds pointing to that research task. The final result must be one bespoke first-contact draft in the normal editable approval flow. Draft and queue for approval only. Never send any email.",
);

await page.getByRole("button", { name: "Assignee", exact: true }).click();
await page
  .getByRole("button", { name: "GOV-25 Chief-of-Staff", exact: true })
  .last()
  .click();
await page.getByRole("button", { name: "Project", exact: true }).click();
await page.keyboard.type("CK Operations");
await page.keyboard.press("Enter");
await page.screenshot({
  path: "/work/.ckshots/ranked-prospect-task-ready.png",
  fullPage: true,
});

await page.getByRole("button", { name: "Create Task", exact: true }).click();
const createdToast = page.getByText(/^Created CK-\d+$/).first();
await createdToast.waitFor({ timeout: 15000 });
const createdText = (await createdToast.textContent()) || "";
const identifier = createdText.match(/CK-\d+/)?.[0];
if (!identifier) throw new Error(`Could not parse created task from '${createdText}'`);
await page.screenshot({
  path: "/work/.ckshots/ranked-prospect-task-created-toast.png",
  fullPage: true,
});

await page.getByRole("link", { name: `Open ${identifier}`, exact: true }).click();
await page.waitForURL(new RegExp(`/issues/${identifier}$`), { timeout: 15000 });
await page.waitForLoadState("networkidle").catch(() => {});
await page.screenshot({
  path: "/work/.ckshots/ranked-prospect-task-open.png",
  fullPage: true,
});

console.log(
  JSON.stringify(
    {
      identifier,
      url: page.url(),
      consoleErrors,
      failedResponses,
    },
    null,
    2,
  ),
);
await browser.close();
