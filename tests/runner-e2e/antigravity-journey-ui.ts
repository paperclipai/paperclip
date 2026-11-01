import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ConnectionFailure } from "./connection-config.js";

/** Recent sidebar entries are bounded; the searchable roster contains every
 * agent. Scope the exact visible name to the main roster, not sidebar recency. */
export async function openAntigravityAgentFromRoster(page: Page, agentName: string, timeout = 30_000) {
  const navigation = page.locator("aside").getByRole("link", { name: "Agents", exact: true });
  await expect(navigation).toHaveCount(1, { timeout });
  await navigation.click({ timeout });
  const toolbar = page.getByRole("toolbar", { name: "Agents controls", exact: true });
  await toolbar.getByRole("textbox", { name: "Search agents", exact: true }).fill(agentName, { timeout });
  const row = page.getByRole("main").getByRole("link").filter({ has: page.getByText(agentName, { exact: true }) });
  await expect(row).toHaveCount(1, { timeout });
  await row.click({ timeout });
}

/** Both sidebar presentations use ordinary task links: the coordinator uses
 * the identifier and recent lists can repeat the same task or its immutable ID. */
export async function openAntigravityCreatedTask(page: Page, issue: { id: string; identifier?: string | null }, timeout = 30_000) {
  const paths = [issue.id, issue.identifier].filter((value): value is string => Boolean(value))
    .map(value => `a[href$="/issues/${encodeURIComponent(value)}"]:visible`);
  // Every match is an exact alias of this captured task. Recents and expanded
  // project lists may legitimately expose it more than once.
  const task = page.locator("aside").locator(paths.join(", ")).first();
  await expect(task).toHaveCount(1, { timeout });
  await task.click({ timeout });
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
  // The thread restores its bottom anchor after reload. Scrolling its entire
  // large header fights that restoration and is unnecessary to read status.
  const control = header.getByRole("button", { name: "Change status (current: Done)", exact: true });
  await expect(control).toHaveCount(1, { timeout });
  await expect(control).toBeVisible({ timeout });
  const current = page.getByRole("navigation", { name: "breadcrumb", exact: true }).locator('[aria-current="page"]:visible');
  if (await current.count()) {
    await expect(current).toHaveCount(1, { timeout });
    await expect(current.getByRole("img", { name: "Done", exact: true })).toBeVisible({ timeout });
  }
}

export async function assertAntigravityFileActivity(page: Page, runId: string, timeout = 30_000) {
  if (typeof runId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(runId)) throw new ConnectionFailure("browser_activity_run_identity_invalid");
  // The shipped adapter prefixes both phase and item IDs with their run ID.
  // Older successful rows must not satisfy this turn, or poison its checks.
  const groups = page.locator(`section[data-testid="task-chat-activity-phase"][data-activity-group^="${runId}:"]`);
  const histories = groups.getByTestId("task-chat-activity-phase-toggle");
  const older = page.getByRole("button", { name: "More messages", exact: true });
  await expect.poll(async () => await older.isVisible() || await histories.count() > 0, { timeout }).toBe(true);
  if (await older.isVisible()) await older.click();
  await expect.poll(() => histories.count(), { timeout }).toBeGreaterThan(0);
  for (const toggle of await histories.all()) if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const items = groups.locator(`li[data-activity-item-id^="${runId}:"]:visible`).filter({ has: page.locator("[data-activity-row]") });
  await expect.poll(() => items.count(), { timeout }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => {
    let reads = 0, edits = 0;
    for (const item of await items.all()) {
      const row = item.locator("[data-activity-row]");
      const family = await row.getAttribute("data-activity-family");
      if (family !== null && family !== "tool_execution") continue;
      let name: string | undefined;
      if (family === null) {
        // Persisted native tool_call/result entries use the legacy tool model.
        // Its mono target is the adapter's summarized real call input.
        const input = row.locator("span[title].font-mono");
        if (await input.count() !== 1) continue;
        const match = /^operation:\s*(read|edit|write),\s*target:\s*([^,]+)(?:,|$)/u.exec(await input.getAttribute("title") ?? "");
        if (!match || match[2]!.trim() !== "antigravity-proof.txt") continue;
        name = match[1]!;
      }
      const toggle = item.locator(":scope > button");
      await expect(toggle).toHaveCount(1, { timeout });
      if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      if (family === "tool_execution") {
        const details = item.getByTestId("task-chat-provider-detail-list");
        const value = (label: string) => details.locator(":scope > div").filter({ has: page.locator("dt").getByText(label, { exact: true }) }).locator("dd");
        const operation = value("Operation");
        if (await operation.count() !== 1) continue;
        name = (await operation.innerText()).trim();
        if (!["read", "edit", "write"].includes(name)) continue;
        const target = value("Target");
        await expect(target).toHaveCount(1, { timeout });
        if ((await target.innerText()).trim() !== "antigravity-proof.txt") continue;
        await expect(value("Status")).toHaveText("completed", { timeout });
      } else {
        // A non-latest legacy call can display completed-style copy while its
        // phase is live. Require the visible settled-phase summary as well.
        const phase = item.locator('xpath=ancestor::section[@data-testid="task-chat-activity-phase"][1]');
        await expect(phase.locator("[data-completed-summary]")).toBeVisible({ timeout });
        const result = item.getByTestId("task-chat-runner-activity-detail").locator("pre");
        await expect(result).toBeVisible({ timeout });
        await expect(result).toContainText(/\S/u, { timeout });
        await expect(row.locator(":scope > span:nth-child(2) > span:first-child"))
          .toHaveText(/^(?:Ran|Read|Edited|Wrote|Updated|Applied|Created)\b/u, { timeout });
      }
      await expect(row).toBeVisible({ timeout });
      await expect(row).not.toContainText(/·\s*(?:failed|stopped)/u, { timeout });
      await expect(row.locator('[data-conversation-tool-running="true"]')).toHaveCount(0, { timeout });
      if (name === "read") reads++; else if (name === "edit" || name === "write") edits++;
    }
    return reads > 0 && edits > 0;
  }, { timeout }).toBe(true);
}

