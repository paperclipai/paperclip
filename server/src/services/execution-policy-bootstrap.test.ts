import { beforeEach, describe, expect, it, vi } from "vitest";

const updateGeneral = vi.fn();
const listCompanyIds = vi.fn();
const ensureKubernetesEnvironment = vi.fn();
const ensureManagedSandboxEnvironment = vi.fn();

vi.mock("./instance-settings.js", () => ({
  instanceSettingsService: () => ({
    updateGeneral,
    listCompanyIds,
  }),
}));

vi.mock("./environments.js", () => ({
  environmentService: () => ({
    ensureKubernetesEnvironment,
    ensureManagedSandboxEnvironment,
  }),
}));

const {
  parseExecutionPolicyBootstrapEnv,
  applyExecutionPolicyBootstrap,
} = await import("./execution-policy-bootstrap.js");
type ExecutionPolicyBootstrapEnv = import("./execution-policy-bootstrap.js").ExecutionPolicyBootstrapEnv;
type ExecutionPolicyBootstrap = import("./execution-policy-bootstrap.js").ExecutionPolicyBootstrap;

function env(overrides: Record<string, string | undefined>): ExecutionPolicyBootstrapEnv {
  return overrides;
}

// Narrow a parsed bootstrap to the Kubernetes variant (the union now also has a
// provider-agnostic `sandbox` variant with no kubernetesConfig).
function asKubernetes(
  parsed: ReturnType<typeof parseExecutionPolicyBootstrapEnv>,
): Extract<ExecutionPolicyBootstrap, { executionMode: "kubernetes" }> {
  if (!parsed || parsed.executionMode !== "kubernetes") {
    throw new Error(`expected a kubernetes bootstrap, got ${parsed?.executionMode ?? "null"}`);
  }
  return parsed;
}

const bootstrap: ExecutionPolicyBootstrap = {
  executionMode: "kubernetes",
  kubernetesConfig: { inCluster: true, backend: "job" },
};

// `applyExecutionPolicyBootstrap` constructs its services internally from the
// Db, so we mock the service modules; the Db itself is never touched here.
const fakeDb = {} as never;

