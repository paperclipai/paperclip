import { beforeEach, describe, expect, it, vi } from "vitest";

const updateGeneral = vi.fn();
const listCompanyIds = vi.fn();
const ensureKubernetesEnvironment = vi.fn();

vi.mock("./instance-settings.js", () => ({
  instanceSettingsService: () => ({
    updateGeneral,
    listCompanyIds,
  }),
}));

vi.mock("./environments.js", () => ({
  environmentService: () => ({
    ensureKubernetesEnvironment,
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

  it("returns a cleared-policy bootstrap when execution mode is explicitly any", () => {
    // Unlike an absent variable, explicit "any" must persist the reset so a
    // previously bootstrapped kubernetes policy can be rolled back via env.
    expect(
      parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "any" })),
    ).toEqual({ executionMode: "any" });
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
    if (parsed?.executionMode !== "kubernetes") throw new Error("expected a kubernetes bootstrap");
    expect(parsed.kubernetesConfig).toMatchObject({
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
    if (parsed?.executionMode !== "kubernetes") throw new Error("expected a kubernetes bootstrap");
    expect(parsed.kubernetesConfig.inCluster).toBe(false);
    expect(parsed.kubernetesConfig.runtimeClassName).toBeUndefined();
    expect(parsed.kubernetesConfig.egressAllowFqdns).toBeUndefined();
  });

  it("throws on an unknown execution mode", () => {
    expect(() =>
      parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "vm" })),
    ).toThrow(/PAPERCLIP_EXECUTION_MODE/);
  });
});

describe("applyExecutionPolicyBootstrap", () => {
  beforeEach(() => {
    updateGeneral.mockReset().mockResolvedValue(undefined);
    listCompanyIds.mockReset();
    ensureKubernetesEnvironment.mockReset();
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
    // The enforced policy must NOT be persisted when provisioning failed —
    // otherwise a failed bootstrap leaves a stale executionMode=kubernetes
    // that survives an env-var rollback and blocks every run.
    expect(updateGeneral).not.toHaveBeenCalled();
  });

  it("persists executionMode only after every company provisioned", async () => {
    listCompanyIds.mockResolvedValue(["c1", "c2"]);
    ensureKubernetesEnvironment.mockResolvedValue({ id: "env" });

    await applyExecutionPolicyBootstrap(fakeDb, bootstrap);

    expect(updateGeneral).toHaveBeenCalledTimes(1);
    expect(updateGeneral).toHaveBeenCalledWith({ executionMode: "kubernetes" });
    expect(updateGeneral.mock.invocationCallOrder[0]).toBeGreaterThan(
      ensureKubernetesEnvironment.mock.invocationCallOrder[1]!,
    );
  });

  it("persists the cleared policy for an explicit any bootstrap without touching environments", async () => {
    const result = await applyExecutionPolicyBootstrap(fakeDb, { executionMode: "any" });

    expect(result).toEqual({ executionMode: "any", companiesConfigured: 0 });
    expect(updateGeneral).toHaveBeenCalledWith({ executionMode: "any" });
    expect(listCompanyIds).not.toHaveBeenCalled();
    expect(ensureKubernetesEnvironment).not.toHaveBeenCalled();
  });
});
