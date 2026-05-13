import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClusterCommand, type ClusterCommandDeps } from "./cluster.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const MOCK_ROW = {
  id: "c-1",
  label: "kind",
  kind: "kubeconfig" as const,
  kubeconfigSecretRef: null,
  apiServerUrl: null,
  defaultNamespacePrefix: "paperclip-",
  capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] as const },
  paperclipPublicUrl: null,
  imageRegistry: null,
  allowAgentImageOverride: false,
  imageAllowlist: [] as string[],
  createdAt: new Date(),
  createdBy: "x",
};

const MOCK_RESOLVED = {
  ...MOCK_ROW,
  kubeconfigYaml: "<yaml>",
};

function mocks(): ClusterCommandDeps {
  return {
    clusterConnections: {
      create: vi.fn(async (i: { label: string }) => ({
        ...MOCK_ROW,
        id: "c-1",
        label: i.label,
      })) as any,
      list: vi.fn(async () => [MOCK_ROW]) as any,
      get: vi.fn(async () => MOCK_ROW) as any,
      delete: vi.fn(async () => {}) as any,
      resolve: vi.fn(async () => MOCK_RESOLVED) as any,
      update: vi.fn(async () => MOCK_ROW) as any,
    },
    tenantPolicies: {
      get: vi.fn(async () => null) as any,
      upsert: vi.fn(async () => ({} as any)) as any,
    },
    driver: {
      type: "kubernetes" as const,
      validateTarget: vi.fn(async () => {}) as any,
      ensureTenant: vi.fn(async () => ({
        namespace: "paperclip-acme",
        ciliumApplied: false,
      })) as any,
      run: vi.fn() as any,
    },
    companies: {
      getById: vi.fn(async () => ({ id: "co-1", name: "Acme Corp", slug: "acme" })),
    },
    namespaceBindings: {
      record: vi.fn(async () => {}),
    },
    print: (s: string) => out.push(s),
  };
}

let out: string[];

