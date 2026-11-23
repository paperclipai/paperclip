import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as generator from "../../../scripts/generate-antigravity-models.mjs";

const declarationPath = resolve(import.meta.dirname, "../../../antigravity-distributions.json");
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function scratch() { const directory = await mkdtemp(join(tmpdir(), "antigravity-catalog-")); temporary.push(directory); return directory; }

const SOURCE = `
_HIGH_MEDIUM_LOW = (
    sdk_types_module.ThinkingLevel.HIGH,
    sdk_types_module.ThinkingLevel.MEDIUM,
    sdk_types_module.ThinkingLevel.LOW,
)

DEFAULT_MODEL_METADATA_MAP = {
    # Agent Platform only.
    **_thinking_family(
        "gemini-4-neon",
        "Gemini 4 Neon",
        (
            sdk_types_module.ThinkingLevel.HIGH,
            sdk_types_module.ThinkingLevel.EXTRA_HIGH,
        ),
        max_tokens=1_048_576,
        agent_platform_only=True,
    ),
    **_thinking_family(
        "gemini-3.8-flash",
        "Gemini 3.8 Flash",
        _HIGH_MEDIUM_LOW,
        max_tokens=1_048_576,
    ),
}
`;

describe("Antigravity model catalog generator", () => {
  it("accepts the committed catalog against the checked-in runtime declaration", async () => {
    const catalog = await generator.checkAntigravityModelCatalog();
    expect(catalog.apiKey.models).toHaveLength(14);
    expect(catalog.source.runtimeVersion).toBe("1.5.2");
  });

  it("rejects the catalog once the pinned runtime changes", async () => {
    const directory = await scratch();
    const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
    declaration.version = "1.5.3";
    await writeFile(join(directory, "declaration.json"), JSON.stringify(declaration));
    await expect(generator.checkAntigravityModelCatalog({ declarationPath: join(directory, "declaration.json") })).rejects.toThrow(/stale/);
    declaration.version = "1.5.2";
    declaration.platforms["darwin-arm64"].archiveSha256 = "0".repeat(64);
    await writeFile(join(directory, "declaration.json"), JSON.stringify(declaration));
    await expect(generator.checkAntigravityModelCatalog({ declarationPath: join(directory, "declaration.json") })).rejects.toThrow(/stale/);
  });

  it("rejects a hand-edited catalog", async () => {
    const directory = await scratch();
    const edited = (await readFile(generator.ANTIGRAVITY_MODELS_OUTPUT, "utf8")).replace('"gemini-3.1-pro-low"', '"gemini-3.1-pro-medium"');
    await writeFile(join(directory, "catalog.ts"), edited);
    await expect(generator.checkAntigravityModelCatalog({ output: join(directory, "catalog.ts") })).rejects.toThrow();
  });

  it("reads families and levels from the server's catalog table", () => {
    expect(generator.parseAntigravityCatalogSource(SOURCE)).toEqual([
      { id: "gemini-4-neon", label: "Gemini 4 Neon", baseModelId: "gemini-4-neon", levels: ["high", "extra_high"], agentPlatformOnly: true },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", baseModelId: "gemini-3.8-flash", levels: ["high", "medium", "low"], agentPlatformOnly: false },
    ]);
  });

  it("stops on a catalog shape it does not understand", () => {
    expect(() => generator.parseAntigravityCatalogSource(SOURCE.replace("max_tokens=1_048_576,\n        agent_platform_only", "max_tokens=1_048_576,\n        gateway_only=True,\n        agent_platform_only"))).toThrow(/does not understand/);
    expect(() => generator.parseAntigravityCatalogSource(SOURCE.replace("ThinkingLevel.EXTRA_HIGH", "ThinkingLevel.ULTRA"))).toThrow(/unknown thinking level/);
    expect(() => generator.parseAntigravityCatalogSource(SOURCE.replace("**_thinking_family(\n        \"gemini-4-neon\"", "\"custom\": meta,\n    **_thinking_family(\n        \"gemini-4-neon\""))).toThrow();
  });

  it("refuses to generate when the live session disagrees with the table", () => {
    const families = generator.parseAntigravityCatalogSource(SOURCE);
    const binding = { runtimeVersion: "1.5.2", platform: "darwin-arm64", archiveSha256: "a", vendorClosureSha256: "b" };
    const live = { defaultModelId: "gemini-3.8-flash-high", models: ["high", "medium", "low"].map(level => ({ id: `gemini-3.8-flash-${level}`, label: `Gemini 3.8 Flash (${level})` })) };
    expect(generator.buildAntigravityModelCatalog({ families, live, binding }).apiKey.models).toHaveLength(3);
    expect(() => generator.buildAntigravityModelCatalog({ families, live: { ...live, models: live.models.slice(1) }, binding })).toThrow(/differs/);
    expect(() => generator.buildAntigravityModelCatalog({ families, live: { ...live, defaultModelId: "gemini-4-neon-high" }, binding })).toThrow(/default/);
  });
});
