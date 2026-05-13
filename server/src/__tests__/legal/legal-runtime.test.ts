import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  bootLegalRuntime,
  defaultLegalLayerPaths,
  evaluateGates,
  loadRiskGates,
  loadProfile,
  loadProfiles,
  selectProfile,
} from "../../services/legal/index.js";

async function makeLegalLayerFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "odysseus-legal-fixture-"));
  await mkdir(path.join(root, "risk-gates"), { recursive: true });
  await mkdir(path.join(root, "profiles"), { recursive: true });

  await writeFile(
    path.join(root, "risk-gates", "filing.yaml"),
    `gate: filing
display_name: "Court / Agency Filing"
triggers:
  - artifact_kind: court_filing
  - action: submit_to_court
  - keyword_in_deliverable:
      - "for filing"
      - "motion"
evidence_required:
  - assigned_attorney_of_record
  - jurisdiction
approval:
  approver_resolved_from: "active_profile.risk_gates.filing.approver"
  auto_block_resolved_from: "active_profile.risk_gates.filing.auto_block"
hard_blocks:
  - "No filing may proceed without a named attorney_of_record."
`,
    "utf8",
  );

  await writeFile(
    path.join(root, "risk-gates", "budget-threshold.yaml"),
    `gate: budget-threshold
display_name: "Budget threshold"
triggers: []
approval:
  approver_resolved_from: "active_profile.risk_gates.budget-threshold.approver"
`,
    "utf8",
  );

  await writeFile(
    path.join(root, "profiles", "small-firm.yaml"),
    `profile: small-firm
display_name: "Small Law Firm"
practice_areas: [commercial]
specialists_enabled:
  commercial: [nda-drafter]
mcp_connectors: []
required_secrets: []
risk_gates:
  filing:
    approver: partner
    auto_block: true
    rationale: "All court filings require partner signoff."
  budget-threshold:
    approver: billing-partner
    auto_block: true
    threshold_usd: 500
`,
    "utf8",
  );

  return root;
}

describe("legal runtime boot", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeLegalLayerFixture();
  });

  it("defaultLegalLayerPaths resolves repo-root-relative directories", () => {
    const paths = defaultLegalLayerPaths("/repo");
    expect(paths.riskGatesDir).toBe("/repo/risk-gates");
    expect(paths.profilesDir).toBe("/repo/profiles");
  });

  it("loads all risk gates and the named profile", async () => {
    const runtime = await bootLegalRuntime({
      riskGatesDir: path.join(root, "risk-gates"),
      profilesDir: path.join(root, "profiles"),
      profileKey: "small-firm",
    });
    expect(Object.keys(runtime.gates).sort()).toEqual(["budget-threshold", "filing"]);
    expect(runtime.profile.profile).toBe("small-firm");
  });

  it("rejects an unknown profile key", async () => {
    await expect(
      bootLegalRuntime({
        riskGatesDir: path.join(root, "risk-gates"),
        profilesDir: path.join(root, "profiles"),
        profileKey: "no-such-profile",
      }),
    ).rejects.toThrow(/Profile 'no-such-profile' not found/);
  });

  it("evaluate() fires the filing gate on artifact_kind match", async () => {
    const runtime = await bootLegalRuntime({
      riskGatesDir: path.join(root, "risk-gates"),
      profilesDir: path.join(root, "profiles"),
      profileKey: "small-firm",
    });
    const firings = runtime.evaluate({
      artifactKind: "court_filing",
      matterId: "matter-abc",
    });
    expect(firings).toHaveLength(1);
    expect(firings[0]?.gateKey).toBe("filing");
    expect(firings[0]?.matchedTrigger).toBe("artifact_kind=court_filing");
    expect(firings[0]?.approverRole).toBe("partner");
    expect(firings[0]?.autoBlock).toBe(true);
    expect(firings[0]?.evidenceRequired).toContain("assigned_attorney_of_record");
    expect(firings[0]?.hardBlocks).toHaveLength(1);
  });

  it("evaluate() fires on action match", async () => {
    const runtime = await bootLegalRuntime({
      riskGatesDir: path.join(root, "risk-gates"),
      profilesDir: path.join(root, "profiles"),
      profileKey: "small-firm",
    });
    const firings = runtime.evaluate({ action: "submit_to_court" });
    expect(firings.map((f) => f.gateKey)).toContain("filing");
  });

  it("evaluate() fires on keyword in deliverable text (case-insensitive)", async () => {
    const runtime = await bootLegalRuntime({
      riskGatesDir: path.join(root, "risk-gates"),
      profilesDir: path.join(root, "profiles"),
      profileKey: "small-firm",
    });
    const firings = runtime.evaluate({
      deliverableText: "Draft MOTION to dismiss",
    });
    expect(firings).toHaveLength(1);
    expect(firings[0]?.matchedTrigger).toBe("keyword_in_deliverable=motion");
  });

  it("evaluate() fires budget-threshold gate when cost crosses profile threshold", async () => {
    const runtime = await bootLegalRuntime({
      riskGatesDir: path.join(root, "risk-gates"),
      profilesDir: path.join(root, "profiles"),
      profileKey: "small-firm",
    });
    const cheap = runtime.evaluate({ costUsd: 100 });
    expect(cheap).toEqual([]);

    const expensive = runtime.evaluate({ costUsd: 750 });
    expect(expensive.map((f) => f.gateKey)).toEqual(["budget-threshold"]);
    expect(expensive[0]?.matchedTrigger).toBe("cost_usd>=500");
    expect(expensive[0]?.approverRole).toBe("billing-partner");
  });

  it("returns no firings when context matches no triggers", async () => {
    const runtime = await bootLegalRuntime({
      riskGatesDir: path.join(root, "risk-gates"),
      profilesDir: path.join(root, "profiles"),
      profileKey: "small-firm",
    });
    expect(runtime.evaluate({ action: "send_dm" })).toEqual([]);
  });
});