beforeEach(() => {
  out = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cluster commands", () => {
  it("add: creates a connection and prints its id and label", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "add",
      "--label", "kind",
      "--kind", "kubeconfig",
      "--kubeconfig-secret", "local_encrypted:my-cfg",
    ]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("c-1");
    expect(m.clusterConnections.create).toHaveBeenCalled();
    // kubeconfig-secret parsed correctly
    const arg = (m.clusterConnections.create as any).mock.calls[0][0];
    expect(arg.kubeconfigSecretRef).toEqual({ provider: "local_encrypted", name: "my-cfg" });
  });

  it("add: returns non-zero when --label is missing", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["add", "--kind", "kubeconfig"]);
    expect(code).not.toBe(0);
    expect(m.clusterConnections.create).not.toHaveBeenCalled();
  });

  it("add: returns non-zero when --kind is invalid", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["add", "--label", "x", "--kind", "nomad"]);
    expect(code).not.toBe(0);
  });

  it("add: passes --cilium / --storage-class / --arch through to capabilities", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "add",
      "--label", "prod-eks",
      "--kind", "kubeconfig",
      "--kubeconfig-secret", "aws_secrets:prod",
      "--cilium",
      "--storage-class", "gp3",
      "--arch", "amd64,arm64",
    ]);
    expect(code).toBe(0);
    const arg = (m.clusterConnections.create as any).mock.calls[0][0];
    expect(arg.capabilities).toEqual({
      cilium: true,
      storageClass: "gp3",
      architectures: ["amd64", "arm64"],
    });
  });

  it("add: defaults capabilities to single-arch x86 without Cilium when no flags are passed", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "add",
      "--label", "kind",
      "--kind", "kubeconfig",
      "--kubeconfig-secret", "local_encrypted:my-cfg",
    ]);
    expect(code).toBe(0);
    const arg = (m.clusterConnections.create as any).mock.calls[0][0];
    expect(arg.capabilities).toEqual({
      cilium: false,
      storageClass: "standard",
      architectures: ["amd64"],
    });
  });

  it("add: rejects --arch with an unsupported value", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "add",
      "--label", "x",
      "--kind", "kubeconfig",
      "--kubeconfig-secret", "local_encrypted:y",
      "--arch", "ppc64le",
    ]);
    expect(code).not.toBe(0);
    expect(m.clusterConnections.create).not.toHaveBeenCalled();
  });

  it("list: prints connections with capabilities", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["list"]);
    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("kind");
    expect(printed).toContain("standard");
    expect(printed).toContain("amd64");
  });

  it("list: prints a message when there are no connections", async () => {
    const m = mocks();
    (m.clusterConnections.list as any).mockResolvedValue([]);
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["list"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/no cluster/i);
  });

  it("test: prints resolved connection details", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["test", "c-1"]);
    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).toMatch(/ok/i);
    expect(printed).toContain("standard");
    expect(printed).toContain("amd64");
  });

  it("test: returns non-zero when connection is not found", async () => {
    const m = mocks();
    (m.clusterConnections.resolve as any).mockResolvedValue(null);
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["test", "c-missing"]);
    expect(code).not.toBe(0);
    expect(out.join("\n")).toMatch(/not found/i);
  });

  it("ensure-tenant: calls driver.ensureTenant, records the binding, and prints the namespace", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["ensure-tenant", "c-1", "co-1"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("paperclip-acme");
    expect(m.driver.ensureTenant).toHaveBeenCalled();
    expect(m.namespaceBindings.record).toHaveBeenCalledWith({
      clusterConnectionId: "c-1",
      companyId: "co-1",
      namespaceName: "paperclip-acme",
    });
  });

  it("ensure-tenant: passes slug from company object to driver", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    await cmd.run(["ensure-tenant", "c-1", "co-1"]);
    const arg = (m.driver.ensureTenant as any).mock.calls[0][0];
    expect(arg.company.slug).toBe("acme");
  });

  it("ensure-tenant: returns non-zero exit code when company is not found", async () => {
    const m = mocks();
    (m.companies.getById as any).mockResolvedValue(null);
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["ensure-tenant", "c-1", "co-missing"]);
    expect(code).not.toBe(0);
    expect(out.join("\n")).toMatch(/not found/i);
    expect(m.driver.ensureTenant).not.toHaveBeenCalled();
    expect(m.namespaceBindings.record).not.toHaveBeenCalled();
  });

  it("ensure-tenant: returns non-zero when args are missing", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["ensure-tenant", "c-1"]);
    expect(code).not.toBe(0);
  });

  it("remove: calls clusterConnections.delete", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["remove", "c-1"]);
    expect(code).toBe(0);
    expect(m.clusterConnections.delete).toHaveBeenCalledWith("c-1");
  });

  it("remove: returns non-zero when id is missing", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["remove"]);
    expect(code).not.toBe(0);
  });

  it("doctor: validates connection, probes capabilities, prints results", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["doctor", "c-1"]);
    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).toMatch(/storageClass|cilium|amd64/i);
    expect(printed).toContain("ClusterRole");
  });

  it("doctor: returns non-zero when connection is not found", async () => {
    const m = mocks();
    (m.clusterConnections.resolve as any).mockResolvedValue(null);
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["doctor", "c-missing"]);
    expect(code).not.toBe(0);
    expect(out.join("\n")).toMatch(/not found/i);
  });

  it("doctor: returns non-zero when id is missing", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["doctor"]);
    expect(code).not.toBe(0);
  });

  it("unknown subcommand: non-zero exit and usage hint", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["nonsense"]);
    expect(code).not.toBe(0);
    expect(out.join("\n")).toMatch(/usage|cluster/i);
  });

  it("no subcommand: non-zero exit and usage hint", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run([]);
    expect(code).not.toBe(0);
    expect(out.join("\n")).toMatch(/usage|cluster/i);
  });

  it("set-git-credentials: writes gitCredentialsSecretId on the tenant policy", async () => {
    const m = mocks();
    (m.tenantPolicies.upsert as any).mockResolvedValue({
      clusterConnectionId: "c-1",
      companyId: "co-1",
      quota: null, limitRange: null,
      additionalAllowFqdns: [],
      imageOverrides: null,
      gitCredentialsSecretId: "11111111-1111-1111-1111-111111111111",
      ciliumDnsAllowlist: [],
      ciliumEgressCidrs: [],
      httpProxyUrl: null,
    });
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-git-credentials",
      "--cluster", "c-1",
      "--company", "co-1",
      "--secret-id", "11111111-1111-1111-1111-111111111111",
    ]);
    expect(code).toBe(0);
    const arg = (m.tenantPolicies.upsert as any).mock.calls[0][0];
    expect(arg.gitCredentialsSecretId).toBe("11111111-1111-1111-1111-111111111111");
    expect(arg.clusterConnectionId).toBe("c-1");
    expect(arg.companyId).toBe("co-1");
  });

  it("set-git-credentials: rejects a non-UUID secret-id", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-git-credentials",
      "--cluster", "c-1",
      "--company", "co-1",
      "--secret-id", "not-a-uuid",
    ]);
    expect(code).not.toBe(0);
    expect(m.tenantPolicies.upsert).not.toHaveBeenCalled();
  });

  it("set-cilium-policy: passes --cilium-dns and --cilium-cidrs through as arrays", async () => {
    const m = mocks();
    (m.tenantPolicies.upsert as any).mockResolvedValue({
      clusterConnectionId: "c-1", companyId: "co-1",
      quota: null, limitRange: null, additionalAllowFqdns: [], imageOverrides: null,
      gitCredentialsSecretId: null,
      ciliumDnsAllowlist: ["api.anthropic.com", "github.com"],
      ciliumEgressCidrs: ["10.42.0.0/16"],
      httpProxyUrl: null,
    });
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-cilium-policy",
      "--cluster", "c-1",
      "--company", "co-1",
      "--cilium-dns", "api.anthropic.com,github.com",
      "--cilium-cidrs", "10.42.0.0/16",
    ]);
    expect(code).toBe(0);
    const arg = (m.tenantPolicies.upsert as any).mock.calls[0][0];
    expect(arg.ciliumDnsAllowlist).toEqual(["api.anthropic.com", "github.com"]);
    expect(arg.ciliumEgressCidrs).toEqual(["10.42.0.0/16"]);
    expect(arg.clusterConnectionId).toBe("c-1");
    expect(arg.companyId).toBe("co-1");
  });

  it("set-cilium-policy: trims and ignores empty entries in comma lists", async () => {
    const m = mocks();
    (m.tenantPolicies.upsert as any).mockResolvedValue({
      clusterConnectionId: "c-1", companyId: "co-1",
      quota: null, limitRange: null, additionalAllowFqdns: [], imageOverrides: null,
      gitCredentialsSecretId: null,
      ciliumDnsAllowlist: ["api.anthropic.com"],
      ciliumEgressCidrs: [],
      httpProxyUrl: null,
    });
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-cilium-policy",
      "--cluster", "c-1",
      "--company", "co-1",
      "--cilium-dns", " api.anthropic.com , , ",
      "--cilium-cidrs", "",
    ]);
    expect(code).toBe(0);
    const arg = (m.tenantPolicies.upsert as any).mock.calls[0][0];
    expect(arg.ciliumDnsAllowlist).toEqual(["api.anthropic.com"]);
    expect(arg.ciliumEgressCidrs).toEqual([]);
  });

  it("set-cilium-policy: omits a flag entirely → preserve-on-omit (field undefined)", async () => {
    const m = mocks();
    (m.tenantPolicies.upsert as any).mockResolvedValue({
      clusterConnectionId: "c-1", companyId: "co-1",
      quota: null, limitRange: null, additionalAllowFqdns: [], imageOverrides: null,
      gitCredentialsSecretId: null,
      ciliumDnsAllowlist: [], ciliumEgressCidrs: [], httpProxyUrl: null,
    });
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-cilium-policy",
      "--cluster", "c-1",
      "--company", "co-1",
      "--cilium-dns", "api.anthropic.com",
      // --cilium-cidrs omitted entirely
    ]);
    expect(code).toBe(0);
    const arg = (m.tenantPolicies.upsert as any).mock.calls[0][0];
    expect(arg.ciliumDnsAllowlist).toEqual(["api.anthropic.com"]);
    // Undefined → service preserves existing on upsert (Task 2 semantics).
    expect(arg.ciliumEgressCidrs).toBeUndefined();
  });

  it("set-cilium-policy: errors out if --cluster or --company is missing", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["set-cilium-policy", "--cluster", "c-1"]);
    expect(code).not.toBe(0);
    expect(m.tenantPolicies.upsert).not.toHaveBeenCalled();
  });

  it("set-image-allowlist: passes --prefixes through as a string array", async () => {
    const m = mocks();
    (m.clusterConnections.update as any) = vi.fn(async () => MOCK_ROW);
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-image-allowlist",
      "--cluster", "c-1",
      "--prefixes", "ghcr.io/paperclipai/,internal.acme.com/agents/",
    ]);
    expect(code).toBe(0);
    const arg = (m.clusterConnections.update as any).mock.calls[0];
    expect(arg[0]).toBe("c-1");
    expect(arg[1].imageAllowlist).toEqual([
      "ghcr.io/paperclipai/",
      "internal.acme.com/agents/",
    ]);
  });

  it("set-image-allowlist: empty --prefixes clears the list", async () => {
    const m = mocks();
    (m.clusterConnections.update as any) = vi.fn(async () => MOCK_ROW);
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-image-allowlist",
      "--cluster", "c-1",
      "--prefixes", "",
    ]);
    expect(code).toBe(0);
    const arg = (m.clusterConnections.update as any).mock.calls[0];
    expect(arg[1].imageAllowlist).toEqual([]);
  });

  it("set-image-allowlist: errors when --cluster missing", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["set-image-allowlist", "--prefixes", "x/"]);
    expect(code).not.toBe(0);
  });

  it("set-image-allowlist: errors when the cluster id does not match a row", async () => {
    // update() returns null when no row matches. Without the not-found
    // check, an operator with a stale id would see "Updated …" while
    // nothing was persisted.
    const m = mocks();
    (m.clusterConnections.update as any) = vi.fn(async () => null);
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-image-allowlist",
      "--cluster", "missing",
      "--prefixes", "ghcr.io/paperclipai/",
    ]);
    expect(code).toBe(1);
  });
});
