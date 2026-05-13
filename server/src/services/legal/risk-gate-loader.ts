import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import type { RiskGateDefinition } from "./types.js";

/**
 * Load and validate a single risk-gate YAML file.
 *
 * Throws if the file is missing the required `gate` key or `triggers` array,
 * since either omission means the file is structurally not a gate definition.
 */
export async function loadRiskGate(filePath: string): Promise<RiskGateDefinition> {
  const text = await readFile(filePath, "utf8");
  const parsed = parseYaml(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Risk-gate file is not a YAML object: ${filePath}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["gate"] !== "string" || obj["gate"].length === 0) {
    throw new Error(`Risk-gate file missing 'gate' string key: ${filePath}`);
  }
  if (!Array.isArray(obj["triggers"])) {
    throw new Error(`Risk-gate file '${obj["gate"]}' missing 'triggers' array: ${filePath}`);
  }
  return parsed as RiskGateDefinition;
}

/**
 * Load every `*.yaml` file in `dir` and return as a keyed map keyed by gate name.
 *
 * Throws if two files declare the same `gate` key.
 */
export async function loadRiskGates(dir: string): Promise<Record<string, RiskGateDefinition>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const yamlFiles = entries
    .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
    .map((e) => path.join(dir, e.name))
    .sort();

  const gates: Record<string, RiskGateDefinition> = {};
  for (const file of yamlFiles) {
    const gate = await loadRiskGate(file);
    if (gates[gate.gate]) {
      throw new Error(
        `Duplicate risk-gate key '${gate.gate}' loading ${file}; already defined`,
      );
    }
    gates[gate.gate] = gate;
  }
  return gates;
}