describe("loader edge cases", () => {
  it("rejects a yaml without 'gate' key", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "odysseus-bad-gate-"));
    await writeFile(path.join(tmp, "bad.yaml"), "display_name: oops\n", "utf8");
    await expect(loadRiskGates(tmp)).rejects.toThrow(/missing 'gate' string key/);
  });

  it("rejects duplicate gate keys across files", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "odysseus-dup-gate-"));
    const body = `gate: filing
display_name: a
triggers: []
approval:
  approver_resolved_from: active_profile.risk_gates.filing.approver
`;
    await writeFile(path.join(tmp, "a.yaml"), body, "utf8");
    await writeFile(path.join(tmp, "b.yaml"), body, "utf8");
    await expect(loadRiskGates(tmp)).rejects.toThrow(/Duplicate risk-gate key 'filing'/);
  });

  it("loadProfile parses a single profile YAML", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "odysseus-profile-load-"));
    const profilePath = path.join(tmp, "x.yaml");
    await writeFile(
      profilePath,
      `profile: x
display_name: X
practice_areas: []
specialists_enabled: {}
mcp_connectors: []
required_secrets: []
risk_gates: {}
`,
      "utf8",
    );
    const profile = await loadProfile(profilePath);
    expect(profile.profile).toBe("x");
  });

  it("selectProfile throws with helpful message listing known profiles", async () => {
    expect(() =>
      selectProfile(
        { "small-firm": { profile: "small-firm" } as never },
        "in-house-dept",
      ),
    ).toThrow(/Known profiles: small-firm/);
  });
});

describe("evaluateGates directly (without boot)", () => {
  it("throws when profile cannot resolve the approver path", () => {
    const gates = {
      filing: {
        gate: "filing",
        display_name: "Filing",
        triggers: [{ action: "submit_to_court" }],
        approval: {
          approver_resolved_from: "active_profile.risk_gates.filing.approver",
        },
      },
    };
    const profile = {
      profile: "p",
      display_name: "P",
      practice_areas: [],
      specialists_enabled: {},
      mcp_connectors: [],
      required_secrets: [],
      risk_gates: {}, // empty — filing gate has no profile binding
    };
    expect(() => evaluateGates({ action: "submit_to_court" }, gates as never, profile as never)).toThrow(
      /does not resolve approver for gate 'filing'/,
    );
  });
});

describe("real shipped legal layer", () => {
  it("loads risk-gates/*.yaml and profiles/*.yaml from the repo root", async () => {
    // The server test runs from server/ — repo root is two levels up.
    const repoRoot = path.resolve(__dirname, "../../../..");
    const paths = defaultLegalLayerPaths(repoRoot);
    const gates = await loadRiskGates(paths.riskGatesDir);
    expect(Object.keys(gates).sort()).toEqual([
      "budget-threshold",
      "external-communication",
      "filing",
      "privileged-disclosure",
      "signed-document",
    ]);
    const profiles = await loadProfiles(paths.profilesDir);
    expect(Object.keys(profiles).sort()).toEqual(["in-house-dept", "small-firm"]);
  });
});