describe("parseExecutionPolicyBootstrapEnv", () => {
  it("returns null when no execution mode is set (default unrestricted)", () => {
    expect(parseExecutionPolicyBootstrapEnv(env({}))).toBeNull();
  });

  it("returns null when execution mode is explicitly any", () => {
    expect(
      parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "any" })),
    ).toBeNull();
  });

  it("parses the forced kubernetes policy with a job/gvisor/cilium config", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "kubernetes",
        PAPERCLIP_K8S_BACKEND: "job",
        PAPERCLIP_K8S_IN_CLUSTER: "true",
        PAPERCLIP_K8S_RUNTIME_CLASS_NAME: "gvisor",
        PAPERCLIP_K8S_EGRESS_MODE: "cilium",
        PAPERCLIP_K8S_EGRESS_ALLOW_FQDNS: "api.anthropic.com, api.openai.com",
        PAPERCLIP_K8S_EGRESS_ALLOW_CIDRS: "10.0.0.0/8",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.executionMode).toBe("kubernetes");
    expect(asKubernetes(parsed).kubernetesConfig).toMatchObject({
      backend: "job",
      inCluster: true,
      runtimeClassName: "gvisor",
      egressMode: "cilium",
      egressAllowFqdns: ["api.anthropic.com", "api.openai.com"],
      egressAllowCidrs: ["10.0.0.0/8"],
    });
  });

  it("defaults inCluster false and omits unset optional fields", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({ PAPERCLIP_EXECUTION_MODE: "kubernetes" }),
    );
    expect(asKubernetes(parsed).kubernetesConfig.inCluster).toBe(false);
    expect(asKubernetes(parsed).kubernetesConfig.runtimeClassName).toBeUndefined();
    expect(asKubernetes(parsed).kubernetesConfig.egressAllowFqdns).toBeUndefined();
  });

  it("throws on an unknown execution mode", () => {
    expect(() =>
      parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "vm" })),
    ).toThrow(/PAPERCLIP_EXECUTION_MODE/);
  });

  it("parses sandbox mode with no provider as a persist-only bootstrap", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "sandbox" }));
    expect(parsed).toEqual({ executionMode: "sandbox" });
  });

  it("parses sandbox mode with a default provider + config for auto-provisioning", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "sandbox",
        PAPERCLIP_SANDBOX_PROVIDER: "daytona",
        PAPERCLIP_SANDBOX_CONFIG: JSON.stringify({ apiUrl: "https://daytona.example", target: "eu" }),
      }),
    );
    expect(parsed).toEqual({
      executionMode: "sandbox",
      sandbox: { provider: "daytona", config: { apiUrl: "https://daytona.example", target: "eu" } },
    });
  });

  it("defaults sandbox config to an empty object when only a provider is given", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({ PAPERCLIP_EXECUTION_MODE: "sandbox", PAPERCLIP_SANDBOX_PROVIDER: "e2b" }),
    );
    expect(parsed).toEqual({ executionMode: "sandbox", sandbox: { provider: "e2b", config: {} } });
  });

  it("throws when PAPERCLIP_SANDBOX_CONFIG is not valid JSON", () => {
    expect(() =>
      parseExecutionPolicyBootstrapEnv(
        env({
          PAPERCLIP_EXECUTION_MODE: "sandbox",
          PAPERCLIP_SANDBOX_PROVIDER: "daytona",
          PAPERCLIP_SANDBOX_CONFIG: "{not json",
        }),
      ),
    ).toThrow(/PAPERCLIP_SANDBOX_CONFIG must be valid JSON/);
  });

  it("throws when PAPERCLIP_SANDBOX_CONFIG is a JSON non-object", () => {
    expect(() =>
      parseExecutionPolicyBootstrapEnv(
        env({
          PAPERCLIP_EXECUTION_MODE: "sandbox",
          PAPERCLIP_SANDBOX_PROVIDER: "daytona",
          PAPERCLIP_SANDBOX_CONFIG: "[1,2,3]",
        }),
      ),
    ).toThrow(/PAPERCLIP_SANDBOX_CONFIG must be a JSON object/);
  });

  it("attaches the declared adapter registry to the kubernetes config", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "kubernetes",
        PAPERCLIP_ADAPTERS: JSON.stringify([
          { adapterType: "opencode_local", runtimeImage: "img", envKeys: ["ANTHROPIC_API_KEY"], allowFqdns: [], probeCommand: ["opencode", "--version"], defaultEnv: { ANTHROPIC_BASE_URL: "http://bifrost:8080" } },
        ]),
      }),
    );
    expect(asKubernetes(parsed).kubernetesConfig.adapters).toHaveLength(1);
    expect(asKubernetes(parsed).kubernetesConfig.adapters?.[0].adapterType).toBe("opencode_local");
  });

  it("leaves adapters undefined when PAPERCLIP_ADAPTERS is absent", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "kubernetes" }));
    expect(asKubernetes(parsed).kubernetesConfig.adapters).toBeUndefined();
  });

  it("reads PAPERCLIP_K8S_RPC_TIMEOUT_MS into kubernetesConfig.timeoutMs", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "kubernetes",
        PAPERCLIP_K8S_RPC_TIMEOUT_MS: "600000",
      }),
    );
    expect(asKubernetes(parsed).kubernetesConfig.timeoutMs).toBe(600000);
  });

  it("omits timeoutMs when PAPERCLIP_K8S_RPC_TIMEOUT_MS is absent", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "kubernetes" }));
    expect(asKubernetes(parsed).kubernetesConfig.timeoutMs).toBeUndefined();
  });

  it("throws when PAPERCLIP_K8S_RPC_TIMEOUT_MS is not a positive integer", () => {
    expect(() =>
      parseExecutionPolicyBootstrapEnv(
        env({ PAPERCLIP_EXECUTION_MODE: "kubernetes", PAPERCLIP_K8S_RPC_TIMEOUT_MS: "0" }),
      ),
    ).toThrow(/PAPERCLIP_K8S_RPC_TIMEOUT_MS/);
    expect(() =>
      parseExecutionPolicyBootstrapEnv(
        env({ PAPERCLIP_EXECUTION_MODE: "kubernetes", PAPERCLIP_K8S_RPC_TIMEOUT_MS: "abc" }),
      ),
    ).toThrow(/PAPERCLIP_K8S_RPC_TIMEOUT_MS/);
  });
});

