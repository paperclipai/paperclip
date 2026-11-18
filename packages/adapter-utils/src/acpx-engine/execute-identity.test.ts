// Identity split and launch-environment finalization tests (Phase 17).
//
// Two tests are compile-time: the real assertion is that this file typechecks.
// A `@ts-expect-error` marks an assignment that MUST fail; if it starts to
// compile, tsc reports the unused directive and the typecheck fails. Each
// compile-time assertion lives in a declared, unexecuted function, so vitest
// never runs a synthetic value.

import { describe, expect, it } from "vitest";
import {
  buildSessionFingerprint,
  buildSessionKey,
  finalizeLaunchEnvironment,
  projectAcpxInheritedHostEnvironment,
  SESSION_KEY_MAX_ENCODED_LENGTH,
} from "./execute.js";
import type {
  LaunchEnvironment,
  RunScopedContribution,
  RunSiteReuseCandidate,
  SessionFingerprintIdentity,
} from "./run-contracts.js";

// A complete fingerprint identity with representative values for the 17 fields.
const SAMPLE_FINGERPRINT_IDENTITY: SessionFingerprintIdentity = {
  acpxAgent: "claude",
  agentCommand: "claude",
  cwd: "/work",
  mode: "persistent",
  permissionMode: "approve-all",
  nonInteractivePermissions: "deny",
  requestedModel: "",
  requestedThinkingEffort: "",
  fastMode: false,
  remoteExecutionIdentity: null,
  additionalSourcesIdentity: {},
  skillsIdentity: {},
  skillPromptInstructions: "",
  paperclipClaudeSettings: null,
  mcpServers: [],
  secretManifestHash: "0000",
  adapterEnvHash: "0000",
};

