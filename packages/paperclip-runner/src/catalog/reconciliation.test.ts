import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CAPABILITY_SEMANTIC_TOOL_CATALOG as SCENARIO_CATALOG } from "../tools/capability-semantic-tool-catalog.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG as LIVE_CATALOG } from "../semantic-tools/catalog.js";
import {
  CAPABILITY_CANONICAL_OPERATIONS,
  capabilityCanonicalOperation,
} from "./canonical-operations.js";
import {
  CAPABILITY_CANONICAL_CATALOG,
  capabilityCatalogReconciliation,
} from "./reconciliation.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("canonical semantic-catalog reconciliation authority", () => {
  it("pins the reconciled op-set relationship between the two catalogs", () => {
    const summary = capabilityCatalogReconciliation();
    expect(summary.scenarioCount).toBe(37);
    expect(summary.liveCount).toBe(28);
    expect(summary.sharedCount).toBe(24);
    expect(summary.unionCount).toBe(41);
    // Any operation added to or removed from either catalog without a
    // reconciliation decision changes these exact sets and fails the gate.
    expect(summary.liveOnly).toEqual([
      "get_agent",
      "get_approval",
      "get_approval_context",
      "schedule_wake",
    ]);
    expect(summary.scenarioOnly).toEqual([
      "administer_company",
      "export_company",
      "inspect_operation_result",
      "list_cases",
      "list_company_skills",
      "list_goals",
      "list_projects",
      "list_routines",
      "list_secret_metadata",
      "manage_routine",
      "read_secret_value",
      "sync_company_skills",
      "upsert_case",
    ]);
  });

  it("is the single source both catalogs derive their operation set from", () => {
    expect(CAPABILITY_CANONICAL_OPERATIONS).toHaveLength(41);
    const canonicalIds = new Set(CAPABILITY_CANONICAL_OPERATIONS.map((operation) => operation.operationId));
    // Neither catalog may contain an operation absent from the canonical source.
    for (const tool of SCENARIO_CATALOG) expect(canonicalIds.has(tool.operationId)).toBe(true);
    for (const tool of LIVE_CATALOG) expect(canonicalIds.has(tool.operationId)).toBe(true);
    // Every canonical operation is projected onto the surface(s) it names.
    for (const operation of CAPABILITY_CANONICAL_OPERATIONS) {
      if (operation.surfaces.includes("scenario")) {
        expect(SCENARIO_CATALOG.some((tool) => tool.operationId === operation.operationId)).toBe(true);
      }
      if (operation.surfaces.includes("live")) {
        expect(LIVE_CATALOG.some((tool) => tool.operationId === operation.operationId)).toBe(true);
      }
    }
  });

  it("single-sources claims and task modes so the two catalogs cannot diverge", () => {
    for (const operation of CAPABILITY_CANONICAL_OPERATIONS) {
      const scenario = SCENARIO_CATALOG.find((tool) => tool.operationId === operation.operationId);
      const live = LIVE_CATALOG.find((tool) => tool.operationId === operation.operationId);
      if (scenario !== undefined) {
        expect([...scenario.requiredClaims].sort()).toEqual([...operation.requiredClaims].sort());
        expect([...scenario.taskModes].sort()).toEqual([...operation.taskModes].sort());
        expect(scenario.disposition).toBe(operation.placement);
      }
      if (live !== undefined) {
        expect([...live.requiredClaims].sort()).toEqual([...operation.requiredClaims].sort());
        expect([...live.allowedModes].sort()).toEqual([...operation.taskModes].sort());
        expect(live.exposure).toBe(operation.placement === "always_agent_tool" ? "always" : "optional");
      }
    }
  });

  it("names placement, claims, task modes, side-effect class, idempotency, redaction, mock mapping, real binding status, and PRP evidence for every operation", () => {
    expect(CAPABILITY_CANONICAL_CATALOG).toHaveLength(41);
    for (const operation of CAPABILITY_CANONICAL_CATALOG) {
      expect(operation.placement).toMatch(/^(always|optional)_agent_tool$/);
      expect(Array.isArray(operation.requiredClaims)).toBe(true);
      expect(operation.taskModes.length).toBeGreaterThan(0);
      expect(operation.sideEffectClass.length).toBeGreaterThan(0);
      expect(["none", "required", "recommended"]).toContain(operation.idempotency);
      expect(typeof operation.redacts).toBe("boolean");
      expect(["live_codex", "scenario_mock", "test_only"]).toContain(operation.realBindingStatus);
      if (operation.prpBindingStatus === "bound") {
        expect(operation.realServiceBinding).not.toBe("unbound");
      } else {
        expect(operation.realServiceBinding).toBe("unbound");
      }
      expect(operation.prpEvidence.length).toBeGreaterThan(0);
      expect(["audit_pending", "bound"]).toContain(operation.prpBindingStatus);
      // Scenario-surface ops carry a mock mapping; live-only ops resolve inline.
      if (operation.surfaces.includes("scenario")) {
        expect(operation.mockCommandMapping).not.toBeNull();
      }
    }
  });

  it("classifies real binding status so generic_api_request is never product coverage", () => {
    const summary = capabilityCatalogReconciliation();
    expect(summary.byRealBindingStatus).toEqual({
      live_codex: 27,
      scenario_mock: 13,
      test_only: 1,
    });
    expect(capabilityCanonicalOperation("generic_api_request")?.realBindingStatus).toBe("test_only");
  });

  it("unifies the generic_api_request claim to a single test-only grant", () => {
    const canonical = capabilityCanonicalOperation("generic_api_request");
    expect(canonical?.requiredClaims).toEqual(["test:generic_api_request"]);
    const scenario = SCENARIO_CATALOG.find((tool) => tool.operationId === "generic_api_request");
    const live = LIVE_CATALOG.find((tool) => tool.operationId === "generic_api_request");
    expect(scenario?.requiredClaims).toEqual(["test:generic_api_request"]);
    expect(live?.requiredClaims).toEqual(["test:generic_api_request"]);
  });

  it("leaves zero claim or task-mode divergence, and only the reviewed input-schema projection", () => {
    const { divergences } = capabilityCatalogReconciliation();
    // No divergence may be left unrecorded, regardless of field.
    for (const divergence of divergences) {
      expect(divergence.disposition).not.toMatch(/UNRECORDED/);
    }
    const idsFor = (field: string): string[] =>
      divergences
        .filter((entry) => entry.field === field)
        .map((entry) => entry.operationId)
        .sort();

    // Claims and task modes are single-sourced from canonical-operations.ts, so
    // there is nothing left to reconcile on either field.
    expect(idsFor("requiredClaims")).toEqual([]);
    expect(idsFor("taskModes")).toEqual([]);

    // Input schemas remain a single contract projected two ways (idempotency
    // in-band for the provider, out-of-band for the observable runtime); every
    // entry carries the reviewed projection disposition.
    const inputSchema = divergences.filter((entry) => entry.field === "inputSchemaShape");
    expect(inputSchema.length).toBeGreaterThan(0);
    for (const divergence of inputSchema) {
      expect(divergence.disposition).toMatch(/Reviewed intentional projection/);
    }
  });

  it("gives every legacy MCP alias a reviewed disposition in the inventory", () => {
    const raw = readFileSync(
      resolve(packageRoot, "spec/capability/mcp-tool-map.yaml"),
      "utf8",
    );
    const inventory = JSON.parse(raw.replace(/^#.*$/m, ""));
    expect(inventory.inventoryRole).toBe("legacy_alias_index");
    expect(inventory.rows.length).toBeGreaterThan(0);
    const aliasIds = new Set<string>(inventory.rows.map((row: { id: string }) => row.id));
    for (const row of inventory.rows) {
      // Every alias is either folded into a native eval/operation or explicitly
      // dispositioned; a bare alias without a disposition fails the gate.
      expect(typeof row.foldedInto === "string" && row.foldedInto.length > 0).toBe(true);
    }
    // Every legacy alias named by the canonical authority must be a real
    // inventory row, so a native-mapping note cannot reference a phantom alias.
    for (const operation of CAPABILITY_CANONICAL_OPERATIONS) {
      for (const alias of operation.legacyAliases) {
        expect(aliasIds.has(alias)).toBe(true);
      }
    }
  });
});
