import { loadBidPrimeSession } from "../src/core/bidprime-session.js";

const BASE = "https://www.bidprime.com";

const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  Origin: BASE,
  Referer: `${BASE}/`,
};

async function main() {
  const sessionPath = process.argv[2] ?? "/Users/bb/conductor/workspaces/paperclip/delhi/.bidprime-session";
  const session = await loadBidPrimeSession(sessionPath);
  const headers = { ...HEADERS, Cookie: session.cookieHeader };

  console.log("Probing GET /api/v2/auth/context ...");
  const ctx = await fetch(`${BASE}/api/v2/auth/context`, { method: "POST", headers });
  console.log("  status:", ctx.status);
  const ctxBody = await ctx.text();
  if (ctx.ok) {
    try {
      const j = JSON.parse(ctxBody);
      console.log("  auth.user:", JSON.stringify(j.user ?? j).slice(0, 400));
    } catch {
      console.log("  body (non-JSON, first 200 chars):", ctxBody.slice(0, 200));
    }
  } else {
    console.log("  body (first 200 chars):", ctxBody.slice(0, 200));
  }

  console.log("\nProbing GET /api/v2/alerts/list ...");
  const alerts = await fetch(`${BASE}/api/v2/alerts/list`, { headers });
  console.log("  status:", alerts.status);
  const alertsBody = await alerts.text();
  if (alerts.ok) {
    try {
      const j = JSON.parse(alertsBody);
      const items = (j.items ?? j.alerts ?? j.results ?? j) as unknown;
      console.log("  alerts (first 300 chars):", JSON.stringify(items).slice(0, 300));
      // Try to find userIds
      const s = JSON.stringify(j);
      const m = s.match(/"userIds?":\s*\[(\d+)/);
      if (m) console.log("\n→ Found userId:", m[1]);
    } catch {
      console.log("  body (non-JSON, first 200 chars):", alertsBody.slice(0, 200));
    }
  } else {
    console.log("  body (first 200 chars):", alertsBody.slice(0, 200));
  }
}

main().catch((err: Error) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