describe("acpx identity split and launch environment", () => {
  it("test_fingerprint_builder_accepts_only_session_fingerprint_identity", () => {
    // The builder accepts a fingerprint identity and returns a stable hash.
    const first = buildSessionFingerprint(SAMPLE_FINGERPRINT_IDENTITY);
    const second = buildSessionFingerprint(SAMPLE_FINGERPRINT_IDENTITY);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);

    // The compile-time assertions live in an unexecuted function.
    function _assertOnlyIdentity(): void {
      // An outer-key field is not a fingerprint field, so the builder rejects it.
      // @ts-expect-error companyId is not a SessionFingerprintIdentity field.
      buildSessionFingerprint({ ...SAMPLE_FINGERPRINT_IDENTITY, companyId: "c" });
      // @ts-expect-error taskKey is not a SessionFingerprintIdentity field.
      buildSessionFingerprint({ ...SAMPLE_FINGERPRINT_IDENTITY, taskKey: "t" });
    }
    void _assertOnlyIdentity;
  });

  it("test_finalize_launch_environment_is_sole_constructor_of_branded_environment", () => {
    // The finalizer merges every contribution and freezes the launch env.
    const baseEnv: Record<string, string> = { LAUNCH_ENV_TEST_BASE: "base" };
    const launchEnvironment = finalizeLaunchEnvironment(
      baseEnv,
      [{ scope: "session", env: { LAUNCH_ENV_TEST_CONTRIB: "contrib" } }],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        inheritedEnv: {},
      },
    );
    expect(launchEnvironment.env.LAUNCH_ENV_TEST_BASE).toBe("base");
    expect(launchEnvironment.env.LAUNCH_ENV_TEST_CONTRIB).toBe("contrib");
    expect(Object.isFrozen(launchEnvironment.env)).toBe(true);

    // No plain object literal can stand in for the branded environment; it lacks
    // the private brand that only `finalizeLaunchEnvironment` sets.
    function _assertBrand(): void {
      // @ts-expect-error missing the private launch-environment brand.
      const _fake: LaunchEnvironment = { env: {} };
      void _fake;
    }
    void _assertBrand;
  });

  it("test_run_scoped_contribution_is_not_assignable_to_a_reuse_payload", () => {
    // A run-scoped contribution and the branded launch environment must never
    // enter a reuse payload (Amendment B). The reuse candidate types reject both.
    function _assertNotReusable(
      contribution: RunScopedContribution,
      launchEnvironment: LaunchEnvironment,
    ): void {
      // @ts-expect-error a run-scoped contribution is not a reuse candidate.
      const _a: RunSiteReuseCandidate = contribution;
      // @ts-expect-error the branded launch environment is not a reuse candidate.
      const _b: RunSiteReuseCandidate = launchEnvironment;
      void _a;
      void _b;
    }
    void _assertNotReusable;
    expect(true).toBe(true);
  });

  it("inherits only safe host context and the selected provider's credentials", () => {
    const inherited = {
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      OPENAI_API_KEY: "openai-host-secret",
      ANTHROPIC_API_KEY: "anthropic-host-secret",
      ANTHROPIC_AUTH_TOKEN: "anthropic-auth-host-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-host-secret",
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      ANTHROPIC_MODEL: "claude-test",
      ANTHROPIC_SMALL_FAST_MODEL: "claude-fast-test",
      CLAUDE_CONFIG_DIR: "/host/claude",
      CLAUDE_CODE_USE_BEDROCK: "true",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-host-secret",
      OPENROUTER_API_KEY: "openrouter-host-secret",
      GOOGLE_GENAI_USE_GCA: "true",
      KIMI_MODEL_NAME: "kimi-code/test",
      KIMI_MODEL_API_KEY: "kimi-host-secret",
      KIMI_MODEL_BASE_URL: "https://kimi.example",
      KIMI_MODEL_PROVIDER_TYPE: "openai_legacy",
      KIMI_CODE_HOME: "/host/kimi",
      PAPERCLIP_NATIVE_MCP_TOKEN: "native-mcp-host-secret",
      PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "managed-auth-host-secret",
      UNRELATED_SECRET: "unrelated-host-secret",
      NODE_OPTIONS: "--require /tmp/host-hook.cjs",
    };

    expect(projectAcpxInheritedHostEnvironment(inherited, "codex", true)).toEqual({
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      OPENAI_API_KEY: "openai-host-secret",
    });
    expect(projectAcpxInheritedHostEnvironment(inherited, "claude", true)).toEqual({
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      ANTHROPIC_API_KEY: "anthropic-host-secret",
      ANTHROPIC_AUTH_TOKEN: "anthropic-auth-host-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-host-secret",
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      ANTHROPIC_MODEL: "claude-test",
      ANTHROPIC_SMALL_FAST_MODEL: "claude-fast-test",
      CLAUDE_CONFIG_DIR: "/host/claude",
      CLAUDE_CODE_USE_BEDROCK: "true",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-host-secret",
    });
    expect(projectAcpxInheritedHostEnvironment(inherited, "pi", true)).toEqual({
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      OPENROUTER_API_KEY: "openrouter-host-secret",
    });
    expect(projectAcpxInheritedHostEnvironment(inherited, "gemini", true)).toEqual({
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      GOOGLE_GENAI_USE_GCA: "true",
    });
    expect(projectAcpxInheritedHostEnvironment(inherited, "kimi", true)).toEqual({
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      KIMI_MODEL_NAME: "kimi-code/test",
      KIMI_MODEL_API_KEY: "kimi-host-secret",
      KIMI_MODEL_BASE_URL: "https://kimi.example",
      KIMI_MODEL_PROVIDER_TYPE: "openai_legacy",
      KIMI_CODE_HOME: "/host/kimi",
    });
  });

  it("does not project any ambient host environment across a remote boundary", () => {
    const inherited = {
      PATH: "/host/bin",
      OPENAI_API_KEY: "ambient-provider-secret",
      PAPERCLIP_NATIVE_MCP_TOKEN: "ambient-native-mcp-secret",
      PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: "ambient-bootstrap-secret",
    };

    expect(projectAcpxInheritedHostEnvironment(inherited, "codex", false)).toEqual({});
  });

  it("keeps explicit remote adapter and run contributions while rejecting ambient authority", () => {
    const launchEnvironment = finalizeLaunchEnvironment(
      {
        OPENAI_API_KEY: "explicit-provider-secret",
        EXPLICIT_ADAPTER_SECRET: "adapter-secret",
        PAPERCLIP_RUNTIME_API_URL: "http://paperclip.internal/api",
      },
      [
        {
          scope: "session",
          env: { PAPERCLIP_NATIVE_MCP_TOKEN: "explicit-run-contribution" },
        },
      ],
      {
        acpxAgent: "codex",
        inheritHostEnvironment: false,
        inheritedEnv: {
          PATH: "/host/bin",
          OPENAI_API_KEY: "ambient-provider-secret",
          PAPERCLIP_NATIVE_MCP_TOKEN: "ambient-native-mcp-secret",
          PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: "ambient-bootstrap-secret",
        },
      },
    );

    expect(launchEnvironment.env).toMatchObject({
      OPENAI_API_KEY: "explicit-provider-secret",
      EXPLICIT_ADAPTER_SECRET: "adapter-secret",
      PAPERCLIP_RUNTIME_API_URL: "http://paperclip.internal/api",
      PAPERCLIP_NATIVE_MCP_TOKEN: "explicit-run-contribution",
    });
    expect(launchEnvironment.env).not.toHaveProperty("PATH");
    expect(launchEnvironment.env).not.toHaveProperty("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET");
  });

  it("preserves an explicit remote PATH instead of synthesizing a host fallback", () => {
    const launchEnvironment = finalizeLaunchEnvironment(
      { PATH: "/sandbox/bin" },
      [],
      {
        acpxAgent: "codex",
        inheritHostEnvironment: false,
        inheritedEnv: { PATH: "/host/bin" },
      },
    );

    expect(launchEnvironment.env).toEqual({ PATH: "/sandbox/bin" });
  });

  it("lets explicit Windows env values suppress differently-cased ambient values", () => {
    const launchEnvironment = finalizeLaunchEnvironment(
      {
        openai_api_key: "",
        Path: "C:\\explicit\\bin",
      },
      [],
      {
        acpxAgent: "codex",
        inheritHostEnvironment: true,
        inheritedEnv: {
          OPENAI_API_KEY: "ambient-provider-secret",
          PATH: "C:\\ambient\\bin",
        },
        platform: "win32",
      },
    );

    expect(launchEnvironment.env).toEqual({
      openai_api_key: "",
      Path: "C:\\explicit\\bin",
    });
  });
});

