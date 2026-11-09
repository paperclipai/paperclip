import { expect, test } from "@playwright/test";
import { answerBlockerThroughUi } from "./blocker-input.js";

test("answers every page of a saved question set", async ({ page }) => {
  await page.setContent(`<div data-testid="question-text-answer-composer"><textarea></textarea></div>
    <button>Next</button><script>
    window.answers = [];
    document.querySelector('button').onclick = () => {
      window.answers.push(document.querySelector('textarea').value);
      document.querySelector('textarea').value = '';
      document.querySelector('button').textContent = 'Submit answers';
    };</script>`);
  await answerBlockerThroughUi(page, { kind: "ask_user_questions", payload: {
    questionSet: { schema: "paperclip.question_set.v1", questions: [
      { id: "scope", answerMode: "text" }, { id: "audience", answerMode: "text" },
    ] },
  } }, "New direction");
  expect(await page.evaluate(() => (window as any).answers)).toEqual(["New direction", "New direction"]);
});

for (const kind of ["request_confirmation", "request_checkbox_confirmation"]) {
  for (const reason of [true, false]) {
    test(`declines ${kind} with saved scope change (reason=${reason})`, async ({ page }) => {
      await page.setContent(`<div id="card"><button id="decline">Cancel request</button>
        <button id="accept" onclick="window.accepted = true">Approve</button></div>
        <script>
        window.accepted = false;
        document.querySelector('#decline').onclick = () => {
          if (${reason} && !document.querySelector('#decision-reject-reason')) {
            const input = document.createElement('textarea'); input.id = 'decision-reject-reason';
            document.querySelector('#card').append(input); return;
          }
          window.reason = document.querySelector('textarea')?.value;
          document.querySelector('#card').innerHTML = '<div data-testid="task-chat-composer-input"><textarea></textarea></div><button data-testid="task-chat-composer-send">Send</button>';
          document.querySelector('button').onclick = () => { window.reply = document.querySelector('textarea').value; };
        };</script>`);
      const answer = answerBlockerThroughUi(page, { id: "decision", kind, payload: {
        rejectLabel: "Cancel request", allowDeclineReason: reason,
      } }, "Change of scope");
      if (!reason) {
        await expect(answer).rejects.toThrow("confirmation has no rejection reason field");
        await expect(page.locator("#decline")).toBeVisible();
        await expect(page.getByTestId("task-chat-composer-input")).toHaveCount(0);
        return;
      }
      await answer;
      expect(await page.evaluate(() => ({ accepted: (window as any).accepted, reply: (window as any).reply })))
        .toEqual({ accepted: false, reply: reason ? undefined : "Change of scope" });
      if (reason) expect(await page.evaluate(() => (window as any).reason)).toBe("Change of scope");
    });
  }
}

for (const mode of ["single_select", "multi_select"]) {
  test(`diagnoses ${mode} without a custom answer before any page is submitted`, async ({ page }) => {
    await page.setContent(`<button onclick="window.clicked = true">Next</button>`);
    await expect(answerBlockerThroughUi(page, { kind: "ask_user_questions", payload: {
      questionSet: { schema: "paperclip.question_set.v1", questions: [
        { id: "first", answerMode: "text" },
        { id: "closed", answerMode: mode, options: [{ id: "yes", label: "Yes" }] },
      ] },
    } }, "New scope")).rejects.toThrow("closed-choice question closed has no custom answer");
    expect(await page.evaluate(() => (window as any).clicked)).toBeUndefined();
  });

  test(`answers ${mode} with an explicit custom answer`, async ({ page }) => {
    await page.setContent(`<button role="${mode === "multi_select" ? "checkbox" : "radio"}">My answer</button>
      <div data-testid="question-other-answer-composer"><textarea></textarea></div>
      <button id="submit" onclick="window.answer = document.querySelector('textarea').value">Submit answers</button>`);
    await answerBlockerThroughUi(page, { kind: "ask_user_questions", payload: {
      questionSet: { schema: "paperclip.question_set.v1", questions: [
        { id: "scope", answerMode: mode, customAnswer: { enabled: true, label: "My answer" } },
      ] },
    } }, "New scope");
    expect(await page.evaluate(() => (window as any).answer)).toBe("New scope");
  });
}

test("legacy choices retain the production form's implicit Other answer", async ({ page }) => {
  await page.setContent(`<button role="radio">Other</button>
    <div data-testid="question-other-answer-composer"><textarea></textarea></div>
    <button onclick="window.answer = document.querySelector('textarea').value">Submit answers</button>`);
  await answerBlockerThroughUi(page, { kind: "ask_user_questions", payload: {
    questions: [{ id: "scope", prompt: "Choose scope", options: [{ id: "yes", label: "Yes" }] }],
  } }, "New scope");
  expect(await page.evaluate(() => (window as any).answer)).toBe("New scope");
});
