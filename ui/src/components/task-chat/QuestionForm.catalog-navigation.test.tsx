// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PaperclipQuestionSet } from "@paperclipai/adapter-utils";
import { QuestionForm } from "./QuestionForm";
vi.mock("./TaskChatRichInput", () => ({ TaskChatRichInput: () => <textarea /> }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
function queryByRole(scope: HTMLElement, role: "button" | "radio", options: { name: string; exact: true }): HTMLElement | null {
  return [...scope.querySelectorAll<HTMLElement>("button")].find(element =>
    (element.getAttribute("role") ?? "button") === role
      && (element.getAttribute("aria-label") ?? element.textContent?.trim()) === options.name) ?? null;
}
function getByRole(scope: HTMLElement, role: "button" | "radio", options: { name: string; exact: true }): HTMLElement {
  const found = queryByRole(scope, role, options);
  if (!found) throw new Error(`Missing rendered ${role} ${options.name}`);
  return found;
}
const fixture = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../tests/runner-e2e/chat-catalog-domains/identity-questions-and-approvals.ts"), "utf8");
const previousSelector = fixture.match(/await form\.getByRole\("button", \{ name: "([^"]+)", exact: true \}\)\.click\(\);\s*state\.retainedAudience/);
const set: PaperclipQuestionSet = { schema: "paperclip.question_set.v1", questions: [
  { id: "audience", prompt: "Who is the audience?", required: true, answerMode: "single_select", options: [{ id: "researchers", label: "Researchers" }] },
  { id: "tone", prompt: "What tone should we use?", required: true, answerMode: "single_select", options: [{ id: "clear", label: "Clear" }] },
] };
let host: HTMLDivElement, form: HTMLDivElement, root: Root;
const submit = vi.fn();
beforeEach(() => { localStorage.clear(); submit.mockReset(); host = document.createElement("div"); document.body.append(host); form = document.createElement("div"); form.dataset.testid = "task-chat-composer-takeover"; host.append(form); root = createRoot(form); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); });
async function secondPage() {
  await act(async () => root.render(<QuestionForm id="catalog-53" questionSet={set} onSubmit={submit} />));
  await act(async () => getByRole(form, "button", { name: "Next", exact: true }).click());
  expect(form.textContent).toContain("This question is required."); expect(form.textContent).not.toContain("What tone should we use?"); expect(submit).not.toHaveBeenCalled();
  await act(async () => getByRole(form, "radio", { name: "Researchers", exact: true }).click());
  await act(async () => getByRole(form, "button", { name: "Next", exact: true }).click());
  expect(form.textContent).toContain("What tone should we use?");
}
it("uses the actual catalog consumer selector on rendered production pagination and retains the first answer", async () => {
  await secondPage(); expect(previousSelector).not.toBeNull();
  const previous = getByRole(form, "button", { name: previousSelector![1]!, exact: true });
  expect((previous as HTMLButtonElement).disabled).toBe(false); await act(async () => previous.click());
  expect(getByRole(form, "radio", { name: "Researchers", exact: true }).getAttribute("aria-checked")).toBe("true");
  expect(form.textContent).not.toContain("What tone should we use?"); expect(submit).not.toHaveBeenCalled();
});
it("does not substitute wrong navigation names or another question's previous control", async () => {
  await secondPage();
  for (const name of ["Back", "Previous item"]) expect(queryByRole(form, "button", { name, exact: true })).toBeNull();
  expect(getByRole(form, "button", { name: "Previous question", exact: true })).not.toBe(getByRole(form, "button", { name: "Next question", exact: true }));
  const foreign = document.createElement("button"); foreign.setAttribute("aria-label", "Previous question"); host.append(foreign);
  expect(getByRole(form, "button", { name: "Previous question", exact: true })).not.toBe(foreign); expect(submit).not.toHaveBeenCalled();
});
