import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { parseDocument } from "yaml";
import type { ChatScenario } from "./chat-feature-cases.js";
import { evaluateMatcher } from "./matchers.js";

it("validates the complete planned chat catalog against its schema and feature map", async () => {
  const catalog = new URL("./chat-scenarios/", import.meta.url);
  const maps = new URL("../../maps/feature-map/", import.meta.url);
  const schema = JSON.parse(readFileSync(new URL("catalog.schema.json", catalog), "utf8"));
  const areas = readdirSync(catalog).filter(name => name.endsWith(".yaml") && name !== "defaults.yaml").sort();
  const features = readdirSync(maps).filter(name => name.endsWith(".md") && name !== "README.md").map(name => name.slice(0, -3)).sort();
  expect(areas.map(name => name.slice(0, -5))).toEqual(features);
  expect(areas).toHaveLength(35);
  const ids = new Set<string>();
  const covered = new Set<string>();
  const mapped = new Set<string>();
  for (const name of areas) {
    const feature = name.slice(0, -5);
    const document = parseDocument(readFileSync(new URL(name, catalog), "utf8"), { uniqueKeys: true });
    expect(document.errors, name).toEqual([]);
    const value = document.toJS();
    const validation = await evaluateMatcher({ kind: "json_schema", schema }, { json: value });
    expect(validation.passed, `${name}: ${validation.detail}`).toBe(true);
    expect(value.feature, name).toBe(feature);
    for (const scenario of value.scenarios as ChatScenario[]) {
      expect(scenario.id.startsWith(`${feature}.`), scenario.id).toBe(true);
      expect(ids.has(scenario.id), `Duplicate scenario: ${scenario.id}`).toBe(false);
      ids.add(scenario.id);
      scenario.capabilities.forEach(id => covered.add(id));
    }
    const source = readFileSync(new URL(`${feature}.md`, maps), "utf8");
    const subfeatures = source.split(/^## Sub-features\s*$/m)[1]?.split(/^## /m)[0] ?? "";
    const capabilities = [...subfeatures.matchAll(/^- `([^`]+)`:/gm)].map(match => `${feature}/${match[1]}`);
    expect(capabilities.length, feature).toBeGreaterThan(0);
    capabilities.forEach(id => mapped.add(id));
  }
  expect(ids.size).toBe(244);
  expect([...covered].sort()).toEqual([...mapped].sort());
  expect(mapped.size).toBe(191);
  const defaults = parseDocument(readFileSync(new URL("defaults.yaml", catalog), "utf8"), { uniqueKeys: true });
  expect(defaults.errors).toEqual([]);
  expect(defaults.toJS()).toMatchObject({ schema_version: 1, status: "planned" });
  for (const value of Object.values(defaults.toJS().default_context)) {
    expect(value).toBeTypeOf("string");
    expect(String(value).trim()).not.toBe("");
  }
});
