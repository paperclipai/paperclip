import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseArgs,
  buildDigest,
  driftFlagBody,
  probeFilesByIssue,
  DRIFT_MARKER,
  LIVE,
  DRIFT,
  UNVERIFIABLE,
} from "./reconcile-beta.mjs";

// --- CLI ---------------------------------------------------------------------------------------
test("parseArgs applies defaults and overrides", () => {
  const d = parseArgs([]);
  assert.equal(d.base, "http://127.0.0.1:3200");
  assert.equal(d.dir, "release-probes");
  assert.equal(d.limitUnverifiable, 30);
  assert.equal(d.dryRun, false);

  const o = parseArgs(["--base", "http://x:1", "--digest-issue", "iss-1", "--cto-agent", "a-1", "--dry-run", "--json"]);
  assert.equal(o.base, "http://x:1");
  assert.equal(o.digestIssue, "iss-1");
  assert.equal(o.ctoAgent, "a-1");
  assert.equal(o.dryRun, true);
  assert.equal(o.json, true);
});

test("parseArgs rejects unknown options", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
});

// --- probe registry ↔ issue mapping ------------------------------------------------------------
test("probeFilesByIssue maps uppercased stems to files (yaml/yml/json)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "probes-"));
  await writeFile(path.join(dir, "NEO-521.yaml"), "issue: NEO-521\nprobes: []\n");
  await writeFile(path.join(dir, "neo-600.yml"), "issue: NEO-600\nprobes: []\n");
  await writeFile(path.join(dir, "NEO-700.json"), "{}\n");
  await writeFile(path.join(dir, "README.md"), "ignore me\n");
  const m = await probeFilesByIssue(dir);
  assert.ok(m.has("NEO-521"));
  assert.ok(m.has("NEO-600"), "lowercase stem is uppercased");
  assert.ok(m.has("NEO-700"));
  assert.ok(!m.has("README"), "non-probe files are excluded");
});

test("probeFilesByIssue throws on a missing dir", async () => {
  await assert.rejects(() => probeFilesByIssue("/no/such/probe/dir"), /does not exist/);
});

// --- drift flag body ---------------------------------------------------------------------------
test("driftFlagBody names the issue, lists failing probes, and carries the idempotency marker", () => {
  const body = driftFlagBody({
    identifier: "NEO-999",
    title: "Some feature",
    file: "release-probes/NEO-999.yaml",
    failing: [{ name: "route-mounted", type: "route", detail: "HTTP 404, expected [200, 401]" }],
  });
  assert.match(body, /NEO-999/);
  assert.match(body, /route-mounted/);
  assert.match(body, /HTTP 404/);
  assert.match(body, new RegExp(DRIFT_MARKER));
});

// --- digest ------------------------------------------------------------------------------------
const sampleResults = [
  { identifier: "NEO-521", title: "Brand Kit", state: LIVE, failing: [] },
  {
    identifier: "NEO-138",
    title: "Brand Kit (orig)",
    state: DRIFT,
    failing: [{ name: "brand-kits-route", type: "route", detail: "HTTP 404, expected [200, 401]" }],
  },
  { identifier: "NEO-400", title: "Old thing", state: UNVERIFIABLE, failing: [] },
  { identifier: "NEO-401", title: "Older thing", state: UNVERIFIABLE, failing: [] },
];

test("buildDigest counts each class and details drift", () => {
  const { markdown, counts } = buildDigest(sampleResults, {
    base: "http://127.0.0.1:3200",
    ctoAgent: "cto-agent-id",
    limitUnverifiable: 30,
  });
  assert.deepEqual(counts, { live: 1, drift: 1, unverifiable: 2 });
  assert.match(markdown, /🔴 \*\*Drift.*1/);
  assert.match(markdown, /NEO-138/);
  assert.match(markdown, /brand-kits-route/);
  // drift present + ctoAgent given → CTO is @-mentioned
  assert.match(markdown, /agent:\/\/cto-agent-id/);
});

test("buildDigest does not mention the CTO when there is no drift", () => {
  const greenOnly = [
    { identifier: "NEO-521", title: "Brand Kit", state: LIVE, failing: [] },
    { identifier: "NEO-400", title: "Old", state: UNVERIFIABLE, failing: [] },
  ];
  const { markdown, counts } = buildDigest(greenOnly, { base: "b", ctoAgent: "cto", limitUnverifiable: 30 });
  assert.equal(counts.drift, 0);
  assert.doesNotMatch(markdown, /agent:\/\/cto/);
  assert.match(markdown, /No drift/);
});

test("buildDigest caps the unverifiable list and notes the overflow", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    identifier: `NEO-${100 + i}`,
    title: `t${i}`,
    state: UNVERIFIABLE,
    failing: [],
  }));
  const { markdown } = buildDigest(many, { base: "b", ctoAgent: "", limitUnverifiable: 2 });
  assert.match(markdown, /and 3 more/);
});
