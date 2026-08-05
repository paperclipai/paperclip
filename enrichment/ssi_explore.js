#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const REQUIRED_FIELDS = [
  "sku",
  "category_tag",
  "product_name",
  "price_per_sqft",
  "cost_per_sqft",
  "raw_description",
];

// Login and catalog selectors can be retargeted with the matching SSI_*_SELECTOR
// environment variables without changing this file. The default submit selector
// starts with the visible DevExtreme .dx-button wrapper, then keeps plain-form
// button/input fallbacks for compatible login pages.
const DEFAULT_SELECTORS = {
  item: "[data-ssi-product]",
  sku: "[data-ssi-sku]",
  category: "[data-ssi-category]",
  name: "[data-ssi-name]",
  price: "[data-ssi-price]",
  cost: "[data-ssi-cost], [data-ssi-wholesale]",
  description: "[data-ssi-description]",
  next: "[data-ssi-next]",
  username: 'input[name="userName"], input[name="username"], input[type="email"]',
  password: 'input[name="password"], input[type="password"]',
  submit: '.dx-button[role="button"], .dx-button, button[type="submit"], input[type="submit"]',
};

const DEFAULT_MAX_SKUS = 25;
const DEFAULT_RATE_LIMIT_MS = 1000;
const EXPECTED_CHROMIUM_REVISION = "1217";

class SecretValue {
  constructor(value) {
    this.value = value;
  }

  toJSON() {
    return "[redacted]";
  }
}

