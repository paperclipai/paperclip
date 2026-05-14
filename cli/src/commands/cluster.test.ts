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
    },
    tenantPolicies: {
      get: vi.fn(async () => null) as any,
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
    expect(m.clusterConnections.get).toHaveBeenCalledWith("c-1");
    expect(m.clusterConnections.delete).toHaveBeenCalledWith("c-1");
  });

  it("remove: returns non-zero when the connection does not exist", async () => {
    const m = mocks();
    (m.clusterConnections.get as any).mockResolvedValue(null);
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["remove", "missing"]);
    expect(code).not.toBe(0);
    expect(m.clusterConnections.delete).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/not found/i);
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
});
