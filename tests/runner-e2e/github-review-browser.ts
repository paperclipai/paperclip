import { expect, type Page } from "@playwright/test";
import { ConnectionBlock, ConnectionFailure } from "./connection-config.js";
import { connectionDelay } from "./connection-target.js";
import type { GitHubReviewJourneyConfig } from "./github-review-config.js";

export async function enterGitHubJourneyCompany(page: Page, origin: string, company: { issuePrefix: string }) {
  if (!/^[A-Za-z0-9]+$/.test(company.issuePrefix)) throw new ConnectionFailure("invalid_journey_company_prefix");
  const pathname = `/${company.issuePrefix}/dashboard`;
  await page.goto(`${origin}${pathname}`);
  await page.waitForURL(url => url.origin === origin && url.pathname === pathname);
}

export async function assertGitHubJourneyCheck(page: Page, expected: { repository: string; url: string; headSha: string; score: number }, timeout = 30_000) {
  let target: URL;
  try { target = new URL(expected.url); }
  catch { throw new ConnectionFailure("github_check_reference_mismatch"); }
  const prefix = `/${expected.repository}/runs/`;
  const id = target.pathname.startsWith(prefix) ? target.pathname.slice(prefix.length) : "";
  if (target.origin !== "https://github.com" || target.username || target.password || target.search || target.hash
    || !/^[1-9][0-9]*$/.test(id) || !/^[a-f0-9]{40,64}$/.test(expected.headSha)
    || !Number.isInteger(expected.score) || expected.score < 1 || expected.score > 5) {
    throw new ConnectionFailure("github_check_reference_mismatch");
  }
  await expect(page).toHaveURL(target.href, { timeout });
  const check = page.locator(`#check_run_${id}`);
  await expect(check.getByRole("heading", { name: `${expected.score}/5`, exact: true })).toBeVisible({ timeout });
  // GitHub keeps a hidden "Re-run failed checks" menu item before the visible
  // result. Only the selected check's status header can prove its conclusion.
  await expect(check.locator(":scope > .border-bottom").getByText(/failed/i)).toBeVisible({ timeout });
  await expect(check.getByText(expected.headSha, { exact: true })).toBeVisible({ timeout });
}

