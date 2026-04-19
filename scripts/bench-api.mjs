#!/usr/bin/env node
/**
 * Paperclip API Performance Benchmark
 *
 * Measures latency (p50/p95/p99) and throughput for key API endpoints.
 * Run against a live Paperclip instance:
 *
 *   node scripts/bench-api.mjs [--url http://localhost:3100] [--concurrency 10] [--iterations 100]
 *
 * Requires a running Paperclip server with at least one company and agent.
 * Set PAPERCLIP_API_KEY env var for authenticated endpoints.
 */

const DEFAULT_URL = "http://localhost:3100";
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_ITERATIONS = 100;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    url: DEFAULT_URL,
    concurrency: DEFAULT_CONCURRENCY,
    iterations: DEFAULT_ITERATIONS,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) opts.url = args[++i];
    if (args[i] === "--concurrency" && args[i + 1]) opts.concurrency = parseInt(args[++i], 10);
    if (args[i] === "--iterations" && args[i + 1]) opts.iterations = parseInt(args[++i], 10);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function fmt(ms) {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function timedFetch(url, options = {}) {
  const start = performance.now();
  const res = await fetch(url, options);
  const elapsed = performance.now() - start;
  // Consume body to ensure connection is fully measured
  await res.text();
  return { status: res.status, elapsed };
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------
async function runBenchmark(name, fn, { concurrency, iterations }) {
  const durations = [];
  const errors = [];
  let completed = 0;

  // Run in batches of `concurrency`
  for (let batch = 0; batch < iterations; batch += concurrency) {
    const batchSize = Math.min(concurrency, iterations - batch);
    const promises = Array.from({ length: batchSize }, async () => {
      try {
        const { status, elapsed } = await fn();
        if (status >= 400) {
          errors.push({ status, elapsed });
        }
        durations.push(elapsed);
      } catch (err) {
        errors.push({ error: err.message, elapsed: 0 });
      }
      completed++;
    });
    await Promise.all(promises);
  }

  const stats = computeStats(durations);
  const wallStart = performance.now();
  // Approximate wall-clock throughput from total time
  const totalMs = durations.reduce((a, b) => a + b, 0);
  const rps = durations.length > 0 ? (durations.length / (totalMs / concurrency)) * 1000 : 0;

  return { name, stats, errors: errors.length, rps, total: durations.length };
}

// ---------------------------------------------------------------------------
// Discover test fixtures (company, agent, issue)
// ---------------------------------------------------------------------------
async function discoverFixtures(baseUrl, apiKey) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  // Health — always available
  let companyId, agentId, issueId;

  try {
    const meRes = await fetch(`${baseUrl}/api/agents/me`, { headers });
    if (meRes.ok) {
      const me = await meRes.json();
      agentId = me.id;
      companyId = me.companyId;
    }
  } catch {
    // Not running as agent — try to discover from companies
  }

  if (!companyId) {
    // Try the first company (for board-user tokens or open instances)
    try {
      const companiesRes = await fetch(`${baseUrl}/api/companies`, {
        headers,
      });
      if (companiesRes.ok) {
        const companies = await companiesRes.json();
        if (companies.length > 0) companyId = companies[0].id;
      }
    } catch {}
  }

  if (companyId) {
    try {
      const issuesRes = await fetch(`${baseUrl}/api/companies/${companyId}/issues?status=done&limit=1`, { headers });
      if (issuesRes.ok) {
        const issues = await issuesRes.json();
        if (issues.length > 0) issueId = issues[0].id;
      }
    } catch {}
  }

  return { companyId, agentId, issueId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs();
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║         Paperclip API Performance Benchmark             ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Target:      ${opts.url}`);
  console.log(`  Concurrency: ${opts.concurrency}`);
  console.log(`  Iterations:  ${opts.iterations}`);
  console.log(`  Auth:        ${apiKey ? "Bearer token" : "none"}`);
  console.log();

  // Check server is reachable
  try {
    const probe = await fetch(`${opts.url}/health`);
    if (!probe.ok) throw new Error(`health returned ${probe.status}`);
  } catch (err) {
    console.error(`ERROR: Cannot reach ${opts.url}/health — ${err.message}`);
    console.error("Make sure the Paperclip server is running.");
    process.exit(1);
  }

  const fixtures = await discoverFixtures(opts.url, apiKey);
  console.log("Discovered fixtures:");
  console.log(`  companyId: ${fixtures.companyId || "(none)"}`);
  console.log(`  agentId:   ${fixtures.agentId || "(none)"}`);
  console.log(`  issueId:   ${fixtures.issueId || "(none)"}`);
  console.log();

  const benchmarks = [];
  const benchOpts = {
    concurrency: opts.concurrency,
    iterations: opts.iterations,
  };

  // --- 1. Health check (baseline, unauthenticated) ---
  benchmarks.push(await runBenchmark("GET /health", () => timedFetch(`${opts.url}/health`), benchOpts));

  // --- 2. List issues ---
  if (fixtures.companyId) {
    benchmarks.push(
      await runBenchmark(
        "GET /companies/:id/issues (list)",
        () => timedFetch(`${opts.url}/api/companies/${fixtures.companyId}/issues?limit=20`, { headers }),
        benchOpts,
      ),
    );
  }

  // --- 3. Get single issue ---
  if (fixtures.issueId) {
    benchmarks.push(
      await runBenchmark(
        "GET /issues/:id (detail)",
        () =>
          timedFetch(`${opts.url}/api/issues/${fixtures.issueId}`, {
            headers,
          }),
        benchOpts,
      ),
    );
  }

  // --- 4. Heartbeat context ---
  if (fixtures.issueId) {
    benchmarks.push(
      await runBenchmark(
        "GET /issues/:id/heartbeat-context",
        () => timedFetch(`${opts.url}/api/issues/${fixtures.issueId}/heartbeat-context`, { headers }),
        benchOpts,
      ),
    );
  }

  // --- 5. List comments ---
  if (fixtures.issueId) {
    benchmarks.push(
      await runBenchmark(
        "GET /issues/:id/comments",
        () => timedFetch(`${opts.url}/api/issues/${fixtures.issueId}/comments`, { headers }),
        benchOpts,
      ),
    );
  }

  // --- 6. Agent identity ---
  if (fixtures.agentId) {
    benchmarks.push(
      await runBenchmark("GET /agents/me", () => timedFetch(`${opts.url}/api/agents/me`, { headers }), benchOpts),
    );
  }

  // --- 7. Inbox lite ---
  if (fixtures.agentId) {
    benchmarks.push(
      await runBenchmark(
        "GET /agents/me/inbox-lite",
        () => timedFetch(`${opts.url}/api/agents/me/inbox-lite`, { headers }),
        benchOpts,
      ),
    );
  }

  // --- 8. Dashboard ---
  if (fixtures.companyId) {
    benchmarks.push(
      await runBenchmark(
        "GET /companies/:id/dashboard",
        () => timedFetch(`${opts.url}/api/companies/${fixtures.companyId}/dashboard`, { headers }),
        benchOpts,
      ),
    );
  }

  // --- 9. Issue search ---
  if (fixtures.companyId) {
    benchmarks.push(
      await runBenchmark(
        "GET /companies/:id/issues?q=test (search)",
        () => timedFetch(`${opts.url}/api/companies/${fixtures.companyId}/issues?q=test&limit=10`, { headers }),
        benchOpts,
      ),
    );
  }

  // --- 10. Issue create + delete (write path) ---
  if (fixtures.companyId) {
    // Lower iteration count for mutating operations
    const writeOpts = {
      concurrency: Math.min(opts.concurrency, 5),
      iterations: Math.min(opts.iterations, 20),
    };
    const createdIds = [];

    benchmarks.push(
      await runBenchmark(
        "POST /companies/:id/issues (create)",
        async () => {
          const res = await timedFetch(`${opts.url}/api/companies/${fixtures.companyId}/issues`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: `[bench] perf test ${Date.now()}`,
              description: "Temporary benchmark issue — auto-cleanup",
              status: "done",
              priority: "low",
            }),
          });
          // Track for cleanup — parse from original fetch
          try {
            const createRes = await fetch(
              `${opts.url}/api/companies/${fixtures.companyId}/issues?q=%5Bbench%5D+perf+test&limit=1&status=done`,
              { headers },
            );
            if (createRes.ok) {
              const issues = await createRes.json();
              if (issues.length > 0 && !createdIds.includes(issues[0].id)) {
                createdIds.push(issues[0].id);
              }
            }
          } catch {}
          return res;
        },
        writeOpts,
      ),
    );

    // Cleanup benchmark issues
    if (createdIds.length > 0) {
      console.log(`  Cleaning up ${createdIds.length} benchmark issues...`);
      await Promise.all(
        createdIds.map((id) =>
          fetch(`${opts.url}/api/issues/${id}`, {
            method: "DELETE",
            headers,
          }).catch(() => {}),
        ),
      );
    }

    // Also cleanup any we missed
    try {
      const cleanupRes = await fetch(
        `${opts.url}/api/companies/${fixtures.companyId}/issues?q=%5Bbench%5D+perf+test&limit=50&status=done`,
        { headers },
      );
      if (cleanupRes.ok) {
        const stale = await cleanupRes.json();
        await Promise.all(
          stale.map((i) =>
            fetch(`${opts.url}/api/issues/${i.id}`, {
              method: "DELETE",
              headers,
            }).catch(() => {}),
          ),
        );
        if (stale.length > 0) console.log(`  Cleaned up ${stale.length} stale benchmark issues.`);
      }
    } catch {}
  }

  // --- Print results ---
  console.log();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log();

  const colWidths = { name: 42, p50: 10, p95: 10, p99: 10, mean: 10, rps: 10, err: 6 };
  const header = [
    "Endpoint".padEnd(colWidths.name),
    "p50".padStart(colWidths.p50),
    "p95".padStart(colWidths.p95),
    "p99".padStart(colWidths.p99),
    "mean".padStart(colWidths.mean),
    "~rps".padStart(colWidths.rps),
    "err".padStart(colWidths.err),
  ].join(" ");

  console.log(header);
  console.log("─".repeat(header.length));

  for (const b of benchmarks) {
    const row = [
      b.name.padEnd(colWidths.name),
      fmt(b.stats.p50).padStart(colWidths.p50),
      fmt(b.stats.p95).padStart(colWidths.p95),
      fmt(b.stats.p99).padStart(colWidths.p99),
      fmt(b.stats.mean).padStart(colWidths.mean),
      b.rps.toFixed(0).padStart(colWidths.rps),
      String(b.errors).padStart(colWidths.err),
    ].join(" ");
    console.log(row);
  }

  console.log();
  console.log(`Completed ${benchmarks.reduce((s, b) => s + b.total, 0)} total requests.`);
  console.log();

  // --- JSON output for CI / tracking ---
  const jsonOut = {
    timestamp: new Date().toISOString(),
    config: {
      url: opts.url,
      concurrency: opts.concurrency,
      iterations: opts.iterations,
    },
    results: benchmarks.map((b) => ({
      name: b.name,
      ...b.stats,
      rps: Math.round(b.rps),
      errors: b.errors,
    })),
  };
  const outPath = "benchmarks/baseline.json";
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(jsonOut, null, 2) + "\n");
  console.log(`Results saved to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
