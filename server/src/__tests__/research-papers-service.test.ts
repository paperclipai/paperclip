import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { researchPapersService } from "../services/research-papers.js";

let root: string;
let selfPracticeDir: string;
let candidatesFile: string;
let toolbeltDir: string;

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "research-papers-test-"));
  selfPracticeDir = path.join(root, "self_practice");
  candidatesFile = path.join(root, "paper-candidates.jsonl");
  toolbeltDir = path.join(root, "toolbelt");
  await mkdir(toolbeltDir, { recursive: true });

  const group = path.join(selfPracticeDir, "repro-repair-20260101");
  const famDir = path.join(group, "fixture-anomaly");
  const guardDir = path.join(group, "fixture-refuted-guard");
  const realRefutedDir = path.join(group, "fixture-refuted-real");
  const microDir = path.join(group, "micro-paper-099-fixture");
  await mkdir(famDir, { recursive: true });
  await mkdir(guardDir, { recursive: true });
  await mkdir(realRefutedDir, { recursive: true });
  await mkdir(microDir, { recursive: true });

  // --- family paper: claims missing + local kill (the common shape) ---
  await writeJson(path.join(famDir, "VERDICT.json"), {
    paper_reproduction_verdict: "CLAIM_VALUES_MISSING_PRIMARY_SOURCE",
    claim_value_status: "CLAIM_VALUES_MISSING_PRIMARY_SOURCE",
    comparability: "ADAPTATION_NOT_COMPARABLE",
    local_validation_verdict: "LOCAL_VALIDATION_KILL",
    not_a_paper_refutation: true,
    failing_gates: { strat: ["oos_sharpe_ge_0_50", "oos_cagr_ge_0_03"] },
    measured_numbers: { strat_oos_net: { sharpe: 0.1, cagr: 0.02, total_return: 0.05, max_drawdown: -0.1 } },
    target: "Fixture anomaly",
  });
  await writeFile(
    path.join(famDir, "PAPER_CLAIMS.yaml"),
    [
      "paper_family: fixture_anomaly",
      "primary_sources:",
      "  - Author (2020), A Paper",
      "  - Other (2019), Another Paper",
      "claim_value_status: CLAIM_VALUES_MISSING_PRIMARY_SOURCE",
      "paper_numeric_claims_extracted: false",
      "extracted_claims: []",
      "notes:",
      "  - Prior artifacts did not preserve table values.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeJson(path.join(famDir, "BENCHMARKS.json"), {
    benchmark_window: "2020..2026",
    buy_hold: { sharpe: 0.6, cagr: 0.1, total_return: 1.2, max_drawdown: -0.3 },
  });
  await writeJson(path.join(famDir, "LOCAL_VALIDATION_REPORT.json"), {
    local_validation_verdict: "LOCAL_VALIDATION_KILL",
    data_readiness: { first_date: "2010-01-01", last_date: "2026-01-01", rows: 100 },
  });
  await writeFile(path.join(famDir, "README.md"), "# Fixture anomaly repair\n\nLocal proxy only; not a paper refutation.\n", "utf8");

  // --- refuted GUARD: paper_refuted true but NO faithful reproduction attempted ---
  await writeJson(path.join(guardDir, "VERDICT.json"), {
    paper_reproduction_verdict: "DATA_BLOCKED",
    local_validation_verdict: "ADAPTATION_NOT_COMPARABLE",
    paper_refuted: true,
  });
  await writeJson(path.join(guardDir, "REPRODUCTION_REPORT.json"), {
    paper_reproduction_verdict: "DATA_BLOCKED",
    faithful_reproduction_attempted: false,
    paper_refuted: true,
  });

  // --- refuted REAL: faithful reproduction attempted AND refuted ---
  await writeJson(path.join(realRefutedDir, "REPRODUCTION_REPORT.json"), {
    paper_reproduction_verdict: "PAPER_REFUTED",
    faithful_reproduction_attempted: true,
    paper_refuted: true,
    title: "A Genuinely Refuted Paper",
  });

  // --- micro-addon paper enriched from the candidates ledger ---
  await writeJson(path.join(microDir, "VERDICT.json"), {
    local_validation_verdict: "ADAPTATION_NOT_COMPARABLE",
    measured_local_proxy_numbers: { trades_count: 10, net_return_after_costs: -5.2, sharpe_or_simple_score: -1.1 },
    safety: { broker_or_order_call: false, paid_data_requested: false },
  });
  await writeJson(path.join(microDir, "REPRODUCTION_REPORT.json"), {
    paper_id: "PAPER-099",
    matched_candidate_id: "PAPER-099",
    paper_reproduction_verdict: "CLAIM_VALUES_MISSING_PRIMARY_SOURCE",
    claim_value_status: "CLAIM_VALUES_MISSING_PRIMARY_SOURCE",
    paper_refuted: false,
    qualitative_claims_preserved: ["A qualitative claim survives."],
    faithful_reproduction_blockers: ["No local data."],
  });

  // LOOP_STATE maps dirs -> labels and provides flattened terminal verdicts.
  await writeJson(path.join(group, "LOOP_STATE.json"), {
    artifact_paths: {
      "Fixture anomaly": famDir,
      "Fixture micro": microDir,
    },
    terminal_verdicts: {
      "Fixture anomaly": {
        paper_reproduction_verdict: "CLAIM_VALUES_MISSING_PRIMARY_SOURCE",
        local_validation_verdict: "LOCAL_VALIDATION_KILL",
        strat_oos_net_sharpe: 0.1,
        strat_oos_net_cagr: 0.02,
      },
    },
  });

  // execution spike (different shape, no VERDICT.json)
  const spikeDir = path.join(selfPracticeDir, "nautilus-spike-20260101T000000Z");
  await mkdir(spikeDir, { recursive: true });
  await writeJson(path.join(spikeDir, "NAUTILUS_FIXTURE_TEST_REPORT.json"), {
    generated_utc: "2026-01-01T00:00:00Z",
    readiness: {
      status: "PASS_FOR_READ_ONLY",
      blockers: [],
      safety: { read_only: true, places_orders: false, paper_trades: false },
    },
    replay: { metrics: { sessions: 121, corr_paper: -0.09, slope_last_on_first_paper: -0.03 } },
  });
  await writeFile(path.join(spikeDir, "SPIKE.md"), "# Fixture replay spike\n\nRead-only deterministic replay.\n", "utf8");

  await writeFile(
    candidatesFile,
    [
      JSON.stringify({ id: "PAPER-099", title: "Fixture Micro Paper", authors: ["Jane Doe"], url: "https://example.com/p" }),
      "",
    ].join("\n"),
    "utf8",
  );
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("researchPapersService.overview", () => {
  it("discovers papers across groups and preserves the two verdict axes", async () => {
    const svc = researchPapersService({ selfPracticeDir, candidatesFile, toolbeltDir });
    const out = await svc.overview("company-1");

    expect(out.companyId).toBe("company-1");
    expect(out.safety).toMatchObject({ readOnly: true, brokerActions: false, paidComputeActions: false });
    expect(out.counts.total).toBe(5);
    expect(out.counts.byCategory).toMatchObject({ paper_family: 3, micro_addon: 1, execution_spike: 1 });

    const fam = out.papers.find((p) => p.slug === "fixture-anomaly");
    expect(fam).toBeDefined();
    // Title comes from the LOOP_STATE label.
    expect(fam!.title).toBe("Fixture anomaly");
    expect(fam!.paperReproductionVerdict).toBe("CLAIM_VALUES_MISSING_PRIMARY_SOURCE");
    expect(fam!.localValidationVerdict).toBe("LOCAL_VALIDATION_KILL");
    expect(fam!.notAPaperRefutation).toBe(true);
    expect(fam!.headlineTone).toBe("claims_missing");
    // Both axes surfaced as badges, paper axis is the headline.
    expect(fam!.badges.map((b) => b.tone)).toEqual(expect.arrayContaining(["claims_missing", "local_kill"]));
    // Primary sources parsed out of the YAML.
    expect(fam!.claims.primarySources).toEqual(["Author (2020), A Paper", "Other (2019), Another Paper"]);
    expect(fam!.claims.numericClaimsExtracted).toBe(false);
    // Metrics flattened from the LOOP_STATE terminal verdict + benchmarks.
    expect(fam!.measured.summary.some((m) => m.key === "strat_oos_net_sharpe")).toBe(true);
    expect(fam!.benchmark.summary.length).toBeGreaterThan(0);
    expect(fam!.failingGates).toMatchObject({ strat: ["oos_sharpe_ge_0_50", "oos_cagr_ge_0_03"] });
    // Chronological log is sorted and includes the verdict event + data window.
    expect(fam!.log.length).toBeGreaterThan(0);
    expect(fam!.log.some((e) => e.source === "VERDICT.json")).toBe(true);
    expect(fam!.log.some((e) => (e.detail ?? "").includes("Data window"))).toBe(true);
    const stamps = fam!.log.filter((e) => e.ts).map((e) => e.ts!);
    expect(stamps).toEqual([...stamps].sort());
    expect(fam!.artifacts.some((a) => a.kind === "verdict")).toBe(true);
  });

  it("NEVER marks a paper refuted unless a faithful reproduction was attempted", async () => {
    const svc = researchPapersService({ selfPracticeDir, candidatesFile, toolbeltDir });
    const out = await svc.overview("company-1");

    const guard = out.papers.find((p) => p.slug === "fixture-refuted-guard");
    expect(guard).toBeDefined();
    expect(guard!.paperRefuted).toBe(true);
    expect(guard!.faithfulReproductionAttempted).toBe(false);
    expect(guard!.headlineTone).not.toBe("refuted");
    expect(guard!.badges.some((b) => b.tone === "refuted")).toBe(false);

    const real = out.papers.find((p) => p.slug === "fixture-refuted-real");
    expect(real).toBeDefined();
    expect(real!.headlineTone).toBe("refuted");
    expect(real!.badges.some((b) => b.tone === "refuted")).toBe(true);
    expect(out.counts.byTone.refuted).toBe(1);
  });

  it("enriches micro-addon papers from the candidates ledger", async () => {
    const svc = researchPapersService({ selfPracticeDir, candidatesFile, toolbeltDir });
    const out = await svc.overview("company-1");

    const micro = out.papers.find((p) => p.slug === "micro-paper-099-fixture");
    expect(micro).toBeDefined();
    expect(micro!.category).toBe("micro_addon");
    expect(micro!.paperId).toBe("PAPER-099");
    expect(micro!.title).toBe("Fixture Micro Paper");
    expect(micro!.authors).toEqual(["Jane Doe"]);
    expect(micro!.sourceUrl).toBe("https://example.com/p");
    expect(micro!.claims.qualitativeClaims).toEqual(["A qualitative claim survives."]);
    expect(micro!.blockers).toEqual(["No local data."]);
    expect(micro!.safetyFlags).toMatchObject({ broker_or_order_call: false });
  });

  it("classifies the execution spike as read-only without a paper axis", async () => {
    const svc = researchPapersService({ selfPracticeDir, candidatesFile, toolbeltDir });
    const out = await svc.overview("company-1");

    const spike = out.papers.find((p) => p.category === "execution_spike");
    expect(spike).toBeDefined();
    expect(spike!.paperReproductionVerdict).toBeNull();
    expect(spike!.headlineTone).toBe("local_pass");
    expect(spike!.measured.summary.some((m) => m.key === "sessions")).toBe(true);
    expect(spike!.safetyFlags).toMatchObject({ read_only: true, places_orders: false });
  });

  it("degrades gracefully when the artifact root is missing", async () => {
    const svc = researchPapersService({
      selfPracticeDir: path.join(root, "does-not-exist"),
      candidatesFile: path.join(root, "missing.jsonl"),
      toolbeltDir: path.join(root, "missing-toolbelt"),
    });
    const out = await svc.overview("company-1");

    expect(out.counts.total).toBe(0);
    expect(out.papers).toEqual([]);
    expect(out.roots.some((r) => r.present === false)).toBe(true);
  });
});
