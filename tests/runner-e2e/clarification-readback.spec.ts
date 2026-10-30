import { expect, test } from "@playwright/test";
import { waitForClarificationDocument } from "./product-journeys/clarification-flow.js";

const answer = "Use AMBERreadback.";
const selector = '[id="document-welcome-note"]:visible, [id="side-panel-content-document:welcome-note"]:visible';

for (const stage of ["mount", "text"] as const) {
  test(`clarification readback waits beyond the default timeout for ${stage}`, async ({ page }) => {
    const body = `Welcome to the afternoon meetup. ${answer}`;
    await page.setContent(stage === "mount" ? "<main></main>" : '<main><section id="document-welcome-note">Loading</section></main>');
    await page.evaluate(({ stage, body }) => {
      setTimeout(() => {
        if (stage === "mount") document.querySelector("main")!.innerHTML = `<section id="document-welcome-note">${body}</section>`;
        else document.querySelector("section")!.textContent = body;
      }, 5_200);
    }, { stage, body });
    await waitForClarificationDocument(page.locator(selector), answer, Date.now() + 8_000);
    await expect(page.locator(selector)).toHaveText(body);
  });
}

test("clarification readback rejects an exhausted campaign before waiting", async ({ page }) => {
  await page.setContent(`<section id="document-welcome-note">Welcome to the afternoon meetup. ${answer}</section>`);
  await expect(waitForClarificationDocument(page.locator(selector), answer, Date.now() - 1))
    .rejects.toMatchObject({ code: "clarification_document_not_ready" });
});

for (const invalid of ["duplicate", "wrong-reference", "wrong-choice"] as const) {
  test(`clarification readback rejects ${invalid} evidence within the campaign deadline`, async ({ page }) => {
    const body = invalid === "wrong-reference" ? "Welcome to the afternoon meetup. Use OLD." : invalid === "wrong-choice" ? answer : `Welcome to the afternoon meetup. ${answer}`;
    await page.setContent(`<section id="document-welcome-note">${body}</section>${invalid === "duplicate" ? `<section id="side-panel-content-document:welcome-note">${body}</section>` : ""}`);
    await expect(waitForClarificationDocument(page.locator(selector), answer, Date.now() + 250)).rejects.toThrow();
  });
}
