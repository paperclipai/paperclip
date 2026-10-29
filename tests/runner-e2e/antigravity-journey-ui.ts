import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ConnectionFailure } from "./connection-config.js";

/** Recent sidebar entries are bounded; the searchable roster contains every
 * agent. Scope the exact visible name to the main roster, not sidebar recency. */
export async function openAntigravityAgentFromRoster(page: Page, agentName: string, timeout = 30_000) {
  await page.getByRole("link", { name: "Agents", exact: true }).click({ timeout });
  const toolbar = page.getByRole("toolbar", { name: "Agents controls", exact: true });
  await toolbar.getByRole("textbox", { name: "Search agents", exact: true }).fill(agentName, { timeout });
  const row = page.getByRole("main").getByRole("link").filter({ has: page.getByText(agentName, { exact: true }) });
  await expect(row).toHaveCount(1, { timeout });
  await row.click({ timeout });
}

/** The ordinary picker is measured before any direct setup-route navigation. */
export async function selectAntigravityFromOrdinaryPicker(page: Page, timeout = 30_000) {
  const dialog = page.getByRole("dialog", { name: "Choose an adapter", exact: true });
  await expect(dialog).toBeVisible({ timeout });
  const advanced = dialog.locator("details").filter({ has: page.locator("summary", { hasText: /^Advanced$/ }) });
  if (await advanced.count()) await expect(advanced).not.toHaveAttribute("open", "", { timeout });
  const radio = dialog.getByRole("radio", { name: /^Google Antigravity(?:\s+Candidate)?$/ });
  await radio.scrollIntoViewIfNeeded({ timeout });
  // The native input is visually hidden; its enclosing ordinary card is visible.
  await expect(radio.locator("..")).toBeVisible({ timeout });
  await radio.locator("..").click({ timeout });
  await expect(radio).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Configure agent", exact: true })).toBeEnabled();
}

export async function assertAntigravityReady(page: Page, agentName: string, timeout = 120_000) {
  const assign = page.getByRole("button", { name: `Assign ${agentName} a Task`, exact: true });
  const finishing = page.getByRole("heading", { name: "Finishing agent setup", exact: true });
  if (await finishing.isVisible()) await expect(assign).toBeDisabled({ timeout });
  await expect(page.getByRole("heading", { name: "Your agent is ready", exact: true })).toBeVisible({ timeout });
  await expect(assign).toBeEnabled({ timeout });
}

export async function assertAntigravityCleanComposer(page: Page, agentName: string, model: string, timeout = 30_000) {
  const dialog = page.getByRole("dialog", { name: "New task", exact: true });
  await expect(dialog).toBeVisible({ timeout });
  await expect(dialog.getByTestId("new-issue-paused-assignee-note")).toBeHidden({ timeout });
  await expect(dialog.getByRole("button", { name: "Select assignee", exact: true })).toContainText(agentName, { timeout });
  const modelLabel = dialog.getByRole("button", { name: "Select model and effort", exact: true }).getByTestId("task-chat-composer-model-label");
  await expect(modelLabel).toHaveText(model === "gemini-3.8-flash-low" ? /^(?:gemini-3\.8-flash-low|Gemini 3\.8 Flash \(Low\))$/ : model, { timeout });
}

export async function assertAntigravityTaskDone(page: Page, timeout = 30_000) {
  const header = page.locator('[data-testid="issue-detail-header"]:visible');
  await expect(header).toBeVisible({ timeout });
  await header.scrollIntoViewIfNeeded({ timeout });
  await expect(header.getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible({ timeout });
}

export async function assertAntigravityFileActivity(page: Page, timeout = 30_000) {
  const histories = page.getByTestId("task-chat-activity-phase-toggle");
  await expect.poll(() => histories.count(), { timeout }).toBeGreaterThan(0);
  for (const toggle of await histories.all()) if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const fileRows = page.locator("[data-activity-row]:visible").filter({ hasText: /operation:\s*(?:read|edit|write),\s*target:\s*antigravity-proof\.txt/ });
  await expect.poll(() => fileRows.count(), { timeout }).toBeGreaterThanOrEqual(2);
  await expect(fileRows.filter({ hasText: /\b(?:failed|interrupted)\b/i })).toHaveCount(0, { timeout });
  await expect(fileRows.filter({ hasText: /operation:\s*read,/ })).not.toHaveCount(0, { timeout });
  await expect(fileRows.filter({ hasText: /operation:\s*(?:edit|write),/ })).not.toHaveCount(0, { timeout });
}

/** Open the card bound to the independently observed attachment, then download
 * through its real file viewer. A stale same-named first-turn card cannot pass. */
export async function inspectAntigravityArtifact(page: Page, attachmentId: string, expected: Buffer, timeout = 30_000) {
  const contentPath = `/api/attachments/${attachmentId}/content`;
  const card = page.locator("article:visible").filter({ has: page.locator(`a[href*="${contentPath}"]`) })
    .filter({ has: page.getByRole("button", { name: "Open in tab: antigravity-proof.txt", exact: true }) });
  const opening = card.getByRole("button", { name: "Open in tab: antigravity-proof.txt", exact: true });
  // Multiple nested articles can match; the actual matching button is unique.
  const buttons = page.getByRole("button", { name: "Open in tab: antigravity-proof.txt", exact: true }).and(opening);
  if (await buttons.count() !== 1) {
    const chip = page.getByTestId("task-chat-bubble-attachments").locator(`a[href*="${contentPath}"]:visible`);
    await expect(chip).toHaveCount(1, { timeout });
    await chip.click();
  } else await buttons.click();
  const raw = page.locator('pre[aria-label="antigravity-proof.txt raw text"]:visible');
  await expect(raw).toHaveCount(1, { timeout });
  await expect(raw).toHaveText(expected.toString("utf8"), { useInnerText: false });
  const download = page.getByRole("link", { name: "Download antigravity-proof.txt", exact: true });
  await expect(download).toHaveAttribute("href", `${contentPath}?download=1`);
  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
  const downloaded = await file.path();
  if (!downloaded || !(await readFile(downloaded)).equals(expected)) throw new ConnectionFailure("browser_download_bytes_mismatch");
}
