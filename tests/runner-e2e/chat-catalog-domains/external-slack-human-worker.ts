import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, test } from "@playwright/test";
import {
  validSlackHumanConnect,
  type SlackHumanConnectInput,
} from "./external-slack-human-contract.js";
/** No Playwright Test worker/report/artifact listener is attached. Never emits
 * screenshots, trace, cookies, browser state, profile or provider response data. */
async function main() {
  let attached = false;
  try {
    test.info();
    attached = true;
  } catch {
    /* standalone */
  }
  if (attached)
    throw new Error("Private Slack operation cannot run within Test");
  const input = JSON.parse(
    await readFile(process.argv[2]!, "utf8"),
  ) as SlackHumanConnectInput & { executablePath?: string; channel?: string };
  if (!validSlackHumanConnect(input))
    throw new Error("Invalid finite Slack human operation");
  const browser = await chromium.launch({
    headless: true,
    ...(input.executablePath ? { executablePath: input.executablePath } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
  });
  try {
    const storage = path.join(path.dirname(process.argv[2]!), "storage.json");
    await writeFile(storage, JSON.stringify(input.session), { mode: 0o600 });
    const context = await browser.newContext({ storageState: storage });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "https://app.slack.com",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(
      `https://app.slack.com/client/${input.workspaceId}/${input.channelId}`,
      { waitUntil: "domcontentloaded" },
    );
    const target = () => {
      const url = new URL(page.url());
      return (
        url.origin === "https://app.slack.com" &&
        url.pathname === `/client/${input.workspaceId}/${input.channelId}`
      );
    };
    if (!target())
      throw new Error(
        "Slack browser did not retain the exact selected workspace/channel",
      );
    // These are actual user controls, not a display-name identity assertion. The
    // copied member ID must equal independent official auth.test/users.info IDs.
    await page
      .getByRole("button", {
        name: /^(Your profile|Your profile and preferences|Profile and preferences)$/i,
      })
      .click();
    await page
      .getByRole("menuitem", { name: /^(Profile|View profile)$/i })
      .click();
    const panel = page
      .locator('[data-qa="flexpane"], [role="complementary"], [role="dialog"]')
      .filter({
        has: page.getByRole("button", { name: /^More(?: actions)?$/i }),
      });
    if ((await panel.count()) !== 1)
      throw new Error(
        "Slack own-profile controls are not uniquely inspectable",
      );
    await panel.getByRole("button", { name: /^More(?: actions)?$/i }).click();
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.getByRole("menuitem", { name: /^Copy member ID$/i }).click();
    const actualUserId = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    if (actualUserId !== input.senderUserId || !target())
      throw new Error(
        "Actual signed-in Slack human does not match selected provider identity",
      );
    await page.keyboard.press("Escape");
    if (input.operation === "retry-callback") {
      await page.goto(
        `https://api.slack.com/apps/${input.appId}/event-subscriptions`,
        { waitUntil: "domcontentloaded" },
      );
      const appURL = new URL(page.url());
      if (
        appURL.origin !== "https://api.slack.com" ||
        appURL.pathname !== `/apps/${input.appId}/event-subscriptions`
      )
        throw new Error(
          "Slack app settings did not retain the exact authorized app",
        );
      const field = page.getByLabel("Request URL", { exact: true });
      await field.waitFor();
      if ((await field.inputValue()) !== input.callbackURL)
        throw new Error(
          "Slack's saved Request URL differs from the actual owned Paperclip endpoint",
        );
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      if (await retry.isVisible()) await retry.click();
      else {
        await field.fill("");
        await field.fill(input.callbackURL!);
      }
      await page.getByText("Verified", { exact: true }).waitFor();
      if ((await field.inputValue()) !== input.callbackURL)
        throw new Error(
          "Slack callback validation changed the saved destination",
        );
      const save = page.getByRole("button", {
        name: "Save Changes",
        exact: true,
      });
      if ((await save.isVisible()) && (await save.isEnabled()))
        await save.click();
      return {
        processIsolation: true,
        testRunnerAttached: false,
        tracingEnabled: false,
        videoEnabled: false,
        verifiedWorkspaceId: input.workspaceId,
        verifiedHumanId: actualUserId,
        callbackRetryRequested: true,
      };
    }
    const composer = page.getByRole("textbox", {
      name: new RegExp(`^Message #?${input.channelName}$`, "i"),
    });
    if ((await composer.count()) !== 1)
      throw new Error(
        "Slack named channel composer is unavailable or ambiguous",
      );
    if ((await composer.innerText()).trim())
      throw new Error(
        "Slack composer has an existing draft; finite fixture will not overwrite it",
      );
    const command = `${input.command} connect`;
    await composer.fill(command);
    if ((await composer.innerText()).trim() !== command || !target())
      throw new Error(
        "Slack composer differs from the exact saved app connect command",
      );
    await composer.press("Enter");
    await composer.filter({ hasText: command }).waitFor({ state: "hidden" });
    return {
      processIsolation: true,
      testRunnerAttached: false,
      tracingEnabled: false,
      videoEnabled: false,
      verifiedWorkspaceId: input.workspaceId,
      verifiedHumanId: actualUserId,
      commandSubmitted: true,
    };
  } finally {
    await browser.close();
  }
}
main()
  .then((receipt) => process.stdout.write(JSON.stringify(receipt)))
  .catch(() => {
    process.stderr.write(
      "Private Slack human operation failed; details withheld\n",
    );
    process.exitCode = 1;
  });
