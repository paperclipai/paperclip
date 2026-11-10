import { setTimeout as delay } from 'node:timers/promises';
import { withNativeMaintenanceBrowser } from './native-browser.js';

/** Actual Chromium visibility; never substitutes a fake document or frozen lifecycle. */
export async function observeMaintenanceBrowser(origin: string, announcementDescription?: string, tenantHeaders?: Record<string, string>) {
  return withNativeMaintenanceBrowser(async (browser, context) => {
    const unmatchedOrigins: string[] = [];
    if (tenantHeaders) {
      // Both HTTP and native WS need the simulated Cloud front door identity.
      // Gate every possible foreign transport BEFORE networking; no fixture
      // header can reach another origin. about:blank does not use networking.
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== origin) { unmatchedOrigins.push(route.request().url()); await route.abort('blockedbyclient'); return; }
        await route.continue();
      });
      await context.routeWebSocket(url => url.origin.replace(/^ws/, 'http') !== origin, route => {
        unmatchedOrigins.push(route.url()); route.close({ code: 1008, reason: 'Outside owned app origin' });
      });
      await context.setExtraHTTPHeaders(tenantHeaders);
    }
    const page = await context.newPage();
    const requests: Array<{ at: number; path: string }> = [];
    page.on('request', request => { const url = new URL(request.url()); if (url.origin === origin) requests.push({ at: performance.now(), path: url.pathname }); });
    await page.goto(origin, { waitUntil: 'networkidle' });
    if (announcementDescription) await page.getByText(announcementDescription, { exact: true }).waitFor({ state: 'visible' });
    await page.bringToFront();
    if (await page.evaluate(() => document.visibilityState) !== 'visible') throw new Error('Browser active-use observation requires a visible page');
    const beforeActive = requests.length;
    await page.reload({ waitUntil: 'networkidle' });
    if (!requests.slice(beforeActive).some(request => request.path.startsWith('/api/'))) throw new Error('Active browser did not make ordinary app requests');
    const visibilityEvents: Array<{ state: string; rendererAt: number }> = [];
    const prefix = 'paperclip-sleep-visibility:';
    page.on('console', message => { if (message.text().startsWith(prefix)) visibilityEvents.push(JSON.parse(message.text().slice(prefix.length))); });
    // Passive native events only; never replace document visibility properties.
    await page.evaluate(prefix => document.addEventListener('visibilitychange', () => console.log(prefix + JSON.stringify({ state: document.visibilityState, rendererAt: performance.now() }))), prefix);
    const visibility = () => page.evaluate(() => ({ state: document.visibilityState, focused: document.hasFocus(), rendererAt: performance.now(),
      ownVisibilityOverride: Boolean(Object.getOwnPropertyDescriptor(document, 'visibilityState')), ownHiddenOverride: Boolean(Object.getOwnPropertyDescriptor(document, 'hidden')),
      ownFocusOverride: Boolean(Object.getOwnPropertyDescriptor(document, 'hasFocus')) }));
    const initialVisibility = await visibility();
    if (initialVisibility.state !== 'visible') throw new Error('Native browser is not visible before the actual tab switch');
    const foreground = await context.newPage();
    await foreground.goto('about:blank'); await foreground.bringToFront();
    const native = await browser.newBrowserCDPSession();
    const windowIdentity = async (target: typeof page) => {
      const session = await context.newCDPSession(target);
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        const { windowId } = await native.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
        return { targetId: targetInfo.targetId, windowId };
      } finally { await session.detach(); }
    };
    const appWindow = await windowIdentity(page), foregroundWindow = await windowIdentity(foreground);
    if (appWindow.windowId !== foregroundWindow.windowId) throw new Error('Background browser qualification requires an actual same-window tab switch');
    const hiddenDeadline = performance.now() + 5_000;
    while (await page.evaluate(() => document.visibilityState) !== 'hidden') {
      if (performance.now() > hiddenDeadline) throw new Error('Browser could not establish a real background tab; visibility simulation is not qualification');
      await delay(50);
    }
    // Let requests already admitted by the transition settle before the untouched window.
    await delay(2_000);
    const initialHidden = await visibility();
    if (initialHidden.state !== 'hidden') throw new Error('Browser lost native hidden state during settling');
    if (!visibilityEvents.some(event => event.state === 'hidden' && event.rendererAt <= initialHidden.rendererAt)) throw new Error('Native hidden event was not observed');
    const hiddenRequests = requests.length, started = performance.now();
    await delay(90_000);
    const finalHidden = await visibility();
    const hiddenRealElapsedMs = performance.now() - started;
    if (hiddenRealElapsedMs < 90_000) throw new Error('Native hidden observation was shorter than 90 real seconds');
    const intervalVisibilityEvents = visibilityEvents.filter(event => event.rendererAt >= initialHidden.rendererAt && event.rendererAt <= finalHidden.rendererAt);
    if (finalHidden.state !== 'hidden' || intervalVisibilityEvents.some(event => event.state !== 'hidden')) throw new Error(`Browser left native hidden state: ${JSON.stringify({ initialHidden, finalHidden, intervalVisibilityEvents })}`);
    if ([initialVisibility, initialHidden, finalHidden].some(state => state.ownVisibilityOverride || state.ownHiddenOverride || state.ownFocusOverride)) throw new Error('Browser visibility or focus properties were overridden');
    const hidden = requests.slice(hiddenRequests);
    if (hidden.some(request => request.path.startsWith('/api/'))) throw new Error(`Background tab produced tenant traffic: ${JSON.stringify(hidden)}`);
    if (unmatchedOrigins.length) throw new Error(`Browser attempted non-owned transport: ${JSON.stringify(unmatchedOrigins)}`);
    await page.bringToFront(); const restoredVisibility = await visibility();
    if (restoredVisibility.state !== 'visible') throw new Error('Native app tab did not become visible after activation');
    if (!visibilityEvents.some(event => event.state === 'visible' && event.rendererAt >= finalHidden.rendererAt)) throw new Error('Native visible restoration event was not observed');
    return { activeRequests: requests.slice(beforeActive, hiddenRequests).length, hiddenRealElapsedMs,
      hiddenRequests: hidden, unmatchedOrigins, visibility: 'Native Chromium default context with no Playwright focus override', initialVisibility, initialHidden, finalHidden,
      intervalVisibilityEvents, visibilityEvents, restoredVisibility, appWindow, foregroundWindow, announcementRendered: Boolean(announcementDescription), authBoundary: tenantHeaders ? 'Owned Cloud front-door headers; actual tenant resolver/membership' : 'Legacy local board', closed: true };
  });
}