/** Open the card bound to the independently observed attachment, then download
 * through its real file viewer. A stale same-named first-turn card cannot pass. */
export async function inspectAntigravityArtifact(page: Page, attachmentId: string, expected: Buffer, timeout = 30_000) {
  if (!/^[a-zA-Z0-9-]+$/u.test(attachmentId)) throw new ConnectionFailure("browser_attachment_identity_invalid");
  const contentPath = `/api/attachments/${attachmentId}/content`;
  const boundLink = page.locator(`a[href="${contentPath}"], a[href="${contentPath}?download=1"]`);
  const cards = page.locator('article[data-testid="task-chat-rich-work-product-artifact"]:visible').filter({ has: boundLink });
  // Work-product titles are human labels, for example "Antigravity Proof File".
  // Their exact attachment link, not that title, binds the ordinary open action.
  const opening = page.getByRole("button", { name: /^Open in tab: /u }).and(cards.getByRole("button", { name: /^Open in tab: /u }));
  const rows = page.locator('[data-artifact-row]:visible, [data-slot="attachment"]:visible')
    .filter({ has: page.getByRole("button", { name: "Open antigravity-proof.txt", exact: true }).or(page.getByRole("link", { name: "Open antigravity-proof.txt", exact: true })) })
    .filter({ has: page.getByText(new RegExp(`(?:^|\\s)${expected.length} B$`, "u")) });
  const boundRows = rows.filter({ has: boundLink });
  const rowOpening = boundRows.getByRole("link", { name: "Open antigravity-proof.txt", exact: true });
  const buttonOnly = rows.filter({ hasNot: page.locator("a[href]") }).getByRole("button", { name: "Open antigravity-proof.txt", exact: true });
  await expect.poll(async () => await opening.count() + await rowOpening.count() + await buttonOnly.count(), { timeout }).toBeGreaterThan(0);
  if (await opening.count()) {
    await expect(opening).toHaveCount(1, { timeout });
    const card = opening.locator('xpath=ancestor::*[self::article or @data-slot="card"][1]');
    await expect(card.getByText(new RegExp(`(?:^|\\s)${expected.length} B$`, "u"))).toBeVisible({ timeout });
    await opening.click({ timeout });
  } else {
    const control = await rowOpening.count() ? rowOpening : buttonOnly;
    await expect(control).toHaveCount(1, { timeout });
    await control.click({ timeout });
  }
  const raw = page.locator('pre[aria-label="antigravity-proof.txt raw text"]:visible');
  await expect(raw).toHaveCount(1, { timeout });
  await expect(raw).toHaveText(expected.toString("utf8"), { useInnerText: false, timeout });
  const download = page.getByRole("link", { name: "Download antigravity-proof.txt", exact: true })
    .and(page.locator(`a[download][href="${contentPath}?download=1"]`));
  await expect(download).toHaveAttribute("href", `${contentPath}?download=1`, { timeout });
  const [file] = await Promise.all([page.waitForEvent("download", { timeout }), download.click({ timeout })]);
  const downloaded = await file.path();
  if (!downloaded || !(await readFile(downloaded)).equals(expected)) throw new ConnectionFailure("browser_download_bytes_mismatch");
}
