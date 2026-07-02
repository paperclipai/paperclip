import { chromium } from '/srv/paperclip/app/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'wireframes');
const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'png');
await fs.mkdir(out, { recursive: true });

const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.svg')).sort();
const browser = await chromium.launch({ executablePath: '/srv/paperclip/home/.cache/ms-playwright/chromium-1223/chrome-linux/chrome' });
const page = await browser.newPage({ deviceScaleFactor: 2 });
for (const f of files) {
  const svg = await fs.readFile(path.join(dir, f), 'utf8');
  const m = svg.match(/width="(\d+)"\s+height="(\d+)"/);
  const w = m ? Number(m[1]) : 1280;
  const h = m ? Number(m[2]) : 880;
  await page.setViewportSize({ width: w, height: h });
  const html = `<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`;
  await page.setContent(html, { waitUntil: 'load' });
  const target = path.join(out, f.replace(/\.svg$/, '.png'));
  await page.screenshot({ path: target, fullPage: false, omitBackground: false, clip: { x: 0, y: 0, width: w, height: h } });
  console.log('wrote', target);
}
await browser.close();
