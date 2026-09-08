import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

type Classification =
  | "direct_v1"
  | "compositional_v1_with_invariant"
  | "control_plane_local"
  | "additive_v1_change"
  | "missing_fixture_docs"
  | "breaking_v2_work";

interface Fact {
  id: string;
  classification: Classification;
  wire: string;
  evidence: string[];
  invariant: string;
  correction?: { kind: string; target: string; fixtures: string[] };
}

const specDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "spec",
);
const crosswalkPath = resolve(specDir, "prp-v1-expressiveness-crosswalk.json");
const schemaPath = resolve(specDir, "prp-v1-expressiveness-crosswalk.schema.json");
const crosswalk = JSON.parse(readFileSync(crosswalkPath, "utf8")) as { facts: Fact[] };
const crosswalkSchema = JSON.parse(readFileSync(schemaPath, "utf8"));

describe("PRP v1 expressiveness crosswalk", () => {
  it("conforms to its self-describing JSON schema", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(crosswalkSchema);
    const valid = validate(crosswalk);
    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(valid).toBe(true);
  });

  it("classifies every required audit fact with concrete evidence", () => {
    const expected = [
      "semantic-tool-exposure", "semantic-tool-call-result", "semantic-tool-denial-and-redaction",
      "optimistic-write-conflict", "artifacts-and-deliverables", "governance-links-and-interactions",
      "blockers-monitors-and-wakes", "budget-cost-stop-reason", "audit-and-idempotency-receipts",
      "capability-negotiation-and-unsupported", "end-to-end-causality",
      "control-plane-local-lifecycle", "future-cross-company-and-destructive-admin",
      "existing-fixture-and-doc-coverage",
    ];
    expect(crosswalk.facts.map((fact) => fact.id).sort()).toEqual(expected.sort());
    for (const fact of crosswalk.facts) {
      expect(fact.evidence.length).toBeGreaterThan(0);
      expect(fact.invariant.length).toBeGreaterThan(0);
      expect(fact.invariant).not.toMatch(/^payload/i);
      if (fact.classification === "control_plane_local" || fact.classification === "breaking_v2_work") {
        expect(fact.wire).toBe("none");
      }
      if (fact.classification === "additive_v1_change") {
        expect(fact.correction?.fixtures.length).toBeGreaterThan(0);
        expect(fact.correction?.target.length).toBeGreaterThan(0);
      }
    }
  });

  it("has no unlanded additive receipt or fixture/document gap", () => {
    expect(
      crosswalk.facts.filter((fact) =>
        fact.classification === "additive_v1_change"
        || fact.classification === "missing_fixture_docs",
      ),
    ).toEqual([]);
  });
});
