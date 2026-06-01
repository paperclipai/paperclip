import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveSecretValue = vi.hoisted(() => vi.fn());
const mockGetCode = vi.hoisted(() => vi.fn());
const mockLoadFromString = vi.hoisted(() => vi.fn());
const mockLoadFromCluster = vi.hoisted(() => vi.fn());
const mockMakeApiClient = vi.hoisted(() => vi.fn());

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

vi.mock("@kubernetes/client-node", () => {
  class FakeKubeConfig {
    loadFromString(yaml: string) {
      const result = mockLoadFromString(yaml);
      if (result instanceof Error) throw result;
    }
    loadFromCluster() {
      mockLoadFromCluster();
    }
    makeApiClient(api: unknown) {
      return mockMakeApiClient(api);
    }
  }
  return {
    KubeConfig: FakeKubeConfig,
    VersionApi: class FakeVersionApi {},
  };
});

import { probeEnvironment } from "../services/environment-probe.js";

function makeEnv(config: Record<string, unknown>) {
  return {
    id: "env-k8s-1",
    companyId: "company-1",
    name: "K8s Probe",
    description: null,
    driver: "k8s" as const,
    status: "active" as const,
    config,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("probeEnvironment — k8s", () => {
  beforeEach(() => {
    mockResolveSecretValue.mockReset();
    mockGetCode.mockReset();
    mockLoadFromString.mockReset();
    mockLoadFromCluster.mockReset();
    mockMakeApiClient.mockReset();
    mockMakeApiClient.mockImplementation(() => ({ getCode: mockGetCode }));
    // Tests that exercise the in-cluster auth path go through a guard in
    // environment-probe.ts that returns "KUBERNETES_SERVICE_HOST is unset"
    // before reaching `loadFromCluster()`. CI runners aren't pods, so the
    // env var is naturally absent and those assertions used to fail with
    // `{ error: "KUBERNETES_SERVICE_HOST is unset", stage: "in-cluster-load" }`
    // instead of the mocked-success path. Stubbing it here keeps the
    // in-cluster-path tests agnostic to whether the test host is in a pod.
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.96.0.1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns ok=true with cluster gitVersion when /version succeeds (in-cluster auth)", async () => {
    mockGetCode.mockResolvedValue({ gitVersion: "v1.28.4", major: "1", minor: "28" });

    const result = await probeEnvironment({} as any, makeEnv({ namespace: "paperclip" }));

    expect(result.ok).toBe(true);
    expect(result.driver).toBe("k8s");
    expect(result.summary).toContain("v1.28.4");
    expect(result.details).toMatchObject({ gitVersion: "v1.28.4" });
    expect(mockLoadFromCluster).toHaveBeenCalledTimes(1);
    expect(mockLoadFromString).not.toHaveBeenCalled();
    expect(mockResolveSecretValue).not.toHaveBeenCalled();
  });

  it("loads kubeconfig from secret when kubeconfigSecretRef is set", async () => {
    const yaml = "apiVersion: v1\nkind: Config\n...";
    mockResolveSecretValue.mockResolvedValue(yaml);
    mockGetCode.mockResolvedValue({ gitVersion: "v1.30.0" });

    const result = await probeEnvironment(
      {} as any,
      makeEnv({ kubeconfigSecretRef: "11111111-1111-1111-1111-111111111111" }),
    );

    expect(result.ok).toBe(true);
    expect(mockResolveSecretValue).toHaveBeenCalledWith(
      "company-1",
      "11111111-1111-1111-1111-111111111111",
      "latest",
    );
    expect(mockLoadFromString).toHaveBeenCalledWith(yaml);
    expect(mockLoadFromCluster).not.toHaveBeenCalled();
  });

  it("captures k8s probe failures with statusCode/message in details and ok=false", async () => {
    mockGetCode.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
    );

    const result = await probeEnvironment({} as any, makeEnv({ namespace: "paperclip" }));

    expect(result.ok).toBe(false);
    expect(result.driver).toBe("k8s");
    expect(result.summary).toContain("k8s probe failed");
    expect(result.details).toMatchObject({
      error: "Unauthorized",
      statusCode: 401,
      stage: "api-call",
    });
  });

  it("falls back to in-cluster auth when kubeconfigSecretRef is empty string (DB drift)", async () => {
    mockGetCode.mockResolvedValue({ gitVersion: "v1.30.0" });

    const result = await probeEnvironment({} as any, makeEnv({ kubeconfigSecretRef: "" }));

    expect(result.ok).toBe(true);
    expect(mockResolveSecretValue).not.toHaveBeenCalled();
    expect(mockLoadFromCluster).toHaveBeenCalledTimes(1);
    expect(mockLoadFromString).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ authMode: "in-cluster" });
  });

  it("reports authMode='kubeconfig-secret' when secret resolution fails (configured intent, not load result)", async () => {
    mockResolveSecretValue.mockRejectedValue(new Error("secret revoked"));

    const result = await probeEnvironment(
      {} as any,
      makeEnv({ kubeconfigSecretRef: "11111111-1111-1111-1111-111111111111" }),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("could not resolve kubeconfig secret");
    expect(result.details).toMatchObject({
      authMode: "kubeconfig-secret",
      stage: "secret-resolution",
      secretRef: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("returns a static error when kubeconfig YAML fails to parse (does not echo content)", async () => {
    const sensitiveYaml = "apiVersion: v1\nclient-certificate-data: SECRET-CERT-CONTENT";
    mockResolveSecretValue.mockResolvedValue(sensitiveYaml);
    mockLoadFromString.mockReturnValue(new Error(`bad yaml at: ${sensitiveYaml}`));

    const result = await probeEnvironment(
      {} as any,
      makeEnv({ kubeconfigSecretRef: "11111111-1111-1111-1111-111111111111" }),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("kubeconfig YAML failed to parse");
    expect(result.details).toMatchObject({ stage: "kubeconfig-parse", authMode: "kubeconfig-secret" });
    expect(JSON.stringify(result.details)).not.toContain("SECRET-CERT-CONTENT");
  });

  it("times out the k8s API call after the configured deadline", async () => {
    vi.useFakeTimers();
    try {
      mockGetCode.mockImplementation(() => new Promise(() => {})); // never resolves

      const probePromise = probeEnvironment({} as any, makeEnv({ namespace: "paperclip" }));
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await probePromise;

      expect(result.ok).toBe(false);
      expect(result.summary).toContain("timed out");
      expect(result.details).toMatchObject({ stage: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
