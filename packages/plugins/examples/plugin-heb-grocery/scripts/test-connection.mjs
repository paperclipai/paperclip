/**
 * HEB Grocery Plugin — Connection Test Script
 *
 * Tests your HEB credentials end-to-end before installing the plugin.
 * Set the environment variables below, then run:
 *
 *   HEB_ACCESS_TOKEN="..." \
 *   HEB_STORE_NUMBER="790" \
 *   node packages/plugins/examples/plugin-heb-grocery/scripts/test-connection.mjs
 *
 * Optional env vars:
 *   HEB_REFRESH_TOKEN   — refresh token (recommended)
 *   HEB_ID_TOKEN        — ID token
 *   HEB_COOKIES         — raw cookie string for cart/shopping list tests
 *                         e.g. "sat=ABC; reese84=XYZ; incap_ses=QRS"
 */

const {
  createTokenSession,
  createSessionFromCookies,
  getAccountDetails,
  getWeeklyAdProducts,
  formatWeeklyAd,
  getCart,
  formatCart,
  setStore,
  isSessionValid,
  getSessionInfo,
} = await import("heb-sdk-unofficial");

const ACCESS_TOKEN = process.env.HEB_ACCESS_TOKEN ?? "";
const REFRESH_TOKEN = process.env.HEB_REFRESH_TOKEN;
const ID_TOKEN = process.env.HEB_ID_TOKEN;
const STORE_NUMBER = process.env.HEB_STORE_NUMBER ?? "790";
const COOKIES = process.env.HEB_COOKIES;

let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log("  ✓ " + label);
}

function fail(label, err) {
  failed++;
  console.log("  ✗ " + label);
  console.log("    " + (err?.message ?? err));
}

function section(title) {
  console.log();
  console.log("── " + title);
}

console.log("=".repeat(60));
console.log("HEB Grocery Plugin — Connection Test");
console.log("=".repeat(60));

// ── 1. Env check ──────────────────────────────────────────────────────────────
section("Environment");

if (!ACCESS_TOKEN) {
  console.log("  ✗ HEB_ACCESS_TOKEN is not set");
  console.log();
  console.log("  Run the setup script first:");
  console.log("    node packages/plugins/examples/plugin-heb-grocery/scripts/setup-auth.mjs");
  process.exit(1);
}
ok("HEB_ACCESS_TOKEN is set (" + ACCESS_TOKEN.length + " chars)");
if (REFRESH_TOKEN) ok("HEB_REFRESH_TOKEN is set");
if (ID_TOKEN) ok("HEB_ID_TOKEN is set");
ok("Store number: " + STORE_NUMBER);
if (COOKIES) ok("HEB_COOKIES is set (cart/shopping list tests will run)");

// ── 2. Session ────────────────────────────────────────────────────────────────
section("Bearer Session");

let session;
try {
  session = createTokenSession({
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    idToken: ID_TOKEN,
    expiresIn: 1800,
  });
  ok("createTokenSession() succeeded");
} catch (err) {
  fail("createTokenSession()", err);
  process.exit(1);
}

try {
  const info = getSessionInfo(session);
  ok("getSessionInfo() — authMode: " + info.authMode);
} catch (err) {
  fail("getSessionInfo()", err);
}

const valid = isSessionValid(session);
if (valid) {
  ok("Session is valid (token not expired)");
} else {
  fail("Session is NOT valid — token may be expired. Re-run setup-auth.mjs", null);
}

// ── 3. Set store ──────────────────────────────────────────────────────────────
section("Store Setup");

try {
  await setStore(session, STORE_NUMBER);
  ok("setStore(" + STORE_NUMBER + ") succeeded");
} catch (err) {
  fail("setStore()", err);
}

// ── 4. Account ────────────────────────────────────────────────────────────────
section("Account Details");

try {
  const account = await getAccountDetails(session);
  const name = [account.firstName, account.lastName].filter(Boolean).join(" ");
  ok("getAccountDetails() — " + (name || account.email || "no name returned"));
  if (account.loyaltyNumber) ok("Loyalty number: " + account.loyaltyNumber);
} catch (err) {
  fail("getAccountDetails()", err);
}

// ── 5. Weekly ad ──────────────────────────────────────────────────────────────
section("Weekly Ad (deals + coupons source)");

try {
  const ad = await getWeeklyAdProducts(session, { limit: 5 });
  ok("getWeeklyAdProducts() — " + ad.products.length + " items returned (of " + ad.totalCount + " total)");
  if (ad.products.length > 0) {
    const first = ad.products[0];
    ok("Sample item: " + first.name + (first.priceText ? " — " + first.priceText : ""));
  }
} catch (err) {
  fail("getWeeklyAdProducts()", err);
}

// ── 6. Cookie session (optional) ─────────────────────────────────────────────
if (COOKIES) {
  section("Cookie Session (cart)");

  let cookieSession;
  try {
    cookieSession = createSessionFromCookies(COOKIES);
    ok("createSessionFromCookies() succeeded");
  } catch (err) {
    fail("createSessionFromCookies()", err);
  }

  if (cookieSession) {
    try {
      const cart = await getCart(cookieSession);
      ok("getCart() — " + cart.itemCount + " item(s) in cart");
    } catch (err) {
      fail("getCart()", err);
    }
  }
} else {
  section("Cookie Session (cart) — SKIPPED (set HEB_COOKIES to test)");
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log();
console.log("=".repeat(60));
console.log("Results: " + passed + " passed, " + failed + " failed");
console.log("=".repeat(60));

if (failed > 0) {
  console.log();
  console.log("Some tests failed. Common fixes:");
  console.log("  - Token expired: re-run setup-auth.mjs to get fresh tokens");
  console.log("  - Wrong store number: find your store at heb.com/store-locations");
  console.log("  - reese84 cookie stale: copy fresh cookies from heb.com DevTools");
  process.exit(1);
} else {
  console.log();
  console.log("All tests passed! Paste your credentials into the HEB Grocery plugin");
  console.log("settings (Plugin Settings → HEB Grocery) and you're good to go.");
}