export async function assertGitHubJourneyTaskDone(page: Page, timeout = 30_000) {
  const status = page.locator('[data-property-row="true"]:visible')
    .filter({ has: page.locator('[data-property-label="Status"]') })
    .locator('[data-property-value="true"]');
  // Status glyphs contain SVG titles, and responsive layouts can retain hidden
  // controls. Read the visible status picker rather than the first Done text.
  await expect(status.getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible({ timeout });
}

export interface GitHubRegistrationBoundary {
  origin: string; pathname: string; passwordRequired: boolean; oneTimeCodeRequired: boolean;
  reauthenticationRequired: boolean; createControlVisible: boolean;
  controls?: { headings: string[]; buttons: string[]; alerts: string[] };
}

/** Keep only navigation and control-presence evidence. Authentication fields,
 * page content, query parameters, and grant payloads must stay out of reports. */
export async function waitForGitHubRegistrationControl(page: Page, owner: string, timeoutMs: number,
  record: (boundary: GitHubRegistrationBoundary) => Promise<void> = async () => {}, reauthenticate?: () => Promise<void>) {
  const control = page.getByRole("button", { name: new RegExp(`^Create GitHub App(?: for ${owner})?$`) });
  const observe = async (includeErrorControls = false) => {
    const url = new URL(page.url());
    if (url.origin !== "https://github.com") throw new ConnectionFailure("github_registration_origin_mismatch");
    const boundary: GitHubRegistrationBoundary = { origin: url.origin, pathname: url.pathname,
      passwordRequired: await page.locator('input[type="password"]:visible').count() > 0,
      oneTimeCodeRequired: await page.locator('input[autocomplete="one-time-code"]:visible').count() > 0,
      reauthenticationRequired: await page.getByRole("heading", { name: /^Confirm access$/i }).isVisible()
        || await page.getByRole("button", { name: /^Use (?:your password|passkey)$/i }).isVisible(),
      createControlVisible: await control.isVisible() };
    boundary.reauthenticationRequired ||= boundary.passwordRequired || boundary.oneTimeCodeRequired
      || /\/(?:login|sessions)(?:\/|$)/.test(boundary.pathname);
    if (includeErrorControls && !boundary.reauthenticationRequired
      && ["/settings/apps/new", "/settings/apps/manifest"].includes(url.pathname)) {
      boundary.controls = { headings: await page.getByRole("heading").allTextContents(),
        buttons: await page.getByRole("button").allTextContents(), alerts: await page.getByRole("alert").allTextContents() };
    }
    await record(boundary);
    return boundary;
  };
  await observe();
  let authenticationAttempted = false;
  for (;;) {
    try { await control.waitFor({ timeout: Math.min(timeoutMs, 30_000) }); break; }
    catch (error) {
      if (page.isClosed()) throw error;
      const boundary = await observe(true);
      if (boundary.reauthenticationRequired) {
        if (reauthenticate && !authenticationAttempted) { authenticationAttempted = true; await reauthenticate(); continue; }
        throw new ConnectionBlock("awaiting_user", "github_registration_reauthentication_required");
      }
      throw new ConnectionFailure("github_registration_create_control_missing");
    }
  }
  await observe();
  return control;
}

/** Capture measured pages only, excluding authentication and unrelated GitHub data. */
export function isGitHubJourneyEvidencePage(value: string, targetOrigin: string, repository: string, appSlug?: string) {
  const url = new URL(value);
  if ([...url.searchParams.keys()].some(key => /token|secret|code|state|password/i.test(key))) return false;
  if (url.origin === targetOrigin) return !/connect|login|auth/.test(url.pathname);
  if (url.origin !== "https://github.com") return false;
  const prefix = `/${repository}/`;
  if (url.pathname.startsWith(prefix) && /^(?:pull\/\d+(?:\/(?:files|commits|checks))?|runs\/\d+|actions\/runs\/\d+(?:\/job\/\d+)?)\/?$/.test(url.pathname.slice(prefix.length))) return true;
  return Boolean(appSlug && (url.pathname === `/apps/${appSlug}/installations/new` || url.pathname === `/apps/${appSlug}/installations/new/permissions`));
}

export async function awaitJourneyCondition(check: () => Promise<boolean>, timeoutMs: number, code: string, signal: AbortSignal, boundary: "awaiting_user" | "failed" = "awaiting_user") {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (signal.aborted) throw new ConnectionBlock("blocked_target", "journey_interrupted");
    if (await check()) return;
    await connectionDelay(750);
  }
  if (boundary === "failed") throw new ConnectionFailure(code);
  throw new ConnectionBlock("awaiting_user", code);
}

export async function observeGitHubJourneyAccount(page: Page) {
  const menu = page.getByRole("button", { name: /Open user navigation menu|View profile and more/i });
  const dialog = page.getByRole("dialog", { name: "User navigation", exact: true });
  await menu.click();
  try { await dialog.waitFor({ timeout: 3_000 }); }
  catch (error) {
    // GitHub can replace its server-rendered header during hydration. Retry
    // once only when the observed control still explicitly says Open.
    if (!await menu.isVisible() || await dialog.isVisible()) throw error;
    await menu.click();
    await dialog.waitFor();
  }
  const profile = dialog.getByRole("link", { name: "Profile", exact: true });
  const href = await profile.getAttribute("href");
  const url = new URL(href ?? "", "https://github.com");
  const account = url.origin === "https://github.com" ? /^\/([A-Za-z0-9-]+)\/?$/.exec(url.pathname)?.[1] : undefined;
  if (!account) throw new ConnectionFailure("github_profile_identity_missing");
  await page.keyboard.press("Escape");
  return account;
}

