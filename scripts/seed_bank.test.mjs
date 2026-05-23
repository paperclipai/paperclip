import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectCandidatePages,
  computePageHash,
  deriveSeedQueries,
  extractGbrainPageBody,
  GbrainClient,
  McpClient,
  planSeedIngest,
  SqliteLedger,
} from "./seed_bank_core.mjs";

const fixtureAgent = {
  id: "agent-1",
  companyId: "company-1",
  capabilities: "Owns Go backend work for NOP Supply Portal, SIWS, Solana RPC, and PoB services.",
  adapterConfig: {
    paperclipSkillSync: {
      desiredSkills: ["blockcast/backend-go", "vercel-labs/agent-browser/agent-browser"],
    },
  },
};

const fixtureParent = {
  id: "parent-1",
  capabilities: "Reviews Paperclip platform topology, release gates, and production incident follow-up.",
};

test("deriveSeedQueries produces stable template queries from agent context", () => {
  assert.deepEqual(deriveSeedQueries({ agent: fixtureAgent, reportsTo: fixtureParent }), [
    {
      kind: "capabilities",
      query: "Owns Go backend work for NOP Supply Portal, SIWS, Solana RPC, and PoB services.",
    },
    { kind: "desired_skill", query: "backend go" },
    { kind: "desired_skill", query: "agent browser" },
    {
      kind: "reports_to_capabilities",
      query: "Reviews Paperclip platform topology, release gates, and production incident follow-up.",
    },
  ]);
});

test("collectCandidatePages dedupes by source and slug and caps in query order", () => {
  const queries = [
    { kind: "capabilities", query: "Go backend" },
    { kind: "desired_skill", query: "agent browser" },
  ];
  const queryResults = new Map([
    [
      "Go backend",
      [
        { source: "default", slug: "nop/runbook", title: "NOP runbook" },
        { source: "default", slug: "solana/rpc", title: "Solana RPC" },
      ],
    ],
    [
      "agent browser",
      [
        { source: "default", slug: "nop/runbook", title: "Duplicate should lose" },
        { source: "gstack-code-nop", slug: "agent/browser", title: "Agent browser" },
      ],
    ],
  ]);

  assert.deepEqual(collectCandidatePages({ queries, queryResults, maxPages: 2 }), [
    { source: "default", slug: "nop/runbook", title: "NOP runbook", query: "Go backend" },
    { source: "default", slug: "solana/rpc", title: "Solana RPC", query: "Go backend" },
  ]);
});

test("computePageHash hashes the full markdown body", () => {
  assert.equal(
    computePageHash("# NOP\n\nSupply Portal"),
    "208fe7b64b95c75fa64a631f9fe986ab946f80f0cad12486d74d0000a00adeba",
  );
});

test("planSeedIngest dry-run never writes ledger rows or ingests pages", async () => {
  const calls = [];
  const ledger = {
    get: () => null,
    upsert: (...args) => calls.push(["ledger", ...args]),
  };
  const hindsight = {
    ingestPage: (...args) => calls.push(["ingest", ...args]),
  };

  const result = await planSeedIngest({
    bankId: "paperclip::company-1::agent-1",
    candidates: [{ source: "default", slug: "nop/runbook", body: "# NOP", title: "nop/runbook" }],
    dryRun: true,
    ledger,
    hindsight,
    mode: "seed",
    now: () => "2026-05-23T00:00:00.000Z",
  });

  assert.deepEqual(result.summary, { considered: 1, ingested: 0, skipped: 0, dryRun: true });
  assert.deepEqual(calls, []);
});

