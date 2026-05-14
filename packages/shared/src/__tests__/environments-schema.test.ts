import { describe, it, expect } from "vitest";
import {
  createEnvironmentSchema,
  updateEnvironmentSchema,
  k8sEnvironmentConfigSchema,
} from "../validators/environment.js";

// `createEnvironmentSchema` is a flat object schema; companyId is taken from
// the URL path (not the body) so it's intentionally absent from baseFields.
const baseFields = {
  name: "blockcast-prod",
  description: null,
};

describe("createEnvironmentSchema — k8s variant", () => {
  it("accepts in-cluster auth (kubeconfigSecretRef omitted)", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: {
        namespace: "paperclip",
        workspaceVolumeClaim: "paperclip-data",
        nodeSelector: { workload: "paperclip" },
        tolerations: [
          { key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts kubeconfigSecretRef for out-of-cluster auth", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: { kubeconfigSecretRef: "company-kubeconfig", namespace: "agents" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects inline kubeconfig (must be a secretRef)", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: { kubeconfig: "apiVersion: v1\nkind: Config\n..." },
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed tolerations", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: { tolerations: "not-an-array" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty providers object (back-compat with B.1)", () => {
    const ok = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: { providers: {} },
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a populated ccrotate provider pool", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: {
        providers: {
          anthropic: { kind: "ccrotate", accounts: ["a@b.net", "c@d.net"] },
          openai: { kind: "ccrotate", accounts: ["e@f.net"] },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty accounts array", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: { providers: { anthropic: { kind: "ccrotate", accounts: [] } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown provider kind", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: { providers: { anthropic: { kind: "vault", accounts: ["a@b.net"] } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-email account strings", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: { providers: { anthropic: { kind: "ccrotate", accounts: ["not-an-email"] } } },
    });
    expect(result.success).toBe(false);
  });

  it("normalizes optional resources", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: {
        resources: {
          requests: { cpu: "500m", memory: "512Mi" },
          limits: { cpu: "2", memory: "4Gi" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty config (all fields optional)", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "k8s",
      config: {},
    });
    expect(result.success).toBe(true);
  });
});

describe("updateEnvironmentSchema — k8s variant", () => {
  it("validates k8s config when driver=k8s in PATCH", () => {
    const ok = updateEnvironmentSchema.safeParse({
      driver: "k8s",
      config: { namespace: "paperclip" },
    });
    expect(ok.success).toBe(true);

    const bad = updateEnvironmentSchema.safeParse({
      driver: "k8s",
      config: { kubeconfig: "inline-not-allowed" },
    });
    expect(bad.success).toBe(false);
  });
});

describe("createEnvironmentSchema — non-k8s drivers unaffected", () => {
  it("local driver still accepts arbitrary config records", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "local",
      config: { anything: "goes", nested: { key: "value" } },
    });
    expect(result.success).toBe(true);
  });

  it("ssh driver still accepts arbitrary config records", () => {
    const result = createEnvironmentSchema.safeParse({
      ...baseFields,
      driver: "ssh",
      config: {
        host: "1.2.3.4",
        port: 22,
        username: "ubuntu",
        remoteWorkspacePath: "/home/ubuntu",
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("k8sEnvironmentConfigSchema is exported", () => {
  it("can be imported and used directly", () => {
    expect(k8sEnvironmentConfigSchema.safeParse({}).success).toBe(true);
    expect(
      k8sEnvironmentConfigSchema.safeParse({ namespace: "x" }).success,
    ).toBe(true);
    expect(
      k8sEnvironmentConfigSchema.safeParse({ kubeconfig: "inline" }).success,
    ).toBe(false);
  });
});
