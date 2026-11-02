export default (ctx) => `#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const THEMES = ["dark", "light"];

const HELP = \`Usage:
  node ${ctx.labDir}/shot.cjs --port <p> --d <kit|all> --out <dir> [--s <surfaces,board>] [--theme <themes>] [--hover]

  --port   port of a running lab dev server (required)
  --d      a direction id | all   (default: today; the ids come from the page's window.__LAB__)
           "all" captures every kit; for the board it composes the one all-kits sheet
  --out    output directory (required; created if missing)
  --s      comma-separated surfaces and/or board   (default: every surface and the board)
  --theme  comma-separated: \${THEMES.join(",")}   (default: both)
  --hover  also capture each surface with the first kit button hovered (no reduced motion)

Start the dev server first (it is not started for you):
  cd ui && npx vite --config ${ctx.configFile} --port <p> --strictPort
\`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--hover") args.hover = true;
    else if (token.startsWith("--")) {
      const [key, inline] = token.slice(2).split("=");
      args[key] = inline ?? argv[(i += 1)];
    }
  }
  return args;
}

function list(value, allowed, name) {
  if (!value) return allowed;
  const picked = value.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = picked.filter((item) => !allowed.includes(item));
  if (unknown.length > 0) fail(\`Unknown \${name}: \${unknown.join(", ")} (expected \${allowed.join(", ")})\`);
  return picked;
}

function fail(message) {
  console.error(\`shot: \${message}\\n\`);
  console.error(HELP);
  process.exit(2);
}

function loadChromium() {
  for (const name of ["@playwright/test", "playwright"]) {
    try {
      return require(name).chromium;
    } catch {
      continue;
    }
  }
  throw new Error("Playwright is not installed (looked for @playwright/test and playwright). Run pnpm install.");
}

async function settleFrame() {
  for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = "eager";
  await document.fonts.ready;
  const quiet = () =>
    new Promise((resolve) => {
      let timer = setTimeout(done, 400);
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, 400);
      });
      function done() {
        observer.disconnect();
        resolve();
      }
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  await quiet();
  await Promise.all(
    [...document.images].map((img) =>
      img.complete ? null : new Promise((resolve) => ["load", "error"].forEach((type) => img.addEventListener(type, resolve, { once: true }))),
    ),
  );
  await Promise.all(
    [...document.querySelectorAll("video")].map((video) =>
      video.readyState >= 2 ? null : new Promise((resolve) => {
        ["loadeddata", "error"].forEach((type) => video.addEventListener(type, resolve, { once: true }));
        setTimeout(resolve, 3500);
      }),
    ),
  );
  await quiet();
}

function watch(page) {
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(\`console error: \${message.text()}\`);
  });
  page.on("pageerror", (error) => problems.push(\`page error: \${error.message}\`));
  page.on("requestfailed", (request) => problems.push(\`request failed: \${request.url()} (\${request.failure()?.errorText ?? "unknown"})\`));
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(\`HTTP \${response.status()}: \${response.url()}\`);
  });
  return problems;
}

async function discoverLab(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(\`\${base}/?chrome=0\`, { waitUntil: "networkidle", timeout: 120000 });
  const lab = await page.evaluate(() => window.__LAB__);
  await context.close();
  if (!lab) throw new Error(\`page did not expose window.__LAB__; main.tsx did not run, read the console\${problems.length ? \`:\\n  \${problems.join("\\n  ")}\` : ""}\`);
  return lab;
}

const shotUrl = (base, shot) => \`\${base}/?d=\${shot.kit}&s=\${shot.surface}&theme=\${shot.theme}&chrome=0\`;

async function capture(browser, base, shot, outDir) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(shotUrl(base, shot), { waitUntil: "networkidle", timeout: 120000 });
  for (const frame of page.frames()) await frame.evaluate(settleFrame);
  const file = path.join(outDir, \`\${shot.kit}__\${shot.surface}__\${shot.theme}.png\`);
  await page.screenshot({ path: file, fullPage: true });
  await context.close();
  return { file, problems };
}

async function captureHover(browser, base, shot, outDir) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(shotUrl(base, shot), { waitUntil: "networkidle", timeout: 120000 });
  for (const frame of page.frames()) await frame.evaluate(settleFrame);
  const target = page.locator("[data-direction] button").first();
  const file = path.join(outDir, \`\${shot.kit}__\${shot.surface}__\${shot.theme}__hover.png\`);
  if ((await target.count()) === 0) problems.push(\`no button inside [data-direction] to hover at \${shotUrl(base, shot)}\`);
  else {
    await target.hover();
    await page.waitForTimeout(350);
    await page.screenshot({ path: file, fullPage: true });
  }
  await context.close();
  return { file, problems };
}

async function captureBoard(browser, base, lab, kit, theme, outDir) {
  const kits = kit === "all" ? lab.directions : [kit];
  const problems = [];
  for (const k of kits) {
    for (const surface of lab.surfaces) {
      if (fs.existsSync(path.join(outDir, \`\${k}__\${surface}__\${theme}.png\`))) continue;
      const result = await capture(browser, base, { kit: k, surface, theme }, outDir);
      problems.push(...result.problems);
    }
  }
  const dark = theme === "dark";
  const tile = (k, surface) => \`<figure style="height:1100px"><img src="\${k}__\${surface}__\${theme}.png" alt="\${k} \${surface}"></figure>\`;
  const rows = kits.map((k) => \`<section><h2>\${lab.names[k]}</h2>\${lab.surfaces.map((surface) => tile(k, surface)).join("")}</section>\`).join("");
  const heads = lab.surfaces.map((surface) => \`<span>\${lab.labels[surface]}</span>\`).join("");
  const html = \`<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:32px;background:\${dark ? "#0f0f0f" : "#e9e9e9"};color:\${dark ? "#f5f5f5" : "#171717"};font:600 22px/1.2 Inter,system-ui,sans-serif}
    header,section{display:grid;grid-template-columns:150px repeat(\${lab.surfaces.length},minmax(0,1fr));gap:16px;align-items:start}
    header{font:500 13px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;opacity:.6;margin-bottom:12px}
    section{margin-bottom:32px}h2{margin:0;font:inherit}
    figure{margin:0;overflow:hidden;border-radius:6px;outline:1px solid \${dark ? "#ffffff1f" : "#0000001f"}}
    img{display:block;width:100%}
  </style><header><span>\${theme}</span>\${heads}</header>\${rows}\`;
  const sheet = path.join(outDir, \`.board-\${kit}-\${theme}.html\`);
  fs.writeFileSync(sheet, html);
  const context = await browser.newContext({ viewport: { width: 2880, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(\`file://\${sheet}\`, { waitUntil: "load" });
  const file = path.join(outDir, \`\${kit}__board__\${theme}.png\`);
  await page.screenshot({ path: file, fullPage: true });
  await context.close();
  fs.unlinkSync(sheet);
  return { file, problems };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.port) fail("--port is required");
  if (!args.out) fail("--out is required");
  const base = \`http://127.0.0.1:\${args.port}\`;
  const browser = await loadChromium().launch({ headless: true });
  let failed = 0;
  let shots = [];
  try {
    const lab = await discoverLab(browser, base);
    const kit = args.d ?? "today";
    if (kit !== "all" && !lab.directions.includes(kit)) fail(\`Unknown --d: \${kit} (expected \${lab.directions.join(", ")} or all)\`);
    const views = list(args.s, [...lab.surfaces, "board"], "surface");
    const themes = list(args.theme, THEMES, "theme");
    for (const surface of [...views.filter((s) => s !== "board"), ...views.filter((s) => s === "board")]) {
      const kits = kit === "all" && surface !== "board" ? lab.directions : [kit];
      for (const k of kits) for (const theme of themes) shots.push({ kit: k, surface, theme });
    }
    const outDir = path.resolve(args.out);
    fs.mkdirSync(outDir, { recursive: true });
    for (const shot of shots) {
      const results = [];
      if (shot.surface === "board") results.push(await captureBoard(browser, base, lab, shot.kit, shot.theme, outDir));
      else {
        results.push(await capture(browser, base, shot, outDir));
        if (args.hover) results.push(await captureHover(browser, base, shot, outDir));
      }
      for (const { file, problems } of results) {
        console.log(\`\${problems.length > 0 ? "FAIL" : "ok  "} \${file}\`);
        for (const problem of [...new Set(problems)]) console.log(\`       \${problem}\`);
        if (problems.length > 0) failed += 1;
      }
    }
  } finally {
    await browser.close();
  }
  if (failed > 0) {
    console.error(\`\\nshot: \${failed} capture(s) reported errors.\`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(\`shot: \${error.message}\`);
  process.exit(1);
});
`;
