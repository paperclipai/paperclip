import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, BrowserContext } from '@playwright/test';

/** A fresh owned browser, not a user's profile. Never terminate by process name. */
export async function withNativeMaintenanceBrowser<T>(run: (browser: Browser, context: BrowserContext) => Promise<T>): Promise<T> {
  const { chromium } = await import('@playwright/test');
  const profile = await mkdtemp(path.join(tmpdir(), 'paperclip-sleep-browser-'));
  let child: ChildProcess | undefined, browser: Browser | undefined, exited: Promise<void> | undefined;
  let exitObserved = false, launchError: Error | undefined, stderr = '', failure: { error: unknown } | undefined;
  try {
    child = spawn(chromium.executablePath(), [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const ownedChild = child;
    exited = new Promise<void>(resolve => {
      ownedChild.once('exit', () => { exitObserved = true; resolve(); });
      ownedChild.once('error', error => { launchError = error; if (!ownedChild.pid) resolve(); });
    });
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16_384); });
    const deadline = performance.now() + 10_000;
    let port: number | undefined;
    while (!port) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null || performance.now() > deadline) throw new Error(`Owned Chromium startup failed: ${stderr}`);
      try {
        const candidate = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        if (Number.isInteger(candidate) && candidate > 0 && candidate < 65536) port = candidate;
      } catch { /* The owned startup file is not ready yet. */ }
      if (!port) await delay(50);
    }
    // Playwright1.62 installs focus emulation on normal pages. Measured native
    // tab switches stayed visible there. The supported noDefaults/default-context
    // path avoids installing that override (types.d.ts ConnectOverCDPOptions).
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 10_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Owned Chromium has no native default context');
    return await run(browser, context);
  } catch (error) { failure = { error }; throw error; }
  finally {
    const errors: unknown[] = [];
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([browser?.close(), new Promise<never>((_, reject) => { disconnectTimer = setTimeout(() => reject(new Error('Owned browser disconnect timed out')), 5_000); })]);
    } catch (error) { errors.push(error); }
    finally { if (disconnectTimer) clearTimeout(disconnectTimer); }
    if (child && exited) {
      const waitExit = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([exited!.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5_000); })]); }
        finally { if (timer) clearTimeout(timer); }
      };
      try {
        if (child.exitCode === null && child.signalCode === null && !launchError) child.kill('SIGTERM');
        if (!(await waitExit())) { child.kill('SIGKILL'); if (!(await waitExit())) throw new Error('Owned Chromium did not exit after termination'); }
      } catch (error) { errors.push(error); }
    }
    if (!child?.pid || exitObserved) {
      try { await rm(profile, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    } else errors.push(new Error(`Owned Chromium exit was not confirmed; profile preserved at ${profile}`));
    if (errors.length) throw new AggregateError([...(failure ? [failure.error] : []), ...errors], 'Native browser work or cleanup failed');
  }
}