/** Prepare one repository grant; submitting Install remains a separate action. */
export async function selectGitHubJourneyRepository(page: Page, repository: string) {
  const selectedOnly = page.getByRole("radio", { name: /Only select repositories/i });
  await selectedOnly.check();
  await page.getByRole("button", { name: /Select repositories/i }).click();
  await page.getByRole("textbox", { name: "Search for a repository", exact: true }).fill(repository.split("/")[1]!);
  const name = new RegExp(`^${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
  // GitHub nests the selectable repository item inside a containing menu item.
  await page.getByRole("menuitem", { name }).last().click();
  await page.keyboard.press("Escape");
  await expect(selectedOnly).toBeChecked();
  await expect(page.getByRole("radio", { name: /^All repositories/ })).not.toBeChecked();
  await expect(page.getByRole("main")).toContainText("Selected 1 repository.");
  await expect(page.getByRole("button", { name: `Remove ${repository.split("/")[1]}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
}

/** Login remains ordinary browser UI. Passkeys are never exported or emulated. */
export async function ensureGitHubJourneyLogin(input: {
  page: Page; config: GitHubReviewJourneyConfig; username: string; password?: () => Promise<string>; signal: AbortSignal;
  checkpoint(id: string): Promise<void>;
}) {
  const { page, config } = input;
  const signedIn = () => page.getByRole("button", { name: /Open user navigation menu|View profile and more/i }).isVisible();
  if (!await signedIn()) {
    const loginLink = page.getByRole("link", { name: /^Sign in$/ });
    if (await loginLink.isVisible()) await loginLink.click();
    if (config.github.login === "password") {
      await page.getByLabel("Username or email address", { exact: true }).fill(input.username);
      await page.getByLabel("Password", { exact: true }).fill(await input.password!());
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    }
    await input.checkpoint("awaiting_github_sign_in");
    console.log("[github-review-journey] Complete Ralph QA GitHub sign-in/passkey in the dedicated QA browser. No credential needs to be pasted into chat.");
    await awaitJourneyCondition(signedIn, config.browser.loginTimeoutMs, "github_login_required", input.signal);
  }
  // The login identifier can be an email address; verify the GitHub handle.
  if ((await observeGitHubJourneyAccount(page)).toLowerCase() !== config.github.account.toLowerCase()) throw new ConnectionBlock("blocked_target", "github_account_mismatch");
}

/** Explicit one-time bootstrap. Later attempts reuse this private repository. */
export async function createPrivateJourneyRepository(page: Page, repository: string) {
  const [owner, name] = repository.split("/");
  await page.getByRole("button", { name: /Create new/i }).click();
  await page.getByRole("menuitem", { name: /New repository/i }).click();
  const ownerButton = page.getByRole("button", { name: /Owner|Choose an owner/i });
  await expect(ownerButton).toHaveText(owner!);
  await page.getByRole("textbox", { name: /Repository name/i }).fill(name!);
  await expect(page.getByText(`${name} is available.`, { exact: true })).toBeVisible();
  const privateChoice = page.getByRole("radio", { name: /Private/ });
  if (await privateChoice.isVisible()) await privateChoice.check();
  else {
    await page.getByRole("button", { name: /Choose visibility|Public/i }).click();
    await page.getByRole("menuitemradio", { name: /Private/ }).click();
  }
  await expect(page.getByRole("button", { name: "Choose visibility: Private", exact: true })).toBeVisible();
  const readme = page.getByRole("button", { name: "Add README", exact: true });
  if (await readme.getAttribute("aria-pressed") !== "true") await readme.click();
  await expect(readme).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Create repository", exact: true }).click();
  await page.waitForURL(url => url.origin === "https://github.com" && url.pathname === `/${repository}`);
  await expect(page.getByRole("link", { name: name!, exact: true }).first()).toBeVisible();
  await expect(page.getByText("Private", { exact: true }).first()).toBeVisible();
}

export async function createGitHubJourneyPullRequest(input: { page: Page; branch: string; title: string; contents: string }) {
  const { page } = input;
  // The initial file list is server-rendered before GitHub's controls hydrate.
  // Its loaded commit receipt provides a visible readiness signal.
  await expect(page.getByRole("link", { name: /^Commit [a-f0-9]{7,40}$/ })).toBeVisible();
  await page.getByRole("button", { name: "Add file", exact: true }).click();
  await page.getByRole("menuitem", { name: "Create new file", exact: true }).click();
  await page.getByRole("textbox", { name: /Name your file|File name/i }).fill("cart-total.js");
  await page.getByRole("textbox", { name: /Editing cart-total.js file contents|File contents/i }).fill(input.contents);
  await page.getByRole("button", { name: /Commit changes/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /Commit message/i }).fill("Add isolated cart precision review fixture");
  await dialog.getByRole("radio", { name: /Create a new branch/i }).check();
  const branch = dialog.getByRole("textbox", { name: "PR target branch", exact: true });
  await branch.fill(input.branch);
  await expect(branch).toHaveValue(input.branch);
  await dialog.getByRole("button", { name: /Propose changes|Commit changes/i }).click();
  await page.getByRole("textbox", { name: /Add a title/i }).fill(input.title);
  await page.getByRole("textbox", { name: /Add a description|Comment|Description/i }).fill("Disposable automated review fixture. This money-total helper promises exact cent totals. Review only; do not modify or merge the branch. No manual bot mention is used.");
  await page.getByRole("button", { name: "Create pull request", exact: true }).click();
  await page.waitForURL(url => url.origin === "https://github.com" && /\/pull\/\d+$/.test(url.pathname));
  const match = /\/pull\/(\d+)$/.exec(new URL(page.url()).pathname);
  if (!match) throw new ConnectionFailure("created_pr_url_missing");
  return Number(match[1]);
}

export async function observeGitHubHead(page: Page) {
  const pull = new URL(page.url());
  const repository = /^\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(pull.pathname)?.[1];
  if (pull.origin !== "https://github.com" || !repository) throw new ConnectionFailure("github_pr_evidence_missing");
  const commits = page.getByRole("link", { name: /^Commits(?:\s*\(?\d+\)?)?$/ });
  await expect(commits).toBeVisible();
  const commitsUrl = new URL(await commits.getAttribute("href") ?? "", pull.origin);
  if (commitsUrl.origin !== pull.origin || commitsUrl.pathname !== `${pull.pathname}/commits`) throw new ConnectionFailure("github_commits_navigation_missing");
  // Follow the rendered navigation link. A click immediately after PR creation
  // can be swallowed when GitHub replaces its server-rendered navigation.
  await page.goto(commitsUrl.href);
  const commit = page.getByRole("link", { name: /^[a-f0-9]{7,40}$/ }).last();
  await expect(commit).toBeVisible();
  const url = new URL(await commit.getAttribute("href") ?? "", pull.origin);
  const sha = /\/(?:commits?|changes)\/([a-f0-9]{40})$/.exec(url.pathname)?.[1];
  if (url.origin !== pull.origin || !sha || ![`/${repository}/commit/${sha}`, `${pull.pathname}/commits/${sha}`, `${pull.pathname}/changes/${sha}`].includes(url.pathname)) throw new ConnectionFailure("github_head_evidence_missing");
  const conversation = page.getByRole("link", { name: /^Conversation(?:\s*\(?\d+\)?)?$/ });
  await expect(conversation).toBeVisible();
  const conversationUrl = new URL(await conversation.getAttribute("href") ?? "", pull.origin);
  if (conversationUrl.origin !== pull.origin || conversationUrl.pathname !== pull.pathname) throw new ConnectionFailure("github_conversation_navigation_missing");
  await page.goto(conversationUrl.href);
  return sha;
}

export async function closeOwnedGitHubPullRequest(page: Page) {
  const closed = page.getByText("Closed", { exact: true }).first();
  if (!await closed.isVisible()) {
    await expect(page.getByRole("button", { name: /^(?:Merge status|Status)$/ })).toBeEnabled();
    await page.getByRole("button", { name: "Close pull request", exact: true }).click();
  }
  await expect(closed).toBeVisible({ timeout: 30_000 });
  const restored = page.getByRole("button", { name: "Restore branch", exact: true });
  if (!await restored.isVisible()) await page.getByRole("button", { name: "Delete branch", exact: true }).click();
  await expect(restored).toBeVisible({ timeout: 30_000 });
}
