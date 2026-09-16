import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_SEMANTIC_TOOL_CATALOG as SCENARIO_CATALOG,
  capabilitySemanticTool,
} from "../tools/capability-semantic-tool-catalog.js";

const docPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "capability-semantic-tools.md",
);
const doc = readFileSync(docPath, "utf8");

/** The catalog counts region, between the disposition prose and descriptor shape. */
function countsRegion(): string {
  const start = doc.indexOf("## Two dispositions");
  const end = doc.indexOf("## Descriptor shape");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end);
}

describe("capability-semantic-tools.md stays in sync with the catalog", () => {
  const always = SCENARIO_CATALOG.filter((tool) => tool.disposition === "always_agent_tool");
  const optional = SCENARIO_CATALOG.filter((tool) => tool.disposition === "optional_agent_tool");

  it("states the current total, always, and optional counts", () => {
    const region = countsRegion();
    const total = /holds \*\*(\d+) tools\*\*/.exec(region)?.[1];
    const alwaysProse = /(\d+) always-agent tools and (\d+) optional tools/.exec(region);
    const alwaysHeader = /### Always-agent tools \((\d+)\)/.exec(region)?.[1];
    const optionalHeader = /### Optional tools \((\d+)\)/.exec(region)?.[1];

    expect(Number(total)).toBe(SCENARIO_CATALOG.length);
    expect(Number(alwaysProse?.[1])).toBe(always.length);
    expect(Number(alwaysProse?.[2])).toBe(optional.length);
    expect(Number(alwaysHeader)).toBe(always.length);
    expect(Number(optionalHeader)).toBe(optional.length);
    // Guard against the historical 36-vs-37 drift the reconciliation plan flagged.
    expect(SCENARIO_CATALOG.length).toBe(37);
  });

  it("lists exactly the catalog's operation ids in the counts region", () => {
    const region = countsRegion();
    const backticked = new Set(
      [...region.matchAll(/`([a-z_]+)`/g)]
        .map((match) => match[1])
        .filter((id) => capabilitySemanticTool(id) !== undefined),
    );
    expect([...backticked].sort()).toEqual(
      SCENARIO_CATALOG.map((tool) => tool.operationId).sort(),
    );
  });
});
