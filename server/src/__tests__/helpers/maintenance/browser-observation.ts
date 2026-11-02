import { setTimeout as delay } from 'node:timers/promises';

/** Actual Chromium visibility; never substitutes a fake document or frozen lifecycle. */
export async function observeMaintenanceBrowser(origin: string) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests: Array<{ at: number; path: string }> = [];
    page.on('request', request => { const url = new URL(request.url()); if (url.origin === origin) requests.push({ at: performance.now(), path: url.pathname }); });
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.bringToFront();
    if (await page.evaluate(() => document.visibilityState) !== 'visible') throw new Error('Browser active-use observation requires a visible page');
    const beforeActive = requests.length;
    await page.reload({ waitUntil: 'networkidle' });
    if (!requests.slice(beforeActive).some(request => request.path.startsWith('/api/'))) throw new Error('Active browser did not make ordinary app requests');
    const foreground = await context.newPage();
    await foreground.goto('about:blank'); await foreground.bringToFront();
    const hiddenDeadline = performance.now() + 5_000;
    while (await page.evaluate(() => document.visibilityState) !== 'hidden') {
      if (performance.now() > hiddenDeadline) throw new Error('Browser could not establish a real background tab; visibility simulation is not qualification');
      await delay(50);
    }
    // Let requests already admitted by the transition settle before the untouched window.
    await delay(2_000);
    const hiddenRequests = requests.length, started = performance.now();
    await delay(90_000);
    const hidden = requests.slice(hiddenRequests);
    if (hidden.some(request => request.path.startsWith('/api/'))) throw new Error(`Background tab produced tenant traffic: ${JSON.stringify(hidden)}`);
    const result = { activeRequests: requests.slice(beforeActive, hiddenRequests).length, hiddenRealElapsedMs: performance.now() - started,
      hiddenRequests: hidden, visibility: 'actual Chromium foreground/background tabs', closed: true };
    await context.close();
    return result;
  } finally { await browser.close(); }
}
