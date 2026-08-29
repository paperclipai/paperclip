#!/usr/bin/env node

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export function normalizeCommit(value) {
  const commit = typeof value === "string" ? value.trim() : "";
  return FULL_SHA_RE.test(commit) ? commit.toLowerCase() : null;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    values.set(key, argv[index + 1] ?? "");
    index += 1;
  }
  return values;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponse(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json,text/html", "cache-control": "no-cache" },
    });
    const body = await response.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      // The root page is intentionally treated as an opaque successful body.
    }
    return { ok: response.ok, status: response.status, json };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
      json: null,
    };
  }
}

export async function verifyDeployment({
  baseUrl,
  expectedCommit,
  timeoutMs = 15 * 60 * 1000,
  pollMs = 10_000,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleepImpl = sleep,
  log = console.log,
}) {
  const normalizedExpected = normalizeCommit(expectedCommit);
  if (!normalizedExpected) throw new Error("expectedCommit must be a full 40-character SHA");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("baseUrl is required");

  const startedAt = now();
  let last = null;
  while (now() - startedAt <= timeoutMs) {
    const [health, page] = await Promise.all([
      readResponse(fetchImpl, `${base}/api/health`),
      readResponse(fetchImpl, base),
    ]);
    last = { health, page };
    const healthCommit = normalizeCommit(health.json?.commit);
    const ready = health.ok
      && health.json?.status === "ok"
      && health.json?.bootstrapStatus === "ready";
    if (ready && healthCommit === normalizedExpected && page.ok) {
      const evidence = {
        baseUrl: base,
        expectedCommit: normalizedExpected,
        healthStatus: health.status,
        healthCommit,
        bootstrapStatus: health.json.bootstrapStatus,
        pageStatus: page.status,
        elapsedMs: now() - startedAt,
      };
      log(JSON.stringify(evidence));
      return evidence;
    }
    await sleepImpl(pollMs);
  }

  const healthDescription = last?.health
    ? `health=${last.health.status || "request-error"} commit=${last.health.json?.commit ?? "null"}${last.health.error ? ` error=${last.health.error}` : ""}`
    : "health=not-requested";
  const pageDescription = last?.page
    ? `page=${last.page.status || "request-error"}${last.page.error ? ` error=${last.page.error}` : ""}`
    : "page=not-requested";
  throw new Error(
    `deployment verification timed out for ${base}; expected=${normalizedExpected}; ${healthDescription}; ${pageDescription}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timeoutSeconds = Number(args.get("timeout-seconds") ?? 900);
  const pollSeconds = Number(args.get("poll-seconds") ?? 10);
  await verifyDeployment({
    baseUrl: args.get("url"),
    expectedCommit: args.get("commit"),
    timeoutMs: Math.max(1, timeoutSeconds) * 1000,
    pollMs: Math.max(0, pollSeconds) * 1000,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[deployment-verification] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