function required(env, key) {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function parseConfigFromEnv(env = process.env) {
  const baseUrl = required(env, "SSI_BASE_URL");
  const authStatePath = required(env, "SSI_AUTH_STATE_PATH");
  const hasPasswordAuth = Boolean(env.SSI_USERNAME && env.SSI_PASSWORD);
  const hasTokenAuth = Boolean(env.SSI_SESSION_TOKEN);

  if (!hasPasswordAuth && !hasTokenAuth) {
    throw new Error("SSI_USERNAME/SSI_PASSWORD or SSI_SESSION_TOKEN is required");
  }

  const auth = hasTokenAuth
    ? { kind: "session_token", token: new SecretValue(env.SSI_SESSION_TOKEN) }
    : {
        kind: "password",
        username: env.SSI_USERNAME,
        password: new SecretValue(env.SSI_PASSWORD),
      };

  return {
    baseUrl,
    loginUrl: env.SSI_LOGIN_URL || baseUrl,
    authStatePath,
    auth,
    selectors: {
      item: env.SSI_PRODUCT_SELECTOR || DEFAULT_SELECTORS.item,
      sku: env.SSI_SKU_SELECTOR || DEFAULT_SELECTORS.sku,
      category: env.SSI_CATEGORY_SELECTOR || DEFAULT_SELECTORS.category,
      name: env.SSI_NAME_SELECTOR || DEFAULT_SELECTORS.name,
      price: env.SSI_PRICE_SELECTOR || DEFAULT_SELECTORS.price,
      cost: env.SSI_COST_SELECTOR || DEFAULT_SELECTORS.cost,
      description: env.SSI_DESCRIPTION_SELECTOR || DEFAULT_SELECTORS.description,
      next: env.SSI_NEXT_SELECTOR || DEFAULT_SELECTORS.next,
      username: env.SSI_USERNAME_SELECTOR || DEFAULT_SELECTORS.username,
      password: env.SSI_PASSWORD_SELECTOR || DEFAULT_SELECTORS.password,
      submit: env.SSI_SUBMIT_SELECTOR || DEFAULT_SELECTORS.submit,
    },
  };
}

function positiveIntFromEnv(env, key, fallback) {
  const raw = env[key];
  if (raw == null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function buildRunGuards(env = process.env) {
  return {
    maxSkus: positiveIntFromEnv(env, "SSI_MAX_SKUS", DEFAULT_MAX_SKUS),
    rateLimitMs: positiveIntFromEnv(env, "SSI_RATE_LIMIT_MS", DEFAULT_RATE_LIMIT_MS),
    singleSession: true,
    readOnly: true,
  };
}

function parseMoney(value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function firstPresent(source, keys) {
  for (const key of keys) {
    if (source[key] != null && source[key] !== "") {
      return source[key];
    }
  }
  return "";
}

function normalizeItem(item) {
  return {
    sku: String(firstPresent(item, ["sku", "SKU", "source_row_id"])).trim(),
    category_tag: String(firstPresent(item, ["category_tag", "categoryTag", "category"])).trim(),
    product_name: String(firstPresent(item, ["product_name", "productName", "name"])).trim(),
    price_per_sqft: parseMoney(firstPresent(item, ["price_per_sqft", "pricePerSqft", "price"])),
    cost_per_sqft: parseMoney(firstPresent(item, ["cost_per_sqft", "costPerSqft", "cost", "wholesale"])),
    raw_description: String(firstPresent(item, ["raw_description", "rawDescription", "description"])).trim(),
  };
}

function buildCatalogOutput(items) {
  const rows = items.map(normalizeItem).map((row) =>
    REQUIRED_FIELDS.reduce((out, field) => {
      out[field] = row[field];
      return out;
    }, {})
  );
  const missingCostSkus = rows
    .filter((row) => row.cost_per_sqft == null)
    .map((row) => row.sku || "(missing sku)");

  return {
    rows,
    halt: missingCostSkus.length > 0,
    missingCostSkus,
  };
}

function serializeRows(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

async function sleep(ms) {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function unsafeMethod(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function sameOriginAndPath(url, expectedUrl) {
  try {
    const parsed = new URL(url);
    const expected = new URL(expectedUrl);
    return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
  } catch (_err) {
    return url === expectedUrl;
  }
}

// The SSI session bearer is a credential scoped to the SSI service origin. It
// must never be attached to a request bound for any other origin, including
// cross-origin redirect targets and subresource fetches. `trustedOrigin` is the
// scheme+host+port of SSI_BASE_URL; only an exact match is trusted.
function sameOrigin(url, trustedOrigin) {
  try {
    return new URL(url).origin === trustedOrigin;
  } catch (_err) {
    return false;
  }
}

async function installReadOnlyRouteGuard(context, loginUrl, bearer = null) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const isSafe = !unsafeMethod(method);
    const isLoginPost = method === "POST" && sameOriginAndPath(request.url(), loginUrl);
    if (!isSafe && !isLoginPost) {
      await route.abort("blockedbyclient");
      return;
    }
    // Per-request bearer injection: attach the session bearer ONLY when the
    // request's origin exactly equals the trusted SSI origin. Because every
    // request (including redirect follow-ups and subresources) re-enters this
    // handler, a redirect to a different origin is re-evaluated here and never
    // receives the bearer.
    if (bearer && bearer.token && sameOrigin(request.url(), bearer.trustedOrigin)) {
      await route.continue({
        headers: { ...request.headers(), Authorization: `Bearer ${bearer.token}` },
      });
      return;
    }
    await route.continue();
  });
}

async function assertLoginControlsPresent(page, selectors) {
  const controls = [
    ["username", selectors.username],
    ["password", selectors.password],
    ["submit", selectors.submit],
  ];

  for (const [name, selector] of controls) {
    const count = await page.locator(selector).count();
    if (count === 0) {
      throw new Error(
        `SSI login form preflight failed: ${name} control was not found for selector ${selector}. ` +
          "This is a login-page/selector mismatch, not a credential failure; " +
          `set SSI_${name.toUpperCase()}_SELECTOR to the current non-secret DOM selector.`
      );
    }
  }
}

async function submitLoginForm(page, selectors) {
  try {
    await page.locator(selectors.submit).first().click({ timeout: 7500 });
  } catch (_err) {
    await page.locator(selectors.password).press("Enter");
  }
}

function loadPlaywright() {
  try {
    return createRequire(path.join(__dirname, "package.json"))("playwright");
  } catch (err) {
    throw new Error(
      "Playwright is required for live SSI exploration but was not found in the enrichment runtime; " +
        `install the enrichment runtime dependencies (${err.message})`
    );
  }
}

function assertChromiumAvailable(playwright) {
  let executablePath;
  try {
    executablePath = playwright.chromium.executablePath();
  } catch (err) {
    throw new Error(
      `Chromium browser preflight failed for Playwright 1.59.1; expected cached Chromium revision ` +
        `${EXPECTED_CHROMIUM_REVISION} (${err.message}). Credentials are not involved.`
    );
  }

  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(
      `Chromium browser executable is missing at ${executablePath || "the Playwright cache path"}; ` +
        `Playwright 1.59.1 requires the pre-provisioned Chromium revision ${EXPECTED_CHROMIUM_REVISION}. ` +
        "Provision that browser before running the enrichment tool; credentials are not involved."
    );
  }

  if (!executablePath.includes(`chromium-${EXPECTED_CHROMIUM_REVISION}`)) {
    throw new Error(
      `Playwright resolved an unexpected Chromium executable (${executablePath}); ` +
        `the enrichment runtime requires Chromium revision ${EXPECTED_CHROMIUM_REVISION}. ` +
        "Check the pinned Playwright dependency and browser cache; credentials are not involved."
    );
  }

  return executablePath;
}

async function authenticate(page, context, config) {
  if (config.auth.kind === "session_token") {
    // Do NOT set a context-wide Authorization header: that would leak the
    // bearer to every origin the browser touches. The bearer is injected
    // per-request, origin-scoped, by installReadOnlyRouteGuard instead.
    return;
  }

  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
  await assertLoginControlsPresent(page, config.selectors);
  await page.locator(config.selectors.username).fill(config.auth.username);
  await page.locator(config.selectors.password).fill(config.auth.password.value);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => undefined),
    submitLoginForm(page, config.selectors),
  ]);
}

