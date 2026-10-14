import { expect, type Locator } from "@playwright/test";

/** Blocker replies include an explanation; ordinary marker-only replies do not. */
export async function assertNativeBlockerReply(agentReplies: Locator, marker: string, timeout = 30_000): Promise<void> {
  const reply = agentReplies.filter({ hasText: marker });
  await expect(reply).toHaveCount(1, { timeout });
  await expect(reply).toBeVisible({ timeout });
  await expect(reply).toContainText("Release Owner", { timeout });
  await expect(reply).toContainText("Grant deployment access", { timeout });
  await expect(reply).not.toContainText(
    /\b(?:not blocked|no longer blocked|access (?:is |has been |was )?already granted|completed Grant deployment access)\b/i,
    { timeout },
  );
  await expect(reply).toContainText(
    /\b(?:blocked|cannot proceed|can't proceed|missing|required access|not (?:yet )?granted|awaiting|waiting|unavailable)\b/i,
    { timeout },
  );
}
