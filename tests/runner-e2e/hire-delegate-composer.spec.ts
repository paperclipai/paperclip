import { expect, test, type Page } from "@playwright/test";
import { sendChatMessage } from "./chat-flow.js";
import { hireHandoffMentions } from "./product-journeys/hire-delegate-flow.js";
import { sendHireHandoffMessage } from "./product-journeys/hire-delegate-composer.js";
import { composerResources as r, startHireComposerFixture } from "./hire-delegate-composer.fixture.js";

test.setTimeout(45_000);
let fixture: Awaited<ReturnType<typeof startHireComposerFixture>>;
test.beforeAll(async () => { fixture = await startHireComposerFixture(); });
test.afterAll(async () => { await fixture?.close(); });
const references = hireHandoffMentions({ companyId: r.companyId, leadId: r.leadId, projectId: r.projectId, campaignId: r.campaignId }, r.agentId,
  { id: r.agentId, companyId: r.companyId, reportsTo: r.leadId, name: `Morgan Reviewer ${r.campaignId}`, icon: "code" },
  { id: r.projectId, companyId: r.companyId, name: `Journey QA hire-delegate-reuse ${r.campaignId}`, color: "#336699" });
const message = (review = false) => `Have the existing ${references.teammate} ${review ? "review the checklist on QA-1 and write a separate saved review" : "write a concise launch checklist as a saved Paperclip document"}. Create exactly one task in ${references.project}, already assigned to that teammate when it is created. Link the result here.`;
async function open(page: Page, key: string, variant = "valid", mode = "production") {
  const url = new URL("/__hire.html", fixture.url); url.searchParams.set("case", key); url.searchParams.set("variant", variant); url.searchParams.set("mode", mode);
  await page.goto(url.href);
  await expect(page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]')).toBeVisible({ timeout: 30_000 });
}
async function saved(page: Page, key: string) { return (await page.request.get(new URL(`/__saved/${encodeURIComponent(key)}`, fixture.url).href)).json() as Promise<Array<{ id: string; body: string }>>; }

test("raw fill escapes mention syntax in the real production composer", async ({ page }) => {
  await open(page, "raw"); const text = message(); await sendChatMessage(page, text);
  await expect.poll(async () => (await saved(page, "raw")).length).toBe(1);
  const [row] = await saved(page, "raw"); expect(row!.body).not.toBe(text); expect(row!.body).toContain("\\[@");
});
for (const [review, mode] of [[false, "production"], [true, "streamlined"]] as const) {
  test(`normal mention controls preserve the exact ${review ? "review" : "checklist"} body in ${mode} composer`, async ({ page }) => {
    const key = mode; await open(page, key, "valid", mode); const text = message(review);
    await sendHireHandoffMessage(page, text, references, Date.now() + 10_000);
    await expect.poll(async () => (await saved(page, key)).length).toBe(1);
    expect(await saved(page, key)).toEqual([{ id: "1", body: text }]);
  });
}
for (const variant of ["wrong-agent", "duplicate", "missing-project"] as const) {
  test(`normal mention controls reject ${variant} without sending`, async ({ page }) => {
    await open(page, variant, variant);
    const send = sendHireHandoffMessage(page, message(), references, Date.now() + (variant === "missing-project" ? 5_000 : 10_000));
    if (variant !== "missing-project") await expect(send).rejects.toMatchObject({
      code: variant === "wrong-agent" ? "hire_handoff_mention_mismatch" : "hire_handoff_mention_ambiguous",
    });
    else {
      await expect(send).rejects.toThrow();
      await expect(page.locator('a[data-mention-kind="agent"]')).toHaveCount(1);
      await expect(page.locator('a[data-mention-kind="project"]')).toHaveCount(0);
    }
    expect(await saved(page, variant)).toEqual([]);
  });
}
