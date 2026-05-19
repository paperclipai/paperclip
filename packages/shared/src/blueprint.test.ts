import { describe, expect, it } from "vitest";
import {
  buildBlueprintApprovalEvidence,
  readyAgentBlueprintToVersion,
  summarizeMissing,
  validateBlueprintInstantiateInput,
  type BlueprintInstantiateContext,
  type BlueprintInstantiateInput,
  type BlueprintVersion,
} from "./blueprint.js";
import { getReadyAgentBlueprint, INITIAL_READY_AGENT_BLUEPRINTS } from "./ready-agent-pool.js";

function makeContext(overrides: Partial<BlueprintInstantiateContext> = {}): BlueprintInstantiateContext {
  return {
    companyId: "company-1",
    projectId: null,
    existingAgentKeys: [],
    availableSkillKeys: [],
    availableMcpBundleKeys: [],
    availableSecretInputNames: [],
    availableProviderKeys: [],
    ...overrides,
  };
}

function withRequiredProviderKey(version: BlueprintVersion, key: string): BlueprintVersion {
  return { ...version, requiredProviderKeys: [...version.requiredProviderKeys, key] };
}

describe("blueprint catalog shared types", () => {
  it("keeps INITIAL_READY_AGENT_BLUEPRINTS additive (no schema mutation)", () => {
    expect(INITIAL_READY_AGENT_BLUEPRINTS.length).toBeGreaterThan(0);
    for (const blueprint of INITIAL_READY_AGENT_BLUEPRINTS) {
      const version = readyAgentBlueprintToVersion(blueprint);
      expect(version.ref).toContain(blueprint.key);
      expect(version.status).toBe("published");
      expect(version.source).toEqual({ kind: "ready_agent_pool", key: blueprint.key });
      expect(version.systemPromptTemplate).toBe(blueprint.systemPrompt);
    }
  });

  it("rejects raw secret values in bindings (fail-closed)", () => {
    const version = readyAgentBlueprintToVersion(getReadyAgentBlueprint("mcp-integration-operator"));
    const input: BlueprintInstantiateInput = {
      config: {},
      secretBindings: [
        {
          inputName: "MCP_REGISTRY_TOKEN",
          secretRef: "sk-live-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
      ],
      notes: null,
    };
    const result = validateBlueprintInstantiateInput(
      version,
      input,
      makeContext({ availableSecretInputNames: ["MCP_REGISTRY_TOKEN"] }),
    );
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      const codes = result.errors.map((error) => error.code);
      expect(codes).toContain("raw_secret_value_forbidden");
    }
  });

  it("requires a secret reference when input is missing", () => {
    const version = readyAgentBlueprintToVersion(getReadyAgentBlueprint("mcp-integration-operator"));
    const input: BlueprintInstantiateInput = {
      config: {},
      secretBindings: [],
      notes: null,
    };
    const result = validateBlueprintInstantiateInput(version, input, makeContext());
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      const codes = result.errors.map((error) => error.code);
      expect(codes).toContain("missing_secret_inputs");
    }
  });

  it("fails closed when a required provider key is missing", () => {
    const base = readyAgentBlueprintToVersion(getReadyAgentBlueprint("code-implementer"));
    const version = withRequiredProviderKey(base, "ANTHROPIC_API_KEY");
    const input: BlueprintInstantiateInput = { config: {}, secretBindings: [], notes: null };
    const result = validateBlueprintInstantiateInput(version, input, makeContext({ availableProviderKeys: [] }));
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      const codes = result.errors.map((error) => error.code);
      expect(codes).toContain("missing_provider_key");
    }
  });

  it("passes when bindings, provider keys, and skills are present", () => {
    const base = readyAgentBlueprintToVersion(getReadyAgentBlueprint("mcp-integration-operator"));
    const version = withRequiredProviderKey(base, "ANTHROPIC_API_KEY");
    const input: BlueprintInstantiateInput = {
      config: { displayName: "MCP Operator" },
      secretBindings: [{ inputName: "MCP_REGISTRY_TOKEN", secretRef: "mcp-registry-token" }],
      notes: "preview",
    };
    const context = makeContext({
      availableSkillKeys: ["native-mcp", "paperclip-agent-operations"],
      availableMcpBundleKeys: ["mcp-marketplace-readonly"],
      availableSecretInputNames: ["MCP_REGISTRY_TOKEN"],
      availableProviderKeys: ["ANTHROPIC_API_KEY"],
    });
    const result = validateBlueprintInstantiateInput(version, input, context);
    expect(result.kind).toBe("ok");

    const missing = summarizeMissing(version, input, context);
    const evidence = buildBlueprintApprovalEvidence({
      version,
      input,
      resolvedSecretBindings: [{ inputName: "MCP_REGISTRY_TOKEN", secretId: "secret-id-1" }],
      missing,
    });
    expect(evidence.approvalOnly).toBe(true);
    expect(evidence.liveApply).toBe(false);
    expect(evidence.liveExternalActions).toBe(false);
    expect(evidence.surface).toBe("agent_os_blueprint");
    expect(evidence.secretBindings).toEqual([
      { inputName: "MCP_REGISTRY_TOKEN", secretId: "secret-id-1" },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("mcp-registry-token");
  });

  it("rejects raw secret values placed in arbitrary config keys", () => {
    const version: BlueprintVersion = {
      ...readyAgentBlueprintToVersion(getReadyAgentBlueprint("code-reviewer")),
      configSchema: {
        version: 1,
        fields: [
          { key: "displayName", label: "Display name", type: "string", required: false },
          { key: "apiKey", label: "API key", type: "string", required: false },
        ],
      },
    };
    const input: BlueprintInstantiateInput = {
      config: { apiKey: "sk-ant-api03-leaked-raw-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      secretBindings: [],
      notes: null,
    };
    const result = validateBlueprintInstantiateInput(version, input, makeContext());
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      const codes = result.errors.map((error) => error.code);
      expect(codes).toContain("raw_secret_value_forbidden");
    }
  });

  it("rejects raw secret values placed in notes (fail-closed) and sanitizes notes in evidence", () => {
    const version = readyAgentBlueprintToVersion(getReadyAgentBlueprint("code-reviewer"));
    const rawSecret = "sk-ant-api03-leaked-via-notes-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const input: BlueprintInstantiateInput = {
      config: { displayName: "Reviewer" },
      secretBindings: [],
      notes: `please remember ${rawSecret} for later`,
    };
    const context = makeContext({
      availableSkillKeys: [...version.requiredSkillRefs],
      availableMcpBundleKeys: [...version.mcpBundleRefs],
      availableSecretInputNames: [],
      availableProviderKeys: [...version.requiredProviderKeys],
    });
    const result = validateBlueprintInstantiateInput(version, input, context);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      const codes = result.errors.map((error) => error.code);
      expect(codes).toContain("raw_secret_value_forbidden");
    }
    const missing = summarizeMissing(version, input, context);
    const evidence = buildBlueprintApprovalEvidence({
      version,
      input,
      resolvedSecretBindings: [],
      missing,
    });
    expect(evidence.notes).toBeNull();
    expect(JSON.stringify(evidence)).not.toContain(rawSecret);
  });

  it("rejects credential-shaped substrings wrapped in punctuation/quotes inside notes", () => {
    const version = readyAgentBlueprintToVersion(getReadyAgentBlueprint("code-reviewer"));
    const rawSecret = "sk-ant-api03-quoted-leak-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const wrappedFormats = [
      `please use "${rawSecret}" for prod`,
      `(${rawSecret})`,
      `token="${rawSecret}";`,
      `<${rawSecret}>`,
      `key:'${rawSecret}',`,
    ];
    for (const notes of wrappedFormats) {
      const input: BlueprintInstantiateInput = {
        config: { displayName: "Reviewer" },
        secretBindings: [],
        notes,
      };
      const context = makeContext({
        availableSkillKeys: [...version.requiredSkillRefs],
        availableMcpBundleKeys: [...version.mcpBundleRefs],
        availableSecretInputNames: [],
        availableProviderKeys: [...version.requiredProviderKeys],
      });
      const result = validateBlueprintInstantiateInput(version, input, context);
      expect(result.kind, `wrapped notes form should reject: ${notes}`).toBe("invalid");
      if (result.kind === "invalid") {
        const codes = result.errors.map((error) => error.code);
        expect(codes).toContain("raw_secret_value_forbidden");
      }
      const missing = summarizeMissing(version, input, context);
      const evidence = buildBlueprintApprovalEvidence({
        version,
        input,
        resolvedSecretBindings: [],
        missing,
      });
      expect(evidence.notes, `wrapped notes form should sanitize: ${notes}`).toBeNull();
      expect(JSON.stringify(evidence)).not.toContain(rawSecret);
    }
  });

  it("rejects credential-shaped substrings wrapped in punctuation/quotes inside config string values", () => {
    const version: BlueprintVersion = {
      ...readyAgentBlueprintToVersion(getReadyAgentBlueprint("code-reviewer")),
      configSchema: {
        version: 1,
        fields: [
          { key: "displayName", label: "Display name", type: "string", required: false },
          { key: "note", label: "Note", type: "string", required: false },
        ],
      },
    };
    const rawSecret = "sk-ant-api03-quoted-in-config-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const wrappedFormats = [
      `"${rawSecret}"`,
      `(${rawSecret})`,
      `token="${rawSecret}"`,
      `key='${rawSecret}'`,
    ];
    for (const wrappedValue of wrappedFormats) {
      const input: BlueprintInstantiateInput = {
        config: { displayName: "Reviewer", note: wrappedValue },
        secretBindings: [],
        notes: null,
      };
      const result = validateBlueprintInstantiateInput(version, input, makeContext());
      expect(result.kind, `wrapped config form should reject: ${wrappedValue}`).toBe("invalid");
      if (result.kind === "invalid") {
        const codes = result.errors.map((error) => error.code);
        expect(codes).toContain("raw_secret_value_forbidden");
      }
    }
  });

  it("preserves benign notes in evidence", () => {
    const version = readyAgentBlueprintToVersion(getReadyAgentBlueprint("code-reviewer"));
    const input: BlueprintInstantiateInput = {
      config: { displayName: "Reviewer" },
      secretBindings: [],
      notes: "Spinning up reviewer for the LET-498 lane.",
    };
    const missing = summarizeMissing(version, input, makeContext());
    const evidence = buildBlueprintApprovalEvidence({
      version,
      input,
      resolvedSecretBindings: [],
      missing,
    });
    expect(evidence.notes).toBe("Spinning up reviewer for the LET-498 lane.");
  });

  it("strips secret_ref typed config fields and unknown keys from evidence", () => {
    const version: BlueprintVersion = {
      ...readyAgentBlueprintToVersion(getReadyAgentBlueprint("code-reviewer")),
      configSchema: {
        version: 1,
        fields: [
          { key: "displayName", label: "Display name", type: "string", required: false },
          { key: "githubToken", label: "GitHub token", type: "secret_ref", required: false },
        ],
      },
    };
    const input: BlueprintInstantiateInput = {
      config: { displayName: "Reviewer", githubToken: "github-token-ref", unknown: "echoed?" },
      secretBindings: [],
      notes: null,
    };
    const missing = summarizeMissing(version, input, makeContext());
    const evidence = buildBlueprintApprovalEvidence({
      version,
      input,
      resolvedSecretBindings: [],
      missing,
    });
    expect(evidence.config).toEqual({ displayName: "Reviewer" });
    expect(JSON.stringify(evidence)).not.toContain("github-token-ref");
    expect(JSON.stringify(evidence)).not.toContain("echoed?");
  });

  it("flags duplicate blueprint instances when an agent for the key exists", () => {
    const version = readyAgentBlueprintToVersion(getReadyAgentBlueprint("code-reviewer"));
    const input: BlueprintInstantiateInput = { config: {}, secretBindings: [], notes: null };
    const result = validateBlueprintInstantiateInput(
      version,
      input,
      makeContext({ existingAgentKeys: ["code-reviewer"] }),
    );
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.errors.map((error) => error.code)).toContain("duplicate_blueprint_instance");
    }
  });

  it("validates config field shape (required + types)", () => {
    const version: BlueprintVersion = {
      ...readyAgentBlueprintToVersion(getReadyAgentBlueprint("ceo-pm")),
      configSchema: {
        version: 1,
        fields: [
          { key: "displayName", label: "Display name", type: "string", required: true },
          { key: "mode", label: "Mode", type: "enum", enumValues: ["draft", "live"], required: true },
        ],
      },
    };
    const input: BlueprintInstantiateInput = {
      config: { mode: "yolo" },
      secretBindings: [],
      notes: null,
    };
    const result = validateBlueprintInstantiateInput(version, input, makeContext());
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      const codes = result.errors.map((error) => error.code);
      expect(codes).toContain("invalid_config_field");
    }
  });
});
