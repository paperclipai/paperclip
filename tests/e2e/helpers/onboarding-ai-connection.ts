import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

/** First-task tests exercise the real wizard and hire/task APIs with an inert
 * adapter. Simulate successful provider authentication without using host auth. */
export async function mockOnboardingLocalAiConnection(page: Page) {
  const connectionId = randomUUID();
  const grantId = randomUUID();
  const sessionId = randomUUID();
  await page.route("**/ai-connections/local/attempts", route => route.fulfill({ status: 201, json: {
    sessionId, expiresAt: "2099-01-01T00:00:00Z",
  } }));
  await page.route("**/ai-connections/local/check", route => route.fulfill({ json: { status: "ready" } }));
  await page.route("**/ai-connections/local/attempts/*", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/ai-connections/local", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toMatchObject({ method: "subscription", ownership: "personal" });
    await route.fulfill({ json: { connectionId, grantId } });
  });
  await page.route("**/ai-connections/default", async (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postDataJSON()).toEqual({ grantId });
    await route.fulfill({ json: { ok: true } });
  });
}
