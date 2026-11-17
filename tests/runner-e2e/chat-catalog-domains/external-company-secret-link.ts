import type { Page } from "@playwright/test";
import { followSecretSetupLink, type SecretSetupLinkProof } from "./external-secret-setup-link.js";

/**
 * Grade a company-secret setup reply by its rendered link, never by its
 * wording: clicking it, as a person would, must reach the organization
 * secret entry ("New secret" on the company Secrets tab).
 */
export interface CompanySecretReplyLinkProof extends SecretSetupLinkProof {
  reachedSecretEntry: true;
}

export async function followCompanySecretReplyLink(page: Page, input: {
  commentId: string; origin: string; prefix: string; timeout: number;
}): Promise<CompanySecretReplyLinkProof | undefined> {
  const proof = await followSecretSetupLink(page, {
    ...input,
    entry: async (_route, remaining) => {
      const tab = page.getByRole("tab", { name: "Secrets", exact: true });
      await tab.waitFor({ state: "visible", timeout: remaining() }).catch(() => undefined);
      if (await tab.count() === 1 && await tab.getAttribute("aria-selected") !== "true") await tab.click({ timeout: remaining() });
      return page.getByRole("button", { name: "New secret", exact: true }).first();
    },
  });
  return proof && { ...proof, reachedSecretEntry: true };
}
