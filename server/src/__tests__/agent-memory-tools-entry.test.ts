import { describe, expect, it } from "vitest";
import {
  AGENT_MEMORY_ENABLED_ENV,
  AGENT_MEMORY_BACKFILL_ENABLED_ENV,
  AGENT_MEMORY_ENTRY_KEY,
  AGENT_MEMORY_TOOLS_ENABLED_ENV,
  AGENT_MEMORY_TOOLS_ENTRY_KEY,
  AGENT_MEMORY_URL_ENV,
  agentMemoryExcludedSetupKeys,
  agentMemoryToolsEligibleForNewAgent,
  agentMemoryToolsEnabled,
  agentMemoryToolsHarness,
} from "../services/default-mcp-agent-memory.js";
import { agentMemoryToolsBackfillSpec, missingEntryEnrollableKeys, missingEntryEligibleSpec } from "../services/default-mcp-missing-entry-enrollment.js";
import {
  ARCANA_STATIC_TEMPLATE_UID,
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_STATIC_CATALOG_CONFIG_KEY,
  staticCatalogAllowlist,
  staticCatalogReviewedRisk,
  validateStaticTemplateSpec,
  type DefaultMcpEntrySpec,
} from "../services/default-mcp-spec.js";
import { staticTemplateEntries } from "../services/default-mcp-static-template.js";

const ENTRY = DEFAULT_MCP_SPEC.find((entry) => entry.key === AGENT_MEMORY_TOOLS_ENTRY_KEY)!;
const MEMORY_URL = "https://memory.example.test";
const ON: NodeJS.ProcessEnv = {
  [AGENT_MEMORY_ENABLED_ENV]: "true",
  [AGENT_MEMORY_URL_ENV]: MEMORY_URL,
  [AGENT_MEMORY_TOOLS_ENABLED_ENV]: "true",
  [AGENT_MEMORY_BACKFILL_ENABLED_ENV]: "true",
};

describe("agent-memory-tools spec entry (TECH-8832)", () => {
  it("is a dedicated static-catalog entry for the three reviewed memory tools, never the admin purge", () => {
    expect(ENTRY.setupHook).toBe("agent_memory_tools");
    expect(ENTRY.templateBootstrap).toBe("static");
    expect(ENTRY.newAgentsOnly).toBe(true);
    expect(ENTRY.installByDefault).toBe(true);
    expect(ENTRY.defaultEnabled).toBe(false);
    expect(ENTRY.reviewedTools?.allow).toEqual(["memory_search", "memory_add", "memory_delete"]);
    expect(ENTRY.staticTemplate?.mcpUrl).toEqual({ env: AGENT_MEMORY_URL_ENV, path: "/mcp" });
    expect(ENTRY.staticTemplate?.uid).not.toBe(ARCANA_STATIC_TEMPLATE_UID);
  });

  it("declares real input schemas, and memory_delete as a reviewed non-destructive write", () => {
    const tools = ENTRY.staticTemplate!.tools!;
    expect(tools.memory_search!.inputSchema).toMatchObject({ required: ["query"] });
    expect(tools.memory_add!.inputSchema).toMatchObject({ required: ["text"] });
    expect(tools.memory_delete!.inputSchema).toMatchObject({ required: ["memory_id"] });
    expect(tools.memory_search!.riskLevel).toBe("read");
    expect(tools.memory_add).toMatchObject({ riskLevel: "write" });
    expect(tools.memory_delete).toMatchObject({ riskLevel: "write", isDestructive: false });
  });

  it("the static template spec of the shipped entries is structurally valid", () => {
    expect(validateStaticTemplateSpec(DEFAULT_MCP_SPEC)).toEqual([]);
  });

  it("rejects a static entry without its own uid, with a duplicate uid, or with a relative path", () => {
    const base: DefaultMcpEntrySpec = { ...ENTRY, key: "other-static", connectionName: "rh-other" };
    expect(validateStaticTemplateSpec([base, { ...base, staticTemplate: { ...ENTRY.staticTemplate!, uid: undefined } }, { ...base, key: "third", staticTemplate: undefined }])).toEqual(
      expect.arrayContaining([expect.stringContaining("staticTemplate.uid is required"), expect.stringContaining("needs staticTemplate")]),
    );
    const dup = validateStaticTemplateSpec([ENTRY, { ...ENTRY, key: "other-static" }]);
    expect(dup).toEqual([expect.stringContaining("duplicates agent-memory-tools")]);
    const relative = validateStaticTemplateSpec([{ ...ENTRY, staticTemplate: { ...ENTRY.staticTemplate!, mcpUrl: { env: AGENT_MEMORY_URL_ENV, path: "mcp" } } }]);
    expect(relative).toEqual([expect.stringContaining('must start with "/"')]);
    // Arcana's own entry needs no staticTemplate (its uid is implicit).
    const arcana = DEFAULT_MCP_SPEC.find((entry) => entry.key === "arcana-brain")!;
    expect(validateStaticTemplateSpec([arcana])).toEqual([]);
  });
});

describe("static catalog reviewed risk (refresh)", () => {
  const config = { [DEFAULT_MCP_STATIC_CATALOG_CONFIG_KEY]: AGENT_MEMORY_TOOLS_ENTRY_KEY };

  it("returns the spec-declared risk for a reviewed verb, so a live destructive hint cannot quarantine it", () => {
    expect(staticCatalogReviewedRisk(config, "memory_search")).toBe("read");
    expect(staticCatalogReviewedRisk(config, "memory_add")).toBe("write");
    expect(staticCatalogReviewedRisk(config, "memory_delete")).toBe("write");
    expect(staticCatalogAllowlist(config)).toEqual(new Set(["memory_search", "memory_add", "memory_delete"]));
  });

  it("is null for an unreviewed verb (the admin purge), an unmarked connection and Arcana's verbs", () => {
    expect(staticCatalogReviewedRisk(config, "memory_purge_agent")).toBeNull();
    expect(staticCatalogReviewedRisk({}, "memory_add")).toBeNull();
    expect(staticCatalogReviewedRisk(null, "memory_add")).toBeNull();
    expect(staticCatalogReviewedRisk({ [DEFAULT_MCP_STATIC_CATALOG_CONFIG_KEY]: "arcana-brain" }, "recall")).toBeNull();
  });
});

