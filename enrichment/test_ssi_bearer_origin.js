const assert = require("node:assert/strict");
const test = require("node:test");

const { installReadOnlyRouteGuard, sameOrigin } = require("./ssi_explore.js");

const TRUSTED = "https://ssi.example.test";
const TRUSTED_ORIGIN = "https://ssi.example.test";
const LOGIN_URL = "https://ssi.example.test/login";
const BEARER = { token: "session-token-value", trustedOrigin: TRUSTED_ORIGIN };

// Capture the handler registered by installReadOnlyRouteGuard and drive it with
// a simulated Playwright Route, exactly as the request would arrive at runtime.
async function captureGuard(bearer) {
  let handler;
  const context = {
    async route(pattern, fn) {
      assert.equal(pattern, "**/*");
      handler = fn;
    },
  };
  await installReadOnlyRouteGuard(context, LOGIN_URL, bearer);
  return async ({ method = "GET", url, headers = {} }) => {
    const result = { action: null, opts: undefined, reason: undefined };
    await handler({
      request: () => ({
        method: () => method,
        url: () => url,
        headers: () => headers,
      }),
      continue: async (opts) => {
        result.action = "continue";
        result.opts = opts;
      },
      abort: async (reason) => {
        result.action = "abort";
        result.reason = reason;
      },
    });
    return result;
  };
}

function authOf(result) {
  return result.opts && result.opts.headers ? result.opts.headers.Authorization : undefined;
}

test("sameOrigin only trusts an exact scheme+host+port match", () => {
  assert.equal(sameOrigin("https://ssi.example.test/catalog", TRUSTED_ORIGIN), true);
  assert.equal(sameOrigin("https://ssi.example.test", TRUSTED_ORIGIN), true);
  // different host
  assert.equal(sameOrigin("https://evil.example.test/catalog", TRUSTED_ORIGIN), false);
  // different scheme
  assert.equal(sameOrigin("http://ssi.example.test/catalog", TRUSTED_ORIGIN), false);
  // different port
  assert.equal(sameOrigin("https://ssi.example.test:8443/catalog", TRUSTED_ORIGIN), false);
  // unparseable
  assert.equal(sameOrigin("not-a-url", TRUSTED_ORIGIN), false);
});

test("(a) bearer IS injected for a same-origin SSI request", async () => {
  const run = await captureGuard(BEARER);
  const result = await run({ method: "GET", url: `${TRUSTED}/catalog`, headers: { accept: "*/*" } });

  assert.equal(result.action, "continue");
  assert.equal(authOf(result), "Bearer session-token-value");
  // Existing request headers are preserved alongside the injected bearer.
  assert.equal(result.opts.headers.accept, "*/*");
});

test("(b) bearer is NOT injected for a different-origin request", async () => {
  const run = await captureGuard(BEARER);
  const result = await run({ method: "GET", url: "https://evil.example.test/catalog" });

  assert.equal(result.action, "continue");
  // Either no header options at all, or options without an Authorization header.
  assert.equal(authOf(result), undefined);
});

test("(c) bearer is NOT forwarded across a cross-origin redirect hop", async () => {
  const run = await captureGuard(BEARER);

  // Redirect follow-ups re-enter the guard as their own requests; the redirect
  // target on a foreign origin must not carry the bearer.
  const foreign = await run({ method: "GET", url: "https://cdn.other-origin.test/asset.js" });
  assert.equal(foreign.action, "continue");
  assert.equal(authOf(foreign), undefined);

  // A subresource fetch on the trusted origin still receives it.
  const same = await run({ method: "GET", url: `${TRUSTED}/assets/app.js` });
  assert.equal(authOf(same), "Bearer session-token-value");
});

test("bearer is not attached to a request that gets blocked", async () => {
  const run = await captureGuard(BEARER);
  // A mutating POST to a non-login path is aborted; no bearer must be emitted.
  const result = await run({ method: "POST", url: `${TRUSTED}/catalog/update` });

  assert.equal(result.action, "abort");
  assert.equal(result.reason, "blockedbyclient");
  assert.equal(result.opts, undefined);
});

test("read-only + login POST behavior is unchanged when a bearer is configured", async () => {
  const run = await captureGuard(BEARER);
  // The exact login POST is allowed and (being same-origin) carries the bearer.
  const login = await run({ method: "POST", url: LOGIN_URL });
  assert.equal(login.action, "continue");
  assert.equal(authOf(login), "Bearer session-token-value");
});
