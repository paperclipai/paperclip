const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_SELECTORS,
  REQUIRED_FIELDS,
  buildCatalogOutput,
  buildRunGuards,
  assertLoginControlsPresent,
  submitLoginForm,
  installReadOnlyRouteGuard,
  loadPlaywright,
  assertChromiumAvailable,
  parseConfigFromEnv,
  serializeRows,
} = require("./ssi_explore.js");

const completeItem = {
  sku: "SSI-QTZ-001",
  category_tag: "quartz",
  product_name: "Arctic White",
  price_per_sqft: "$42.50",
  cost_per_sqft: "$28.00",
  raw_description: "Polished quartz slab",
};

test("serializes the exact six-field seeder schema", () => {
  const output = buildCatalogOutput([completeItem]);

  assert.equal(output.halt, false);
  assert.deepEqual(Object.keys(output.rows[0]), REQUIRED_FIELDS);
  assert.deepEqual(output.rows[0], {
    sku: "SSI-QTZ-001",
    category_tag: "quartz",
    product_name: "Arctic White",
    price_per_sqft: 42.5,
    cost_per_sqft: 28,
    raw_description: "Polished quartz slab",
  });

  const parsed = JSON.parse(serializeRows(output.rows));
  assert.deepEqual(parsed, output.rows);
});

test("halts and reports SKUs when SSI cost is missing, without fabricating cost", () => {
  const output = buildCatalogOutput([
    completeItem,
    { ...completeItem, sku: "SSI-QTZ-002", cost_per_sqft: "" },
  ]);

  assert.equal(output.halt, true);
  assert.deepEqual(output.missingCostSkus, ["SSI-QTZ-002"]);
  assert.equal(output.rows[1].cost_per_sqft, null);
});

test("parses username/password credential contract without exposing secret values", () => {
  const config = parseConfigFromEnv({
    SSI_BASE_URL: "https://ssi.example.test/catalog",
    SSI_USERNAME: "operator@example.test",
    SSI_PASSWORD: "secret-password",
    SSI_AUTH_STATE_PATH: "tmp/ssi-auth-state.json",
  });

  assert.equal(config.baseUrl, "https://ssi.example.test/catalog");
  assert.equal(config.auth.kind, "password");
  assert.equal(config.auth.username, "operator@example.test");
  assert.equal(config.authStatePath, "tmp/ssi-auth-state.json");
  assert.equal(JSON.stringify(config).includes("secret-password"), false);
});

test("defaults the username selector to the current SSI login field", () => {
  const config = parseConfigFromEnv({
    SSI_BASE_URL: "https://ssi.example.test",
    SSI_USERNAME: "operator",
    SSI_PASSWORD: "secret-password",
    SSI_AUTH_STATE_PATH: "tmp/ssi-auth-state.json",
  });

  assert.match(config.selectors.username, /input\[name="userName"\]/);
});

test("defaults the submit selector to the visible DevExtreme button wrapper", () => {
  assert.match(DEFAULT_SELECTORS.submit, /\.dx-button\[role="button"\]/);
});

test("submits the login form by clicking the first submit control", async () => {
  const calls = [];
  const page = {
    locator(selector) {
      assert.equal(selector, DEFAULT_SELECTORS.submit);
      return {
        first: () => ({
          click: async (options) => calls.push(options),
        }),
      };
    },
  };

  await submitLoginForm(page, {
    submit: DEFAULT_SELECTORS.submit,
    password: DEFAULT_SELECTORS.password,
  });

  assert.deepEqual(calls, [{ timeout: 7500 }]);
});

test("falls back to pressing Enter in the password field when submit click fails", async () => {
  const calls = [];
  const page = {
    locator(selector) {
      if (selector === DEFAULT_SELECTORS.submit) {
        return {
          first: () => ({
            click: async () => {
              calls.push("click");
              throw new Error("element is not visible");
            },
          }),
        };
      }
      assert.equal(selector, DEFAULT_SELECTORS.password);
      return {
        press: async (key) => calls.push(`press:${key}`),
      };
    },
  };

  await submitLoginForm(page, {
    submit: DEFAULT_SELECTORS.submit,
    password: DEFAULT_SELECTORS.password,
  });

  assert.deepEqual(calls, ["click", "press:Enter"]);
});

