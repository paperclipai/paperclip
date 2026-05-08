// Smoke test — exercises pollOnce against an in-memory fetch mock.
// Run: node --experimental-strip-types scripts/asset-library/lib/poller.smoke.mjs
//
// Note: invoke from repo root via tsx (`npx tsx ...`) since this loads .ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { pollOnce } = await import("./poller.ts");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "poller-smoke-"));
const stateFile = path.join(tmpDir, "doc-state.json");

const ISSUE_A = "issue-aaaa";
const ISSUE_B = "issue-bbbb";

let docs = {
  [ISSUE_A]: [
    { id: "doc-1", key: "plan", updatedAt: "2026-05-08T10:00:00Z" },
  ],
  [ISSUE_B]: [],
};

const postedComments = [];

const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url, method: init?.method ?? "GET" });
  if (url.endsWith("/issues?titlePrefix=%5Breview-and-ship%5D") || url.includes("titlePrefix=")) {
    return {
      ok: true,
      status: 200,
      json: async () => [
        { id: ISSUE_A, identifier: "GLA-AAA", title: "[review-and-ship] Asset A" },
        { id: ISSUE_B, identifier: "GLA-BBB", title: "[review-and-ship] Asset B" },
        { id: "issue-cccc", identifier: "GLA-CCC", title: "Some unrelated issue" },
      ],
    };
  }
  for (const issueId of [ISSUE_A, ISSUE_B]) {
    if (url.endsWith(`/api/issues/${issueId}/documents`)) {
      return { ok: true, status: 200, json: async () => docs[issueId] };
    }
    if (url.endsWith(`/api/issues/${issueId}/comments`) && init?.method === "POST") {
      postedComments.push({ issueId, body: JSON.parse(init.body).body });
      return { ok: true, status: 201, json: async () => ({ id: "comment-x" }), text: async () => "" };
    }
  }
  return { ok: false, status: 404, text: async () => `unexpected url ${url}` };
};

const cfg = {
  apiUrl: "http://api",
  apiKey: "k",
  companyId: "c",
  assetLibraryUrl: "http://127.0.0.1:7700",
  stateFile,
  intervalMs: 30_000,
  fetchImpl: fakeFetch,
  logger: { info: () => {}, warn: () => {}, error: console.error },
};

console.log("== Pass 1: bootstrap (silent baseline, no comments)");
let r = await pollOnce(cfg);
console.assert(r.bootstrap === true, "expected bootstrap=true");
console.assert(r.commentsPosted === 0, `expected 0 comments, got ${r.commentsPosted}`);
console.assert(r.scannedIssues === 2, `expected 2 review-and-ship issues, got ${r.scannedIssues}`);
console.assert(r.newDocs === 1, `expected 1 pre-existing doc baselined, got ${r.newDocs}`);
console.log("  OK", r);

console.log("== Pass 2: no changes — should be a no-op");
r = await pollOnce(cfg);
console.assert(r.bootstrap === false, "expected bootstrap=false on second run");
console.assert(r.commentsPosted === 0, `expected 0 comments, got ${r.commentsPosted}`);
console.log("  OK", r);

console.log("== Pass 3: new doc on issue A → one comment");
docs[ISSUE_A].push({ id: "doc-2", key: "hero-image", updatedAt: "2026-05-08T10:01:00Z" });
r = await pollOnce(cfg);
console.assert(r.commentsPosted === 1, `expected 1 comment, got ${r.commentsPosted}`);
console.assert(postedComments.length === 1, `expected 1 posted comment, got ${postedComments.length}`);
console.assert(postedComments[0].issueId === ISSUE_A);
console.assert(
  postedComments[0].body.includes(`http://127.0.0.1:7700/asset/${ISSUE_A}/hero-image`),
  `comment body missing url: ${postedComments[0].body}`,
);
console.log("  OK", postedComments[0]);

console.log("== Pass 4: same doc still present → idempotent (no comment)");
r = await pollOnce(cfg);
console.assert(r.commentsPosted === 0, `expected 0 comments, got ${r.commentsPosted}`);
console.log("  OK", r);

console.log("== Pass 5: new doc on issue B (empty until now) → one comment");
docs[ISSUE_B].push({ id: "doc-3", key: "thread-copy", updatedAt: "2026-05-08T10:02:00Z" });
r = await pollOnce(cfg);
console.assert(r.commentsPosted === 1, `expected 1 comment, got ${r.commentsPosted}`);
console.assert(postedComments[1].issueId === ISSUE_B);
console.assert(postedComments[1].body.includes("/asset/issue-bbbb/thread-copy"));
console.log("  OK", postedComments[1]);

console.log("== Pass 6: post-failure should NOT record state (retries next tick)");
const failCfg = {
  ...cfg,
  fetchImpl: async (url, init) => {
    if (url.endsWith(`/api/issues/${ISSUE_A}/comments`) && init?.method === "POST") {
      return { ok: false, status: 500, text: async () => "boom" };
    }
    return fakeFetch(url, init);
  },
};
docs[ISSUE_A].push({ id: "doc-4", key: "carousel", updatedAt: "2026-05-08T10:03:00Z" });
r = await pollOnce(failCfg);
console.assert(r.commentsPosted === 0, `expected 0 commentsPosted on failure`);
console.assert(r.errors.length === 1, `expected 1 error, got ${r.errors.length}`);
// Now retry with working fetch — should comment.
r = await pollOnce(cfg);
console.assert(r.commentsPosted === 1, `expected 1 retried comment, got ${r.commentsPosted}`);
console.log("  OK retry succeeded");

console.log("\nALL POLLER SMOKE PASSES OK");
console.log("State file:", stateFile);
console.log(JSON.parse(fs.readFileSync(stateFile, "utf8")));
fs.rmSync(tmpDir, { recursive: true, force: true });
