import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

/** First-task tests exercise the real wizard and hire/task APIs with an inert
 * adapter. Simulate successful provider authentication without using host auth. */
export async function mockOnboardingLocalAiConnection(page: Page) {
  const connectionId = randomUUID();
  const grantId = randomUUID();
  await page.route("**/ai-connections/local", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toMatchObject({ method: "subscription", ownership: "personal" });
    await route.fulfill({ json: { connectionId, grantId } });
  });
}
