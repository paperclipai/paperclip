import { describe, it, expect } from "vitest";
import { buildSandboxCrManifest } from "../../src/sandbox-cr-builder.js";

const baseInput = {
  namespace: "paperclip-acme",
  sandboxName: "pc-01h00000000000000000000000",
  adapterType: "claude_local",
  image: "ghcr.io/paperclipai/agent-runtime-claude:v1",
  envSecretName: "pc-01h00000000000000000000000-env",
  serviceAccountName: "paperclip-tenant-sa",
  labels: { "paperclip.io/run-id": "r1" },
  resources: {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "2", memory: "4Gi" },
  },
  runtimeClassName: undefined,
};

describe("buildSandboxCrManifest", () => {
  it("returns a Sandbox CR with the correct apiVersion and kind", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.apiVersion).toBe("agents.x-k8s.io/v1alpha1");
    expect(cr.kind).toBe("Sandbox");
  });

  it("sets metadata name and namespace correctly", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.metadata.name).toBe(baseInput.sandboxName);
    expect(cr.metadata.namespace).toBe(baseInput.namespace);
  });

  it("does NOT set ownerReferences (out-of-cluster server, explicit release path)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.metadata.ownerReferences).toBeUndefined();
  });

  it("sets restartPolicy=Always on the pod template (required for long-lived Sandbox pod)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.restartPolicy).toBe("Always");
  });

  it("uses sleep-infinity entrypoint via Tini for multi-command exec", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const container = cr.spec.podTemplate.spec.containers.find((c: { name: string }) => c.name === "agent");
    expect(container.command).toEqual([
      "/usr/bin/tini",
      "--",
      "/bin/sh",
      "-c",
      "sleep infinity",
    ]);
  });

  it("applies the same security baseline as Job backend (non-root, drop ALL, RO rootFS, seccomp)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const podSec = cr.spec.podTemplate.spec.securityContext;
    expect(podSec.runAsNonRoot).toBe(true);
    expect(podSec.runAsUser).toBe(1000);
    expect(podSec.fsGroupChangePolicy).toBe("OnRootMismatch");
    expect(podSec.seccompProfile.type).toBe("RuntimeDefault");

    const container = cr.spec.podTemplate.spec.containers[0];
    expect(container.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
  });

  it("disables automountServiceAccountToken", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.automountServiceAccountToken).toBe(false);
  });

  it("keeps ServiceAccount token mounts out of the loader and agent containers", () => {
    const cr = buildSandboxCrManifest({ ...baseInput, gitReadOnlySecretName: "git-read-only" });
    const containers = cr.spec.podTemplate.spec.containers;
    const volumeNames = cr.spec.podTemplate.spec.volumes.map((volume: { name: string }) => volume.name);

    expect(volumeNames).not.toContain("kube-api-access");
    expect(volumeNames).not.toContain("service-account-token");
    for (const container of containers) {
      expect(container.volumeMounts).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ mountPath: "/var/run/secrets/kubernetes.io/serviceaccount" }),
      ]));
    }
  });

  it("declares writable loader and agent paths under read-only root filesystems", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const loader = cr.spec.podTemplate.spec.containers.find((c: { name: string }) => c.name === "repo-loader");
    expect(loader.env).toEqual([
      { name: "HOME", value: "/home/loader" },
      { name: "TMPDIR", value: "/home/loader/tmp" },
      { name: "XDG_CONFIG_HOME", value: "/home/loader/.config" },
    ]);
    expect(loader.volumeMounts).toEqual([
      { name: "workspace", mountPath: "/workspace" },
      { name: "loader-home", mountPath: "/home/loader" },
    ]);
    const mounts = cr.spec.podTemplate.spec.containers.find((c: { name: string }) => c.name === "agent").volumeMounts;
    const mountPaths = mounts
      .map((m: { mountPath: string }) => m.mountPath)
      .sort();
    expect(mountPaths).toEqual([
      "/home/paperclip",
      "/home/paperclip/.cache",
      "/tmp",
      "/workspace",
    ]);

    const volumes = cr.spec.podTemplate.spec.volumes;
    expect(
      volumes.every((v: { emptyDir?: unknown }) => v.emptyDir !== undefined),
    ).toBe(true);
  });

  it("envFrom references the per-run secret", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const envFrom = cr.spec.podTemplate.spec.containers.find((c: { name: string }) => c.name === "agent").envFrom;
    expect(envFrom[0].secretRef.name).toBe(baseInput.envSecretName);
  });

  it("selectively injects only the minimal Git keys into the loader and never the agent", () => {
    const cr = buildSandboxCrManifest({ ...baseInput, gitReadOnlySecretName: "git-read-only" });
    const containers = cr.spec.podTemplate.spec.containers;
    const loaderEnv = containers.find((c: { name: string }) => c.name === "repo-loader").env;
    expect(loaderEnv).toContainEqual({ name: "GIT_USERNAME", valueFrom: { secretKeyRef: { name: "git-read-only", key: "GIT_USERNAME" } } });
    expect(loaderEnv).toContainEqual({ name: "GIT_TOKEN", valueFrom: { secretKeyRef: { name: "git-read-only", key: "GIT_TOKEN" } } });
    expect(containers.find((c: { name: string }) => c.name === "repo-loader").envFrom).toBeUndefined();
    expect(containers.find((c: { name: string }) => c.name === "agent").envFrom).toEqual([
      { secretRef: { name: baseInput.envSecretName } },
    ]);
    expect(containers.find((c: { name: string }) => c.name === "agent").volumeMounts).not.toContainEqual(
      { name: "loader-home", mountPath: "/home/loader" },
    );
    expect(containers.find((c: { name: string }) => c.name === "agent").volumeMounts).toEqual([
      { name: "workspace", mountPath: "/workspace" },
      { name: "home", mountPath: "/home/paperclip" },
      { name: "cache", mountPath: "/home/paperclip/.cache" },
      { name: "tmp", mountPath: "/tmp" },
    ]);
  });

  it("keeps public repositories credential-free when no binding is configured", () => {
    const loader = buildSandboxCrManifest(baseInput).spec.podTemplate.spec.containers.find((c: { name: string }) => c.name === "repo-loader");
    expect(loader.env).not.toContainEqual(expect.objectContaining({ name: "GIT_TOKEN" }));
    expect(loader.envFrom).toBeUndefined();
  });

  it("injects the repository proxy only into repo-loader", () => {
    const cr = buildSandboxCrManifest({ ...baseInput, repositoryProxyUrl: "http://192.168.0.63:3129" });
    const containers = cr.spec.podTemplate.spec.containers;
    const loaderEnv = containers.find((c: { name: string }) => c.name === "repo-loader").env;
    const agentEnv = containers.find((c: { name: string }) => c.name === "agent").env;
    expect(loaderEnv).toEqual(expect.arrayContaining([
      { name: "HTTP_PROXY", value: "http://192.168.0.63:3129" },
      { name: "HTTPS_PROXY", value: "http://192.168.0.63:3129" },
      { name: "NO_PROXY", value: "localhost,127.0.0.1" },
    ]));
    expect(agentEnv).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "HTTP_PROXY" }),
      expect.objectContaining({ name: "HTTPS_PROXY" }),
    ]));
  });

  it("applies runtimeClassName when set", () => {
    const cr = buildSandboxCrManifest({
      ...baseInput,
      runtimeClassName: "kata-fc",
    });
    expect(cr.spec.podTemplate.spec.runtimeClassName).toBe("kata-fc");
  });

  it("does not set runtimeClassName when unset", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.runtimeClassName).toBeUndefined();
  });

  it("applies provided labels to CR metadata and pod template labels (with role=agent added)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.metadata.labels["paperclip.io/run-id"]).toBe("r1");
    expect(
      cr.spec.podTemplate.metadata.labels["paperclip.io/run-id"],
    ).toBe("r1");
    expect(cr.spec.podTemplate.metadata.labels["paperclip.io/role"]).toBe(
      "agent",
    );
  });

  it("applies imagePullSecrets when provided", () => {
    const cr = buildSandboxCrManifest({
      ...baseInput,
      imagePullSecrets: ["my-pull-secret"],
    });
    expect(cr.spec.podTemplate.spec.imagePullSecrets).toEqual([
      { name: "my-pull-secret" },
    ]);
  });

  it("does not set imagePullSecrets when not provided", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.imagePullSecrets).toBeUndefined();
  });
});
