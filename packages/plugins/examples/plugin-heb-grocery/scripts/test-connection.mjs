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
 *   HEB_COOKIES         — raw cookie string for cookie-session tests
 *                         Format: "sat=ABC; reese84=XYZ; incap_ses_212_NNN=QRS"
 *                         Note: incap_ses cookies have numbered suffixes — include all of them
 */

const {
  createTokenSession,
  createSessionFromCookies,
  getAccountDetails,
  getWeeklyAdProducts,
  getCart,
  setStore,
  isSessionValid,
} = await import("heb-sdk-unofficial");

// Trim whitespace to catch copy-paste artifacts (e.g. a leading space breaks
// the Authorization header format and causes "Format is Authorization: Bearer [token]")
const ACCESS_TOKEN = (process.env.HEB_ACCESS_TOKEN ?? "").trim();
const REFRESH_TOKEN = process.env.HEB_REFRESH_TOKEN?.trim();
const ID_TOKEN = process.env.HEB_ID_TOKEN?.trim();
const STORE_NUMBER = (process.env.HEB_STORE_NUMBER ?? "790").trim();
const COOKIES = process.env.HEB_COOKIES?.trim();

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

function warn(label) {
  console.log("  ⚠ " + label);
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

// Warn about whitespace before trimming so the user knows
if ((process.env.HEB_ACCESS_TOKEN ?? "").startsWith(" ") || (process.env.HEB_ACCESS_TOKEN ?? "").endsWith(" ")) {
  warn("HEB_ACCESS_TOKEN had leading/trailing whitespace — auto-trimmed");
  warn("This whitespace is the most common cause of 'Format is Authorization: Bearer [token]' errors");
}

ok("HEB_ACCESS_TOKEN is set (" + ACCESS_TOKEN.length + " chars)");
if (REFRESH_TOKEN) ok("HEB_REFRESH_TOKEN is set");
if (ID_TOKEN) ok("HEB_ID_TOKEN is set");
ok("Store number: " + STORE_NUMBER);
if (COOKIES) ok("HEB_COOKIES is set (" + COOKIES.length + " chars)");

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
section("Account Details (bearer auth)");

try {
  const account = await getAccountDetails(session);
  const name = [account.firstName, account.lastName].filter(Boolean).join(" ");
  ok("getAccountDetails() — " + (name || account.email || "account loaded"));
  if (account.loyaltyNumber) ok("Loyalty number: " + account.loyaltyNumber);
} catch (err) {
  fail("getAccountDetails()", err);
  if (err?.message?.includes("Bearer")) {
    warn("This usually means your access token has a leading space or is malformed.");
    warn("Ensure the token you paste starts immediately with 'eyJ' and has no spaces.");
  }
}

// ── 5. Weekly ad ──────────────────────────────────────────────────────────────
section("Weekly Ad (bearer auth)");

try {
  const ad = await getWeeklyAdProducts(session, { limit: 5 });
  ok("getWeeklyAdProducts() — " + ad.products.length + " items returned (of " + (ad.totalCount ?? "?") + " total)");
  if (ad.products.length > 0) {
    const first = ad.products[0];
    ok("Sample: " + first.name + (first.priceText ? " — " + first.priceText : ""));
  }
} catch (err) {
  fail("getWeeklyAdProducts()", err);
}

// ── 6. Cart via bearer session ───────────────────────────────────────────────
// Note: cart is tested using the bearer (mobile) session.
// The cookie-based cartEstimated query can return PersistedQueryNotFound when
// HEB's APQ cache doesn't have the hash warm — bearer cartV2 is more reliable.
section("Cart (bearer auth — mobile cartV2)");

try {
  const cart = await getCart(session);
  ok("getCart() — " + cart.itemCount + " item(s) in cart");
} catch (err) {
  fail("getCart()", err);
  if (err?.message?.includes("PersistedQueryNotFound")) {
    warn("APQ cache miss — try again in a few seconds, or refresh your cookies.");
  }
}

// ── 7. Cookie session parse (optional) ───────────────────────────────────────
if (COOKIES) {
  section("Cookie Session (parse check)");
  try {
    const cookieSession = createSessionFromCookies(COOKIES);
    ok("createSessionFromCookies() succeeded");
    // Don't attempt network calls with cookie session — bearer is preferred
    ok("Cookie auth available for shopping list operations");
  } catch (err) {
    fail("createSessionFromCookies()", err);
  }
} else {
  section("Cookie Session — SKIPPED (bearer handles cart; cookies optional)");
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log();
console.log("=".repeat(60));
console.log("Results: " + passed + " passed, " + failed + " failed");
console.log("=".repeat(60));

if (failed > 0) {
  console.log();
  console.log("Some tests failed. Common fixes:");
  console.log("  - 'Format is Authorization: Bearer [token]': your token has a");
  console.log("    leading space. Paste only the eyJ... part, no quotes or spaces.");
  console.log("  - Token expired: re-run setup-auth.mjs to get fresh tokens");
  console.log("    (access tokens expire in ~30 minutes)");
  console.log("  - Wrong store number: find it at heb.com/store-locations");
  process.exit(1);
} else {
  console.log();
  console.log("All tests passed! You're ready to configure the plugin.");
  console.log("Go to Plugin Settings → HEB Grocery and paste in your values.");
}