describe("static template flag gate", () => {
  it("creates the memory tools template only while its flag is true, and repair (env null) ignores the flag", () => {
    const keys = (env: NodeJS.ProcessEnv | null) => staticTemplateEntries(DEFAULT_MCP_SPEC, env).map((entry) => entry.key);
    expect(keys({})).toEqual(["arcana-brain"]);
    expect(keys({ [AGENT_MEMORY_TOOLS_ENABLED_ENV]: "false" })).toEqual(["arcana-brain"]);
    expect(keys({ [AGENT_MEMORY_TOOLS_ENABLED_ENV]: "TRUE" })).toEqual(["arcana-brain", AGENT_MEMORY_TOOLS_ENTRY_KEY]);
    expect(keys(null)).toEqual(["arcana-brain", AGENT_MEMORY_TOOLS_ENTRY_KEY]);
  });
});

describe("agent memory tools eligibility", () => {
  it("needs the tools flag AND a valid memory configuration", () => {
    expect(agentMemoryToolsEnabled(ON)).toBe(true);
    expect(agentMemoryToolsEnabled({ ...ON, [AGENT_MEMORY_TOOLS_ENABLED_ENV]: "false" })).toBe(false);
    expect(agentMemoryToolsEnabled({ ...ON, [AGENT_MEMORY_URL_ENV]: "" })).toBe(false);
    expect(agentMemoryToolsEnabled({ ...ON, [AGENT_MEMORY_ENABLED_ENV]: "false" })).toBe(false);
    expect(agentMemoryToolsEnabled({})).toBe(false);
  });

  it("applies to Claude and Codex harnesses only, never Hermes or an unprofiled adapter", () => {
    expect(agentMemoryToolsHarness("claude_local", {})).toBe(true);
    expect(agentMemoryToolsHarness("codex_local", {})).toBe(true);
    expect(agentMemoryToolsHarness("hermes_local", {})).toBe(false);
    expect(agentMemoryToolsHarness("process", {})).toBe(false);
    expect(agentMemoryToolsHarness(null, {})).toBe(false);
    expect(agentMemoryToolsEligibleForNewAgent("claude_local", {}, ON)).toBe(true);
    expect(agentMemoryToolsEligibleForNewAgent("hermes_local", {}, ON)).toBe(false);
    expect(agentMemoryToolsEligibleForNewAgent("claude_local", {}, {})).toBe(false);
  });

  it("new-agent exclusions: Hermes gets agent-memory but not the tools; Claude gets both only with both flags", () => {
    expect([...agentMemoryExcludedSetupKeys("hermes_local", {}, ON)]).toEqual([AGENT_MEMORY_TOOLS_ENTRY_KEY]);
    expect([...agentMemoryExcludedSetupKeys("claude_local", {}, ON)]).toEqual([]);
    const memoryOnly = { ...ON, [AGENT_MEMORY_TOOLS_ENABLED_ENV]: "false" };
    expect([...agentMemoryExcludedSetupKeys("claude_local", {}, memoryOnly)]).toEqual([AGENT_MEMORY_TOOLS_ENTRY_KEY]);
    expect([...agentMemoryExcludedSetupKeys("process", {}, ON)].sort()).toEqual([AGENT_MEMORY_ENTRY_KEY, AGENT_MEMORY_TOOLS_ENTRY_KEY].sort());
  });
});

describe("missing-entry enrollment of the memory tools", () => {
  const raw = { [AGENT_MEMORY_ENTRY_KEY]: { setup: { state: "ready" } } };
  const claude = { adapterType: "claude_local", adapterConfig: {} };

  it("is an enrollable key but never part of the generic eligible spec", () => {
    expect(missingEntryEnrollableKeys()).toContain(AGENT_MEMORY_TOOLS_ENTRY_KEY);
    expect(missingEntryEligibleSpec().map((entry) => entry.key)).not.toContain(AGENT_MEMORY_TOOLS_ENTRY_KEY);
  });

  it("joins the missing set for a Claude or Codex agent that already has agent-memory, with both flags and the backfill flag", () => {
    expect(agentMemoryToolsBackfillSpec(ON, claude, raw).map((entry) => entry.key)).toEqual([AGENT_MEMORY_TOOLS_ENTRY_KEY]);
    expect(agentMemoryToolsBackfillSpec(ON, { adapterType: "codex_local", adapterConfig: {} }, raw)).toHaveLength(1);
  });

  it("is empty for Hermes, without an agent-memory entry, or when any flag is off", () => {
    expect(agentMemoryToolsBackfillSpec(ON, { adapterType: "hermes_local", adapterConfig: {} }, raw)).toEqual([]);
    expect(agentMemoryToolsBackfillSpec(ON, claude, {})).toEqual([]);
    expect(agentMemoryToolsBackfillSpec({ ...ON, [AGENT_MEMORY_TOOLS_ENABLED_ENV]: "false" }, claude, raw)).toEqual([]);
    expect(agentMemoryToolsBackfillSpec({ ...ON, [AGENT_MEMORY_BACKFILL_ENABLED_ENV]: "false" }, claude, raw)).toEqual([]);
  });
});