describe("applyExecutionPolicyBootstrap", () => {
  beforeEach(() => {
    updateGeneral.mockReset().mockResolvedValue(undefined);
    listCompanyIds.mockReset();
    ensureKubernetesEnvironment.mockReset();
    ensureManagedSandboxEnvironment.mockReset();
  });

  it("does not throw when every company gets a managed environment", async () => {
    listCompanyIds.mockResolvedValue(["c1", "c2", "c3"]);
    ensureKubernetesEnvironment.mockResolvedValue({ id: "env" });

    const result = await applyExecutionPolicyBootstrap(fakeDb, bootstrap);

    expect(result).toEqual({ executionMode: "kubernetes", companiesConfigured: 3 });
    expect(ensureKubernetesEnvironment).toHaveBeenCalledTimes(3);
  });

  it("throws when at least one company fails, after attempting every company", async () => {
    listCompanyIds.mockResolvedValue(["c1", "c2", "c3"]);
    ensureKubernetesEnvironment.mockImplementation(async (companyId: string) => {
      if (companyId === "c2") throw new Error("operator config missing");
      return { id: `env-${companyId}` };
    });

    await expect(applyExecutionPolicyBootstrap(fakeDb, bootstrap)).rejects.toThrow(
      /execution-policy bootstrap: 1 of 3 companies failed.*c2/,
    );

    // It keeps going past the failure (attempts all three companies).
    expect(ensureKubernetesEnvironment).toHaveBeenCalledTimes(3);
  });

  it("persists sandbox mode (no default provider) without provisioning any environment", async () => {
    listCompanyIds.mockResolvedValue(["c1", "c2"]);

    const result = await applyExecutionPolicyBootstrap(fakeDb, { executionMode: "sandbox" });

    expect(result).toEqual({ executionMode: "sandbox", companiesConfigured: 0 });
    expect(updateGeneral).toHaveBeenCalledWith({ executionMode: "sandbox" });
    expect(ensureKubernetesEnvironment).not.toHaveBeenCalled();
    expect(ensureManagedSandboxEnvironment).not.toHaveBeenCalled();
  });

  it("auto-provisions the default sandbox for every company when a provider is set", async () => {
    listCompanyIds.mockResolvedValue(["c1", "c2", "c3"]);
    ensureManagedSandboxEnvironment.mockResolvedValue({ id: "sbx" });

    const result = await applyExecutionPolicyBootstrap(fakeDb, {
      executionMode: "sandbox",
      sandbox: { provider: "daytona", config: { target: "eu" } },
    });

    expect(result).toEqual({ executionMode: "sandbox", companiesConfigured: 3 });
    expect(ensureManagedSandboxEnvironment).toHaveBeenCalledTimes(3);
    expect(ensureManagedSandboxEnvironment).toHaveBeenCalledWith("c1", {
      provider: "daytona",
      config: { target: "eu" },
    });
    expect(ensureKubernetesEnvironment).not.toHaveBeenCalled();
  });

  it("throws when a company fails to get its managed sandbox, after attempting all", async () => {
    listCompanyIds.mockResolvedValue(["c1", "c2", "c3"]);
    ensureManagedSandboxEnvironment.mockImplementation(async (companyId: string) => {
      if (companyId === "c2") throw new Error("provider unreachable");
      return { id: `sbx-${companyId}` };
    });

    await expect(
      applyExecutionPolicyBootstrap(fakeDb, {
        executionMode: "sandbox",
        sandbox: { provider: "daytona", config: {} },
      }),
    ).rejects.toThrow(/1 of 3 companies failed to get a managed sandbox.*c2/);
    expect(ensureManagedSandboxEnvironment).toHaveBeenCalledTimes(3);
  });
});
