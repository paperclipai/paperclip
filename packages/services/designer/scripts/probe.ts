#!/usr/bin/env -S node --import tsx
import { createBrowser } from '../browser.ts';

const cmd = process.argv[2];
const arg = process.argv[3];

const browser = createBrowser({ headed: true });

async function main(): Promise<void> {
  switch (cmd) {
    case 'login':
      console.log('Opening claude.ai/design in a headed browser window.');
      console.log('Complete Cloudflare + sign in. Session state auto-persists to ~/.agent-browser/.');
      await browser.open('https://claude.ai/design');
      break;
    case 'url':
      console.log(await browser.url());
      break;
    case 'title':
      console.log(await browser.title());
      break;
    case 'snapshot':
      console.log(await browser.snapshotText({ interactive: true, scope: arg }));
      break;
    case 'snapshot-json':
      console.log(JSON.stringify(await browser.snapshot({ interactive: true, scope: arg }), null, 2));
      break;
    case 'screenshot': {
      const p = arg || `./logs/probe-${Date.now()}.png`;
      await browser.screenshot(p, { full: true });
      console.log(p);
      break;
    }
    case 'eval':
      if (!arg) throw new Error('Usage: probe.ts eval <js>');
      console.log(await browser.eval(arg));
      break;
    case 'open':
      await browser.open(arg || 'https://claude.ai/design');
      console.log(await browser.url());
      break;
    case 'close':
      await browser.close();
      break;
    case 'tabs': {
      const tabs = await browser.tabs();
      const composer = '[data-testid="chat-composer-input"]';
      const signedIn = '[data-testid="create-project-button"]';
      for (const t of tabs) {
        await browser.activateTab(t.index).catch(() => null);
        const composerOk = await browser.isVisible(composer).catch(() => false);
        const signedInOk = await browser.isVisible(signedIn).catch(() => false);
        const flag = composerOk ? 'composer' : signedInOk ? 'home' : 'unrecognized';
        console.log(`[${t.index}] active=${t.active ? 'Y' : 'N'} ${flag.padEnd(12)} ${t.url}`);
      }
      break;
    }
    default:
      console.log(`Usage:
  probe.ts login                  open headed window for manual login
  probe.ts open <url>             navigate
  probe.ts url                    print current url
  probe.ts title                  print current title
  probe.ts tabs                   list CDP tabs with readiness verdict
  probe.ts snapshot [scope]       interactive a11y tree (text)
  probe.ts snapshot-json [scope]  interactive a11y tree (JSON)
  probe.ts screenshot [path]      full-page screenshot
  probe.ts eval <js>              evaluate JS in page
  probe.ts close                  close browser`);
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
