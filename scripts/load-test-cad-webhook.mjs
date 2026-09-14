#!/usr/bin/env node
/**
 * Load test: CAD webhook endpoint at 500 events/min from a simulated agency.
 *
 * Usage:
 *   node scripts/load-test-cad-webhook.mjs [options]
 *
 * Options:
 *   --url         Base URL of the server (default: http://localhost:3000)
 *   --agency      Agency code (default: SFFD)
 *   --secret      HMAC secret for the agency (default: sffd-dev-secret-32bytes-padxxxxx)
 *   --rate        Events per minute (default: 500)
 *   --duration    Test duration in seconds (default: 60)
 *   --vendor      Payload format: generic|tritech|motorola (default: generic)
 *
 * Acceptance criteria:
 *   - No duplicate alerts (incidentId conflict handled by upsert)
 *   - Alert correlation lag ≤ 30s (measured as p95 roundtrip latency)
 */

import { createHmac } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) {
      acc.push([arg.slice(2), arr[i + 1] ?? true]);
    }
    return acc;
  }, []),
);

const BASE_URL = args.url ?? "http://localhost:3000";
const AGENCY_CODE = args.agency ?? "SFFD";
const SECRET = args.secret ?? "sffd-dev-secret-32bytes-padxxxxx";
const RATE = parseInt(String(args.rate ?? 500), 10);
const DURATION_S = parseInt(String(args.duration ?? 60), 10);
const VENDOR = args.vendor ?? "generic";

const INTERVAL_MS = Math.floor(60_000 / RATE); // ms between events

function makeSignature(body) {
  return "sha256=" + createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

function buildPayload(seq) {
  const incidentId = `LOAD-TEST-${Date.now()}-${seq}`;
  const reportedAt = new Date().toISOString();

  if (VENDOR === "tritech") {
    return {
      contentType: "application/json",
      body: JSON.stringify({
        CallNumber: incidentId,
        NatureOfCall: `Load Test Event ${seq}`,
        CallType: "TEST",
        Latitude: 37.7749 + (Math.random() - 0.5) * 0.1,
        Longitude: -122.4194 + (Math.random() - 0.5) * 0.1,
        CallEnteredDateTime: reportedAt,
        Agency: AGENCY_CODE,
      }),
    };
  }

  if (VENDOR === "motorola") {
    const lat = (37.7749 + (Math.random() - 0.5) * 0.1).toFixed(6);
    const lon = (-122.4194 + (Math.random() - 0.5) * 0.1).toFixed(6);
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<PremierOneEvent xmlns:pm="urn:motorola:premierone:cad:v1">
  <pm:IncidentNumber>${incidentId}</pm:IncidentNumber>
  <pm:NatureOfCall>Load Test Event ${seq}</pm:NatureOfCall>
  <pm:IncidentCategory>TEST</pm:IncidentCategory>
  <pm:Latitude>${lat}</pm:Latitude>
  <pm:Longitude>${lon}</pm:Longitude>
  <pm:CallReceivedDateTime>${reportedAt}</pm:CallReceivedDateTime>
  <pm:AgencyCode>${AGENCY_CODE}</pm:AgencyCode>
</PremierOneEvent>`;
    return { contentType: "application/xml", body };
  }

  // generic JSON
  return {
    contentType: "application/json",
    body: JSON.stringify({
      incident_id: incidentId,
      incident_name: `Load Test Event ${seq}`,
      incident_type: "TEST",
      lat: 37.7749 + (Math.random() - 0.5) * 0.1,
      lon: -122.4194 + (Math.random() - 0.5) * 0.1,
      reported_at: reportedAt,
      agency_code: AGENCY_CODE,
    }),
  };
}

async function sendEvent(seq) {
  const { contentType, body } = buildPayload(seq);
  const sig = makeSignature(body);
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/cad/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "x-cad-signature": sig,
        "x-cad-agency-code": AGENCY_CODE,
      },
      body,
    });
    const latency = Date.now() - start;
    return { ok: res.status === 200 || res.status === 201, status: res.status, latency };
  } catch (err) {
    return { ok: false, status: 0, latency: Date.now() - start, error: err.message };
  }
}

async function main() {
  console.log(`CAD webhook load test`);
  console.log(`  URL:      ${BASE_URL}/api/cad/webhook`);
  console.log(`  Agency:   ${AGENCY_CODE}`);
  console.log(`  Vendor:   ${VENDOR}`);
  console.log(`  Rate:     ${RATE} events/min (~1 every ${INTERVAL_MS}ms)`);
  console.log(`  Duration: ${DURATION_S}s`);
  console.log();

  const stats = { sent: 0, ok: 0, errors: 0, latencies: [] };
  const endAt = Date.now() + DURATION_S * 1000;
  let seq = 0;

  // Run at ~RATE events/min using a timer
  await new Promise((resolve) => {
    const interval = setInterval(async () => {
      if (Date.now() >= endAt) {
        clearInterval(interval);
        resolve();
        return;
      }
      seq++;
      stats.sent++;
      const result = await sendEvent(seq);
      if (result.ok) {
        stats.ok++;
      } else {
        stats.errors++;
        if (stats.errors <= 5) {
          console.error(`  [seq=${seq}] Error: status=${result.status} ${result.error ?? ""}`);
        }
      }
      stats.latencies.push(result.latency);
    }, INTERVAL_MS);
  });

  // Wait for in-flight requests
  await new Promise((r) => setTimeout(r, 1000));

  stats.latencies.sort((a, b) => a - b);
  const p50 = stats.latencies[Math.floor(stats.latencies.length * 0.5)] ?? 0;
  const p95 = stats.latencies[Math.floor(stats.latencies.length * 0.95)] ?? 0;
  const p99 = stats.latencies[Math.floor(stats.latencies.length * 0.99)] ?? 0;
  const successRate = stats.sent > 0 ? ((stats.ok / stats.sent) * 100).toFixed(1) : "0";

  console.log(`\nResults:`);
  console.log(`  Sent:          ${stats.sent}`);
  console.log(`  Successful:    ${stats.ok} (${successRate}%)`);
  console.log(`  Errors:        ${stats.errors}`);
  console.log(`  Latency p50:   ${p50}ms`);
  console.log(`  Latency p95:   ${p95}ms`);
  console.log(`  Latency p99:   ${p99}ms`);
  console.log();

  const pass = stats.errors === 0 && p95 <= 30_000;
  if (pass) {
    console.log("✓ PASS — no errors, p95 latency within 30s alert correlation budget");
  } else {
    if (stats.errors > 0) console.error(`✗ FAIL — ${stats.errors} errors`);
    if (p95 > 30_000) console.error(`✗ FAIL — p95 latency ${p95}ms exceeds 30s budget`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
