import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { Locator } from "@playwright/test";
import { ConnectionBlock } from "./connection-config.js";
import { connectionDelay } from "./connection-target.js";

/** An attended operator can use the QA browser or confirm its displayed action
 * in this run's terminal. Approval is never saved in the reusable profile. */
export async function attendGitHubJourneyAction(input: {
  control: Locator; action: "create-app" | "install-app"; appName: string;
  signal: AbortSignal; timeoutMs: number;
}, operatorInput: Readable & { isTTY?: boolean } = process.stdin) {
  const command = `${input.action} ${input.appName}`;
  const terminal = operatorInput.isTTY ? createInterface({ input: operatorInput, terminal: false }) : undefined;
  let confirmed = false;
  terminal?.on("line", line => { if (line.trim() === command) confirmed = true; });
  console.log(`[github-review-journey] Inspect the displayed App permissions. Complete the action in the QA browser${terminal ? `, or type exactly: ${command}` : "."}`);
  const deadline = Date.now() + input.timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (input.signal.aborted) throw new ConnectionBlock("blocked_target", "journey_interrupted");
      if (!await input.control.isVisible()) return;
      if (confirmed) {
        await input.control.click();
        return;
      }
      await connectionDelay(500);
    }
    throw new ConnectionBlock("awaiting_user", `${input.action.replaceAll("-", "_")}_consent_required`);
  } finally { terminal?.close(); }
}