async function extractCatalogItems(page, config, guards) {
  const items = [];

  while (items.length < guards.maxSkus) {
    await page.waitForSelector(config.selectors.item, { timeout: 15000 });
    const pageItems = await page.$$eval(
      config.selectors.item,
      (nodes, selectors) => {
        const text = (root, selector) => {
          const found = root.querySelector(selector);
          return found ? found.textContent.trim() : "";
        };
        return nodes.map((node) => ({
          sku: text(node, selectors.sku),
          category_tag: text(node, selectors.category),
          product_name: text(node, selectors.name),
          price_per_sqft: text(node, selectors.price),
          cost_per_sqft: text(node, selectors.cost),
          raw_description: text(node, selectors.description),
        }));
      },
      config.selectors
    );
    items.push(...pageItems.slice(0, guards.maxSkus - items.length));

    const next = page.locator(config.selectors.next).first();
    if ((await next.count()) === 0 || items.length >= guards.maxSkus) {
      break;
    }
    const disabled = await next.evaluate((node) =>
      node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true"
    );
    if (disabled) {
      break;
    }
    await sleep(guards.rateLimitMs);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => undefined),
      next.click(),
    ]);
  }

  return items;
}

async function runLive() {
  const config = parseConfigFromEnv();
  const guards = buildRunGuards();
  const { chromium } = loadPlaywright();
  const executablePath = assertChromiumAvailable({ chromium });
  const storageState = fs.existsSync(config.authStatePath) ? config.authStatePath : undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ storageState });
  const bearer =
    config.auth.kind === "session_token"
      ? { token: config.auth.token.value, trustedOrigin: new URL(config.baseUrl).origin }
      : null;
  await installReadOnlyRouteGuard(context, config.loginUrl, bearer);

  try {
    const page = await context.newPage();
    await authenticate(page, context, config);
    await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
    const items = await extractCatalogItems(page, config, guards);
    await fs.promises.mkdir(path.dirname(config.authStatePath), { recursive: true });
    await context.storageState({ path: config.authStatePath });

    const output = buildCatalogOutput(items);
    process.stdout.write(serializeRows(output.rows));
    if (output.halt) {
      process.stderr.write(
        `HALT: missing SSI cost_per_sqft for SKU(s): ${output.missingCostSkus.join(", ")}\n`
      );
      return 2;
    }
    return 0;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  runLive()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_SELECTORS,
  REQUIRED_FIELDS,
  buildCatalogOutput,
  buildRunGuards,
  parseConfigFromEnv,
  serializeRows,
  installReadOnlyRouteGuard,
  sameOrigin,
  assertLoginControlsPresent,
  submitLoginForm,
  loadPlaywright,
  assertChromiumAvailable,
};
