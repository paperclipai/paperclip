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

const DEFAULT_SELECTORS = {
  item: "[data-ssi-product]",
  sku: "[data-ssi-sku]",
  category: "[data-ssi-category]",
  name: "[data-ssi-name]",
  price: "[data-ssi-price]",
  cost: "[data-ssi-cost], [data-ssi-wholesale]",
  description: "[data-ssi-description]",
  next: "[data-ssi-next]",
  username: 'input[name="username"], input[type="email"]',
  password: 'input[name="password"], input[type="password"]',
  submit: 'button[type="submit"], input[type="submit"]',
};

const DEFAULT_MAX_SKUS = 25;
const DEFAULT_RATE_LIMIT_MS = 1000;

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

async function installReadOnlyRouteGuard(context, loginUrl) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!unsafeMethod(request.method())) {
      await route.continue();
      return;
    }
    if (request.method().toUpperCase() === "POST" && sameOriginAndPath(request.url(), loginUrl)) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });
}

function loadPlaywright() {
  const attempts = [
    () => require("playwright"),
    () => createRequire(path.join(process.cwd(), "dispatcher", "package.json"))("playwright"),
    () => createRequire(path.join(process.cwd(), "review-ui", "package.json"))("playwright"),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (_err) {
      // Try the next local package that may already have Playwright installed.
    }
  }
  throw new Error("Playwright is required for live SSI exploration but was not found");
}

async function authenticate(page, context, config) {
  if (config.auth.kind === "session_token") {
    await context.setExtraHTTPHeaders({
      Authorization: `Bearer ${config.auth.token.value}`,
    });
    return;
  }

  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });
  await page.locator(config.selectors.username).fill(config.auth.username);
  await page.locator(config.selectors.password).fill(config.auth.password.value);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => undefined),
    page.locator(config.selectors.submit).click(),
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
  const storageState = fs.existsSync(config.authStatePath) ? config.authStatePath : undefined;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState });
  await installReadOnlyRouteGuard(context, config.loginUrl);

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
  REQUIRED_FIELDS,
  buildCatalogOutput,
  buildRunGuards,
  parseConfigFromEnv,
  serializeRows,
  installReadOnlyRouteGuard,
  loadPlaywright,
};
