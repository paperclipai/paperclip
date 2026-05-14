import { describe, it, expect } from "vitest";
import type {
  AdapterExecutionTarget,
  K8sRemoteSpec,
} from "./execution-target.js";

describe("AdapterExecutionTarget — k8s variant", () => {
  it("compiles with a k8s remote target", () => {
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "k8s",
      environmentId: "00000000-0000-0000-0000-000000000000",
      leaseId: "00000000-0000-0000-0000-000000000001",
      remoteCwd: "/paperclip",
      config: {
        kubeconfig: null,
        namespace: "paperclip",
        workspaceVolumeClaim: "paperclip-data",
        workspaceMountPath: "/paperclip",
        secretsNamespace: "paperclip",
        nodeSelector: { workload: "paperclip" },
        tolerations: [],
        labels: {},
        serviceAccountName: null,
        imagePullPolicy: null,
        resources: null,
      },
    };
    expect(target.kind).toBe("remote");
    if (target.kind === "remote" && target.transport === "k8s") {
      expect(target.config.namespace).toBe("paperclip");
    }
  });

  it("accepts a k8s remote target with providers populated", () => {
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "k8s",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/paperclip",
      config: {
        kubeconfig: null,
        namespace: "paperclip",
        workspaceVolumeClaim: "paperclip-eng-data",
        workspaceMountPath: "/paperclip",
        secretsNamespace: "paperclip",
        nodeSelector: {},
        tolerations: [],
        labels: {},
        serviceAccountName: null,
        imagePullPolicy: null,
        resources: null,
        providers: {
          anthropic: { kind: "ccrotate", accounts: ["a@b.net", "c@d.net"] },
        },
      },
    };
    expect(target.transport).toBe("k8s");
    if (target.kind === "remote" && target.transport === "k8s") {
      expect(target.config.providers?.anthropic?.accounts).toEqual(["a@b.net", "c@d.net"]);
    }
  });

  it("type narrows correctly on transport discriminator", () => {
    const target = {
      kind: "remote",
      transport: "k8s",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/paperclip",
      config: {
        kubeconfig: null,
        namespace: null,
        workspaceVolumeClaim: null,
        workspaceMountPath: null,
        secretsNamespace: null,
        nodeSelector: {},
        tolerations: [],
        labels: {},
        serviceAccountName: null,
        imagePullPolicy: null,
        resources: null,
      } satisfies K8sRemoteSpec,
    } as AdapterExecutionTarget;
    if (target.kind === "remote" && target.transport === "k8s") {
      // Inside this branch, target.config must be K8sRemoteSpec — TypeScript will
      // fail this test at build time if narrowing doesn't work.
      const _spec: K8sRemoteSpec = target.config;
      expect(_spec).toBeDefined();
    }
  });
});
