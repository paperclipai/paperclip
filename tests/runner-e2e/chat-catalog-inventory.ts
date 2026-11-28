import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { parseDocument } from "yaml";
import type { ChatScenario } from "./chat-feature-cases.js";

export interface CatalogChatScenario extends ChatScenario { feature: string; sourceFile: string }
const directory = new URL("./chat-scenarios/", import.meta.url);
export const chatCatalogScenarios: readonly CatalogChatScenario[] = readdirSync(directory)
  .filter(name => name.endsWith(".yaml") && name !== "defaults.yaml").sort().flatMap(name => {
    const document = parseDocument(readFileSync(new URL(name, directory), "utf8"), { uniqueKeys: true });
    if (document.errors.length) throw new Error(`Invalid chat catalog file ${name}`);
    const catalog = document.toJS();
    const feature = name.slice(0, -5);
    if (catalog.schema_version !== 1 || catalog.feature !== feature || catalog.status !== "planned" || !Array.isArray(catalog.scenarios))
      throw new Error(`Unsupported chat catalog file ${name}`);
    return catalog.scenarios.map((scenario: ChatScenario) => {
      if (!scenario.id.startsWith(`${feature}.`) || [scenario.context, scenario.query, scenario.expected_outcome].some(value => typeof value !== "string" || !value.trim())
        || !Array.isArray(scenario.capabilities) || scenario.capabilities.length === 0)
        throw new Error(`Invalid scenario in ${name}`);
      return { ...scenario, feature, sourceFile: `tests/runner-e2e/chat-scenarios/${name}` };
    });
  }).sort((a, b) => a.id.localeCompare(b.id));
if (chatCatalogScenarios.length !== 244 || new Set(chatCatalogScenarios.map(row => row.id)).size !== 244)
  throw new Error("Frozen chat catalog must contain exactly 244 unique scenarios");
/** Canonical semantic digest; whitespace changes alone do not alter scenario meaning. */
export const chatCatalogSemanticDigest = createHash("sha256").update(JSON.stringify(chatCatalogScenarios.map(
  ({ id, capabilities, context, query, expected_outcome }) => ({ id, capabilities, context, query, expected_outcome }),
))).digest("hex");

/** Campaign freeze also binds original file bytes and shared context defaults. */
export const chatCatalogInventoryDigest = createHash("sha256").update(JSON.stringify({
  defaultsSha256: createHash("sha256").update(readFileSync(new URL("defaults.yaml", directory))).digest("hex"),
  scenarios: chatCatalogScenarios.map(({ id, capabilities, context, query, expected_outcome, sourceFile }) => ({
    id,
    scenarioSha256: createHash("sha256").update(JSON.stringify({ id, capabilities, context, query, expected_outcome })).digest("hex"),
    sourceSha256: createHash("sha256").update(readFileSync(new URL(`../../${sourceFile}`, import.meta.url))).digest("hex"),
  })),
})).digest("hex");
