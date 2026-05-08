/**
 * BBA Session Login Script
 * Clones the BBA Chromium profile to a temp dir, opens it headed for manual login,
 * detects login via CDP, saves cookies to cache. No profile lock conflicts.
 * Usage: npx tsx scripts/bba-login.mjs
 */
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const PROFILE_DIR  = "C:\\Users\\thepr\\.paperclip\\bba-playwright-profile";
const COOKIE_CACHE = path.join(os.homedir(), ".paperclip", "bba-cookie-cache.json");
const CASA_URL     = "https://www.casapariurilor.ro";
const LOGIN_BTN    = ".header-login-wrapper.user-box-link";
const CDP_PORT     = 9244;

async function clearProfileLocks(dir) {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { await fs.unlink(path.join(dir, name)); } catch { /* ignore */ }
  }
}

console.log("=".repeat(60));
console.log("  BBA Session Login — casapariurilor.ro");
console.log("=".repeat(60));
console.log("");
console.log(`Profile: ${PROFILE_DIR}`);
console.log(`Cache:   ${COOKIE_CACHE}`);
console.log("");
console.log("Instructiuni:");
console.log("  1. Se deschide browserul cu profilul BBA pe casapariurilor.ro");
console.log("  2. Apasa CONECTARE si logheaza-te (username + parola)");
console.log("  3. Bifeaza 'Tine-ma minte' daca exista optiunea");
console.log("  4. Scriptul detecteaza automat login-ul si salveaza sesiunea");
console.log("");

// Clone the BBA profile to temp — avoids profile lock conflict with keepalive
const cloneDir = path.join(os.tmpdir(), `bba-login-clone-${Date.now()}`);
console.log("Clonez profilul BBA in temp...");

try {
  await fs.cp(PROFILE_DIR, cloneDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const base = path.basename(src).toLowerCase();
      // Skip lock files and caches — same logic as BBA's cloneUserDataDir
      return !["singletonlock", "singletoncookie", "singletonsocket",
               "cache", "code cache", "gpucache", "dawncache"].includes(base);
    },
  });
} catch (err) {
  // Best-effort if some files can't be copied (locked by OS)
  console.log("  (unele fisiere nu au putut fi copiate — continuu)");
}

await clearProfileLocks(cloneDir);
console.log("Clone gata. Pornesc browserul...");
console.log("");

const pwChromiumPath = chromium.executablePath();

const chromiumProc = spawn(
  pwChromiumPath,
  [
    `--user-data-dir=${cloneDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--window-size=1280,800",
    CASA_URL,
  ],
  { stdio: "ignore", windowsHide: false, detached: false },
);

chromiumProc.on("exit", (code) => {
  if (code && code !== 0 && code !== 21) {
    process.stderr.write(`\nChromium exit code: ${code}\n`);
  }
});

// Poll CDP — cloned profile starts quickly
let browser = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1_000));
  if (chromiumProc.exitCode !== null) {
    console.error("❌ Chromium s-a inchis prematur (exit:", chromiumProc.exitCode, ")");
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
    process.exit(1);
  }
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    break;
  } catch {
    process.stdout.write(".");
  }
}
console.log("");

if (!browser) {
  console.error("❌ Nu s-a putut conecta via CDP dupa 20s.");
  try { chromiumProc.kill(); } catch { /* ignore */ }
  await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(1);
}

const ctx = browser.contexts()[0];
const page = ctx?.pages()[0] ?? await ctx?.newPage();

if (!page) {
  console.error("❌ Nu s-a putut accesa pagina browser-ului.");
  try { chromiumProc.kill(); } catch { /* ignore */ }
  process.exit(1);
}

// Force fresh login — clear cookies + localStorage so user MUST enter credentials
// (Profile cache may show "logged in" but server session is expired)
console.log("Curatare sesiune veche...");
try {
  await ctx.clearCookies();
  await page.goto(CASA_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.evaluate(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
} catch { /* ignore navigation errors */ }

console.log("Gata. Acum logheaza-te cu credentialele tale in browser.");
console.log("(Ctrl+C pentru a anula)");
console.log("");

const MAX_MS  = 5 * 60 * 1000;
const POLL_MS = 2_000;
const start   = Date.now();
let saved = false;

while (Date.now() - start < MAX_MS) {
  if (chromiumProc.exitCode !== null) {
    console.log("\nBrowserul a fost inchis.");
    break;
  }

  try {
    const currentPage = ctx.pages()[0];
    if (!currentPage) { await new Promise((r) => setTimeout(r, POLL_MS)); continue; }

    const url = currentPage.url();
    if (!url.includes("casapariurilor")) {
      await new Promise((r) => setTimeout(r, POLL_MS)); continue;
    }

    const loginBtnVisible = await currentPage
      .locator(LOGIN_BTN)
      .isVisible({ timeout: 1_500 })
      .catch(() => true);

    if (!loginBtnVisible) {
      // Logged in — extract cookies while browser is open (captures PREMATCH_SESSION)
      const state = await ctx.storageState();

      await fs.mkdir(path.dirname(COOKIE_CACHE), { recursive: true });
      await fs.writeFile(COOKIE_CACHE, JSON.stringify(state, null, 2), "utf8");

      const casaCookies = state.cookies.filter((c) => c.domain.includes("casapariurilor"));
      const persistent  = casaCookies.filter((c) => c.expires > 0);
      const sessionOnly = casaCookies.filter((c) => c.expires === -1);

      console.log("✅ Login detectat! Cookies salvate:");
      console.log(`   Total site:   ${casaCookies.length}`);
      console.log(`   Persistente:  ${persistent.length}`);
      console.log(`   De sesiune:   ${sessionOnly.length}`);

      if (persistent.length > 0) {
        const maxExp = Math.max(...persistent.map((c) => c.expires));
        console.log(`   Expira:       ${new Date(maxExp * 1000).toLocaleDateString("ro-RO")}`);
        console.log("");
        console.log("✅ Sesiunea va fi mentinuta automat de keepalive (30 min).");
      } else {
        console.log("");
        console.log("⚠️  Nu s-au detectat cookie-uri persistente.");
        console.log("   Bifeaza 'Tine-ma minte' la urmatorule login.");
      }

      saved = true;
      console.log("");
      console.log("Inchid browserul automat in 10 secunde...");
      await new Promise((r) => setTimeout(r, 10_000));
      break;
    }
  } catch {
    // navigating
  }

  await new Promise((r) => setTimeout(r, POLL_MS));
}

try { await browser.close(); } catch { /* ignore */ }
try { chromiumProc.kill(); }   catch { /* ignore */ }
await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);

if (!saved) {
  console.log("❌ Sesiunea NU a fost salvata — nu s-a detectat login in browser.");
  process.exitCode = 1;
}
