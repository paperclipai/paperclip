import { type Page } from "@playwright/test";
import { fillTaskPrompt, withBrowserEvent } from "../user-actions.js";

/** Use the production form's labels and explicitly open each independent picker. */
export async function fillRoutineCreateForm(page: Page, input: {
  title: string; agentName: string; projectName: string; prompt: string;
}) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title", exact: true }).fill(input.title);
  // Focus is idempotent: InlineEntitySelector opens on focus, while a click
  // can close a picker that keyboard focus has already opened.
  await dialog.getByRole("button", { name: "Choose an agent", exact: true }).focus();
  await dialog.getByPlaceholder("Search agents…", { exact: true }).fill(input.agentName);
  await dialog.getByRole("button", { name: input.agentName, exact: true }).click();
  await dialog.getByRole("button", { name: "No project", exact: true }).focus();
  await dialog.getByPlaceholder("Search projects…", { exact: true }).fill(input.projectName);
  await dialog.getByRole("button", { name: input.projectName, exact: true }).click();
  await fillTaskPrompt(dialog.getByRole("textbox", { name: "Instructions", exact: true }), input.prompt);
}

/** The fixture owns exactly one schedule; use its normal page popover. */
export async function setRoutineScheduleEnabled(
  page: Pick<Page, "getByRole" | "waitForResponse">, triggerRoute: string, enabled: boolean,
) {
  await page.getByRole("button", { name: /^Change schedule:/ }).click();
  return withBrowserEvent(
    () => page.waitForResponse(response => response.request().method() === "PATCH"
      && new URL(response.url()).pathname === triggerRoute),
    () => page.getByRole("button", { name: enabled ? "Resume" : "Pause", exact: true }).click());
}

export async function enableRoutineScheduleTrigger(page: Pick<Page, "getByRole" | "waitForResponse">, triggerRoute: string) {
  return setRoutineScheduleEnabled(page, triggerRoute, true);
}
