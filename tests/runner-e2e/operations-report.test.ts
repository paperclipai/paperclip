import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openEvalCostLedger } from "./cost-ledger.js";
import { readEvalOperationsReport, renderEvalOperationsReport, validateEvalOperationsReport } from "./operations-report.js";
import { buildRunnerCampaign } from "./history.js";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";

it("reports shared setup/retry spending once, preserves unknown holds and omits private provider receipts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-operations-report-"));
  const file = path.join(root, "ledger.jsonl");
  const ledger = await openEvalCostLedger(file, { campaignId: "pilot", maxUsd: "1", deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 10, maxConcurrent: 2 });
  try {
    await ledger.reserve("setup", { executionId: "cell", attemptId: "first", phase: "setup" }, "0.2");
    await ledger.observe({ observationId: "gateway", requestId: "setup", provider: "fixture", providerRequestId: "private-provider-id", source: "gateway",
      currency: "USD", route: "direct", classification: "estimated", pricingVersion: "fixture", costUsd: "0.05", final: true });
    await ledger.observe({ observationId: "native", requestId: "setup", provider: "fixture", providerRequestId: "private-provider-id", source: "native_otlp",
      currency: "USD", route: "direct", classification: "reported", costUsd: "0.05", final: true });
    await ledger.finish("setup", "failed");
    await ledger.reserve("retry", { executionId: "cell", attemptId: "retry", phase: "agent" }, "0.2");
    await ledger.finish("retry", "cancelled");
    const report = await readEvalOperationsReport(file);
    validateEvalOperationsReport(report);
    if (report.status === "unavailable") throw new Error("Expected readable fixture ledger");
    expect(report).toMatchObject({ knownUsd: "0.050000000", heldUsd: "0.200000000", committedUsd: "0.250000000", requests: 2,
      unresolvedRequests: 1, inflight: 0, breakdown: { reported: "0.050000000", estimated: "0.000000000" },
      attempts: [{ attemptId: "first", requests: 1, knownUsd: "0.050000000" }, { attemptId: "retry", unresolvedRequests: 1, heldUsd: "0.200000000" }] });
    expect(JSON.stringify(report)).not.toContain("private-provider-id");
    const campaign = buildRunnerCampaign({ campaignId: "retry-campaign", generatedAt: new Date().toISOString(), expected: [], results: [], operations: report });
    expect(campaign.operations).toEqual(report);
    expect(campaign.billing.reportedLlmCostUsd).toBe(0);
    await writeFile(path.join(root, "normalized-results.json"), JSON.stringify(campaign));
    await regenerateRunnerDashboard({ bundle: root, historyFile: null });
    const rebuilt = JSON.parse(await readFile(path.join(root, "normalized-results.json"), "utf8"));
    expect(rebuilt.operations).toEqual(report);
    expect(await readFile(path.join(root, "dashboard.html"), "utf8")).toContain("$0.200000000 additional held reservations");
    expect(renderEvalOperationsReport(report)).toContain("Do not add its model subtotal to heartbeat totals");
    expect(renderEvalOperationsReport(report)).toContain("Unrecorded infrastructure, storage, subscriptions");
    expect(() => validateEvalOperationsReport({ ...report, secret: "forbidden" } as never)).toThrow("Invalid retained");
    expect(() => validateEvalOperationsReport({ ...report, knownUsd: "0.060000000" })).toThrow("Invalid retained");
    expect(() => validateEvalOperationsReport({ ...report, attempts: [] })).toThrow("Invalid retained");
    expect(() => validateEvalOperationsReport({ ...report, deadlineAt: "Tue, 20 Oct 2026 01:00:00 GMT (private note)" })).toThrow("Invalid retained");
  } finally { await ledger.close(); await rm(root, { recursive: true, force: true }); }
});

it("publishes the parsed deadline without private text accepted by the journal's date parser", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-operations-report-")), file = path.join(root, "ledger.jsonl");
  const deadlineAt = "Thu, 01 Jan 2099 00:00:00 GMT (private budget rationale)";
  const ledger = await openEvalCostLedger(file, { campaignId: "pilot", maxUsd: "1", deadlineAt, maxRequests: 10, maxConcurrent: 2 });
  try {
    const report = await readEvalOperationsReport(file);
    expect(report).toMatchObject({ deadlineAt: "2099-01-01T00:00:00.000Z" });
    expect(JSON.stringify(report)).not.toContain("private budget rationale");
    expect(await readFile(file, "utf8")).toContain(deadlineAt);
  } finally { await ledger.close(); await rm(root, { recursive: true, force: true }); }
});

it("preserves reports with explicit unknown accounting after a partial journal write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-operations-report-")), file = path.join(root, "ledger.jsonl");
  const ledger = await openEvalCostLedger(file, { campaignId: "pilot", maxUsd: "1", deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 10, maxConcurrent: 2 });
  await ledger.reserve("request", { executionId: "cell", attemptId: "attempt", phase: "setup" }, "0.2");
  await ledger.close();
  try {
    await writeFile(file, '{"partial-record":', { flag: "a" });
    const damaged = await readFile(file, "utf8");
    const report = await readEvalOperationsReport(file);
    expect(report).toEqual({ version: 1, scope: "shared_gateway_ledger", status: "unavailable" });
    validateEvalOperationsReport(report);
    expect(renderEvalOperationsReport(report)).toContain("Request amounts, counts, and held reservations are unknown");
    expect(renderEvalOperationsReport(report)).not.toContain("$0");
    expect(() => validateEvalOperationsReport({ ...report, knownUsd: "0.000000000" } as never)).toThrow("Invalid retained");
    const campaign = buildRunnerCampaign({ campaignId: "damaged-ledger", generatedAt: new Date().toISOString(), expected: [], results: [], operations: report });
    await writeFile(path.join(root, "normalized-results.json"), JSON.stringify(campaign));
    await regenerateRunnerDashboard({ bundle: root, historyFile: null });
    const rebuilt = JSON.parse(await readFile(path.join(root, "normalized-results.json"), "utf8"));
    expect(rebuilt.operations).toEqual(report);
    expect(await readFile(path.join(root, "dashboard.html"), "utf8")).toContain("Request ledger accounting unavailable");
    expect(await readFile(file, "utf8")).toBe(damaged);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps an in-flight final receipt reserved until the forwarding request finishes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-operations-report-")), file = path.join(root, "ledger.jsonl");
  const ledger = await openEvalCostLedger(file, { campaignId: "pilot", maxUsd: "1", deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 10, maxConcurrent: 2 });
  try {
    await ledger.reserve("request", { executionId: "cell", attemptId: "attempt", phase: "agent" }, "0.2");
    await ledger.observe({ observationId: "usage", requestId: "request", provider: "fixture", source: "provider", currency: "USD", route: "direct", classification: "reported", costUsd: "0.05", final: true });
    const report = await readEvalOperationsReport(file);
    validateEvalOperationsReport(report);
    expect(report).toMatchObject({ inflight: 1, knownUsd: "0.050000000", heldUsd: "0.150000000", committedUsd: "0.200000000", unresolvedRequests: 0 });
  } finally { await ledger.close(); await rm(root, { recursive: true, force: true }); }
});