describe("acpx session key length", () => {
  const COMPANY_ID = "11111111-2222-4333-8444-555555555555";
  const AGENT_ID = "66666666-7777-4888-9999-aaaaaaaaaaaa";
  const FINGERPRINT = "0123456789abcdef";
  const longestFileName = (key: string) => `${encodeURIComponent(key)}.stream.1024.ndjson`;

  it("keeps a key that fits unchanged so its saved session still resumes", () => {
    const key = buildSessionKey(
      { companyId: COMPANY_ID, agentId: AGENT_ID, taskKey: "__heartbeat__" },
      FINGERPRINT,
    );
    expect(key).toBe(`paperclip:${COMPANY_ID}:${AGENT_ID}:__heartbeat__:${FINGERPRINT}`);
    expect(Buffer.byteLength(longestFileName(key))).toBeLessThanOrEqual(143);
  });

  it("digests a key whose file names would exceed the eCryptfs NAME_MAX", () => {
    const issueTaskKey = "9b1f1c52-3f43-4f7a-9d55-0a6a1c2b7e10";
    const summarySlotTaskKey = `summary-slot:${COMPANY_ID}:execution_workspace:${issueTaskKey}:header`;
    for (const taskKey of [issueTaskKey, summarySlotTaskKey]) {
      const key = buildSessionKey({ companyId: COMPANY_ID, agentId: AGENT_ID, taskKey }, FINGERPRINT);
      expect(key).toMatch(/^paperclip:sha256:[0-9a-f]{32}$/);
      expect(encodeURIComponent(key).length).toBeLessThanOrEqual(SESSION_KEY_MAX_ENCODED_LENGTH);
      expect(Buffer.byteLength(longestFileName(key))).toBeLessThanOrEqual(143);
    }
  });

  it("gives a digested key the same scoping as the full key", () => {
    const identity = { companyId: COMPANY_ID, agentId: AGENT_ID, taskKey: "9b1f1c52-3f43-4f7a-9d55-0a6a1c2b7e10" };
    const key = buildSessionKey(identity, FINGERPRINT);
    expect(buildSessionKey({ ...identity }, FINGERPRINT)).toBe(key);
    expect(buildSessionKey({ ...identity, taskKey: "0d6c7e4a-6b0e-4f0b-8a51-2f7d5c9e3a11" }, FINGERPRINT)).not.toBe(key);
    expect(buildSessionKey({ ...identity, agentId: "5f0e8a2b-7c1d-4e3f-9a6b-8d2c4e1f0a93" }, FINGERPRINT)).not.toBe(key);
    expect(buildSessionKey(identity, "ffffffffffffffff")).not.toBe(key);
  });
});
