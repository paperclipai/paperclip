import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import { parseYaml, runProbe, normalizeStatusList, extractAssetPaths } from "./verify-content.mjs";

// --- YAML parser ------------------------------------------------------------------------------
test("parseYaml parses the probe schema (scalars, block seq, flow list, quotes, comments)", () => {
  const doc = parseYaml(`
# a comment
issue: NEO-521
description: Brand Kit is live
probes:
  - name: brand-kit-in-bundle   # trailing comment
    type: bundle
    path: /
    match: brand-kits
  - name: route-mounted
    type: route
    path: /api/x
    expectStatus: [200, 401]
  - name: table
    type: db
    command: node scripts/db-assert.mjs --regclass public.brand_kits
    match: "db-assert: OK"
`);
  assert.equal(doc.issue, "NEO-521");
  assert.equal(doc.description, "Brand Kit is live");
  assert.equal(doc.probes.length, 3);
  assert.deepEqual(doc.probes[0], { name: "brand-kit-in-bundle", type: "bundle", path: "/", match: "brand-kits" });
  assert.deepEqual(doc.probes[1].expectStatus, [200, 401]);
  assert.equal(doc.probes[2].match, "db-assert: OK");
  assert.equal(doc.probes[2].command, "node scripts/db-assert.mjs --regclass public.brand_kits");
});

test("normalizeStatusList coerces scalar and list, defaults to [200]", () => {
  assert.deepEqual(normalizeStatusList(undefined), [200]);
  assert.deepEqual(normalizeStatusList(401), [401]);
  assert.deepEqual(normalizeStatusList([200, "401"]), [200, 401]);
});

test("extractAssetPaths prefers the hashed index-*.js asset", () => {
  const html = '<script type="module" src="/assets/index-Bi8vFKY3.js"></script><link href="/assets/vendor-abc.js">';
  assert.deepEqual(extractAssetPaths(html, "index-"), ["/assets/index-Bi8vFKY3.js"]);
});

// --- probe runners against a stub instance ----------------------------------------------------
function startStub() {
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<script type="module" src="/assets/index-DEADBEEF.js"></script>');
    } else if (req.url === "/assets/index-DEADBEEF.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end('const x="brand-kits";const y="MARKER_PRESENT";');
    } else if (req.url === "/api/mounted") {
      res.writeHead(401);
      res.end('{"error":"unauthorized"}');
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test("bundle probe: green when marker present via auto-discovery, red when absent", async () => {
  const { server, base } = await startStub();
  try {
    const ok = await runProbe({ type: "bundle", path: "/", match: "MARKER_PRESENT" }, base, 4000);
    assert.equal(ok.ok, true, ok.detail);
    const bad = await runProbe({ type: "bundle", path: "/", match: "NOT_THERE_xyz" }, base, 4000);
    assert.equal(bad.ok, false);
  } finally {
    server.close();
  }
});

test("route probe: asserts expected status; 404 where 401 expected is red", async () => {
  const { server, base } = await startStub();
  try {
    const ok = await runProbe({ type: "route", path: "/api/mounted", expectStatus: [200, 401] }, base, 4000);
    assert.equal(ok.ok, true, ok.detail);
    const bad = await runProbe({ type: "route", path: "/api/missing", expectStatus: [200, 401] }, base, 4000);
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /HTTP 404/);
  } finally {
    server.close();
  }
});

test("route probe: body marker must match when given", async () => {
  const { server, base } = await startStub();
  try {
    const ok = await runProbe({ type: "route", path: "/api/mounted", expectStatus: [401], match: "unauthorized" }, base, 4000);
    assert.equal(ok.ok, true, ok.detail);
    const bad = await runProbe({ type: "route", path: "/api/mounted", expectStatus: [401], match: "nope" }, base, 4000);
    assert.equal(bad.ok, false);
  } finally {
    server.close();
  }
});

// --- db probe: command + psql guard (Hard Rule #1) --------------------------------------------
test("db probe: greps command output for the marker", async () => {
  const ok = await runProbe({ type: "db", command: "echo 'db-assert: OK relation exists'", match: "db-assert: OK" }, "http://unused", 4000);
  assert.equal(ok.ok, true, ok.detail);
  const bad = await runProbe({ type: "db", command: "echo nothing-useful", match: "db-assert: OK" }, "http://unused", 4000);
  assert.equal(bad.ok, false);
});

test("db probe: refuses raw psql (Hard Rule #1)", async () => {
  const refused = await runProbe({ type: "db", command: "psql -c 'select 1'", match: "x" }, "http://unused", 4000);
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /psql/i);
});

test("db probe: non-zero command exit is red unless allowNonZeroExit", async () => {
  const red = await runProbe({ type: "db", command: "echo has-marker db-assert: OK; exit 3", match: "db-assert: OK" }, "http://unused", 4000);
  assert.equal(red.ok, false);
  const allowed = await runProbe({ type: "db", command: "echo db-assert: OK; exit 3", match: "db-assert: OK", allowNonZeroExit: true }, "http://unused", 4000);
  assert.equal(allowed.ok, true, allowed.detail);
});

test("unknown probe type is red", async () => {
  const r = await runProbe({ type: "sniff", match: "x" }, "http://unused", 4000);
  assert.equal(r.ok, false);
  assert.match(r.detail, /unknown probe type/);
});
