import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  renderOperationGroupsDocument,
  validateOperationGroupsInput,
} from "./operation-groups-doc.js";
import {
  loadOperationGroupsInput,
  operationGroupsPackageRoot,
} from "./operation-groups-inputs.js";

describe("canonical operation-groups specification", () => {
  const input = loadOperationGroupsInput();

  it("reconciles catalog, aliases, source/generated contracts, PRP schemas, scenarios, and exports", () => {
    expect(() => validateOperationGroupsInput(input)).not.toThrow();
  });

  it("rejects each protected catalog/alias/contract/export drift class", () => {
    const variants = [
      {
        name: "catalog",
        value: { ...input, canonicalOperations: input.canonicalOperations.slice(1) },
      },
      {
        name: "alias",
        value: { ...input, legacyAliases: input.legacyAliases.slice(1) },
      },
      {
        name: "source contract",
        value: {
          ...input,
          sourceContractToolMappings: {
            ...input.sourceContractToolMappings,
            paperclipMe: ["control_plane_owned", "unreviewed_target"] as const,
          },
        },
      },
      {
        name: "generated contract",
        value: {
          ...input,
          generatedContractOperationIds: input.generatedContractOperationIds.slice(1),
        },
      },
      {
        name: "package export",
        value: { ...input, rootIndexSource: "" },
      },
    ];
    for (const variant of variants) {
      expect(
        () => validateOperationGroupsInput(variant.value),
        `${variant.name} drift should fail`,
      ).toThrow(/Operation-groups drift detected/);
    }
  });

  it("accounts for every operation and all 16/106 behavior groups", () => {
    const behaviorOperationIds = new Set(
      input.source.behaviorGroups.flatMap((group) => group.operationIds),
    );
    expect(behaviorOperationIds).toEqual(
      new Set(input.canonicalOperations.map((operation) => operation.operationId)),
    );
    expect(input.source.behaviorGroups).toHaveLength(16);
    expect(input.scenarios).toHaveLength(106);
    expect(new Set(input.scenarios.map((scenario) => scenario.id)).size).toBe(106);
    expect(input.eventTypes).toHaveLength(65);
    expect(input.commandTypes).toHaveLength(13);
  });

  it("keeps the checked-in Markdown byte-identical to the generated contract", () => {
    const current = readFileSync(
      resolve(operationGroupsPackageRoot(), "spec/paperclip-agent-operation-groups.md"),
      "utf8",
    );
    expect(current).toBe(renderOperationGroupsDocument(input));
    for (const scenario of input.scenarios) {
      expect(current).toContain(`[\`${scenario.id}\`](`);
    }
    expect(current).not.toMatch(/(?:^|\/)phase-[0-9]/m);
  });
});
