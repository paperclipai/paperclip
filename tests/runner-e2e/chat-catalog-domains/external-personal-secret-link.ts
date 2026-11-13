import type { Locator, Page } from "@playwright/test";
import { followSecretSetupLink, supportedSecretSettingsLink as supportedLink } from "./external-secret-setup-link.js";

/**
 * Grade a personal-secret setup reply by its rendered link, never by its
 * wording: clicking it, as a person would, must reach the current person's
 * own-value entry for the required definition.
 */
export interface PersonalSecretReplyLinkProof {
  commentId: string;
  /** The rendered link's resolved target, as the person's click followed it. */
  route: string;
  linkText: string;
  reachedOwnValueEntry: true;
  definitionKey: string;
}

/** A rendered link target is supported only for this origin and company's secrets settings. */
export function supportedSecretSettingsLink(href: string | null, origin: string, prefix: string, definitionId: string): string | undefined {
  return supportedLink(href, origin, prefix, definitionId);
}

/**
 * The own-value entry is "Set my value" in the detail sheet a definition link
 * opens, or "Set value" on the definition's row in My secrets.
 */
export async function followPersonalSecretReplyLink(page: Page, input: {
  commentId: string; origin: string; prefix: string; definitionId: string; definitionKey: string; timeout: number;
}): Promise<PersonalSecretReplyLinkProof | undefined> {
  const proof = await followSecretSetupLink(page, {
    commentId: input.commentId, origin: input.origin, prefix: input.prefix, timeout: input.timeout, definitionId: input.definitionId,
    entry: async (route, remaining): Promise<Locator> => {
      if (route.searchParams.get("definition") === input.definitionId) {
        // A link naming the definition opens its detail sheet, whose own-value action is "Set my value".
        const sheet = page.locator('[data-testid="secret-details"]').filter({ has: page.getByText(input.definitionKey, { exact: true }) });
        return sheet.getByRole("button", { name: "Set my value", exact: true });
      }
      const tab = page.getByRole("tab", { name: "My secrets", exact: true });
      await tab.waitFor({ state: "visible", timeout: remaining() }).catch(() => undefined);
      if (await tab.count() === 1 && await tab.getAttribute("aria-selected") !== "true") await tab.click({ timeout: remaining() });
      // The row is bound to the required definition by its identity, and shows its key.
      const row = page.locator(`[data-testid=${JSON.stringify(`my-secret-${input.definitionId}`)}]`)
        .filter({ has: page.getByText(input.definitionKey, { exact: true }) });
      return row.getByRole("button", { name: "Set value", exact: true });
    },
  });
  return proof && { ...proof, reachedOwnValueEntry: true, definitionKey: input.definitionKey };
}
