import { test, expect } from "@playwright/test";
import { createMarketingWorkspace } from "./helpers/marketing-workspace";
import { instrumentNavLog } from "./helpers/onboarding-landing";

// Marketing onboarding leaves the first task and agent to the user. Retain
// the route-selection race check when another workspace already exists.
for (const seedExisting of [false, true]) {
  test('workspace onboarding stays on explicit agent setup (existing=' + seedExisting + ')', async ({ page }) => {
    if (seedExisting) {
      const response = await page.request.post('/api/companies', { data: { name: 'Existing-' + Date.now() } });
      expect(response.ok()).toBe(true);
    }
    await instrumentNavLog(page);
    const workspace = await createMarketingWorkspace(page, 'Explicit-setup-' + Date.now());
    await expect(page.getByRole('button', { name: 'Choose adapter', exact: true })).toBeDisabled();
    const navigation = await page.evaluate(() => (window as unknown as { __navLog: string[] }).__navLog);
    expect(navigation.filter(route => route.endsWith('/dashboard'))).toEqual([]);
    for (const collection of ['agents', 'issues']) {
      const response = await page.request.get('/api/companies/' + workspace.id + '/' + collection);
      expect(response.ok()).toBe(true);
      expect(await response.json()).toEqual([]);
    }
  });
}
