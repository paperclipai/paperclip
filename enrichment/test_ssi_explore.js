const assert = require("node:assert/strict");
const test = require("node:test");

const {
  REQUIRED_FIELDS,
  buildCatalogOutput,
  buildRunGuards,
  installReadOnlyRouteGuard,
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