test("preflights login controls before any credential interaction", async () => {
  const selectors = {
    username: 'input[name="userName"]',
    password: 'input[name="password"]',
    submit: 'button[type="submit"]',
  };
  const calls = [];
  const page = {
    locator(selector) {
      calls.push(selector);
      return { count: async () => (selector === selectors.username ? 0 : 1) };
    },
  };

  await assert.rejects(
    () => assertLoginControlsPresent(page, selectors),
    (error) => {
      assert.match(error.message, /SSI login form preflight failed/);
      assert.match(error.message, /username control was not found/);
      assert.match(error.message, /not a credential failure/);
      assert.equal(error.message.includes("secret-password"), false);
      return true;
    }
  );
  assert.deepEqual(calls, [selectors.username]);
});

test("parses session-token auth and fast-fails on missing credentials", () => {
  const tokenConfig = parseConfigFromEnv({
    SSI_BASE_URL: "https://ssi.example.test",
    SSI_SESSION_TOKEN: "session-token-value",
    SSI_AUTH_STATE_PATH: "tmp/ssi-auth-state.json",
  });

  assert.equal(tokenConfig.auth.kind, "session_token");
  assert.equal(JSON.stringify(tokenConfig).includes("session-token-value"), false);

  assert.throws(
    () =>
      parseConfigFromEnv({
        SSI_BASE_URL: "https://ssi.example.test",
        SSI_AUTH_STATE_PATH: "tmp/ssi-auth-state.json",
      }),
    /SSI_USERNAME\/SSI_PASSWORD or SSI_SESSION_TOKEN/
  );
});

test("run guards are bounded, rate-limited, single-session, and read-only", () => {
  const guards = buildRunGuards({ SSI_MAX_SKUS: "12", SSI_RATE_LIMIT_MS: "1500" });

  assert.deepEqual(guards, {
    maxSkus: 12,
    rateLimitMs: 1500,
    singleSession: true,
    readOnly: true,
  });

  assert.throws(() => buildRunGuards({ SSI_MAX_SKUS: "0" }), /SSI_MAX_SKUS/);
  assert.throws(() => buildRunGuards({ SSI_RATE_LIMIT_MS: "-1" }), /SSI_RATE_LIMIT_MS/);
});

test("read-only route guard allows only exact login POST and blocks nearby mutation POSTs", async () => {
  let routeHandler;
  const context = {
    async route(pattern, handler) {
      assert.equal(pattern, "**/*");
      routeHandler = handler;
    },
  };
  await installReadOnlyRouteGuard(context, "https://ssi.example.test/catalog");

  const routeRequest = async (method, url) => {
    const actions = [];
    await routeHandler({
      request: () => ({ method: () => method, url: () => url }),
      continue: async () => actions.push("continue"),
      abort: async (reason) => actions.push(`abort:${reason}`),
    });
    return actions;
  };

  assert.deepEqual(
    await routeRequest("GET", "https://ssi.example.test/catalog/update"),
    ["continue"]
  );
  assert.deepEqual(
    await routeRequest("POST", "https://ssi.example.test/catalog"),
    ["continue"]
  );
  assert.deepEqual(
    await routeRequest("POST", "https://ssi.example.test/catalog/update"),
    ["abort:blockedbyclient"]
  );
});

test("resolves Playwright from the enrichment package without caller environment overrides", () => {
  const playwright = loadPlaywright();

  assert.equal(require("playwright/package.json").version, "1.59.1");
  assert.doesNotThrow(() => assertChromiumAvailable(playwright));
});

test("reports a missing Chromium executable before attempting a live SSI run", () => {
  assert.throws(
    () =>
      assertChromiumAvailable({
        chromium: { executablePath: () => "/missing/chromium" },
      }),
    /Chromium browser executable is missing/
  );
});