test("planSeedIngest ingests first run, skips unchanged seed rerun, and refreshes changed hashes", async () => {
  const rows = new Map();
  const ingested = [];
  const ledger = {
    get: (bankId, source, slug) => rows.get(`${bankId}\0${source}\0${slug}`) ?? null,
    upsert: (row) => rows.set(`${row.bankId}\0${row.gbrainSource}\0${row.gbrainSlug}`, row),
  };
  const hindsight = {
    ingestPage: (page) => ingested.push(page),
  };
  const baseArgs = {
    bankId: "paperclip::company-1::agent-1",
    dryRun: false,
    ledger,
    hindsight,
    now: () => "2026-05-23T00:00:00.000Z",
  };

  const first = await planSeedIngest({
    ...baseArgs,
    mode: "seed",
    candidates: [{ source: "default", slug: "nop/runbook", body: "# NOP", title: "nop/runbook" }],
  });
  const rerun = await planSeedIngest({
    ...baseArgs,
    mode: "seed",
    candidates: [{ source: "default", slug: "nop/runbook", body: "# NOP", title: "nop/runbook" }],
  });
  const refresh = await planSeedIngest({
    ...baseArgs,
    mode: "refresh",
    candidates: [{ source: "default", slug: "nop/runbook", body: "# NOP changed", title: "nop/runbook" }],
  });

  assert.deepEqual(first.summary, { considered: 1, ingested: 1, skipped: 0, dryRun: false });
  assert.deepEqual(rerun.summary, { considered: 1, ingested: 0, skipped: 1, dryRun: false });
  assert.deepEqual(refresh.summary, { considered: 1, ingested: 1, skipped: 0, dryRun: false });
  assert.equal(ingested.length, 2);
  assert.equal(ingested[0].title, "nop/runbook");
  assert.equal(ingested[1].body, "# NOP changed");
});

test("extractGbrainPageBody composes compiled_truth + timeline and falls back to body/markdown/content (BLO-6793)", () => {
  assert.equal(
    extractGbrainPageBody({ compiled_truth: "# A", timeline: "- t1" }),
    "# A\n\n- t1",
  );
  assert.equal(extractGbrainPageBody({ compiled_truth: "# Only truth" }), "# Only truth");
  assert.equal(extractGbrainPageBody({ markdown: "legacy md" }), "legacy md");
  assert.equal(extractGbrainPageBody("raw string"), "raw string");
  assert.equal(extractGbrainPageBody({}), "");
});

test("McpClient.callTool surfaces tool-level isError results instead of silently returning the error body (BLO-6793)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: "invalid_params", message: "Parameter \"salience\" must be a string" }) }],
        },
      })}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  try {
    const client = new McpClient("http://stub/mcp", "stub-token");
    await assert.rejects(() => client.callTool("query", {}), /invalid_params/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GbrainClient.query sends string enums for salience/recency (BLO-6793)", async () => {
  const calls = [];
  const stubMcp = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return [{ slug: "blo-2956", source_id: "default", title: "Solana RPC" }];
    },
  };
  const gbrain = new GbrainClient(stubMcp);
  const items = await gbrain.query({ query: "Solana RPC", sources: ["default"], limit: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "query");
  assert.equal(typeof calls[0].args.salience, "string");
  assert.equal(typeof calls[0].args.recency, "string");
  assert.equal(calls[0].args.salience, "on");
  assert.equal(calls[0].args.recency, "on");
  assert.deepEqual(items, [{ source: "default", slug: "blo-2956", title: "Solana RPC" }]);
});

test("SqliteLedger persists rows by bank, source, and slug", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "seed-bank-ledger-test-"));
  try {
    const ledger = new SqliteLedger(path.join(dir, "seed-bank-ledger.db"));
    await ledger.init();
    await ledger.upsert({
      bankId: "bank-1",
      gbrainSource: "default",
      gbrainSlug: "nop/runbook",
      contentHash: "hash-1",
      ingestedAt: "2026-05-23T00:00:00.000Z",
      pageByteCount: 12,
    });
    await ledger.upsert({
      bankId: "bank-1",
      gbrainSource: "default",
      gbrainSlug: "nop/runbook",
      contentHash: "hash-2",
      ingestedAt: "2026-05-23T01:00:00.000Z",
      pageByteCount: 13,
    });

    assert.equal(await ledger.countRows(), 1);
    assert.deepEqual(await ledger.get("bank-1", "default", "nop/runbook"), {
      bankId: "bank-1",
      gbrainSource: "default",
      gbrainSlug: "nop/runbook",
      contentHash: "hash-2",
      ingestedAt: "2026-05-23T01:00:00.000Z",
      pageByteCount: 13,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
